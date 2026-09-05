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

import { env, SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../../db/migrate'
import { ROUTES } from '../../server/index'
import { signUp, withCookie } from './helpers'

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
})
