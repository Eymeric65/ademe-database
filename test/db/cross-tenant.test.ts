/**
 * The only real guard.
 *
 * ADR-0003 says it plainly: D1 has no row-level security, so nothing in the
 * database will refuse a query that forgot its predicate. `server/db.ts` is
 * the structural answer and `test/unit/no-raw-db.test.ts` keeps it structural
 * -- but neither of those observes an actual second user failing to read the
 * first user's rows. This does, over HTTP, with two genuine sessions.
 *
 * Non-vacuity is proven by deleting the `userId` predicate from
 * `getSavedBuilding` and watching B read A's row; the output is in the PR body.
 */

import { env, fetchMock, SELF } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../../db/migrate'
import { ROUTES } from '../../server/index'
import {
  event,
  postWebhook,
  STRIPE_ORIGIN,
  recentStatus,
  setPlan,
  signUp,
  stubCheckout,
  stubCompleted,
  withCookie,
} from './helpers'

beforeEach(async () => {
  await migrate(env.DB)
})

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T
}

function post(cookie: string, path: string, body: unknown): Promise<Response> {
  return SELF.fetch(`http://x${path}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('two users and one database', () => {
  it('never lets B see, delete or clobber A\'s saved buildings', async () => {
    const a = await signUp('a@example.test')
    const b = await signUp('b@example.test')

    const created = await json<{ id: string }>(await post(a, '/api/buildings', { numeroDpe: 'X' }))
    expect(created.id).toBeTruthy()

    // B cannot see it.
    expect(await json(await SELF.fetch('http://x/api/buildings', withCookie(b)))).toEqual([])

    // B cannot delete it, and the answer is 404 -- not 403, which would confirm
    // the id exists.
    const del = await SELF.fetch(`http://x/api/buildings/${created.id}`, {
      method: 'DELETE',
      headers: { cookie: b },
    })
    expect(del.status).toBe(404)

    // A still has exactly one.
    const stillA = await json<unknown[]>(await SELF.fetch('http://x/api/buildings', withCookie(a)))
    expect(stillA).toHaveLength(1)

    // B saving the same certificate gets its OWN row, and A is untouched. The
    // unique index is on (user_id, numero_dpe), so a predicate-free upsert
    // would take A's row over instead of creating one.
    const bs = await json<{ id: string }>(await post(b, '/api/buildings', { numeroDpe: 'X' }))
    expect(bs.id).not.toBe(created.id)
    expect(
      await json<unknown[]>(await SELF.fetch('http://x/api/buildings', withCookie(a))),
    ).toHaveLength(1)
    expect(
      await json<unknown[]>(await SELF.fetch('http://x/api/buildings', withCookie(b))),
    ).toHaveLength(1)
  })

  it('keeps one row per source, and B still reaches none of A\'s', async () => {
    const a = await signUp('src-a@example.test')
    const b = await signUp('src-b@example.test')

    // The same numero in two trees is two records (ADR-0034).
    expect((await post(a, '/api/buildings', { numeroDpe: 'X', source: 'existant' })).status).toBe(201)
    expect((await post(a, '/api/buildings', { numeroDpe: 'X', source: 'neuf', dept: '09' })).status).toBe(201)
    const rows = await json<{ id: string; source: string; dept: string | null }[]>(
      await SELF.fetch('http://x/api/buildings', withCookie(a)),
    )
    expect(rows.map((r) => r.source).sort()).toEqual(['existant', 'neuf'])
    const neuf = rows.find((r) => r.source === 'neuf')
    expect(neuf?.dept).toBe('09')

    // B saving the same record gets B's own row, not A's.
    const bs = await json<{ id: string }>(
      await post(b, '/api/buildings', { numeroDpe: 'X', source: 'neuf', dept: '09' }),
    )
    expect(rows.map((r) => r.id)).not.toContain(bs.id)

    const del = await SELF.fetch(`http://x/api/buildings/${neuf?.id}`, {
      method: 'DELETE',
      headers: { cookie: b },
    })
    expect(del.status).toBe(404)
    expect(
      await json<unknown[]>(await SELF.fetch('http://x/api/buildings', withCookie(a))),
    ).toHaveLength(2)
  })

  it('refuses a source it does not know, and an audit it could not find again', async () => {
    const a = await signUp('src-bad@example.test')
    expect((await post(a, '/api/buildings', { numeroDpe: 'X', source: 'bogus' })).status).toBe(400)
    // An audit step's key names no partition; without one it is unreachable.
    expect((await post(a, '/api/buildings', { numeroDpe: 'X', source: 'audit' })).status).toBe(400)
    expect(
      (await post(a, '/api/buildings', { numeroDpe: 'X', source: 'neuf', dept: '../x' })).status,
    ).toBe(400)
    expect(await json(await SELF.fetch('http://x/api/buildings', withCookie(a)))).toEqual([])
  })

  it('never lets B see or delete A\'s saved searches', async () => {
    const a = await signUp('sa@example.test')
    const b = await signUp('sb@example.test')

    const created = await json<{ id: string }>(
      await post(a, '/api/searches', { name: 'Foix, D', spec: { codePostal: '09000' } }),
    )
    expect(created.id).toBeTruthy()

    expect(await json(await SELF.fetch('http://x/api/searches', withCookie(b)))).toEqual([])

    const del = await SELF.fetch(`http://x/api/searches/${created.id}`, {
      method: 'DELETE',
      headers: { cookie: b },
    })
    expect(del.status).toBe(404)
    expect(
      await json<unknown[]>(await SELF.fetch('http://x/api/searches', withCookie(a))),
    ).toHaveLength(1)
  })
})

describe('the gate, walked route by route', () => {
  /**
   * Derived from ROUTES rather than from a hand-written list: a route added
   * later is covered because it is in ROUTES, not because somebody remembered
   * to add it here too.
   */
  it('refuses every non-public route without a cookie', async () => {
    const guarded = ROUTES.filter((r) => r.scope !== 'public')
    expect(guarded.length).toBeGreaterThan(5)

    for (const route of guarded) {
      const path = route.path.replace(/:[^/]+/g, 'some-id')
      const res = await SELF.fetch(`http://x${path}`, {
        method: route.method === 'ANY' ? 'GET' : route.method,
      })
      expect(res.status, `${route.method} ${route.path}`).toBe(401)
    }
  })

  it('refuses every paid route to a signed-in free account', async () => {
    const free = await signUp('walk-free@example.test')
    const paid = ROUTES.filter((r) => r.scope === 'paid')
    expect(paid.length).toBeGreaterThan(0)

    for (const route of paid) {
      const path = route.path.replace(/:[^/]+/g, 'some-id')
      const res = await SELF.fetch(`http://x${path}`, {
        method: route.method === 'ANY' ? 'GET' : route.method,
        headers: { cookie: free },
      })
      expect(res.status, `${route.method} ${route.path}`).toBe(403)
    }
  })
})

describe('one paid account and one free', () => {
  /**
   * The plan is read per caller, not per session or per browser: A being paid
   * must never lend B the paid tree. See ADR-0038.
   */
  it('serves the paid tree to A and refuses it to B', async () => {
    await env.DATA.put('recent/v1/probe.bin', new Uint8Array(10))
    const a = await signUp('paid-a@example.test')
    const b = await signUp('free-b@example.test')
    await setPlan('paid-a@example.test', 'decouverte')

    // Every body read: an R2 stream left open fails isolated storage.
    const status = async (cookie: string) => {
      const res = await SELF.fetch('http://x/data/recent/v1/probe.bin', withCookie(cookie))
      await res.arrayBuffer()
      return res.status
    }
    expect(await status(b)).toBe(403)
    expect(await status(a)).toBe(200)
    expect(await status(b)).toBe(403)
  })
})

describe('two users and one subscription', () => {
  /**
   * Checkout is a `self` route and the webhook is public, so the binding here
   * is the subscription row's user_id, set by the owner's own checkout. See
   * ADR-0047.
   */
  beforeEach(() => {
    fetchMock.activate()
    fetchMock.disableNetConnect()
  })
  afterEach(() => {
    fetchMock.assertNoPendingInterceptors()
    fetchMock.deactivate()
  })

  async function payingA(): Promise<{ a: string; b: string }> {
    await env.DATA.put('recent/v1/probe.bin', new Uint8Array(10))
    const a = await signUp('sub-a@example.test')
    const b = await signUp('sub-b@example.test')
    stubCheckout('cs_of_a')
    const res = await SELF.fetch('http://x/api/billing/checkout', { method: 'POST', headers: { cookie: a } })
    expect(res.status).toBe(200)
    await res.arrayBuffer()
    stubCompleted('cs_of_a', 'sub_of_a', { status: 'active', periodEnd: new Date(Date.now() + 20 * 86_400_000) })
    expect((await postWebhook(event('checkout.session.completed', { id: 'cs_of_a' }))).status).toBe(204)
    return { a, b }
  }

  it('makes A paid and never B', async () => {
    const { a, b } = await payingA()
    expect(await recentStatus(a)).toBe(200)
    expect(await recentStatus(b)).toBe(403)
  })

  it('shows B nothing of A\'s in /api/me', async () => {
    const { b } = await payingA()
    const me = (await (await SELF.fetch('http://x/api/me', withCookie(b))).json()) as Record<string, unknown>
    expect(me).toMatchObject({ plan: 'free', renewsOn: null, endsOn: null })
  })

  it('does not count A\'s subscription against B\'s checkout', async () => {
    const { b } = await payingA()
    stubCheckout('cs_of_b')
    const res = await SELF.fetch('http://x/api/billing/checkout', { method: 'POST', headers: { cookie: b } })
    expect(res.status).toBe(200)
    await res.arrayBuffer()
    const row = await env.DB.prepare(
      'SELECT s.status, u.email FROM subscription s JOIN user u ON u.id = s.user_id WHERE s.id = ?',
    )
      .bind('cs_of_b')
      .first()
    expect(row).toEqual({ status: 'pending', email: 'sub-b@example.test' })
  })

  it('never opens a portal on A\'s customer for B, to manage or to cancel', async () => {
    const { a, b } = await payingA()
    // One portal session is on offer, and every form Stripe is asked with is kept.
    const asked: string[] = []
    fetchMock
      .get(STRIPE_ORIGIN)
      .intercept({ method: 'POST', path: '/v1/billing_portal/sessions' })
      .reply(200, (opts) => {
        asked.push(String(opts.body))
        return JSON.stringify({ id: 'bps_a', url: 'https://billing.stripe.invalid/session/bps_a' })
      })

    for (const body of [{}, { cancel: true }]) {
      const res = await post(b, '/api/billing/portal', body)
      expect(res.status).toBe(404)
      await res.arrayBuffer()
    }
    expect(asked.filter((form) => form.includes('cus_of_sub_of_a'))).toEqual([])

    // The stub was live all along: A's own call is the one that reaches it.
    const own = await post(a, '/api/billing/portal', {})
    expect(own.status).toBe(200)
    await own.arrayBuffer()
    expect(asked).toHaveLength(1)
    expect(new URLSearchParams(asked[0]).get('customer')).toBe('cus_of_sub_of_a')
  })
})
