import { SELF } from 'cloudflare:test'

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
