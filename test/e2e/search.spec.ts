import { expect, test, type Page } from '@playwright/test'
import { signUpViaApi, uniqueEmail } from './helpers'

/**
 * The product's whole reason to exist, through the browser.
 *
 * Every test signs in first. Since ADR-0012 the search form is not rendered
 * without a session and the Parquet answers 401 without one, so a signed-out
 * search would be testing the gate rather than the search.
 *
 * The fixture is 800 real certificates across départements 09 and 48, exported
 * by ademe/export_parquet.py and served from a second origin with Range support
 * -- the same shape as R2. `test/e2e/global-setup.ts` refuses to start unless
 * that server answers 206, because a server that ignores Range makes DuckDB
 * fail with a message about anything but ranges.
 */

// A real certificate from the fixture. Its facts are what an advert would
// publish; its address is what the advert withholds and this product finds.
const TARGET = {
  numero: '2107E0132696Z',
  codePostal: '09000',
  commune: 'Foix',
  address: 'Quartier de la Gare',
  classe: 'E',
  surface: '176',
}

test('finds a certificate from the facts a listing publishes', async ({ page }) => {
  await signUpViaApi(page, uniqueEmail('search'))
  await page.goto('/')

  await page.getByLabel('Code postal').fill(TARGET.codePostal)
  await page.getByLabel('Classe énergie').selectOption(TARGET.classe)
  await page.getByLabel('Surface (m²)').fill(TARGET.surface)
  await page.getByRole('button', { name: 'Rechercher' }).click()

  // DuckDB-WASM initialises on the first search, so this is the slow one.
  await expect(page.getByText(TARGET.address)).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText(TARGET.commune).first()).toBeVisible()
})

test('one letter of difference excludes it', async ({ page }) => {
  /**
   * The non-vacuity proof for the test above. Without it, a search that
   * returned every row in the partition would pass just as well -- the address
   * would still be on the page.
   */
  await signUpViaApi(page, uniqueEmail('search-excl'))
  await page.goto('/')

  await page.getByLabel('Code postal').fill(TARGET.codePostal)
  await page.getByLabel('Classe énergie').selectOption('D') // was E
  await page.getByLabel('Surface (m²)').fill(TARGET.surface)
  await page.getByRole('button', { name: 'Rechercher' }).click()

  // Wait on the results region rather than on its wording. Matching the copy
  // coupled this to a sentence that later changed, and the fixture hid it: 400
  // rows returned nothing, so the "Aucun certificat" branch always matched.
  // Against the real 31,157-row partition the search returns hits and the
  // wording is different, so the waiter timed out on a page that was correct.
  await expect(
    page.locator('.count').or(page.getByText('Aucun certificat')),
  ).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText(TARGET.address)).toHaveCount(0)
})

test('a result links to Google Maps at real coordinates', async ({ page }) => {
  await signUpViaApi(page, uniqueEmail('search-map'))
  await page.goto('/')

  await page.getByLabel('Code postal').fill(TARGET.codePostal)
  await page.getByLabel('Classe énergie').selectOption(TARGET.classe)
  await page.getByLabel('Surface (m²)').fill(TARGET.surface)
  await page.getByRole('button', { name: 'Rechercher' }).click()

  const map = page.getByRole('link', { name: 'Voir sur Google Maps' }).first()
  await expect(map).toBeVisible({ timeout: 60_000 })

  // 42.9N 1.6E is Ariège. Asserting the actual place, not merely that a link
  // exists: ADEME's own coordinates put overseas certificates in Norway, and a
  // link to Norway is still a link (ADR-0011).
  const url = new URL((await map.getAttribute('href'))!)
  expect(url.host).toBe('www.google.com')
  const [lat, lon] = (url.searchParams.get('query') ?? '').split(',').map(Number)
  expect(lat).toBeGreaterThan(42.5)
  expect(lat).toBeLessThan(43.5)
  expect(lon).toBeGreaterThan(1)
  expect(lon).toBeLessThan(2.5)
})

// A transparent 1×1 PNG, served in place of every map tile.
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

/** TARGET on its exact day of issue. */
async function searchTarget(page: Page): Promise<{ tiles: number }> {
  // Tiles are a third party's bytes: the suite must neither depend on IGN
  // being up nor spend its fair use. The markers are SVG and need no tile.
  const served = { tiles: 0 }
  await page.route(/^https:\/\/data\.geopf\.fr\/wmts/, (route) => {
    served.tiles++
    return route.fulfill({ contentType: 'image/png', body: PIXEL })
  })
  await page.goto('/')
  await page.getByLabel('Code postal').fill(TARGET.codePostal)
  await page.getByLabel('Classe énergie').selectOption(TARGET.classe)
  await page.getByLabel('Du', { exact: true }).fill('2021-08-03')
  await page.getByLabel('Au', { exact: true }).fill('2021-08-03')
  await page.getByRole('button', { name: 'Rechercher' }).click()
  await expect(page.getByRole('link', { name: TARGET.address })).toBeVisible({ timeout: 60_000 })
  return served
}

test('the results are on a map, one marker each, opening the record', async ({ page }) => {
  await signUpViaApi(page, uniqueEmail('search-leaflet'))
  const served = await searchTarget(page)

  await expect(page.locator('.results-map.leaflet-container')).toBeVisible()
  // The basemap is asked of the provider the stub stands in for. Were the tile
  // URL to drift, the stub would match nothing and CI would reach the network.
  await expect.poll(() => served.tiles).toBeGreaterThan(0)
  const links = await page.getByRole('link', { name: 'Voir sur Google Maps' }).count()
  expect(links).toBeGreaterThan(0)
  const markers = page.locator('.results-map path.leaflet-interactive')
  await expect(markers).toHaveCount(links)

  await markers.first().click()
  const popup = page.locator('.leaflet-popup-content a')
  await expect(popup).toContainText(TARGET.address)
  await expect(popup).toHaveAttribute('href', `#/existant/09/${TARGET.numero}`)
})

test('back to the search keeps the form and the results', async ({ page }) => {
  await signUpViaApi(page, uniqueEmail('search-back'))
  await searchTarget(page)

  await page.getByRole('link', { name: TARGET.address }).click()
  await expect(page.getByRole('heading', { name: TARGET.address })).toBeVisible({ timeout: 30_000 })
  // The form's own input: the detail page has a "Code postal" field too.
  const cp = page.locator('form.search #cp')
  await expect(cp).toBeHidden()

  await page.getByRole('link', { name: 'Retour à la recherche' }).click()
  // A remounted search shows an empty form: what was typed is the proof the
  // results were kept rather than fetched again.
  await expect(cp).toHaveValue(TARGET.codePostal)
  await expect(page.getByRole('link', { name: TARGET.address })).toBeVisible({ timeout: 2_000 })
  await expect(page.locator('.results-map path.leaflet-interactive').first()).toBeVisible()
})

test('the map sits beside the list on a desktop and above it on a phone', async ({ page }) => {
  await signUpViaApi(page, uniqueEmail('search-layout'))
  await page.setViewportSize({ width: 1280, height: 900 })
  await searchTarget(page)

  const map = page.locator('.results-map')
  const hit = page.locator('.hit').first()
  await expect(map).toBeVisible()
  let m = (await map.boundingBox())!
  let h = (await hit.boundingBox())!
  expect(m.x).toBeGreaterThanOrEqual(h.x + h.width)

  await page.setViewportSize({ width: 390, height: 844 })
  await expect.poll(async () => (await map.boundingBox())?.width ?? 0).toBeLessThan(390)
  m = (await map.boundingBox())!
  h = (await hit.boundingBox())!
  expect(m.y + m.height).toBeLessThanOrEqual(h.y)
  expect(m.height).toBeGreaterThan(200)
})

test('the exact day of the diagnostic finds it', async ({ page }) => {
  await signUpViaApi(page, uniqueEmail('search-day'))
  await page.goto('/')

  await page.getByLabel('Code postal').fill(TARGET.codePostal)
  await page.getByLabel('Classe énergie').selectOption(TARGET.classe)
  // Issued 2021-08-03. A month would have matched the whole of August.
  await page.getByLabel('Du', { exact: true }).fill('2021-08-03')
  await page.getByLabel('Au', { exact: true }).fill('2021-08-03')
  await page.getByRole('button', { name: 'Rechercher' }).click()

  await expect(page.getByText(TARGET.address)).toBeVisible({ timeout: 60_000 })
})

test('the day after excludes it', async ({ page }) => {
  // The non-vacuity proof for the day range: same search, one day later.
  await signUpViaApi(page, uniqueEmail('search-day-excl'))
  await page.goto('/')

  await page.getByLabel('Code postal').fill(TARGET.codePostal)
  await page.getByLabel('Classe énergie').selectOption(TARGET.classe)
  await page.getByLabel('Du', { exact: true }).fill('2021-08-04')
  await page.getByRole('button', { name: 'Rechercher' }).click()

  await expect(
    page.locator('.count').or(page.getByText('Aucun certificat')),
  ).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText(TARGET.address)).toHaveCount(0)
})

test('a surface written the French way still searches', async ({ page }) => {
  await signUpViaApi(page, uniqueEmail('search-comma'))
  await page.goto('/')

  await page.getByLabel('Code postal').fill(TARGET.codePostal)
  await page.getByLabel('Classe énergie').selectOption(TARGET.classe)
  await page.getByLabel('Surface (m²)').fill('176,4')
  await page.getByRole('button', { name: 'Rechercher' }).click()

  await expect(page.getByText(TARGET.address)).toBeVisible({ timeout: 60_000 })
})

test('a commune needs a département, and then finds it', async ({ page }) => {
  await signUpViaApi(page, uniqueEmail('search-commune'))
  await page.goto('/')

  await page.getByLabel('Commune').fill(TARGET.commune)
  await page.getByLabel('Classe énergie').selectOption(TARGET.classe)
  // Alone, a commune would read every partition in the country.
  await expect(page.getByRole('button', { name: 'Rechercher' })).toBeDisabled()

  await page.getByLabel('Département').selectOption('09')
  await page.getByRole('button', { name: 'Rechercher' }).click()
  await expect(page.getByText(TARGET.address)).toBeVisible({ timeout: 60_000 })
})

// One real record per other source, all in Ariège: printed by
// `scripts/build-e2e-fixture.py --from-published`.
const OTHERS = [
  { source: 'neuf', tab: 'Logement neuf', key: '2109N0084499R', codePostal: '09100',
    classe: 'A', day: '2021-07-06', address: '5 Lieu Dit Jouandou' },
  { source: 'tertiaire', tab: 'Tertiaire', key: '2109T0155160Q', codePostal: '09100',
    classe: 'C', day: '2021-08-08', address: '11 Rue Taillancier' },
  { source: 'audit', tab: 'Audit énergétique', key: 'abacf936-8b57-46a1-b920-fc072cb29e7e',
    codePostal: '09400', classe: 'F', day: '2023-09-05', address: '20 Rue du Barry' },
] as const

for (const t of OTHERS) {
  test(`finds a ${t.tab} record and opens it from its own tree`, async ({ page }) => {
    await signUpViaApi(page, uniqueEmail(`search-${t.source}`))
    await page.goto('/')

    await page.getByRole('radio', { name: t.tab }).check()
    await page.getByLabel('Code postal').fill(t.codePostal)
    await page.getByLabel('Classe énergie').selectOption(t.classe)
    await page.getByLabel('Du', { exact: true }).fill(t.day)
    await page.getByLabel('Au', { exact: true }).fill(t.day)
    await page.getByRole('button', { name: 'Rechercher' }).click()

    // The link names the source and the partition, so the detail reads one
    // known file of the right tree.
    const link = page.locator(`a[href="#/${t.source}/09/${t.key}"]`)
    await expect(link).toBeVisible({ timeout: 60_000 })
    await link.click()
    await expect(page.getByRole('heading', { name: new RegExp(t.address) })).toBeVisible({
      timeout: 30_000,
    })
  })
}
