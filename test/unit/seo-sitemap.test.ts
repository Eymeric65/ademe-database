import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { NAMES, deptSlug } from '../../src/data/sources'
import { ORIGIN, pickAggregates, prerenderInto } from '../../scripts/prerender'

/**
 * A sitemap that lists a URL nothing was written for is worse than no sitemap:
 * every one of those is a 404 handed to a crawler on purpose. So the test runs
 * the real prerender into a temporary directory and checks the two sets --
 * what the sitemap claims, and what is on disk -- are the same set.
 *
 * It renders from a fixture rather than from whatever aggregate this machine
 * has: the real one is fetched from R2 and gitignored (ADR-0045), so a test
 * pinned to it would assert one number on a build server and another on a
 * laptop.
 */

const tmp = mkdtempSync(join(tmpdir(), 'prerender-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

// The sample is the committed fixture, and its 09 block is a real département's
// numbers -- so cloning it gives a page with everything a page renders.
const SAMPLE = join(process.cwd(), 'src/seo/aggregates.sample.json')
const sample = JSON.parse(readFileSync(SAMPLE, 'utf8'))
const template = sample.departements['09']

const CODES = Object.keys(NAMES)
const fixture = join(tmp, 'aggregates.fixture.json')
writeFileSync(
  fixture,
  JSON.stringify({
    ...sample,
    departements: {
      ...Object.fromEntries(
        CODES.map((code) => [code, { ...template, dept: code, publishable: true }]),
      ),
      // Neither is a place a page could be about (ADR-0024, ADR-0045).
      NG: { ...template, dept: 'NG', publishable: false },
      DOM: { ...template, dept: 'DOM', publishable: false },
    },
  }),
)

const out = join(tmp, 'all')
const written = prerenderInto(out, fixture)

describe('the sitemap', () => {
  it('lists the app, and one URL per page actually written', () => {
    const xml = readFileSync(join(out, 'sitemap.xml'), 'utf8')
    const locs = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1] as string)

    expect(locs).toContain(`${ORIGIN}/`)
    for (const loc of locs) {
      expect(loc.startsWith(`${ORIGIN}/`)).toBe(true)
      const path = loc.slice(ORIGIN.length)
      if (path === '/') continue
      // The assertion this file exists for: a loc with no file behind it is a
      // 404 handed to a crawler on purpose.
      expect(existsSync(join(out, `${path.slice(1)}.html`))).toBe(true)
    }
    expect(locs.length).toBe(written.pages.length + 1)
  })

  it('writes one page per publishable département, and no others', () => {
    expect(written.pages.length).toBe(CODES.length)
    for (const page of written.pages) {
      expect(existsSync(join(out, `${page}.html`))).toBe(true)
      expect(page.startsWith('departement/')).toBe(true)
    }
    const xml = readFileSync(join(out, 'sitemap.xml'), 'utf8')
    for (const page of written.pages) expect(xml).toContain(`<loc>${ORIGIN}/${page}</loc>`)
  })

  it('writes nothing for the partitions that are not places', () => {
    for (const code of ['NG', 'DOM']) {
      expect(written.pages).not.toContain(`departement/${deptSlug(code)}`)
      expect(existsSync(join(out, `departement/${deptSlug(code)}.html`))).toBe(false)
    }
  })
})

/**
 * The aggregate is fetched from R2 by whoever deploys and is not in the tree.
 * A build with no credentials -- CI's e2e job, a laptop -- must still render
 * pages, because a prerender that wrote nothing would be a deploy that removed
 * every indexed URL, silently. See ADR-0045.
 */
describe('the aggregate it renders from', () => {
  it('is the real one when it is on disk, and the sample when it is not', () => {
    const real = join(tmp, 'aggregates.json')
    expect(pickAggregates(real, SAMPLE)).toBe(SAMPLE)
    writeFileSync(real, readFileSync(SAMPLE))
    expect(pickAggregates(real, SAMPLE)).toBe(real)
  })

  it('renders real pages from the committed sample alone', () => {
    const offline = join(tmp, 'offline')
    const { pages } = prerenderInto(offline, SAMPLE)
    expect(pages).toEqual(['departement/ariege', 'departement/haute-garonne'])
    // Not a placeholder: the sample carries Ariège's own published numbers.
    expect(readFileSync(join(offline, 'departement/ariege.html'), 'utf8')).toContain('203,7')
  })
})
