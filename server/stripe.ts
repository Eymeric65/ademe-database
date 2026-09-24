/**
 * Stripe's API, as much of it as the paid plan needs.
 *
 * `fetch` and WebCrypto only: no SDK, no dependency. Every call is made with the
 * secret key, so everything read back here is Stripe's own word -- which is why
 * the webhook handler re-fetches rather than trusting the event body.
 * See ADR-0047.
 */

import { SUBSCRIPTION_STATUSES } from '../db/schema'

const API = 'https://api.stripe.com/v1'

/** Five minutes either way, the tolerance Stripe's own libraries default to. */
const TOLERANCE_SECONDS = 5 * 60

/**
 * Did Stripe sign this body?
 *
 * `Stripe-Signature` is `t={seconds},v1={hex}[,v1=…][,v0=…]`. The signed
 * payload is `{t}.{raw body}`, HMAC-SHA256 with the endpoint's signing secret
 * (the whole `whsec_…` string). Several `v1` values appear while a secret is
 * being rotated; any one match is enough. `v0` is never accepted.
 *
 * TRAP: `body` must be the raw text as received. Re-serialising parsed JSON
 * changes whitespace or key order and every signature stops matching.
 */
export async function verifySignature(input: {
  secret: string
  header: string | null
  body: string
  now: number
}): Promise<boolean> {
  const { secret, header, body, now } = input
  if (!secret || !header) return false

  let timestamp = ''
  const candidates: string[] = []
  for (const part of header.split(',')) {
    const [name, value] = part.trim().split('=', 2)
    if (name === 't' && value) timestamp = value
    if (name === 'v1' && value) candidates.push(value)
  }
  if (!/^\d+$/.test(timestamp) || candidates.length === 0) return false
  if (Math.abs(now - Number(timestamp)) > TOLERANCE_SECONDS) return false

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`)))
  const expected = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('')

  let ok = false
  // Every candidate is compared in full, so the time taken says nothing about
  // which one matched or how far into it.
  for (const candidate of candidates) if (equal(candidate, expected)) ok = true
  return ok
}

/** Constant-time for equal lengths; a length mismatch is not a secret. */
function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// --- the API ---------------------------------------------------------------

export type Status = (typeof SUBSCRIPTION_STATUSES)[number]

/** What entitles, as Stripe says it right now. */
export type SubscriptionFacts = {
  subscriptionId: string
  customerId: string
  status: Exclude<Status, 'pending'>
  /** Unix seconds: end of the current period, or null. */
  paidUntil: number | null
  cancelAtPeriodEnd: boolean
}

export class StripeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/**
 * The secret key, or null when this deployment has none it may use. Callers
 * answer 503.
 *
 * TRAP: a deployment marked test-mode-only refuses a live key outright. A
 * preview holding one would take real money into the preview database.
 */
export function stripeKey(env: { STRIPE_SECRET_KEY?: string; STRIPE_TEST_MODE_ONLY?: string }): string | null {
  const key = env.STRIPE_SECRET_KEY
  if (!key) return null
  if (env.STRIPE_TEST_MODE_ONLY === '1' && !/^(sk|rk)_test_/.test(key)) return null
  return key
}

async function call<T>(key: string, method: string, path: string, form?: URLSearchParams): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      accept: 'application/json',
      ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(form ? { body: form.toString() } : {}),
  })
  // Read the body every time, even when it is thrown away: an unread body
  // holds the connection open until the isolate gives up on it.
  const text = await res.text()
  if (!res.ok) throw new StripeError(res.status, `${method} ${path}: ${res.status} ${text.slice(0, 200)}`)
  return (text ? JSON.parse(text) : null) as T
}

/**
 * Open a hosted Checkout Session for one account and return where to send it.
 *
 * The settings after `cancel_url` are the ones chosen in Checkout Studio.
 * Each is Stripe's default today; they are spelled out so that a change of
 * default at Stripe is not a change of checkout here.
 */
export async function createCheckoutSession(
  key: string,
  input: { priceId: string; userId: string; email: string; customerId: string | null; origin: string },
): Promise<{ id: string; url: string }> {
  const form = new URLSearchParams({
    mode: 'subscription',
    'line_items[0][price]': input.priceId,
    'line_items[0][quantity]': '1',
    client_reference_id: input.userId,
    'subscription_data[metadata][user_id]': input.userId,
    success_url: `${input.origin}/?abonnement=merci`,
    cancel_url: `${input.origin}/?abonnement=annule`,
    billing_address_collection: 'auto',
    'phone_number_collection[enabled]': 'false',
    'automatic_tax[enabled]': 'false',
    allow_promotion_codes: 'false',
    payment_method_collection: 'always',
  })
  // One Stripe customer per account, reused on every resubscription.
  if (input.customerId) form.set('customer', input.customerId)
  else form.set('customer_email', input.email)
  const session = await call<{ id: string; url?: string | null }>(key, 'POST', '/checkout/sessions', form)
  if (!session.url) throw new StripeError(502, `checkout session ${session.id} came back without a url`)
  return { id: session.id, url: session.url }
}

/**
 * Open a Customer Portal session for one customer and return where to send it.
 * It comes back to the host it was opened from, so a preview returns to the
 * preview. With a subscription id it opens straight on Stripe's cancel page,
 * whose own confirmation is the last click. See ADR-0048.
 */
export async function createPortalSession(
  key: string,
  input: { customerId: string; origin: string; cancelSubscriptionId?: string },
): Promise<{ url: string }> {
  const form = new URLSearchParams({
    customer: input.customerId,
    return_url: `${input.origin}/#/abonnement`,
  })
  if (input.cancelSubscriptionId) {
    form.set('flow_data[type]', 'subscription_cancel')
    form.set('flow_data[subscription_cancel][subscription]', input.cancelSubscriptionId)
    form.set('flow_data[after_completion][type]', 'redirect')
    form.set('flow_data[after_completion][redirect][return_url]', `${input.origin}/?abonnement=resilie`)
  }
  const session = await call<{ id: string; url?: string | null }>(key, 'POST', '/billing_portal/sessions', form)
  if (!session.url) throw new StripeError(502, `portal session ${session.id} came back without a url`)
  return { url: session.url }
}

/**
 * The subscription a checkout became, or null while it has not become one:
 * still open, expired, or not a subscription checkout at all.
 */
export async function subscriptionOfCheckout(key: string, sessionId: string): Promise<string | null> {
  const session = await call<{ mode?: string; status?: string; subscription?: string | { id: string } | null }>(
    key,
    'GET',
    `/checkout/sessions/${encodeURIComponent(sessionId)}`,
  )
  if (session.mode !== 'subscription' || session.status !== 'complete' || !session.subscription) return null
  return typeof session.subscription === 'string' ? session.subscription : session.subscription.id
}

type Subscription = {
  id: string
  status: string
  customer: string | { id: string }
  cancel_at_period_end?: boolean
  cancel_at?: number | null
  current_period_end?: number
  items?: { data?: { current_period_end?: number }[] }
}

/**
 * A subscription's status and how far it is paid.
 *
 * The period end moved from the subscription to its items in API version
 * 2025-03-31; both are read, so the account's API version does not matter.
 * An unknown status is an error rather than a guess: the CHECK would refuse
 * it anyway, and a 5xx makes Stripe deliver again after a deploy that knows it.
 */
export async function readSubscription(key: string, id: string): Promise<SubscriptionFacts> {
  const sub = await call<Subscription>(key, 'GET', `/subscriptions/${encodeURIComponent(id)}`)
  if (!(SUBSCRIPTION_STATUSES as readonly string[]).includes(sub.status) || sub.status === 'pending') {
    throw new StripeError(502, `subscription ${id} has unknown status ${sub.status}`)
  }
  const ends = [sub.current_period_end, ...(sub.items?.data ?? []).map((i) => i.current_period_end)].filter(
    (n): n is number => typeof n === 'number',
  )
  return {
    subscriptionId: sub.id,
    customerId: typeof sub.customer === 'string' ? sub.customer : sub.customer.id,
    status: sub.status as SubscriptionFacts['status'],
    paidUntil: ends.length ? Math.max(...ends) : null,
    cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end) || sub.cancel_at != null,
  }
}
