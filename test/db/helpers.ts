import { env, fetchMock, SELF } from 'cloudflare:test'

/**
 * Sign up through the real HTTP surface and return the session cookie.
 *
 * Through HTTP rather than by inserting a user row: a test that fabricates its
 * own session proves nothing about whether sign-in works, and the cross-tenant
 * probe in PR4 depends on these cookies being the genuine article.
 */
export async function signUp(email: string, password = 'correct-horse-battery'): Promise<string> {
  const res = await SELF.fetch('http://x/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, name: email.split('@')[0] }),
  })
  if (res.status >= 400) {
    throw new Error(`sign-up failed: ${res.status} ${await res.text()}`)
  }
  const cookie = res.headers.get('set-cookie')
  if (!cookie) throw new Error('sign-up returned no cookie')
  // Only the name=value pair; the attributes are not sent back by a client.
  return cookie.split(';')[0] as string
}

export function withCookie(cookie: string): RequestInit {
  return { headers: { cookie } }
}

/**
 * Move an account between plans the way an operator does: an UPDATE on D1,
 * because nothing over HTTP can make an account paid. See ADR-0038.
 */
export async function setPlan(email: string, plan: string): Promise<void> {
  const r = await env.DB.prepare('UPDATE user SET plan = ?, updated_at = unixepoch() WHERE email = ?')
    .bind(plan, email)
    .run()
  // An UPDATE that matched nobody would leave the test asserting on a free
  // account it believes is paid.
  if (r.meta.changes !== 1) throw new Error(`setPlan matched ${r.meta.changes} rows for ${email}`)
}

// --- Stripe, stubbed at the HTTP boundary ----------------------------------
// An external API answered by fetchMock, not a fake database: D1 stays real.

export const STRIPE_ORIGIN = 'https://api.stripe.com'
const WEBHOOK_SECRET = 'whsec_test_not_a_real_secret'

type Reply = { status?: number; body?: unknown }

/** Answer one Stripe call, once. */
export function stripe(method: string, path: string, reply: Reply = {}): void {
  fetchMock
    .get(STRIPE_ORIGIN)
    .intercept({ method, path: `/v1${path}` })
    .reply(reply.status ?? 200, reply.body === undefined ? '' : JSON.stringify(reply.body))
}

/** What checkout calls: one Checkout Session, created. */
export function stubCheckout(session: string): void {
  stripe('POST', '/checkout/sessions', {
    body: { id: session, object: 'checkout.session', url: `https://checkout.stripe.invalid/${session}` },
  })
}

type SubscriptionShape = {
  status: string
  customer?: string
  periodEnd: Date
  cancelAtPeriodEnd?: boolean
}

/**
 * A subscription as Stripe answers GET /v1/subscriptions/:id. The period end
 * sits on the item, where API versions since 2025-03-31 put it.
 */
export function stubSubscription(id: string, s: SubscriptionShape): void {
  stripe('GET', `/subscriptions/${id}`, {
    body: {
      id,
      object: 'subscription',
      status: s.status,
      customer: s.customer ?? `cus_of_${id}`,
      cancel_at_period_end: s.cancelAtPeriodEnd ?? false,
      cancel_at: null,
      items: { data: [{ current_period_end: Math.floor(s.periodEnd.getTime() / 1000) }] },
    },
  })
}

/** What completing a checkout reads back: the session, then its subscription. */
export function stubCompleted(session: string, sub: string, s: SubscriptionShape, { status = 'complete' } = {}): void {
  stripe('GET', `/checkout/sessions/${session}`, {
    body: {
      id: session,
      object: 'checkout.session',
      mode: 'subscription',
      status,
      customer: s.customer ?? `cus_of_${sub}`,
      subscription: status === 'complete' ? sub : null,
    },
  })
  if (status === 'complete') stubSubscription(sub, s)
}

/** An event envelope as Stripe sends one. Only `type` and the object's id are ever read. */
export function event(type: string, object: Record<string, unknown>) {
  return { id: `evt_${crypto.randomUUID()}`, object: 'event', type, data: { object } }
}

/** A webhook delivery signed the way Stripe signs one: `${t}.${raw body}`, t in seconds. */
export async function postWebhook(
  body: unknown,
  { secret = WEBHOOK_SECRET, timestamp = Math.floor(Date.now() / 1000) } = {},
): Promise<Response> {
  const raw = JSON.stringify(body)
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${raw}`)))
  const hex = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('')
  return SELF.fetch('http://x/api/billing/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': `t=${timestamp},v1=${hex}` },
    body: raw,
  })
}

/** GET a paid-tree file and report the status. The body is read: an R2 stream left open fails isolated storage. */
export async function recentStatus(cookie: string): Promise<number> {
  const res = await SELF.fetch('http://x/data/recent/v1/probe.bin', withCookie(cookie))
  await res.arrayBuffer()
  return res.status
}
