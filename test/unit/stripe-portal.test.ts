/**
 * The form a portal session is opened with. The member comes back to the host
 * they left from, and a cancel goes straight to Stripe's cancel page and back
 * to « Résiliation enregistrée ». See ADR-0048.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPortalSession } from '../../server/stripe'

const ORIGIN = 'https://abc123-ademe.example.workers.dev'

function stubFetch(reply: unknown = { id: 'bps_1', url: 'https://billing.stripe.invalid/session/bps_1' }) {
  const sent: { url: string; init: RequestInit }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      sent.push({ url, init })
      return new Response(JSON.stringify(reply), { status: 200 })
    }),
  )
  return sent
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createPortalSession', () => {
  it('opens the portal for the customer and returns to the caller\'s own Abonnement page', async () => {
    const sent = stubFetch()
    const session = await createPortalSession('rk_test_x', { customerId: 'cus_1', origin: ORIGIN })

    expect(session).toEqual({ url: 'https://billing.stripe.invalid/session/bps_1' })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.url).toBe('https://api.stripe.com/v1/billing_portal/sessions')
    expect(sent[0]!.init.method).toBe('POST')
    const form = new URLSearchParams(String(sent[0]!.init.body))
    expect(form.get('customer')).toBe('cus_1')
    expect(form.get('return_url')).toBe(`${ORIGIN}/#/abonnement`)
    expect([...form.keys()].filter((k) => k.startsWith('flow_data'))).toEqual([])
  })

  it('deep-links a cancel to Stripe\'s cancel page, then back to « Résiliation enregistrée »', async () => {
    const sent = stubFetch()
    await createPortalSession('rk_test_x', { customerId: 'cus_1', origin: ORIGIN, cancelSubscriptionId: 'sub_1' })

    const form = new URLSearchParams(String(sent[0]!.init.body))
    expect(form.get('customer')).toBe('cus_1')
    expect(form.get('return_url')).toBe(`${ORIGIN}/#/abonnement`)
    expect(form.get('flow_data[type]')).toBe('subscription_cancel')
    expect(form.get('flow_data[subscription_cancel][subscription]')).toBe('sub_1')
    expect(form.get('flow_data[after_completion][type]')).toBe('redirect')
    expect(form.get('flow_data[after_completion][redirect][return_url]')).toBe(`${ORIGIN}/?abonnement=resilie`)
  })

  it('refuses a session that came back without a url', async () => {
    stubFetch({ id: 'bps_2' })
    await expect(createPortalSession('rk_test_x', { customerId: 'cus_1', origin: ORIGIN })).rejects.toThrow(/without a url/)
  })
})
