import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { signUpViaApi, uniqueEmail } from './helpers'

/**
 * What a search and a detail cost, measured through the browser that pays.
 *
 * The guard is that no wide or reference file is ever fetched whole. DuckDB
 * falls back to a plain GET of the entire file when it doubts the server's
 * ranges, and nothing on screen changes -- the national tree made that 146 MB
 * for one Paris certificate (ADR-0035). A small search file IS fetched whole,
 * on purpose and once. Against a deployed preview (E2E_BASE_URL) the same
 * specs read the national tree and print the numbers the ADR records.
 */

const NATIONAL = Boolean(process.env.E2E_BASE_URL)

// Paris's search file is 15 MB, over the whole-fetch limit, so it is read by
// ranges; the fixture has nothing that large.
const LARGE = NATIONAL
  ? { codePostal: '75011', classe: 'D', surface: '45', address: /Paris/ }
  : { codePostal: '09000', classe: 'E', surface: '176', address: /Quartier de la Gare/ }

// Ariège's is under a megabyte nationally, and a few kB in the fixture.
const SMALL = { codePostal: '09000', classe: 'E', surface: '176', address: /Quartier de la Gare/ }

const DETAIL = NATIONAL
  ? { numero: '2475E2178628K', dept: '75', address: '3 Rue Mercoeur 75011 Paris' }
  : { numero: '2107E0132696Z', dept: '09', address: 'Quartier de la Gare' }

type Tally = {
  requests: number
  /** GETs of a wide or reference Parquet file answered 200: the whole file. */
  full: number
  bytes: number
  byPath: Record<string, number>
  log: string[]
}

function track(page: Page): Tally {
  const tally: Tally = { requests: 0, full: 0, bytes: 0, byPath: {}, log: [] }
  page.on('response', (res) => {
    const req = res.request()
    const url = new URL(req.url())
    if (!url.pathname.startsWith('/data/v1/')) return
    tally.requests += 1
    const kind = url.pathname.replace(/^\/data\/v1\//, '').replace(/dept=[^/]+\/.*/, 'dept=*')
    tally.byPath[kind] = (tally.byPath[kind] ?? 0) + 1
    const whole = req.method() === 'GET' && res.status() === 200
    if (whole && url.pathname.endsWith('.parquet') && !url.pathname.includes('/search/')) {
      tally.full += 1
    }
    void Promise.all([req.sizes(), req.allHeaders()]).then(([s, headers]) => {
      tally.bytes += s.responseBodySize
      tally.log.push(
        `${req.method()} ${url.pathname.slice('/data/v1/'.length)} ${headers.range ?? '-'}` +
          ` -> ${res.status()} ${s.responseBodySize}`,
      )
    })
  })
  return tally
}

async function report(info: TestInfo, name: string, tally: Tally, ms: number) {
  const line = { scenario: name, national: NATIONAL, ms, ...tally }
  console.log(JSON.stringify(line))
  await info.attach(name, { body: JSON.stringify(line, null, 2), contentType: 'application/json' })
}

async function searchFor(page: Page, info: TestInfo, name: string, t: typeof SMALL) {
  await signUpViaApi(page, uniqueEmail(`perf-${name}`))
  await page.goto('/')
  // The engine is fetched once per browser and is not the data plane's cost.
  const tally = track(page)
  await page.getByLabel('Code postal').fill(t.codePostal)
  await page.getByLabel('Classe énergie').selectOption(t.classe)
  await page.getByLabel('Surface (m²)').fill(t.surface)
  const start = Date.now()
  await page.getByRole('button', { name: 'Rechercher' }).click()
  // Inside the results: the Département select also says "75 Paris".
  await expect(page.locator('.hit-address').getByText(t.address).first()).toBeVisible({
    timeout: 80_000,
  })
  await report(info, name, tally, Date.now() - start)
  return tally
}

test('a search in a small département fetches its partition once', async ({ page }, info) => {
  const tally = await searchFor(page, info, 'search-small', SMALL)
  expect(tally.byPath['search/dept=*'], tally.log.join('\n')).toBe(1)
})

test('a search in a large département reads ranges, never a whole file', async ({ page }, info) => {
  const tally = await searchFor(page, info, 'search-large', LARGE)
  expect(tally.full, tally.log.join('\n')).toBe(0)
})

test('a detail opened with its partition looks nothing up', async ({ page }, info) => {
  await signUpViaApi(page, uniqueEmail('perf-detail'))
  const tally = track(page)
  const start = Date.now()
  await page.goto(`/#/existant/${DETAIL.dept}/${DETAIL.numero}`)
  await expect(page.getByRole('heading', { name: DETAIL.address })).toBeVisible({
    timeout: 80_000,
  })
  await report(info, 'detail', tally, Date.now() - start)
  // A result link carries the partition, so the exceptions index is not read.
  expect(tally.byPath['index/numero-exceptions.parquet'] ?? 0).toBe(0)
  expect(tally.full, tally.log.join('\n')).toBe(0)
})

test('what one gated request costs over an ungated one', async ({ page }, info) => {
  await signUpViaApi(page, uniqueEmail('perf-gate'))
  const time = async (path: string) => {
    const samples: number[] = []
    for (let i = 0; i < 20; i++) {
      const t = Date.now()
      const res = await page.request.get(path, { headers: { Range: 'bytes=0-99' } })
      expect(res.status()).toBe(206)
      samples.push(Date.now() - t)
    }
    samples.sort((a, b) => a - b)
    return samples[10] as number
  }
  const gated = await time('/data/v1/manifest.json')
  const open = await time('/data/vendor/duckdb/duckdb-eh.wasm')
  const line = { scenario: 'gate', national: NATIONAL, gatedMedianMs: gated, openMedianMs: open }
  console.log(JSON.stringify(line))
  await info.attach('gate', { body: JSON.stringify(line, null, 2), contentType: 'application/json' })
})
