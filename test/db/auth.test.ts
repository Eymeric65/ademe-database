/**
 * Sessions, against real Miniflare D1.
 *
 * Case (d) is the one that matters most. Email+password exists ONLY so that CI
 * can sign in as two different users and prove one cannot read the other's
 * rows -- a Google round-trip cannot be automated. That makes the switch which
 * turns it off in production a security control, and a security control that
 * is never tested in its OFF position is a comment.
 */

import { env, SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../../db/migrate'
import { authFor } from '../../server/db'
import { signUp, withCookie } from './helpers'

/**
 * TRAP: migrate explicitly, per test.
 *
 * `ensureMigrated` memoises per isolate, which is right in production -- an
 * isolate's database never goes away underneath it. Under `isolatedStorage`
 * it does: every test gets a fresh one while the memoised promise survives,
 * so the second test in a file would meet an empty database that the Worker
 * believes it already migrated. Establishing the schema here, rather than
 * relying on the first request to do it, is also just clearer.
 */
beforeEach(async () => {
  await migrate(env.DB)
})

describe('with test credentials enabled', () => {
  it('signs up and identifies the caller', async () => {
    const cookie = await signUp('ada@example.test')
    const res = await SELF.fetch('http://x/api/me', withCookie(cookie))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ email: 'ada@example.test' })
  })

  it('refuses an unauthenticated caller', async () => {
    const res = await SELF.fetch('http://x/api/me')
    expect(res.status).toBe(401)
  })

  it("never answers with the other user's identity", async () => {
    const a = await signUp('a@example.test')
    const b = await signUp('b@example.test')
    expect(a).not.toBe(b)

    const asA = await (await SELF.fetch('http://x/api/me', withCookie(a))).json()
    const asB = await (await SELF.fetch('http://x/api/me', withCookie(b))).json()
    expect(asA).toMatchObject({ email: 'a@example.test' })
    expect(asB).toMatchObject({ email: 'b@example.test' })
    expect((asA as { id: string }).id).not.toBe((asB as { id: string }).id)
  })
})

describe('the AUTH_TEST_CREDENTIALS switch, in its OFF position', () => {
  /**
   * Email+password exists so CI can sign in as two users and prove one cannot
   * read the other's rows -- a Google round-trip cannot be automated. That
   * makes this variable a security control, and a control only ever tested
   * while ON is a comment.
   *
   * Tested against `authFor` rather than through SELF.fetch because bindings
   * are fixed when the runtime starts: mutating `env` does not reach the
   * Worker that SELF.fetch dispatches to. `authFor` is where the switch lives,
   * so this is the narrower and more honest target -- and the ON position is
   * already covered end-to-end by the cases above.
   */
  function signUpRequest() {
    return new Request('http://x/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'nope@example.test', password: 'x'.repeat(20), name: 'nope' }),
    })
  }

  it('refuses a password sign-up and creates nobody', async () => {
    const production = { ...env, AUTH_TEST_CREDENTIALS: undefined } as unknown as Env
    const res = await authFor(production).handler(signUpRequest())

    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM user WHERE email = 'nope@example.test'").first<{ n: number }>()
    expect(row?.n).toBe(0)
  })

  it('accepts the same request when the switch is on, so the case is not vacuous', async () => {
    const res = await authFor(env as unknown as Env).handler(signUpRequest())
    expect(res.status).toBeLessThan(400)
  })
})

describe('Google on a preview, through the stable preview host', () => {
  /**
   * Google refuses any redirect URI it was not told about, and every branch
   * preview has a host of its own. So a branch asks Google to come back to the
   * ONE registered preview host, which hands the profile back encrypted.
   * See ADR-0036. Through `authFor` for the same reason as the switch above.
   */
  const STABLE = 'https://stable-preview.example'
  const BRANCH = 'https://some-branch-preview.example'
  const google = { GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'client-secret' }

  function preview(): Env {
    return { ...env, ...google, BETTER_AUTH_URL: '', OAUTH_PROXY_URL: STABLE } as unknown as Env
  }

  async function redirectURI(e: Env, origin: string): Promise<string | null> {
    const res = await authFor(e, origin).handler(
      new Request(`${origin}/api/auth/sign-in/social`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ provider: 'google', callbackURL: `${origin}/` }),
      }),
    )
    expect(res.status).toBe(200)
    const { url } = (await res.json()) as { url: string }
    return new URL(url).searchParams.get('redirect_uri')
  }

  it('asks Google for the stable host callback from a branch host', async () => {
    expect(await redirectURI(preview(), BRANCH)).toBe(`${STABLE}/api/auth/callback/google`)
  })

  it('lets the stable host sign in for itself, without a proxy', async () => {
    expect(await redirectURI(preview(), STABLE)).toBe(`${STABLE}/api/auth/callback/google`)
  })

  it('leaves production on its own pinned callback', async () => {
    const production = {
      ...env,
      ...google,
      BETTER_AUTH_URL: 'https://recherche-maison.com',
      OAUTH_PROXY_URL: undefined,
      AUTH_TEST_CREDENTIALS: undefined,
    } as unknown as Env
    expect(await redirectURI(production, 'https://recherche-maison.com')).toBe(
      'https://recherche-maison.com/api/auth/callback/google',
    )
  })

  it('refuses a forged hand-back and sets no session', async () => {
    const res = await authFor(preview(), BRANCH).handler(
      new Request(
        `${BRANCH}/api/auth/oauth-proxy-callback?callbackURL=${encodeURIComponent(`${BRANCH}/`)}&profile=forged`,
      ),
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toMatch(/error/)
    expect(res.headers.get('set-cookie') ?? '').not.toMatch(/session_token/)
  })
})
