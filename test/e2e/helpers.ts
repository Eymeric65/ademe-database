import { execFileSync } from 'node:child_process'
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

/**
 * Make an account paid the one way there is: an UPDATE on D1 (ADR-0038).
 *
 * Against the preview D1 `wrangler dev --env preview` reads, locally -- or the
 * deployed preview's, remotely, when E2E_BASE_URL points at one. Reads the
 * plan back through /api/me, so a command that updated nothing fails here
 * rather than as a missing row three screens later. Call it before the page
 * loads: the app reads the account once.
 */
export async function makePaid(page: Page, email: string): Promise<void> {
  if (!/^[a-z0-9-]+@example\.test$/.test(email)) throw new Error(`not a test account: ${email}`)
  execFileSync('npx', [
    'wrangler', 'd1', 'execute', 'ademe-app-preview', '--env', 'preview',
    process.env.E2E_BASE_URL ? '--remote' : '--local',
    '--command', `UPDATE user SET plan = 'paid', updated_at = unixepoch() WHERE email = '${email}'`,
  ], { stdio: 'pipe' })
  const me = (await (await page.request.get('/api/me')).json()) as { plan?: string }
  if (me.plan !== 'paid') throw new Error(`${email} is still ${me.plan} after the UPDATE`)
}

export function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`
}
