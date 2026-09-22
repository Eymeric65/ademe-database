import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
 * has: the real one is fetched from R2 and gitignored (ADR-0046), so a test
 * pinned to it would assert one number on a build server and another on a
 * laptop.
 */

const tmp = mkdtempSync(join(tmpdir(), 'prerender-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

// Vite emits the app's stylesheet under a content hash and records it in the
// built index.html; the présentation page links it from there, so the
// prerender needs an index.html in every tree it writes into.
const CSS_HREF = '/assets/index-fixture0.css'
const INDEX = `<!doctype html><html><head><link rel="stylesheet" crossorigin href="${CSS_HREF}"></head><body></body></html>`

function treeAt(name: string): string {
  const dir = join(tmp, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.html'), INDEX)
  return dir
}

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
      // Neither is a place a page could be about (ADR-0024, ADR-0046).
      NG: { ...template, dept: 'NG', publishable: false },
      DOM: { ...template, dept: 'DOM', publishable: false },
    },
  }),
)

const out = treeAt('all')
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
    expect(written.pages.filter((p) => p.startsWith('departement/')).length).toBe(CODES.length)
    for (const page of written.pages) {
      expect(existsSync(join(out, `${page}.html`))).toBe(true)
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
 * every indexed URL, silently. See ADR-0046.
 */
describe('the aggregate it renders from', () => {
  it('is the real one when it is on disk, and the sample when it is not', () => {
    const real = join(tmp, 'aggregates.json')
    expect(pickAggregates(real, SAMPLE)).toBe(SAMPLE)
    writeFileSync(real, readFileSync(SAMPLE))
    expect(pickAggregates(real, SAMPLE)).toBe(real)
  })

  // A deploy is the one build that must never fall back: `rclone copyto` of a
  // missing object exits 0 having copied nothing, and dev shipped the sample's
  // two pages that way, green.
  it('refuses the sample when the real one is required', () => {
    const missing = join(tmp, 'required', 'aggregates.json')
    expect(() => pickAggregates(missing, SAMPLE, true)).toThrow(/aggregates\.json/)
    mkdirSync(join(tmp, 'required'), { recursive: true })
    writeFileSync(missing, readFileSync(SAMPLE))
    expect(pickAggregates(missing, SAMPLE, true)).toBe(missing)
  })

  it('renders real pages from the committed sample alone', () => {
    const offline = treeAt('offline')
    const { pages } = prerenderInto(offline, SAMPLE)
    expect(pages).toEqual([
      'departement/ariege',
      'departement/haute-garonne',
      'presentation',
      'cgv',
      'mentions-legales',
      'departements',
    ])
    // Not a placeholder: the sample carries Ariège's own published numbers.
    expect(readFileSync(join(offline, 'departement/ariege.html'), 'utf8')).toContain('203,7')
  })
})

/**
 * A département page nothing links to is reachable only from a search result.
 * /departements is the one page that links every one of them, and the tab that
 * leads there is on every page, the app's included.
 */
describe('the index of départements', () => {
  it('is written, listed in the sitemap, and links every page written', () => {
    expect(written.pages).toContain('departements')
    const xml = readFileSync(join(out, 'sitemap.xml'), 'utf8')
    expect(xml).toContain(`<loc>${ORIGIN}/departements</loc>`)

    const html = readFileSync(join(out, 'departements.html'), 'utf8')
    const linked = [...html.matchAll(/href="\/(departement\/[^"]+)"/g)].map((m) => m[1])
    expect(linked).toEqual(written.pages.filter((p) => p.startsWith('departement/')))
  })

  it('is one tab away from every static page', () => {
    for (const page of ['departements', 'presentation', 'departement/ariege']) {
      const html = readFileSync(join(out, `${page}.html`), 'utf8')
      expect(html).toContain('<header class="masthead">')
      expect(html).toContain('href="/departements"')
      expect(html).toContain(`href="${CSS_HREF}"`)
    }
  })
})

describe('the présentation page', () => {
  it('is written, and listed in the one sitemap', () => {
    expect(written.pages).toContain('presentation')
    expect(existsSync(join(out, 'presentation.html'))).toBe(true)
    const xml = readFileSync(join(out, 'sitemap.xml'), 'utf8')
    expect(xml).toContain(`<loc>${ORIGIN}/presentation</loc>`)
  })

  it('links the stylesheet the built app itself loads, and ships no script', () => {
    const html = readFileSync(join(out, 'presentation.html'), 'utf8')
    expect(html).toContain(`href="${CSS_HREF}"`)
    expect(html).not.toContain('<script')
    expect(html).toContain(`<link rel="canonical" href="${ORIGIN}/presentation"/>`)
    // The hero, and a section from the body: the real component, not a stub.
    expect(html).toContain('Le diagnostic montre le logement')
    expect(html).toContain('Les limites, franchement')
    // The signedIn branch: links, never a button nothing can click.
    expect(html).not.toContain('<button')
    expect(html).toContain('<base href="/"/>')
  })

  it('refuses to emit an unstyled page when the stylesheet cannot be found', () => {
    const bare = mkdtempSync(join(tmpdir(), 'prerender-bare-'))
    writeFileSync(join(bare, 'index.html'), '<!doctype html><html><head></head><body></body></html>')
    expect(() => prerenderInto(bare, SAMPLE)).toThrow(/stylesheet/i)
    rmSync(bare, { recursive: true, force: true })
  })
})

/**
 * Selling a subscription to consumers in France requires terms of sale and a
 * legal notice at addresses anybody can reach, Stripe's reviewers included --
 * so they are prerendered pages, not hash routes.
 */
describe('the legal pages', () => {
  const LEGAL = [
    { page: 'cgv', heading: 'Conditions générales de vente' },
    { page: 'mentions-legales', heading: 'Mentions légales' },
  ]

  it('are written, and listed in the sitemap', () => {
    const xml = readFileSync(join(out, 'sitemap.xml'), 'utf8')
    for (const { page } of LEGAL) {
      expect(written.pages).toContain(page)
      expect(existsSync(join(out, `${page}.html`))).toBe(true)
      expect(xml).toContain(`<loc>${ORIGIN}/${page}</loc>`)
    }
  })

  it('render under the masthead, with the app stylesheet and no script', () => {
    for (const { page, heading } of LEGAL) {
      const html = readFileSync(join(out, `${page}.html`), 'utf8')
      expect(html).toContain('<header class="masthead">')
      expect(html).toContain(`href="${CSS_HREF}"`)
      expect(html).toContain(`<link rel="canonical" href="${ORIGIN}/${page}"/>`)
      expect(html).toContain(`<h1>${heading}</h1>`)
      expect(html).not.toContain('<script')
    }
  })

  it('say what is sold, for how much, and how it ends', () => {
    const html = readFileSync(join(out, 'cgv.html'), 'utf8')
    expect(html).toContain('5 € TTC par mois')
    expect(html).toContain('Gérer mon abonnement')
    expect(html).toContain('L221-28')
  })

  it('name the host and the processors of personal data', () => {
    const html = readFileSync(join(out, 'mentions-legales.html'), 'utf8')
    for (const name of ['Cloudflare', 'Stripe', 'Google', 'CNIL']) expect(html).toContain(name)
  })

  it('are linked from the foot of every other static page', () => {
    for (const page of ['presentation', 'departements', 'departement/ariege']) {
      const html = readFileSync(join(out, `${page}.html`), 'utf8')
      expect(html, page).toContain('href="/cgv"')
      expect(html, page).toContain('href="/mentions-legales"')
    }
  })

  // The publisher's identity is the operator's to supply, not the code's to
  // invent. Until it is filled in, this fails, and the pages cannot ship.
  it('carry no placeholder left to fill in', () => {
    for (const { page } of LEGAL) {
      expect(readFileSync(join(out, `${page}.html`), 'utf8'), page).not.toContain('à compléter')
    }
  })
})
