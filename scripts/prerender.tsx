/**
 * Turns the département aggregate into dist/departement/*.html, renders
 * dist/presentation.html, and writes the one dist/sitemap.xml covering both.
 *
 * Why this exists: src/routes.ts is a hash router, so the whole app is one URL
 * to a crawler and the domain has exactly one indexable page. These static
 * files are the other hundred and one. They are derived, never committed --
 * the aggregate is built by the weekly job and fetched from R2 by whoever
 * deploys (ADR-0046), and this is the mechanical step that turns it into pages,
 * run from `npm run build` AFTER `vite build`, because Vite empties dist/
 * first.
 *
 * No Worker route is involved: wrangler.jsonc sets no `html_handling`, so the
 * ASSETS default (auto-trailing-slash) is what resolves /departement/ariege to
 * dist/departement/ariege.html. test/e2e/seo.spec.ts is what proves it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { NAMES, deptSlug } from '../src/data/sources'
import type { DepartementAggregate } from '../src/seo/page'
import { ORIGIN, renderDepartementPage, renderPresentationPage } from '../src/seo/page'

export { ORIGIN }

type Aggregates = {
  data_built_at: string
  high_water: string
  departements: Record<string, DepartementAggregate>
}

// readFileSync rather than an import: the aggregate is 357 kB of data, and a
// module import would pull it into the type graph and into any bundle that
// ever touched this file.
//
// The real aggregate is fetched from R2 by whoever is about to deploy and is
// gitignored; the sample is committed, so a build with no credentials -- CI's
// e2e job, a laptop -- renders two real pages instead of none. See ADR-0046.
const realPath = fileURLToPath(new URL('../src/seo/aggregates.json', import.meta.url))
const samplePath = fileURLToPath(new URL('../src/seo/aggregates.sample.json', import.meta.url))
const distDir = fileURLToPath(new URL('../dist/', import.meta.url))

/**
 * The real aggregate when it is on disk, the committed sample otherwise. Pure
 * and parameterised so a test can drive both branches without depending on
 * whether whoever runs it happens to have fetched the aggregate.
 */
export function pickAggregates(real: string, sample: string): string {
  return existsSync(real) ? real : sample
}

/** The aggregate this machine renders from. */
export function aggregatesPath(): string {
  return pickAggregates(realPath, samplePath)
}

/**
 * The app's stylesheet, as the built index.html records it.
 *
 * Vite emits src/index.css under a content hash, and /presentation has to link
 * it: the pres-* and spec-* classes are ~400 lines and are not being inlined.
 *
 * TRAP: read off index.html, never globbed out of dist/assets. A glob is right
 * only while there is exactly one stylesheet, and silently picks the wrong
 * file the day a second one appears. index.html is the authoritative record of
 * which one the app actually loads.
 */
export function stylesheetHref(indexHtml: string): string {
  const href = /<link\b[^>]*\brel=["']?stylesheet["']?[^>]*>/i
    .exec(indexHtml)?.[0]
    ?.match(/\bhref=["']([^"']+)["']/i)?.[1]
  if (!href) {
    throw new Error(
      'prerender: no <link rel="stylesheet"> in the built index.html; ' +
        'refusing to write an unstyled /presentation',
    )
  }
  return href
}

/**
 * Writes the pages and the sitemap under `outDir`, and returns the paths
 * written, without the .html -- which is also what the sitemap lists.
 */
export function prerenderInto(outDir: string, from = aggregatesPath()): { pages: string[] } {
  const data = JSON.parse(readFileSync(from, 'utf8')) as Aggregates
  const stamp = { highWater: data.high_water, dataBuiltAt: data.data_built_at }

  // Sorted by code; order is the contract, so two builds of the same aggregate
  // produce byte-identical files and the sitemap reads the same way twice.
  // NG (ungeocoded, not a place) and DOM (a merged bucket) are not places a
  // page could be about, and the aggregate marks them unpublishable.
  const codes = Object.keys(data.departements)
    .filter((code) => data.departements[code]?.publishable)
    .sort()

  const links = codes.map((dept) => ({
    dept,
    name: NAMES[dept] ?? dept,
    slug: deptSlug(dept),
  }))

  const root = outDir.endsWith('/') ? outDir : `${outDir}/`
  mkdirSync(`${root}departement`, { recursive: true })

  const pages: string[] = []
  for (const code of codes) {
    const agg = data.departements[code] as DepartementAggregate
    const slug = deptSlug(code)
    const html = renderDepartementPage({
      agg,
      stamp,
      // Every OTHER département: 100 internal links per page is the crawl path.
      others: links.filter((l) => l.dept !== code),
    })
    writeFileSync(`${root}departement/${slug}.html`, html)
    pages.push(`departement/${slug}`)
  }

  // The Présentation, at an address a crawler can reach. It is the only page
  // here that links a stylesheet rather than inlining one, so it is also the
  // only one that needs the build's own index.html.
  const indexHtml = readFileSync(`${root}index.html`, 'utf8')
  writeFileSync(
    `${root}presentation.html`,
    renderPresentationPage({ stylesheet: stylesheetHref(indexHtml) }),
  )
  pages.push('presentation')

  const locs = ['/', ...pages.map((p) => `/${p}`)]
  const sitemap =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    locs
      .map(
        (loc) =>
          `  <url><loc>${ORIGIN}${loc}</loc><lastmod>${data.high_water}</lastmod></url>\n`,
      )
      .join('') +
    '</urlset>\n'
  writeFileSync(`${root}sitemap.xml`, sitemap)

  return { pages }
}

function main(): void {
  const from = aggregatesPath()
  const { pages } = prerenderInto(distDir, from)
  // Which file, every time: a build that shipped the sample and a build that
  // shipped the real numbers are otherwise indistinguishable after the fact.
  const which = from === realPath ? 'src/seo/aggregates.json' : 'src/seo/aggregates.sample.json'
  console.log(`wrote ${pages.length} page(s) and dist/sitemap.xml from ${which}`)
}

if (process.argv[1]?.endsWith('prerender.tsx')) main()
