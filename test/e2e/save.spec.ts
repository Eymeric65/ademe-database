import { expect, test } from '@playwright/test'
import { signUpViaApi, uniqueEmail } from './helpers'

/**
 * The detail view and the save flow, end to end.
 *
 * The last assertion is the point: PR4 proved cross-tenant isolation over HTTP,
 * and this proves the screen a person actually looks at agrees. A green D1 test
 * and a saved list that renders somebody else's rows are compatible states.
 */

const TARGET = {
  numero: '2107E0132696Z',
  codePostal: '09000',
  address: 'Quartier de la Gare',
  classe: 'E',
  surface: '176',
}

async function findTarget(page: import('@playwright/test').Page) {
  // Signed in first: since ADR-0012 there is no search form without a session.
  await page.goto('/')
  await page.getByLabel('Code postal').fill(TARGET.codePostal)
  await page.getByLabel('Classe énergie').selectOption(TARGET.classe)
  await page.getByLabel('Surface (m²)').fill(TARGET.surface)
  await page.getByRole('button', { name: 'Rechercher' }).click()
  await expect(page.getByText(TARGET.address)).toBeVisible({ timeout: 60_000 })
}

test('the detail view shows a column only the wide file has', async ({ page }) => {
  await signUpViaApi(page, uniqueEmail('detail'))
  await findTarget(page)
  await page.getByRole('link', { name: TARGET.address }).click()

  await expect(page.getByRole('heading', { name: TARGET.address })).toBeVisible({
    timeout: 30_000,
  })
  // conso_5_usages_ef is NOT in the 17-column search index. Seeing it is the
  // proof the detail read went to the wide file rather than reusing the row
  // already in memory -- which would look identical for every other field.
  const fact = page.locator('.fact[data-key="conso_5_usages_ef"]')
  await expect(fact).toBeVisible()
  // Named in French, in a unit, and able to say what it is for.
  await expect(fact.locator('dt')).toContainText('Consommation totale')
  await expect(fact.locator('dd').first()).toHaveText(/Wh\/an$/)
  await fact.getByRole('button', { name: 'Explication' }).click()
  await expect(fact.getByText(/cinq usages/)).toBeVisible()
})

test('the detail view shows no column the file path invented', async ({ page }) => {
  await signUpViaApi(page, uniqueEmail('detail-dept'))
  await findTarget(page)
  await page.getByRole('link', { name: TARGET.address }).click()

  // The wide file's own column first, so the count below runs on a loaded
  // detail and not on an empty page, where it would pass for nothing.
  await expect(page.locator('.fact[data-key="conso_5_usages_ef"]')).toBeVisible({
    timeout: 30_000,
  })
  // `dept` is not a column of the wide file. DuckDB derives it from the
  // `dept=09/` in the path unless told not to, and the detail lists every key.
  await expect(page.locator('.fact[data-key="dept"]')).toHaveCount(0)
})

test('a certificate opened by its bare numero is found, and dated by the day', async ({ page }) => {
  await signUpViaApi(page, uniqueEmail('detail-legacy'))
  // The first links and every row saved before sources carry no partition,
  // and this numero's own digits say '07', not '09': the exceptions index.
  await page.goto(`/#/dpe/${TARGET.numero}`)
  await expect(page.getByRole('heading', { name: TARGET.address })).toBeVisible({
    timeout: 60_000,
  })
  await expect(page.getByText('03/08/2021').first()).toBeVisible()
  // No id_rnb, and the crosswalk has no row for it.
  await expect(page.getByText(/Aucun bâtiment/)).toBeVisible({ timeout: 30_000 })
})

test('a linked certificate shows its building and the parcel under it', async ({ page }) => {
  await signUpViaApi(page, uniqueEmail('detail-rnb'))
  await page.goto('/#/existant/09/2109E0005780R')
  // Inside the panel: the id also appears among the raw facts, as `id_rnb`.
  const panel = page.locator('.building')
  await expect(panel.getByText('3MG28QE2BRPX')).toBeVisible({ timeout: 60_000 })
  await expect(panel.getByText('09265000AK0063')).toBeVisible()
  await expect(panel.getByText('667 m²')).toBeVisible()
})

test('an address match says how many buildings it could be', async ({ page }) => {
  await signUpViaApi(page, uniqueEmail('detail-ban'))
  await page.goto('/#/existant/09/2100E0188987T')
  await expect(page.getByText(/3 bâtiments possibles/).first()).toBeVisible({ timeout: 60_000 })
})

test('a new-build certificate reaches its building through its own id_rnb', async ({ page }) => {
  await signUpViaApi(page, uniqueEmail('detail-neuf'))
  await page.goto('/#/neuf/09/2109N0084499R')
  // The parcel comes from RNB's own plots: no crosswalk for this source yet.
  const panel = page.locator('.building')
  await expect(panel.getByText('6X7KNTQTK36K')).toBeVisible({ timeout: 60_000 })
  await expect(panel.getByText('09177000ZC0189')).toBeVisible({ timeout: 30_000 })
})

for (const t of [
  { source: 'neuf', key: '2109N0084499R', address: /Madière/ },
  // An audit step's key is a UUID: only the saved partition finds it again.
  { source: 'audit', key: 'abacf936-8b57-46a1-b920-fc072cb29e7e', address: /Rue du Barry/ },
]) {
  test(`a saved ${t.source} record reopens in its own tree`, async ({ page }) => {
    await signUpViaApi(page, uniqueEmail(`save-${t.source}`))
    await page.goto(`/#/${t.source}/09/${t.key}`)
    await page.getByRole('button', { name: 'Enregistrer' }).click({ timeout: 60_000 })
    await expect(page.getByRole('button', { name: 'Retirer' })).toBeVisible()

    await page.getByRole('link', { name: 'Enregistrés' }).click()
    await page.getByRole('link', { name: t.key }).click()
    await expect(page).toHaveURL(new RegExp(`#/${t.source}/09/${t.key}$`))
    await expect(page.getByRole('heading', { name: t.address })).toBeVisible({ timeout: 60_000 })
  })
}

test('a signed-in user saves a certificate and finds it again', async ({ page }) => {
  await signUpViaApi(page, uniqueEmail('save'))
  await findTarget(page)
  await page.getByRole('link', { name: TARGET.address }).click()
  await page.getByRole('button', { name: 'Enregistrer' }).click()

  await expect(page.getByRole('button', { name: 'Retirer' })).toBeVisible()

  await page.getByRole('link', { name: 'Enregistrés' }).click()
  // By role, not by text: the numero also appears twice on the detail view, so
  // a bare text locator is ambiguous while the navigation is still settling.
  await expect(page.getByRole('link', { name: TARGET.numero })).toBeVisible()
})

test('a second user in a fresh browser sees an empty saved list', async ({ browser }) => {
  /**
   * The UI-level cross-tenant probe. A separate browser context, so a separate
   * cookie jar: nothing is shared but the database.
   */
  const first = await browser.newContext()
  const a = await first.newPage()
  await signUpViaApi(a, uniqueEmail('tenant-a'))
  await findTarget(a)
  await a.getByRole('link', { name: TARGET.address }).click()
  await a.getByRole('button', { name: 'Enregistrer' }).click()
  await expect(a.getByRole('button', { name: 'Retirer' })).toBeVisible()

  const second = await browser.newContext()
  const b = await second.newPage()
  await signUpViaApi(b, uniqueEmail('tenant-b'))
  await b.goto('/#/saved')
  await expect(b.getByText(/Aucun certificat enregistré/)).toBeVisible()
  await expect(b.getByRole('link', { name: TARGET.numero })).toHaveCount(0)

  // A still has it, so the empty list above is isolation and not a wipe.
  await a.goto('/#/saved')
  await expect(a.getByRole('link', { name: TARGET.numero })).toBeVisible()

  await first.close()
  await second.close()
})
