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
 *
 * This build has no bucket credentials, so it renders the committed sample:
 * Ariège and Haute-Garonne, with their own published numbers (ADR-0046). How
 * many pages a full aggregate produces is `test/unit/seo-sitemap.test.ts`'s
 * business; what a real Worker does with one of them is this file's.
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

  // The crawl path: every OTHER département the aggregate carries is one link
  // away -- here the sample's second one, Haute-Garonne.
  const others = await page.locator('a[href^="/departement/"]').evaluateAll((els) =>
    els.map((el) => el.getAttribute('href')),
  )
  expect(others).toEqual(['/departement/haute-garonne'])
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

/**
 * A département page reached from a search result used to have one way out: a
 * bare wordmark. The index at /departements links every page, and the app's
 * own masthead -- same classes, same stylesheet -- leads to it from all of them.
 */
test('the index of départements links every page, under the app’s masthead', async ({ page }) => {
  const res = await page.goto('/departements')
  expect(res?.status()).toBe(200)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Statistiques par département')

  const pages = await page.locator('a[href^="/departement/"]').evaluateAll((els) =>
    els.map((el) => el.getAttribute('href')),
  )
  expect(pages).toEqual(['/departement/ariege', '/departement/haute-garonne'])

  const menu = page.getByRole('navigation', { name: 'Principal' })
  await expect(menu.getByRole('link', { name: 'Statistiques' })).toHaveAttribute(
    'aria-current',
    'page',
  )
  // Styled by the app's stylesheet, not merely present: the masthead sticks.
  await expect(page.locator('header.masthead')).toHaveCSS('position', 'sticky')

  await page.getByRole('link', { name: '09 Ariège' }).click()
  await expect(page).toHaveURL(/\/departement\/ariege$/)
  await expect(page.locator('header.masthead')).toHaveCSS('position', 'sticky')
  await page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name: 'Statistiques' }).click()
  await expect(page).toHaveURL(/\/departements$/)
})

test('the terms of sale and the legal notice are one click from the présentation, with no script', async ({
  page,
}) => {
  await page.goto('/presentation')
  await page.getByRole('link', { name: 'Conditions générales de vente' }).click()
  await expect(page).toHaveURL(/\/cgv$/)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Conditions générales de vente')
  await expect(page.locator('body')).toContainText('5 € TTC par mois')
  await expect(page.locator('header.masthead')).toHaveCSS('position', 'sticky')
  expect(await page.locator('script').count()).toBe(0)

  // Exact: section 8 of the terms links « mentions légales » too.
  await page.getByRole('link', { name: 'Mentions légales', exact: true }).click()
  await expect(page).toHaveURL(/\/mentions-legales$/)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Mentions légales')
  await expect(page.locator('body')).toContainText('Cloudflare')
})

test('the sitemap carries the présentation', async ({ page }) => {
  const res = await page.request.get('/sitemap.xml')
  expect(res.status()).toBe(200)
  expect(await res.text()).toContain('<loc>https://recherche-maison.com/presentation</loc>')
})

/**
 * www on a PAGE, not an /api path. A request that matches a file in dist/ is
 * answered by ASSETS without ever reaching the Worker, so the redirect in
 * server/index.ts never ran for `/` -- people stayed on www, and every sign-in
 * they tried was refused by Better Auth as an untrusted callback, silently.
 * test/db/host.test.ts calls the Worker directly and cannot see this.
 */
for (const path of ['/', '/presentation', '/departement/ariege']) {
  test(`www sends ${path} to the apex`, async ({ request }) => {
    // Host is only ours to choose on the local wrangler dev; on a deployed
    // preview it would address some other zone entirely.
    test.skip(!!process.env.E2E_BASE_URL, 'Host override needs the local Worker')
    const res = await request.get(path, {
      headers: { Host: 'www.recherche-maison.com' },
      maxRedirects: 0,
    })
    expect(res.status()).toBe(301)
    const location = new URL(res.headers()['location'] ?? '')
    expect(location.host).toBe('recherche-maison.com')
    expect(location.pathname).toBe(path)
  })
}
