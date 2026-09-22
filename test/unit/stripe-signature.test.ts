/**
 * The webhook route is public, so this check is all that stands between the
 * internet and a reconcile. It is only a poke -- the handler re-fetches from
 * Stripe and never trusts the body (ADR-0047) -- but an unsigned poke would
 * still let anybody spend our Stripe rate limit on demand.
 *
 * The signatures below are computed here with node's own HMAC, not with the
 * code under test, so a verifier that agreed with itself about a wrong payload
 * would still fail.
 */

import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifySignature } from '../../server/stripe'

const SECRET = 'whsec_test_not_a_real_secret'
const BODY = '{"type":"checkout.session.completed","data":{"object":{"id":"cs_1"}}}'
const NOW = 1_790_000_000

function v1(secret: string, t: number, body: string): string {
  return createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')
}

describe('verifySignature', () => {
  const t = NOW - 10

  it('accepts what Stripe signed', async () => {
    const header = `t=${t},v1=${v1(SECRET, t, BODY)}`
    expect(await verifySignature({ secret: SECRET, header, body: BODY, now: NOW })).toBe(true)
  })

  it('accepts any one of several v1 signatures, as during a secret rotation', async () => {
    const header = `t=${t},v1=${v1('whsec_old', t, BODY)},v1=${v1(SECRET, t, BODY)},v0=deadbeef`
    expect(await verifySignature({ secret: SECRET, header, body: BODY, now: NOW })).toBe(true)
  })

  it('refuses a body changed after signing', async () => {
    const header = `t=${t},v1=${v1(SECRET, t, BODY)}`
    const body = BODY.replace('cs_1', 'cs_2')
    expect(await verifySignature({ secret: SECRET, header, body, now: NOW })).toBe(false)
  })

  it('refuses a signature made with another secret', async () => {
    const header = `t=${t},v1=${v1('whsec_somebody_else', t, BODY)}`
    expect(await verifySignature({ secret: SECRET, header, body: BODY, now: NOW })).toBe(false)
  })

  it('refuses a timestamp moved after signing', async () => {
    const header = `t=${t + 1},v1=${v1(SECRET, t, BODY)}`
    expect(await verifySignature({ secret: SECRET, header, body: BODY, now: NOW })).toBe(false)
  })

  it('refuses a signature older than five minutes, and one from the future', async () => {
    for (const at of [NOW - 301, NOW + 301]) {
      const header = `t=${at},v1=${v1(SECRET, at, BODY)}`
      expect(await verifySignature({ secret: SECRET, header, body: BODY, now: NOW }), String(at)).toBe(false)
    }
  })

  it('refuses a v0 signature, which Stripe uses only for test events', async () => {
    const header = `t=${t},v0=${v1(SECRET, t, BODY)}`
    expect(await verifySignature({ secret: SECRET, header, body: BODY, now: NOW })).toBe(false)
  })

  it('refuses a missing header, a missing timestamp and an empty secret', async () => {
    const good = `t=${t},v1=${v1(SECRET, t, BODY)}`
    expect(await verifySignature({ secret: SECRET, header: null, body: BODY, now: NOW })).toBe(false)
    expect(await verifySignature({ secret: SECRET, header: `v1=${v1(SECRET, t, BODY)}`, body: BODY, now: NOW })).toBe(false)
    expect(await verifySignature({ secret: '', header: good, body: BODY, now: NOW })).toBe(false)
  })
})
