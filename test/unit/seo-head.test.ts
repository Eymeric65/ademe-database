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

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../..')
const INDEX = resolve(ROOT, 'index.html')
const ROBOTS = resolve(ROOT, 'public/robots.txt')
/** Everything Vite copies to the served root verbatim, the icon included. */
const PUBLIC = resolve(ROOT, 'public')

/** The one origin this site is served from, and the one a canonical may name. */
const ORIGIN = 'https://recherche-maison.com'

/** A standalone SVG without this does not render, whatever the extension says. */
const SVG_NS = 'xmlns="http://www.w3.org/2000/svg"'

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

/**
 * Where an XML comment in `xml` breaks the rules, or null if none does.
 *
 * XML forbids a double hyphen inside a comment body and forbids a body that
 * ends in a single hyphen. Breaking either one does not spoil the comment, it
 * spoils the WHOLE FILE: the document stops being well formed, and a browser
 * asked for an SVG renders its XML error page where the icon should be.
 *
 * The hyphens that close the comment are not part of the body and must not be
 * flagged, or this would reject every valid file it was ever pointed at.
 */
export function badComment(xml: string): { line: number; reason: string } | null {
  const OPEN = '<!--'
  const CLOSE = '-->'
  let at = 0
  for (;;) {
    const open = xml.indexOf(OPEN, at)
    if (open === -1) return null
    const close = xml.indexOf(CLOSE, open + OPEN.length)
    if (close === -1) return { line: lineOf(xml, open), reason: 'a comment that is never closed' }
    const body = xml.slice(open + OPEN.length, close)
    const doubled = body.indexOf('--')
    if (doubled !== -1) {
      return {
        line: lineOf(xml, open + OPEN.length + doubled),
        reason: 'a double hyphen inside a comment',
      }
    }
    if (body.endsWith('-')) {
      return { line: lineOf(xml, close), reason: 'a comment body ending in a hyphen' }
    }
    at = close + CLOSE.length
  }
}

/** 1-based line of `index`, so a failure names somewhere to look. */
function lineOf(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i++) if (text[i] === '\n') line += 1
  return line
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

describe('the XML comment detector itself', () => {
  it('flags a double hyphen inside a comment, and names its line', () => {
    const svg = ['<svg>', '<!-- see src/index.css --', '     and on -->', '</svg>'].join('\n')
    expect(badComment(svg)).toEqual({ line: 2, reason: 'a double hyphen inside a comment' })
  })

  it('flags a comment body that ends in a hyphen', () => {
    expect(badComment('<!-- a ramp --->')?.reason).toBe('a comment body ending in a hyphen')
  })

  it('flags a comment that is never closed', () => {
    expect(badComment('<!-- and then nothing')?.reason).toBe('a comment that is never closed')
  })

  it('does not trip over the hyphens that close a comment', () => {
    expect(badComment('<!-- a ramp -->')).toBeNull()
    expect(badComment('<!-- one --><svg /><!-- two -->')).toBeNull()
  })

  it('accepts a document with no comment at all', () => {
    expect(badComment('<svg viewBox="0 0 32 32" />')).toBeNull()
  })

  it('keeps looking past a clean comment to find a later broken one', () => {
    expect(badComment('<!-- fine -->\n<!-- not --fine -->')?.line).toBe(2)
  })

  it('catches the exact shape that broke this icon: a CSS custom property', () => {
    // The habit that caused it: naming the ink colour the way CSS spells it,
    // with the two leading dashes, inside a comment.
    const named = '<!-- prussian is ' + '-'.repeat(2) + 'prussian-ink -->'
    expect(badComment(named)?.reason).toBe('a double hyphen inside a comment')
  })
})

describe('public/favicon.svg is a document a browser can parse', () => {
  /**
   * Nothing else in this repo reads an SVG. Vite copies public/ byte for byte,
   * so a malformed icon ships green through every check and surfaces only as an
   * XML error page in the one place nobody screenshots: the tab.
   */
  const svgs = readdirSync(PUBLIC, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith('.svg'))

  it('finds at least one SVG, so the checks below are never empty', () => {
    expect(svgs.length).toBeGreaterThan(0)
  })

  it('has no comment that would stop the file parsing', () => {
    const broken = svgs.flatMap((name) => {
      const bad = badComment(readFileSync(join(PUBLIC, name), 'utf8'))
      return bad ? [`${name} line ${bad.line}: ${bad.reason}`] : []
    })
    expect(broken).toEqual([])
  })

  it('declares the SVG namespace, without which it does not render standalone', () => {
    const missing = svgs.filter(
      (name) => !readFileSync(join(PUBLIC, name), 'utf8').includes(SVG_NS),
    )
    expect(missing).toEqual([])
  })

  it('is the file index.html actually points rel="icon" at', () => {
    const href = linkHref(readFileSync(INDEX, 'utf8'), 'icon')
    expect(href).not.toBeNull()
    expect(href!.startsWith('/')).toBe(true)
    expect(existsSync(resolve(PUBLIC, `.${href}`))).toBe(true)
  })
})
