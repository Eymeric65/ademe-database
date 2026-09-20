import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ORIGIN, prerenderInto } from '../../scripts/prerender'

/**
 * A sitemap that lists a URL nothing was written for is worse than no sitemap:
 * every one of those is a 404 handed to a crawler on purpose. So the test runs
 * the real prerender into a temporary directory and checks the two sets --
 * what the sitemap claims, and what is on disk -- are the same set.
 */

// Vite emits the app's stylesheet under a content hash and records it in the
// built index.html; the présentation page links it from there, so the
// prerender needs an index.html in the tree it is writing into.
const CSS_HREF = '/assets/index-fixture0.css'
const out = mkdtempSync(join(tmpdir(), 'prerender-'))
writeFileSync(
  join(out, 'index.html'),
  `<!doctype html><html><head><link rel="stylesheet" crossorigin href="${CSS_HREF}"></head><body></body></html>`,
)
const written = prerenderInto(out)

afterAll(() => rmSync(out, { recursive: true, force: true }))

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
    expect(written.pages.filter((p) => p.startsWith('departement/')).length).toBe(101)
    for (const page of written.pages) {
      expect(existsSync(join(out, `${page}.html`))).toBe(true)
    }
    const xml = readFileSync(join(out, 'sitemap.xml'), 'utf8')
    for (const page of written.pages) expect(xml).toContain(`<loc>${ORIGIN}/${page}</loc>`)
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
    expect(() => prerenderInto(bare)).toThrow(/stylesheet/i)
    rmSync(bare, { recursive: true, force: true })
  })
})
