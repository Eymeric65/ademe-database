/**
 * The route gate is default-deny and it runs BEFORE dispatch.
 *
 * The load-bearing case is the second one. A gate applied after routing answers
 * 404 for an unknown /api path, which is indistinguishable from "route exists
 * but is unprotected" the day somebody adds one. 401 for an unmatched path is
 * the observable proof that default-deny comes first.
 */

import { env, SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../../db/migrate'
import { signUp } from './helpers'

describe('the data route', () => {
  beforeEach(async () => {
    await migrate(env.DB)
  })

  /**
   * DuckDB-WASM opens a file with `HEAD` and `Range: bytes=0-`, and reads it
   * by ranges only if that answers 206. A 200 sends it down a fallback that
   * GETs the whole file: measured on the national tree, 146 MB to show one
   * Paris certificate. See ADR-0035.
   */
  const SIZE = 1000

  it('answers a ranged HEAD with 206 and the whole length, on the public prefix', async () => {
    await env.DATA.put('vendor/probe.bin', new Uint8Array(SIZE))
    const res = await SELF.fetch('http://x/data/vendor/probe.bin', {
      method: 'HEAD',
      headers: { range: 'bytes=0-' },
    })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-length')).toBe(String(SIZE))
    expect(res.headers.get('content-range')).toBe(`bytes 0-${SIZE - 1}/${SIZE}`)
  })

  it('does the same behind the gate', async () => {
    await env.DATA.put('v1/probe.bin', new Uint8Array(SIZE))
    const cookie = await signUp('ranged-head@example.test')
    const res = await SELF.fetch('http://x/data/v1/probe.bin', {
      method: 'HEAD',
      headers: { range: 'bytes=0-', cookie },
    })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe(`bytes 0-${SIZE - 1}/${SIZE}`)
  })

  it('still answers a plain HEAD with 200', async () => {
    await env.DATA.put('vendor/probe.bin', new Uint8Array(SIZE))
    const res = await SELF.fetch('http://x/data/vendor/probe.bin', { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe(String(SIZE))
  })
})

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
