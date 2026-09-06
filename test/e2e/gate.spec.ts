import { expect, test } from '@playwright/test'
import { signUpViaApi, uniqueEmail } from './helpers'

/**
 * The certificates require a session, and the proof is at the transport.
 *
 * Hiding the form is the part a person sees; it is not the part that holds.
 * Until this PR the Parquet sat on a public R2 domain the browser read
 * directly, so a UI-only gate was a suggestion anybody could step around with
 * one `curl`. The assertion this file exists for is the second test: the bytes
 * themselves answer 401 without a caller.
 *
 * The engine is deliberately NOT gated. It has to load before the app can tell
 * anyone to sign in, and it is an open-source binary rather than data.
 */

const TARGET = { numero: '2107E0132696Z' }

test('the search form is not there to be used signed out', async ({ page }) => {
  await page.goto('/')

  // The in-page CTA, not the masthead's: waiting on something the gate itself
  // renders is what stops this passing while the page is merely still loading.
  await expect(page.getByRole('button', { name: 'Se connecter et chercher' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Rechercher' })).toHaveCount(0)
  await expect(page.getByLabel('Code postal')).toHaveCount(0)
})

test('the certificates answer 401 without a session', async ({ page }) => {
  /**
   * The load-bearing one. A gate that only hid the form would pass the test
   * above and fail this, which is the whole distinction being drawn.
   */
  const res = await page.request.get('/data/v1/manifest.json')
  expect(res.status()).toBe(401)
})

test('a signed-in caller reads them, with ranges intact', async ({ page }) => {
  await signUpViaApi(page, uniqueEmail('gate'))

  const whole = await page.request.get('/data/v1/manifest.json')
  expect(whole.status()).toBe(200)

  // Range is not a nicety. DuckDB reads a Parquet footer, then the row groups
  // it needs; a proxy that answered 200 with the whole file to every request
  // would work and would download the entire partition every time.
  const part = await page.request.get('/data/v1/manifest.json', {
    headers: { Range: 'bytes=0-99' },
  })
  expect(part.status()).toBe(206)
  expect(part.headers()['content-range']).toMatch(/^bytes 0-99\/\d+$/)
  expect((await part.body()).byteLength).toBe(100)
})

test('the engine stays reachable signed out, and still says application/wasm', async ({ page }) => {
  const res = await page.request.head('/data/vendor/duckdb/duckdb-eh.wasm')
  expect(res.status()).toBe(200)
  // WebAssembly.compileStreaming refuses anything else, naming neither the file
  // nor the header. This has already cost one debugging session.
  expect(res.headers()['content-type']).toBe('application/wasm')
})

test('a certificate link shared with a stranger shows the gate', async ({ page }) => {
  await page.goto(`/#/dpe/${TARGET.numero}`)

  // Wait on the gate before asserting an absence. Without this the test passes
  // against an ungated page that simply has not finished fetching yet -- which
  // is exactly how it behaved before the gate existed.
  await expect(page.getByRole('button', { name: 'Se connecter et consulter' })).toBeVisible()
  // conso_5_usages_ef lives only in the wide file. Its absence is the proof
  // nothing was fetched, rather than fetched and not rendered.
  await expect(page.getByText('conso_5_usages_ef')).toHaveCount(0)
})
