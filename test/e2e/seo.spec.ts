import { expect, test } from '@playwright/test'

/**
 * The département pages are the only URLs a crawler can index, and a crawler
 * that runs no JavaScript is the one they exist for. So this is the one spec
 * in the suite with javaScriptEnabled: false -- with it on, a broken static
 * page would still be rescued by the React bundle and the test would pass.
 *
 * It is also the only proof that ASSETS resolves the extensionless path:
 * wrangler.jsonc sets no html_handling, so the default auto-trailing-slash is
 * what maps /departement/ariege to dist/departement/ariege.html. Nothing but a
 * running Worker can settle that.
 */
test.use({ javaScriptEnabled: false })

test('a département page renders its statistics without any JavaScript', async ({ page }) => {
  const res = await page.goto('/departement/ariege')
  expect(res?.status()).toBe(200)

  await expect(page.getByRole('heading', { level: 1 })).toContainText('Ariège')
  await expect(page.locator('body')).toContainText('Passoires thermiques')
  // The consumption median: a number that can only have come from the aggregate.
  await expect(page.locator('body')).toContainText('203,7')

  // No bundle: the page must carry nothing a crawler would have to execute.
  const scripts = await page.locator('script').evaluateAll((els) =>
    els.map((el) => `${el.getAttribute('src') ?? ''}|${el.getAttribute('type') ?? ''}`),
  )
  expect(scripts.every((s) => s === '|application/ld+json')).toBe(true)

  // The crawl path: every other département is one link away.
  expect(await page.locator('a[href^="/departement/"]').count()).toBe(100)
})

test('the sitemap is served and points at pages that exist', async ({ page }) => {
  const res = await page.request.get('/sitemap.xml')
  expect(res.status()).toBe(200)
  const xml = await res.text()
  expect(xml).toContain('<loc>https://recherche-maison.com/departement/ariege</loc>')

  const one = await page.request.get('/departement/haute-garonne')
  expect(one.status()).toBe(200)
})
