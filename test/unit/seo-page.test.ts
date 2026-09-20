import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { NAMES, deptSlug } from '../../src/data/sources'
import { renderDepartementPage } from '../../src/seo/page'

/**
 * The prerendered département pages are the ONLY indexable URLs this domain
 * has: src/routes.ts is a hash router, so every screen of the app is the same
 * URL to a crawler. These pages have to stand on their own -- no bundle, no
 * DuckDB, no session -- which is why the last assertion here is about what the
 * output does NOT contain.
 */

const FIXTURE = {
  dept: '09',
  publishable: true,
  certificates: 31157,
  etiquette_dpe: { A: 505, B: 1515, C: 9311, D: 9121, E: 5734, F: 2830, G: 2141 },
  etiquette_ges: { A: 6314, B: 8655, C: 7978, D: 4112, E: 2396, F: 1170, G: 532 },
  passoires: { count: 4971, classed: 31157, share: 0.1595 },
  conso_ep_kwh_m2: { counted: 31157, p25: 146.9, median: 203.7, p75: 276.0 },
  surface_m2: { counted: 30322, median: 79.3 },
  periode_construction: [
    { label: 'avant 1948', count: 11411 },
    { label: '1948-1974', count: 10263 },
  ],
  type_batiment: [
    { label: 'maison', count: 17316 },
    { label: 'appartement', count: 13025 },
  ],
  par_annee: [
    { year: 2021, count: 2242 },
    { year: 2022, count: 5763 },
  ],
  communes: [
    { code_insee: '09225', nom: 'Pamiers', count: 5094 },
    { code_insee: '09122', nom: 'Foix', count: 3247 },
  ],
}

const STAMP = { highWater: '2026-09-07', dataBuiltAt: '2026-09-11T04:15:59+00:00' }

const OTHERS = [
  { dept: '31', name: 'Haute-Garonne', slug: 'haute-garonne' },
  { dept: '2A', name: 'Corse-du-Sud', slug: 'corse-du-sud' },
]

const html = renderDepartementPage({ agg: FIXTURE, stamp: STAMP, others: OTHERS })

describe('the département page', () => {
  it('names the département and its certificate count in the h1', () => {
    const h1 = /<h1[^>]*>(.*?)<\/h1>/s.exec(html)?.[1] ?? ''
    expect(h1).toContain('Ariège')
    expect(h1).toContain('31 157')
  })

  it('leads with the passoires thermiques share, as a percentage', () => {
    expect(html).toContain('16,0 %')
    expect(html).toContain('4 971')
  })

  it('states the data cut-off in plain French and credits ADEME under Licence Ouverte', () => {
    expect(html).toContain('7 septembre 2026')
    expect(html).toMatch(/Licence Ouverte/)
    expect(html).toMatch(/ADEME/)
  })

  it('carries the canonical URL, the description and the Open Graph set', () => {
    expect(html).toContain(
      '<link rel="canonical" href="https://recherche-maison.com/departement/ariege"/>',
    )
    expect(html).toMatch(/<meta name="description" content="[^"]{80,180}"\/>/)
    expect(html).toContain('property="og:url" content="https://recherche-maison.com/departement/ariege"')
    expect(html).toContain('property="og:type"')
    expect(html).toContain('property="og:locale" content="fr_FR"')
  })

  it('reports the quartiles, the median surface and the breakdowns', () => {
    expect(html).toContain('203,7')
    expect(html).toContain('146,9')
    expect(html).toContain('276,0')
    expect(html).toContain('79,3')
    expect(html).toContain('avant 1948')
    expect(html).toContain('maison')
    expect(html).toContain('2022')
  })

  it('links every other département, and the app', () => {
    expect(html).toContain('href="/departement/haute-garonne"')
    expect(html).toContain('href="/departement/corse-du-sud"')
    expect(html).toContain('href="/"')
  })

  it('emits JSON-LD that parses, with a Dataset and a BreadcrumbList', () => {
    const blocks = [
      ...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs),
    ].map((m) => JSON.parse(m[1] as string))
    expect(blocks.length).toBeGreaterThan(0)
    const types = blocks.map((b) => b['@type'])
    expect(types).toContain('Dataset')
    expect(types).toContain('BreadcrumbList')
  })

  it('ships zero JavaScript: the only script is the JSON-LD', () => {
    expect(html).not.toContain('<script src')
    const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1] ?? '')
    expect(scripts.length).toBeGreaterThan(0)
    for (const attrs of scripts) expect(attrs).toBe(' type="application/ld+json"')
  })

  it('names the arrondissement rather than repeating the city twenty times', () => {
    const paris = renderDepartementPage({
      agg: {
        ...FIXTURE,
        dept: '75',
        communes: [
          { code_insee: '75115', nom: 'Paris', count: 94011 },
          { code_insee: '75101', nom: 'Paris', count: 4000 },
          { code_insee: '69381', nom: 'Lyon', count: 10 },
          { code_insee: '13216', nom: 'Marseille', count: 9 },
        ],
      },
      stamp: STAMP,
      others: OTHERS,
    })
    expect(paris).toContain('Paris 15e')
    expect(paris).toContain('Paris 1er')
    expect(paris).toContain('Lyon 1er')
    expect(paris).toContain('Marseille 16e')
  })
})

describe('the slugs the pages are published at', () => {
  it('strips accents and typographic apostrophes', () => {
    expect(deptSlug('09')).toBe('ariege')
    expect(deptSlug('21')).toBe('cote-d-or')
    expect(deptSlug('95')).toBe('val-d-oise')
    expect(deptSlug('2A')).toBe('corse-du-sud')
    expect(deptSlug('90')).toBe('territoire-de-belfort')
    expect(deptSlug('988')).toBe('nouvelle-caledonie')
  })

  it('is unique across every publishable département, and URL-safe', () => {
    const aggregates = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../src/seo/aggregates.json', import.meta.url)), 'utf8'),
    ) as { departements: Record<string, { publishable: boolean }> }
    const codes = Object.keys(aggregates.departements).filter(
      (c) => aggregates.departements[c]?.publishable,
    )
    expect(codes.length).toBe(101)

    const slugs = codes.map(deptSlug)
    for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    expect(new Set(slugs).size).toBe(slugs.length)
    for (const code of codes) expect(NAMES[code]).toBeTruthy()
  })
})
