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
import { setPlan, signUp } from './helpers'

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

  it('never lets a browser keep a HEAD answer', async () => {
    /**
     * Firefox answers DuckDB's ranged HEAD out of the plain HEAD it cached a
     * moment before: 200, no Content-Range, and every file failed to open.
     * Measured on Firefox 153; Chrome goes to the network.
     */
    await env.DATA.put('v1/probe.bin', new Uint8Array(SIZE))
    await env.DATA.put('vendor/probe.bin', new Uint8Array(SIZE))
    const cookie = await signUp('head-cache@example.test')
    for (const [path, range] of [
      ['v1/probe.bin', null],
      ['v1/probe.bin', 'bytes=0-'],
      ['vendor/probe.bin', null],
    ] as const) {
      const res = await SELF.fetch(`http://x/data/${path}`, {
        method: 'HEAD',
        headers: { cookie, ...(range ? { range } : {}) },
      })
      expect(res.headers.get('cache-control'), `${path} ${range ?? ''}`).toBe('no-store')
    }
  })
})

describe('the paid tree', () => {
  /**
   * The last two months of certificates live under recent/ and are served to
   * paid accounts only. Free accounts are signed in, so every refusal here is
   * the plan check and not the session check. See ADR-0038.
   */
  const SIZE = 1000
  const PROBE = 'http://x/data/recent/v1/probe.bin'

  beforeEach(async () => {
    await migrate(env.DB)
    await env.DATA.put('recent/v1/probe.bin', new Uint8Array(SIZE))
  })

  it('refuses a free account on GET, ranged GET and ranged HEAD', async () => {
    const cookie = await signUp('free@example.test')
    for (const [method, range] of [
      ['GET', null],
      ['GET', 'bytes=0-99'],
      ['HEAD', 'bytes=0-'],
    ] as const) {
      const res = await SELF.fetch(PROBE, { method, headers: { cookie, ...(range ? { range } : {}) } })
      await res.arrayBuffer()
      expect(res.status, `${method} ${range ?? ''}`).toBe(403)
    }
  })

  it('serves a paid account by ranges, and never lets the browser keep it', async () => {
    const cookie = await signUp('paid@example.test')
    await setPlan('paid@example.test', 'decouverte')

    const get = await SELF.fetch(PROBE, { headers: { cookie, range: 'bytes=0-99' } })
    expect(get.status).toBe(206)
    expect(get.headers.get('content-range')).toBe(`bytes 0-99/${SIZE}`)
    // The browser cache is keyed by URL, not by account: a kept answer would
    // reach the next account to sign in on this browser, whatever its plan.
    expect(get.headers.get('cache-control')).toBe('no-store')
    // TRAP: read every R2 body. One left streaming holds the bucket's SQLite
    // open past the test, and isolated storage fails the whole file.
    expect((await get.arrayBuffer()).byteLength).toBe(100)

    const head = await SELF.fetch(PROBE, { method: 'HEAD', headers: { cookie, range: 'bytes=0-' } })
    expect(head.status).toBe(206)
    expect(head.headers.get('cache-control')).toBe('no-store')
  })

  it('refuses the next request once the account goes back to free', async () => {
    const cookie = await signUp('lapsed@example.test')
    await setPlan('lapsed@example.test', 'decouverte')
    const paid = await SELF.fetch(PROBE, { headers: { cookie } })
    expect(paid.status).toBe(200)
    expect((await paid.arrayBuffer()).byteLength).toBe(SIZE)

    await setPlan('lapsed@example.test', 'free')
    expect((await SELF.fetch(PROBE, { headers: { cookie } })).status).toBe(403)
  })

  it('cannot be reached by climbing out of another data prefix', async () => {
    const cookie = await signUp('climber@example.test')
    for (const path of [
      '/data/v1/..%2Frecent%2Fv1%2Fprobe.bin',
      '/data/v1/%2e%2e/recent/v1/probe.bin',
      '/data/v1/%2E%2E%2Frecent/v1/probe.bin',
      '/data/vendor/..%2Frecent%2Fv1%2Fprobe.bin',
      '/data/vendor/%2e%2e/recent/v1/probe.bin',
    ]) {
      for (const headers of [{ cookie }, {}] as Record<string, string>[]) {
        const res = await SELF.fetch(`http://x${path}`, { headers })
        await res.arrayBuffer()
        expect(res.status, `${path} ${'cookie' in headers ? 'free' : 'anonymous'}`).toBeGreaterThanOrEqual(400)
      }
    }
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
