import { expect, test } from '@playwright/test'

/**
 * The product's whole reason to exist, through the browser.
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

test('a result links to the map at real coordinates', async ({ page }) => {
  await page.goto('/')

  await page.getByLabel('Code postal').fill(TARGET.codePostal)
  await page.getByLabel('Classe énergie').selectOption(TARGET.classe)
  await page.getByLabel('Surface (m²)').fill(TARGET.surface)
  await page.getByRole('button', { name: 'Rechercher' }).click()

  const map = page.getByRole('link', { name: 'Voir sur la carte' }).first()
  await expect(map).toBeVisible({ timeout: 60_000 })

  // 42.9N 1.6E is Ariège. Asserting the actual place, not merely that a link
  // exists: ADEME's own coordinates put overseas certificates in Norway, and a
  // link to Norway is still a link (ADR-0011).
  const href = await map.getAttribute('href')
  const lat = Number(new URL(href!).searchParams.get('mlat'))
  const lon = Number(new URL(href!).searchParams.get('mlon'))
  expect(lat).toBeGreaterThan(42.5)
  expect(lat).toBeLessThan(43.5)
  expect(lon).toBeGreaterThan(1)
  expect(lon).toBeLessThan(2.5)
})
