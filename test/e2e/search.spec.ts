import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makePaid, signUpViaApi, uniqueEmail } from './helpers'

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

/**
 * TARGET on its exact day of issue -- or, `wide`, every class-E certificate in
 * its postcode, enough markers to spread across the map.
 */
async function searchTarget(page: Page, { wide = false } = {}): Promise<{ tiles: number; zoom: number }> {
  // Tiles are a third party's bytes: the suite must neither depend on IGN
  // being up nor spend its fair use. The markers are SVG and need no tile.
  const served = { tiles: 0, zoom: 0 }
  await page.route(/^https:\/\/data\.geopf\.fr\/wmts/, (route) => {
    served.tiles++
    const z = Number(new URL(route.request().url()).searchParams.get('TILEMATRIX'))
    served.zoom = Math.max(served.zoom, z)
    return route.fulfill({ contentType: 'image/png', body: PIXEL })
  })
  await page.goto('/')
  await page.getByLabel('Code postal').fill(TARGET.codePostal)
  await page.getByLabel('Classe énergie').selectOption(TARGET.classe)
  if (!wide) {
    await page.getByLabel('Du', { exact: true }).fill('2021-08-03')
    await page.getByLabel('Au', { exact: true }).fill('2021-08-03')
  }
  await page.getByRole('button', { name: 'Rechercher' }).click()
  await expect(page.getByRole('link', { name: TARGET.address })).toBeVisible({ timeout: 60_000 })
  return served
}

/** How many markers are drawn inside the map's own box. */
async function markersInView(page: Page): Promise<[inside: number, total: number]> {
  return page.evaluate(() => {
    const box = document.querySelector('.results-map')!.getBoundingClientRect()
    const centres = [...document.querySelectorAll('.results-map path.leaflet-interactive')].map((p) => {
      const b = p.getBoundingClientRect()
      return [b.x + b.width / 2, b.y + b.height / 2] as const
    })
    const inside = centres.filter(
      ([x, y]) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom,
    )
    return [inside.length, centres.length] as [number, number]
  })
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

test('a map resized across the breakpoint keeps its tiles and markers inside it', async ({ page }) => {
  await signUpViaApi(page, uniqueEmail('search-resize'))
  await page.setViewportSize({ width: 1280, height: 900 })
  await searchTarget(page, { wide: true })
  // 17 class-E certificates in 09000, one of them RECENT: a free member's map
  // has no marker for it.
  await expect.poll(() => markersInView(page)).toEqual([16, 16])

  for (const width of [768, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    // TRAP: the map's layers are absolutely positioned. Were the map to lose
    // its positioning -- sticky on a desktop, static below the breakpoint --
    // they would lay out against <main> and paint over the search form,
    // unclipped, leaving the map itself empty.
    const pane = await page.evaluate(
      () => (document.querySelector('.results-map .leaflet-map-pane') as HTMLElement).offsetParent?.className ?? '',
    )
    expect(pane, `at ${width}px`).toContain('results-map')
    await expect.poll(() => markersInView(page), { message: `at ${width}px` }).toEqual([16, 16])
  }
})

test('the wheel over the map zooms it rather than scrolling the page', async ({ page }) => {
  await signUpViaApi(page, uniqueEmail('search-wheel'))
  await page.setViewportSize({ width: 1280, height: 900 })
  const served = await searchTarget(page)

  const map = page.locator('.results-map')
  await map.scrollIntoViewIfNeeded()
  await expect.poll(() => served.zoom).toBeGreaterThan(0)
  const zoom = served.zoom
  const scrolled = await page.evaluate(() => window.scrollY)
  // Upward, so a page that did take the wheel always has somewhere to go.
  expect(scrolled).toBeGreaterThan(0)

  const box = (await map.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, -400)

  await expect.poll(() => served.zoom).toBeGreaterThan(zoom)
  expect(await page.evaluate(() => window.scrollY)).toBe(scrolled)
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

// --- withdrawn certificates (ADR-0044) ---------------------------------------

// The fixture's one withdrawn certificate, in DEPTS[1]'s base tree: printed by
// `scripts/build-e2e-fixture.py --resplit`. Its partition carries the
// `withdrawn_on` column and 09's does not, which is the mixed-age tree the
// published one is during every weekly run.
const WITHDRAWN = {
  numero: '2148E0009724W',
  dept: '48',
  codePostal: '48100',
  classe: 'E',
  address: '1 Square des Cevennes 48100 Bourgs sur Colagne',
  on: '21/09/2026',
}

test('a withdrawn certificate says so instead of being a dead end', async ({ page }) => {
  await signUpViaApi(page, uniqueEmail('withdrawn-detail'))
  await page.goto(`/#/existant/${WITHDRAWN.dept}/${WITHDRAWN.numero}`)

  await expect(page.locator('.withdrawn')).toHaveText(
    `Ce DPE a été retiré du registre ADEME le ${WITHDRAWN.on}.`,
    { timeout: 60_000 },
  )
  // The record is still there: withdrawn is a tag on the row, not a deletion.
  await expect(page.getByRole('heading', { name: WITHDRAWN.address })).toBeVisible()
  // And the tag is not one of the raw facts: it is ours, not ADEME's, so it has
  // no column_meta entry and would render as an unlabelled row.
  await expect(page.locator('.fact[data-key="withdrawn_on"]')).toHaveCount(0)
})

test('a live certificate in the same partition says nothing of the sort', async ({ page }) => {
  /** The non-vacuity proof for the test above: without it, a notice rendered
   * unconditionally would pass just as well. */
  await signUpViaApi(page, uniqueEmail('withdrawn-live'))
  await page.goto('/')
  await page.getByLabel('Code postal').fill(WITHDRAWN.codePostal)
  await page.getByLabel('Classe énergie').selectOption(WITHDRAWN.classe)
  await page.getByRole('button', { name: 'Rechercher' }).click()

  const live = page.locator('.hit').filter({ hasNotText: WITHDRAWN.address }).first()
  await expect(live).toBeVisible({ timeout: 60_000 })
  await live.locator('.hit-address a').click()
  await expect(page.locator('.summary')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.withdrawn')).toHaveCount(0)
})

test('a search that returns a withdrawn certificate labels it', async ({ page }) => {
  await signUpViaApi(page, uniqueEmail('withdrawn-search'))
  await page.goto('/')
  await page.getByLabel('Code postal').fill(WITHDRAWN.codePostal)
  await page.getByLabel('Classe énergie').selectOption(WITHDRAWN.classe)
  await page.getByRole('button', { name: 'Rechercher' }).click()

  const hit = page.locator('.hit', { hasText: WITHDRAWN.address })
  await expect(hit).toBeVisible({ timeout: 60_000 })
  await expect(hit.locator('.hit-withdrawn')).toHaveText('Retiré du registre ADEME')
  await expect(page.locator('.hit-withdrawn')).toHaveCount(1)
})

test('a paid member searches a partition whose two files are of different ages', async ({ page }) => {
  /** The base file of 48 carries `withdrawn_on` and its recent file does not,
   * because only the partitions a run rewrites gain the column. A paid member
   * reads both in ONE scan (ADR-0039), which is a Binder Error unless the
   * query unions them by name. */
  const email = uniqueEmail('withdrawn-paid')
  await signUpViaApi(page, email)
  await makePaid(page, email)
  await page.goto('/')
  await page.getByLabel('Code postal').fill(WITHDRAWN.codePostal)
  await page.getByLabel('Classe énergie').selectOption(WITHDRAWN.classe)
  await page.getByRole('button', { name: 'Rechercher' }).click()

  await expect(page.locator('.count')).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('.error')).toHaveCount(0)
  await expect(page.locator('.hit', { hasText: WITHDRAWN.address })).toBeVisible()
})

// --- the last two months (ADR-0038, ADR-0039) --------------------------------

// The newest class-E certificate in TARGET's postcode, which the fixture's split
// put in the paid tree: printed by `scripts/build-e2e-fixture.py --resplit`.
const RECENT = {
  numero: '2609E2093061X',
  address: 'Résidence la Condamine 1 09000 Foix',
  day: '2026-08-06',
}

test('the fixture puts RECENT on the paid side of its own cutoff', () => {
  // The cutoff comes from the manifest the split wrote, never from today: the
  // fixture is frozen, the calendar is not.
  const m = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/v1/manifest.json'), 'utf8'),
  ) as { recent: { cutoff: string } }
  expect(RECENT.day >= m.recent.cutoff).toBe(true)
})

test('a free member is told how many newer certificates match, and shown none', async ({ page }) => {
  await signUpViaApi(page, uniqueEmail('recent-free'))
  await searchTarget(page, { wide: true })

  await expect(page.locator('.recent-locked')).toContainText(
    '1 certificat plus récent — passez au plan Découverte pour y accéder',
  )
  await expect(page.locator('.recent-locked-note a')).toHaveAttribute('href', '#/abonnement')
  await expect(page.locator('.map-recent-note')).toHaveText('1 certificat plus récent non affiché sur la carte')
  // The blurred rows are placeholders: nothing in them is the certificate.
  await expect(page.getByText(RECENT.address)).toHaveCount(0)
  await expect.poll(() => markersInView(page)).toEqual([16, 16])
})

test('a free member following a link to a recent certificate is told why it is not there', async ({ page }) => {
  await signUpViaApi(page, uniqueEmail('recent-free-detail'))
  await page.goto(`/#/existant/09/${RECENT.numero}`)

  await expect(page.getByText('Introuvable dans logement existant.')).toBeVisible({ timeout: 30_000 })
  await expect(
    page.getByText('Les certificats de moins de deux mois sont réservés au plan Découverte.'),
  ).toBeVisible()
})

test('a paid member gets the newest certificate first, and opens it', async ({ page }) => {
  const email = uniqueEmail('recent-paid')
  await signUpViaApi(page, email)
  await makePaid(page, email)
  await searchTarget(page, { wide: true })

  await expect(page.locator('.hit-address').first()).toHaveText(RECENT.address)
  await expect(page.locator('.recent-locked')).toHaveCount(0)
  await expect(page.locator('.map-recent-note')).toBeHidden()
  await expect.poll(() => markersInView(page)).toEqual([17, 17])

  await page.getByRole('link', { name: RECENT.address }).click()
  await expect(page.getByRole('heading', { name: RECENT.address })).toBeVisible({ timeout: 30_000 })
})

test('a paid member sees which certificates their plan gives them, in the list and on the page', async ({ page }) => {
  const email = uniqueEmail('recent-premium')
  await signUpViaApi(page, email)
  await makePaid(page, email)
  await searchTarget(page, { wide: true })

  // Only the paid tree's row carries the tab: the rest are free to everyone.
  const hit = page.locator('.hit', { hasText: RECENT.address })
  await expect(hit.locator('.premium')).toHaveText('Premium')
  await expect(page.locator('.hits .premium')).toHaveCount(1)

  await page.getByRole('link', { name: RECENT.address }).click()
  await expect(page.getByRole('heading', { name: RECENT.address })).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.eyebrow .premium')).toHaveText('Premium')
})

test('a free member sees no premium tab on what everyone gets', async ({ page }) => {
  await signUpViaApi(page, uniqueEmail('recent-premium-free'))
  await searchTarget(page, { wide: true })

  await expect(page.locator('.hit-address').first()).toBeVisible()
  await expect(page.locator('.premium')).toHaveCount(0)
})
