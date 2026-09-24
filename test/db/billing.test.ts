/**
 * The paid plan, bought through Stripe Checkout. See ADR-0047.
 *
 * D1 is real Miniflare SQLite; only Stripe is stubbed, at the HTTP boundary,
 * by fetchMock. Net connect is disabled, so a Stripe call the test did not
 * expect fails the request instead of reaching anything -- which is how "an
 * unknown id costs no Stripe call" is observed below.
 */

import { env, fetchMock, SELF } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../../db/migrate'
import { callerFrom } from '../../server/db'
import { ROUTES } from '../../server/index'
import {
  event,
  postWebhook,
  recentStatus,
  setPlan,
  signUp,
  STRIPE_ORIGIN,
  stripe,
  stubCheckout,
  stubCompleted,
  stubSubscription,
  withCookie,
} from './helpers'

const DAY = 24 * 60 * 60 * 1000

beforeAll(() => {
  fetchMock.activate()
  fetchMock.disableNetConnect()
})

beforeEach(async () => {
  await migrate(env.DB)
  await env.DATA.put('recent/v1/probe.bin', new Uint8Array(10))
})

afterEach(() => {
  // Every stubbed Stripe call was made: a test that set one up and never
  // reached it was not testing the path it thinks it was.
  fetchMock.assertNoPendingInterceptors()
})

function post(cookie: string, path: string): Promise<Response> {
  return SELF.fetch(`http://x${path}`, { method: 'POST', headers: { cookie } })
}

async function me(cookie: string): Promise<Record<string, unknown>> {
  return (await (await SELF.fetch('http://x/api/me', withCookie(cookie))).json()) as Record<string, unknown>
}

type Row = {
  user_id: string
  subscription_id: string | null
  customer_id: string | null
  status: string
  paid_until: number | null
  cancel_at_period_end: number
}

async function rowOf(session: string): Promise<Row | null> {
  return env.DB.prepare(
    'SELECT user_id, subscription_id, customer_id, status, paid_until, cancel_at_period_end FROM subscription WHERE id = ?',
  )
    .bind(session)
    .first<Row>()
}

const seconds = (d: Date) => Math.floor(d.getTime() / 1000)
const day = (d: Date) => d.toISOString().slice(0, 10)

/** Sign up and open a checkout; returns the cookie with the pending row in place. */
async function checkedOut(email: string, session: string): Promise<string> {
  const cookie = await signUp(email)
  stubCheckout(session)
  const res = await post(cookie, '/api/billing/checkout')
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ url: `https://checkout.stripe.invalid/${session}` })
  return cookie
}

/** Check out and pay: the completed webhook, with Stripe saying the subscription is `status`. */
async function paid(
  email: string,
  session: string,
  sub: string,
  s: { status?: string; periodEnd?: Date; cancelAtPeriodEnd?: boolean } = {},
): Promise<string> {
  const cookie = await checkedOut(email, session)
  stubCompleted(session, sub, {
    status: s.status ?? 'active',
    periodEnd: s.periodEnd ?? new Date(Date.now() + 30 * DAY),
    cancelAtPeriodEnd: s.cancelAtPeriodEnd ?? false,
  })
  const res = await postWebhook(event('checkout.session.completed', { id: session, object: 'checkout.session' }))
  expect(res.status).toBe(204)
  return cookie
}

describe('checkout', () => {
  it('opens a Checkout Session for the caller, with the settings chosen in Checkout Studio', async () => {
    const cookie = await signUp('buyer@example.test')
    const { id } = await me(cookie)
    let sent = ''
    fetchMock
      .get(STRIPE_ORIGIN)
      .intercept({ method: 'POST', path: '/v1/checkout/sessions' })
      .reply(200, (opts) => {
        sent = String(opts.body)
        return JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.invalid/cs_1' })
      })

    const res = await post(cookie, '/api/billing/checkout')
    expect(res.status).toBe(200)
    await res.arrayBuffer()

    const form = new URLSearchParams(sent)
    expect(Object.fromEntries(form)).toMatchObject({
      mode: 'subscription',
      'line_items[0][price]': 'price_test',
      'line_items[0][quantity]': '1',
      client_reference_id: id,
      customer_email: 'buyer@example.test',
      success_url: 'http://x/?abonnement=merci',
      cancel_url: 'http://x/?abonnement=annule',
      billing_address_collection: 'auto',
      'phone_number_collection[enabled]': 'false',
      'automatic_tax[enabled]': 'false',
      allow_promotion_codes: 'false',
      payment_method_collection: 'always',
    })
    expect(await rowOf('cs_1')).toEqual({
      user_id: id,
      subscription_id: null,
      customer_id: null,
      status: 'pending',
      paid_until: null,
      cancel_at_period_end: 0,
    })
    // Opening a checkout is not paying.
    expect(await recentStatus(cookie)).toBe(403)
  })

  it('reuses the Stripe customer of an earlier subscription', async () => {
    const cookie = await paid('again@example.test', 'cs_a', 'sub_a', { status: 'canceled' })
    let sent = ''
    fetchMock
      .get(STRIPE_ORIGIN)
      .intercept({ method: 'POST', path: '/v1/checkout/sessions' })
      .reply(200, (opts) => {
        sent = String(opts.body)
        return JSON.stringify({ id: 'cs_b', url: 'https://checkout.stripe.invalid/cs_b' })
      })
    const res = await post(cookie, '/api/billing/checkout')
    expect(res.status).toBe(200)
    await res.arrayBuffer()
    const form = new URLSearchParams(sent)
    expect(form.get('customer')).toBe('cus_of_sub_a')
    expect(form.has('customer_email')).toBe(false)
  })

  it('refuses an account that is already paid', async () => {
    const cookie = await signUp('comped@example.test')
    await setPlan('comped@example.test', 'paid')
    expect((await post(cookie, '/api/billing/checkout')).status).toBe(409)
  })

  it('refuses a second subscription while one is still alive at Stripe, even unpaid', async () => {
    const cookie = await paid('twice@example.test', 'cs_t', 'sub_t', { status: 'past_due' })
    // Free, because past_due does not entitle -- but a new checkout would bill twice.
    expect(await recentStatus(cookie)).toBe(403)
    expect((await post(cookie, '/api/billing/checkout')).status).toBe(409)
  })

  it('refuses a caller with no session', async () => {
    expect((await SELF.fetch('http://x/api/billing/checkout', { method: 'POST' })).status).toBe(401)
  })
})

describe('the webhook', () => {
  it('turns a completed checkout into the paid tree', async () => {
    const end = new Date(Date.now() + 30 * DAY)
    const cookie = await paid('payer@example.test', 'cs_2', 'sub_2', { periodEnd: end })
    const { id } = await me(cookie)
    expect(await rowOf('cs_2')).toEqual({
      user_id: id,
      subscription_id: 'sub_2',
      customer_id: 'cus_of_sub_2',
      status: 'active',
      paid_until: seconds(end),
      cancel_at_period_end: 0,
    })
    expect(await recentStatus(cookie)).toBe(200)
    expect(await me(cookie)).toMatchObject({ plan: 'paid', renewsOn: day(end), endsOn: null })
  })

  it('is harmless when delivered twice', async () => {
    const cookie = await paid('twice-delivered@example.test', 'cs_d', 'sub_d')
    stubCompleted('cs_d', 'sub_d', { status: 'active', periodEnd: new Date(Date.now() + 30 * DAY) })
    expect((await postWebhook(event('checkout.session.completed', { id: 'cs_d' }))).status).toBe(204)
    const n = await env.DB.prepare('SELECT count(*) AS n FROM subscription').first<{ n: number }>()
    expect(n?.n).toBe(1)
    expect(await recentStatus(cookie)).toBe(200)
  })

  it('writes what Stripe says, not what the event body says', async () => {
    const cookie = await paid('liar@example.test', 'cs_l', 'sub_l')
    stubSubscription('sub_l', { status: 'canceled', periodEnd: new Date(Date.now() + 30 * DAY) })
    const res = await postWebhook(
      event('customer.subscription.updated', { id: 'sub_l', object: 'subscription', status: 'active' }),
    )
    expect(res.status).toBe(204)
    expect((await rowOf('cs_l'))?.status).toBe('canceled')
    expect(await recentStatus(cookie)).toBe(403)
  })

  it('leaves a checkout that is not complete pending', async () => {
    const cookie = await checkedOut('abandoned@example.test', 'cs_o')
    stubCompleted('cs_o', 'unused', { status: 'active', periodEnd: new Date() }, { status: 'open' })
    expect((await postWebhook(event('checkout.session.completed', { id: 'cs_o' }))).status).toBe(204)
    expect((await rowOf('cs_o'))?.status).toBe('pending')
    expect(await recentStatus(cookie)).toBe(403)
  })

  it('refuses a bad signature and changes nothing', async () => {
    const cookie = await checkedOut('forged@example.test', 'cs_f')
    const res = await postWebhook(event('checkout.session.completed', { id: 'cs_f' }), { secret: 'whsec_wrong' })
    expect(res.status).toBe(400)
    expect((await rowOf('cs_f'))?.status).toBe('pending')
    expect(await recentStatus(cookie)).toBe(403)
  })

  it('refuses a correctly signed replay older than five minutes', async () => {
    const res = await postWebhook(event('checkout.session.completed', { id: 'cs_x' }), {
      timestamp: Math.floor(Date.now() / 1000) - 10 * 60,
    })
    expect(res.status).toBe(400)
  })

  it('acknowledges a checkout nobody here opened, without asking Stripe or writing a row', async () => {
    // No intercept is set up: a Stripe call would fail the request.
    const res = await postWebhook(event('checkout.session.completed', { id: 'cs_stranger' }))
    expect(res.status).toBe(204)
    expect(await rowOf('cs_stranger')).toBeNull()
  })

  it('acknowledges a subscription nobody here owns, without asking Stripe', async () => {
    const res = await postWebhook(event('customer.subscription.updated', { id: 'sub_stranger' }))
    expect(res.status).toBe(204)
  })

  it('acknowledges an event it does not read', async () => {
    expect((await postWebhook(event('invoice.created', { id: 'in_1' }))).status).toBe(204)
  })

  it('answers 5xx when Stripe fails, so Stripe delivers again', async () => {
    await checkedOut('outage@example.test', 'cs_5')
    stripe('GET', '/checkout/sessions/cs_5', { status: 503, body: { error: { message: 'down' } } })
    const res = await postWebhook(event('checkout.session.completed', { id: 'cs_5' }))
    expect(res.status).toBeGreaterThanOrEqual(500)
    await res.arrayBuffer()
    expect((await rowOf('cs_5'))?.status).toBe('pending')
  })
})

describe('what entitles', () => {
  it('keeps a subscription cancelled at period end paid to the end of its month', async () => {
    const end = new Date(Date.now() + 10 * DAY)
    const cookie = await paid('leaver@example.test', 'cs_7', 'sub_7', { periodEnd: end })
    stubSubscription('sub_7', { status: 'active', periodEnd: end, cancelAtPeriodEnd: true })
    expect((await postWebhook(event('customer.subscription.updated', { id: 'sub_7' }))).status).toBe(204)
    expect(await recentStatus(cookie)).toBe(200)
    expect(await me(cookie)).toMatchObject({ plan: 'paid', renewsOn: null, endsOn: day(end) })
  })

  it('stops at once when Stripe deletes the subscription', async () => {
    const cookie = await paid('deleted@example.test', 'cs_8', 'sub_8')
    stubSubscription('sub_8', { status: 'canceled', periodEnd: new Date(Date.now() + 20 * DAY) })
    expect((await postWebhook(event('customer.subscription.deleted', { id: 'sub_8' }))).status).toBe(204)
    expect(await recentStatus(cookie)).toBe(403)
    expect(await me(cookie)).toMatchObject({ plan: 'free', renewsOn: null, endsOn: null })
  })

  it('does not read on an unpaid renewal', async () => {
    const cookie = await paid('overdue@example.test', 'cs_9', 'sub_9')
    stubSubscription('sub_9', { status: 'past_due', periodEnd: new Date(Date.now() + 28 * DAY) })
    expect((await postWebhook(event('customer.subscription.updated', { id: 'sub_9' }))).status).toBe(204)
    expect(await recentStatus(cookie)).toBe(403)
  })

  it('stops once the period and its day of grace are over, even if no webhook said so', async () => {
    const cookie = await paid('silent@example.test', 'cs_10', 'sub_10', { periodEnd: new Date(Date.now() - 2 * DAY) })
    expect((await rowOf('cs_10'))?.status).toBe('active')
    expect(await recentStatus(cookie)).toBe(403)
  })

  it('still reads within the day of grace, while a renewal is on its way', async () => {
    const cookie = await paid('renewing@example.test', 'cs_11', 'sub_11', { periodEnd: new Date(Date.now() - DAY / 2) })
    expect(await recentStatus(cookie)).toBe(200)
  })

  it('still honours a plan set by hand', async () => {
    const cookie = await signUp('manual@example.test')
    await setPlan('manual@example.test', 'paid')
    expect(await recentStatus(cookie)).toBe(200)
  })
})

describe('what /api/me says about billing', () => {
  it('gives a subscriber their status, and no portal link: the portal is a session now (ADR-0048)', async () => {
    const cookie = await paid('portal@example.test', 'cs_p', 'sub_p', { status: 'past_due' })
    const body = await me(cookie)
    expect(body).toMatchObject({ plan: 'free', subscriptionStatus: 'past_due' })
    expect(body).not.toHaveProperty('manageUrl')
  })

  it('gives a free member no status', async () => {
    const cookie = await signUp('never@example.test')
    expect(await me(cookie)).toMatchObject({ plan: 'free', subscriptionStatus: null })
  })

  it('gives no status while a checkout is only opened', async () => {
    const cookie = await checkedOut('opened@example.test', 'cs_q')
    expect(await me(cookie)).toMatchObject({ subscriptionStatus: null })
  })
})

describe('the portal', () => {
  function portal(cookie: string, body: unknown): Promise<Response> {
    return SELF.fetch('http://x/api/billing/portal', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  /** Answer one portal session and hand back the form it was asked with. */
  function stubPortal(): { form: () => URLSearchParams } {
    let sent = ''
    fetchMock
      .get(STRIPE_ORIGIN)
      .intercept({ method: 'POST', path: '/v1/billing_portal/sessions' })
      .reply(200, (opts) => {
        sent = String(opts.body)
        return JSON.stringify({ id: 'bps_1', url: 'https://billing.stripe.invalid/session/bps_1' })
      })
    return { form: () => new URLSearchParams(sent) }
  }

  it('opens a session for the caller\'s own customer, returning to the host they came from', async () => {
    const cookie = await paid('manage@example.test', 'cs_m', 'sub_m')
    const stub = stubPortal()
    const res = await portal(cookie, {})
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ url: 'https://billing.stripe.invalid/session/bps_1' })
    expect(stub.form().get('customer')).toBe('cus_of_sub_m')
    expect(stub.form().get('return_url')).toBe('http://x/#/abonnement')
    expect(stub.form().get('flow_data[type]')).toBeNull()
  })

  it('deep-links a cancel to the caller\'s own live subscription', async () => {
    const cookie = await paid('leaving@example.test', 'cs_l', 'sub_l')
    const stub = stubPortal()
    const res = await portal(cookie, { cancel: true })
    expect(res.status).toBe(200)
    await res.arrayBuffer()
    expect(stub.form().get('flow_data[type]')).toBe('subscription_cancel')
    expect(stub.form().get('flow_data[subscription_cancel][subscription]')).toBe('sub_l')
    expect(stub.form().get('flow_data[after_completion][redirect][return_url]')).toBe('http://x/?abonnement=resilie')
  })

  it('answers 404, and asks Stripe nothing, for an account with no customer', async () => {
    const cookie = await checkedOut('nocustomer@example.test', 'cs_n')
    const res = await portal(cookie, {})
    expect(res.status).toBe(404)
    await res.arrayBuffer()
  })

  it('answers 404 to a cancel once the subscription is over, but still opens the invoices', async () => {
    const cookie = await paid('gone@example.test', 'cs_g', 'sub_g', { status: 'canceled' })
    const refused = await portal(cookie, { cancel: true })
    expect(refused.status).toBe(404)
    await refused.arrayBuffer()
    stubPortal()
    const res = await portal(cookie, {})
    expect(res.status).toBe(200)
    await res.arrayBuffer()
  })

  it('answers 502 when Stripe fails', async () => {
    const cookie = await paid('down@example.test', 'cs_d', 'sub_d')
    stripe('POST', '/billing_portal/sessions', { status: 500, body: { error: { message: 'boom' } } })
    const res = await portal(cookie, {})
    expect(res.status).toBe(502)
    await res.arrayBuffer()
  })
})

describe('with Stripe unconfigured', () => {
  async function call(path: string, overrides: Partial<Env>): Promise<number> {
    const route = ROUTES.find((r) => r.path === path)
    expect(route, path).toBeDefined()
    const res = await route!.handle({
      request: new Request(`http://x${path}`, { method: 'POST', body: '{}' }),
      env: { ...env, ...overrides } as Env,
      caller: callerFrom('someone'),
      params: {},
    })
    return res.status
  }

  it('answers 503 on every billing route rather than guessing', async () => {
    const bare = { STRIPE_SECRET_KEY: undefined, STRIPE_WEBHOOK_SECRET: undefined, STRIPE_PRICE_ID: undefined }
    expect(await call('/api/billing/checkout', bare)).toBe(503)
    expect(await call('/api/billing/portal', bare)).toBe(503)
    expect(await call('/api/billing/webhook', bare)).toBe(503)
  })

  it('refuses a live key where only test mode is allowed', async () => {
    const live = { STRIPE_SECRET_KEY: 'sk_live_not_a_real_key', STRIPE_TEST_MODE_ONLY: '1' }
    expect(await call('/api/billing/checkout', live)).toBe(503)
    expect(await call('/api/billing/portal', live)).toBe(503)
    expect(await call('/api/billing/webhook', live)).toBe(503)
  })
})
