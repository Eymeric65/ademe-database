import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

const out = mkdtempSync(join(tmpdir(), 'prerender-'))
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
    expect(written.pages.length).toBe(101)
    for (const page of written.pages) {
      expect(existsSync(join(out, `${page}.html`))).toBe(true)
      expect(page.startsWith('departement/')).toBe(true)
    }
    const xml = readFileSync(join(out, 'sitemap.xml'), 'utf8')
    for (const page of written.pages) expect(xml).toContain(`<loc>${ORIGIN}/${page}</loc>`)
  })
})
