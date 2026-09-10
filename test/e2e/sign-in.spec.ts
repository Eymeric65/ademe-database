import { expect, test } from '@playwright/test'
import { signUpViaApi, uniqueEmail } from './helpers'

/**
 * The header, through the transport a person actually uses.
 *
 * A green D1 test and a broken screen are compatible states -- /api/me can
 * answer perfectly while nothing renders it. This is the test that would
 * notice.
 */
test('signed out, the header offers Google and hides the saved area', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Se connecter', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Enregistrés' })).toHaveCount(0)
})

test('signing in shows the account and reveals the saved area, and signing out undoes it', async ({
  page,
}) => {
  const email = uniqueEmail('shell')
  await page.goto('/')
  await signUpViaApi(page, email)
  await page.reload()

  await expect(page.getByText(email)).toBeVisible()
  await expect(page.getByRole('link', { name: 'Enregistrés' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Se connecter', exact: true })).toHaveCount(0)

  // Exercises POST /api/auth/sign-out through the real UI, not through the API.
  await page.getByRole('button', { name: 'Se déconnecter' }).click()

  await expect(page.getByRole('button', { name: 'Se connecter', exact: true })).toBeVisible()
  await expect(page.getByText(email)).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Enregistrés' })).toHaveCount(0)
})

test('the hash router shows the saved screen without a page load', async ({ page }) => {
  await signUpViaApi(page, uniqueEmail('router'))
  await page.goto('/')
  await page.getByRole('link', { name: 'Enregistrés' }).click()
  await expect(page).toHaveURL(/#\/saved$/)
  await expect(page.getByRole('heading', { name: 'Enregistrés' })).toBeVisible()
})
