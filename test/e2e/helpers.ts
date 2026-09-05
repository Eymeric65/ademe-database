import type { Page } from '@playwright/test'

/**
 * Sign up through the API from inside the browser context, so the cookie lands
 * where the app will look for it.
 *
 * `page.request` shares the context's cookie jar; a plain fetch from Node would
 * not, and the test would then assert against a browser that is still signed
 * out. Only possible because AUTH_TEST_CREDENTIALS is set in dev and preview --
 * a Google round-trip cannot be automated (ADR-0008).
 */
export async function signUpViaApi(page: Page, email: string): Promise<void> {
  const res = await page.request.post('/api/auth/sign-up/email', {
    data: { email, password: 'correct-horse-battery', name: email.split('@')[0] },
  })
  if (!res.ok()) throw new Error(`sign-up failed: ${res.status()} ${await res.text()}`)
}

export function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`
}
