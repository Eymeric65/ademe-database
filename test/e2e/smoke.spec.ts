import { expect, test } from '@playwright/test'

/**
 * One browser, both halves of the origin.
 *
 * The heading proves the React build reached the browser through the ASSETS
 * binding. The second assertion proves the API is on the SAME origin -- and
 * that is the one that earns its place, because a broken API path still
 * renders a perfectly good page. Only the data is missing, and a screenshot
 * of the shell looks like success.
 */
test('the app renders and its API answers on the same origin', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'DPE' })).toBeVisible()

  const res = await page.request.get('/api/health')
  expect(res.status()).toBe(200)
  expect(await res.json()).toMatchObject({ ok: true })
})
