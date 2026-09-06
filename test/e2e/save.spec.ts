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
  await expect(page.getByText('conso_5_usages_ef', { exact: false }).first()).toBeVisible()
})

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
