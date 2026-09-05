/**
 * The route gate is default-deny and it runs BEFORE dispatch.
 *
 * The load-bearing case is the second one. A gate applied after routing answers
 * 404 for an unknown /api path, which is indistinguishable from "route exists
 * but is unprotected" the day somebody adds one. 401 for an unmatched path is
 * the observable proof that default-deny comes first.
 */

import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

describe('the gate', () => {
  it('lets the public health route through and reports applied migrations', async () => {
    const res = await SELF.fetch('http://x/api/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, migrations: expect.any(Number) })
  })

  it('answers 401, not 404, for an unmatched /api path with no caller', async () => {
    const res = await SELF.fetch('http://x/api/anything-else')
    expect(res.status).toBe(401)
  })
})
