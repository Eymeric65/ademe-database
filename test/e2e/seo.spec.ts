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

/**
 * The Présentation is the best copy on the site and, as a hash route, it was
 * invisible: #/presentation never leaves the browser. /presentation is the
 * same sections at a real address, and this asserts the two things that make
 * it worth having -- it renders with no bundle, and its calls to action are
 * links, not buttons whose onClick nothing will ever run.
 */
test('the présentation renders at its own URL, with links rather than dead buttons', async ({
  page,
}) => {
  const res = await page.goto('/presentation')
  expect(res?.status()).toBe(200)

  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'Le diagnostic montre le logement',
  )
  await expect(page.locator('body')).toContainText('Ce que l’annonce ne dit pas')
  await expect(page.locator('body')).toContainText('Les limites, franchement')

  // The point of the signedIn branch: a <button onClick> is completely inert
  // here, and two dead buttons are worse than two links into the app.
  expect(await page.locator('.presentation button').count()).toBe(0)
  const hrefs = await page
    .locator('.presentation a.signin')
    .evaluateAll((els) => els.map((el) => (el as HTMLAnchorElement).href))
  expect(hrefs.length).toBe(2)
  // <base href="/"> is what turns the component's own "#/" into the app root
  // instead of a fragment of this very page.
  for (const href of hrefs) {
    const u = new URL(href)
    expect(`${u.pathname}${u.hash}`).toBe('/#/')
  }

  // Unlike the département pages, this one LINKS the app's stylesheet: the
  // pres-* classes live in src/index.css and are not going to be inlined.
  const css = await page.locator('link[rel=stylesheet]').getAttribute('href')
  expect(css).toMatch(/^\/assets\/.+\.css$/)
  const sheet = await page.request.get(css as string)
  expect(sheet.status()).toBe(200)
  expect(await sheet.text()).toContain('.pres-hero')

  // Zero JavaScript: not one script tag of any kind.
  expect(await page.locator('script').count()).toBe(0)

  await expect(page.locator('link[rel=canonical]')).toHaveAttribute(
    'href',
    'https://recherche-maison.com/presentation',
  )
})

test('the sitemap carries the présentation', async ({ page }) => {
  const res = await page.request.get('/sitemap.xml')
  expect(res.status()).toBe(200)
  expect(await res.text()).toContain('<loc>https://recherche-maison.com/presentation</loc>')
})
