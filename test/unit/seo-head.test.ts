/**
 * The site is one URL and it has to describe itself to a machine.
 *
 * `index.html` ships an empty `<div id="root">`: a crawler, a link preview or a
 * messaging app sees the head and nothing else, because the app has not run.
 * So the head IS the page as far as they are concerned. This test catches the
 * failure where somebody edits index.html -- reformats it, swaps a tool,
 * regenerates it from a template -- and the description, the canonical or the
 * Open Graph set silently goes with it, which nobody notices for weeks because
 * the site still looks perfect in a browser.
 *
 * It also catches the placeholder: an empty `content=""` or a two-word stub is
 * a tag that exists and says nothing, which is why the description is measured
 * rather than merely found.
 *
 * `public/robots.txt` is asserted because Cloudflare answers /robots.txt with
 * its own managed content-signals file -- comments only, no Allow, no Sitemap.
 * Ours has to exist and to carry directives, or the managed one is what the
 * crawler gets.
 *
 * The detectors are run against synthetic input as well as the real files. A
 * regex that matched nothing would pass on any tree while asserting nothing at
 * all, which is worse than no test -- it looks like evidence. Same shape as
 * test/unit/no-raw-db.test.ts and test/unit/authorization.test.ts.
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../..')
const INDEX = resolve(ROOT, 'index.html')
const ROBOTS = resolve(ROOT, 'public/robots.txt')

/** The one origin this site is served from, and the one a canonical may name. */
const ORIGIN = 'https://recherche-maison.com'

/** Below this, a description is a stub rather than a sentence. */
const MIN_DESCRIPTION = 80

/** The Open Graph set a link preview needs before it will render a card. */
const OG_REQUIRED = ['og:title', 'og:description', 'og:type', 'og:url', 'og:locale']

/** `content` of the first `<meta name="...">` with this name, or null. */
export function metaContent(html: string, name: string): string | null {
  return tagContent(html, 'name', name)
}

/** `content` of the first `<meta property="...">` with this property, or null. */
export function propertyContent(html: string, property: string): string | null {
  return tagContent(html, 'property', property)
}

function tagContent(html: string, attr: string, value: string): string | null {
  const re = new RegExp(
    `<meta[^>]*\\b${attr}\\s*=\\s*["']${escapeRe(value)}["'][^>]*>`,
    'i',
  )
  const tag = re.exec(html)?.[0]
  if (!tag) return null
  return /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? null
}

/** `href` of the first `<link rel="...">` with this rel, or null. */
export function linkHref(html: string, rel: string): string | null {
  const tag = new RegExp(`<link[^>]*\\brel\\s*=\\s*["']${escapeRe(rel)}["'][^>]*>`, 'i').exec(
    html,
  )?.[0]
  if (!tag) return null
  return /\bhref\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? null
}

/** The text between `<title>` and `</title>`, or null. */
export function titleText(html: string): string | null {
  return /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? null
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

describe('the detectors themselves', () => {
  const sample = `<head>
    <title>Un titre</title>
    <meta name="description" content="Une phrase." />
    <meta property="og:title" content="Un titre" />
    <link rel="canonical" href="https://example.test/" />
  </head>`

  it('reads a meta name, a meta property, a link href and the title', () => {
    expect(metaContent(sample, 'description')).toBe('Une phrase.')
    expect(propertyContent(sample, 'og:title')).toBe('Un titre')
    expect(linkHref(sample, 'canonical')).toBe('https://example.test/')
    expect(titleText(sample)).toBe('Un titre')
  })

  it('returns null for a tag that is not there', () => {
    expect(metaContent(sample, 'theme-color')).toBeNull()
    expect(propertyContent(sample, 'og:url')).toBeNull()
    expect(linkHref(sample, 'icon')).toBeNull()
  })

  it('does not confuse a name with a property, or one og tag with another', () => {
    expect(metaContent(sample, 'og:title')).toBeNull()
    expect(propertyContent(sample, 'og:t')).toBeNull()
  })

  it('reports an empty content as empty rather than as missing', () => {
    expect(metaContent('<meta name="description" content="" />', 'description')).toBe('')
  })
})

describe('index.html describes the page to a crawler', () => {
  const html = readFileSync(INDEX, 'utf8')

  it('declares a canonical URL at the real origin', () => {
    const canonical = linkHref(html, 'canonical')
    expect(canonical).not.toBeNull()
    expect(canonical).toContain(ORIGIN)
  })

  it('carries a description that is a sentence, not a placeholder', () => {
    const description = metaContent(html, 'description')
    expect(description).not.toBeNull()
    expect(description!.trim().length).toBeGreaterThanOrEqual(MIN_DESCRIPTION)
  })

  it.each(OG_REQUIRED)('carries a non-empty %s', (property) => {
    const content = propertyContent(html, property)
    expect(content).not.toBeNull()
    expect(content!.trim()).not.toBe('')
  })

  it('points og:url and og:locale at this site and this language', () => {
    expect(propertyContent(html, 'og:url')).toContain(ORIGIN)
    expect(propertyContent(html, 'og:locale')).toBe('fr_FR')
  })

  it('leads the title with the query rather than the brand', () => {
    const title = titleText(html)
    expect(title).not.toBeNull()
    expect(title!.toLowerCase()).toContain('dpe')
    // A phrase somebody could have typed into a search box, not a brand stub:
    // long enough to say what the page is for, short enough not to be cut off
    // in the result.
    expect(title!.length).toBeGreaterThanOrEqual(35)
    expect(title!.length).toBeLessThanOrEqual(60)
    expect(title!.toLowerCase().startsWith('recherche-maison')).toBe(false)
  })

  it('keeps the font preload, which is load-bearing for the first heading', () => {
    expect(html).toContain('/fonts/fraunces-roman-latin.woff2')
  })
})

describe('public/robots.txt replaces the managed one', () => {
  it('exists in public/, where Vite copies it to the served root', () => {
    expect(existsSync(ROBOTS)).toBe(true)
  })

  it('allows crawling and names the sitemap', () => {
    const robots = readFileSync(ROBOTS, 'utf8')
    expect(robots).toMatch(/^User-agent:\s*\*$/m)
    expect(robots).toMatch(/^Allow:\s*\/$/m)
    expect(robots).toMatch(new RegExp(`^Sitemap:\\s*${escapeRe(ORIGIN)}/sitemap\\.xml$`, 'm'))
  })

  it('disallows nothing, since every path here is meant to be crawled', () => {
    const robots = readFileSync(ROBOTS, 'utf8')
    expect(robots).not.toMatch(/^Disallow:\s*\/\s*$/m)
  })
})
