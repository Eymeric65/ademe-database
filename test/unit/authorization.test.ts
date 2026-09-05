/**
 * Every route is owner-scoped unless somebody named it otherwise, in writing.
 *
 * The gate in server/index.ts is default-deny, so an unscoped route is already
 * refused. This test guards the other direction: it makes WIDENING the scope an
 * edit that shows up in a diff next to a list a reviewer can read, rather than
 * one word buried in a route declaration.
 *
 * Adding a name to SELF_SCOPED is the moment the control binds. CLAUDE.md
 * section 9: the same PR must carry a cross-tenant test proving the second user
 * cannot reach the first's rows.
 *
 * The detector is tested against synthetic input as well as the real file. A
 * regex that silently matched nothing would pass on a clean tree while
 * asserting nothing at all, which is worse than no test -- it looks like
 * evidence. Same shape as test/unit/no-raw-db.test.ts.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROUTER = resolve(import.meta.dirname, '../../server/index.ts')

/** Reachable without a session. Sign-in cannot require being signed in. */
const PUBLIC = ['/api/health', '/api/auth/*']

/**
 * Reads the caller's own identity and nothing owned. Every addition here needs
 * a cross-tenant test in the same PR.
 */
const SELF_SCOPED = ['/api/me']

export type Declared = { path: string; scope: string }

/** Pull every `path: '...'` / `scope: '...'` pair out of the ROUTES literal. */
export function declaredRoutes(source: string): Declared[] {
  const out: Declared[] = []
  const re = /path:\s*'([^']+)'\s*,\s*(?:\/\/[^\n]*\n\s*)*scope:\s*'([^']+)'/g
  for (const m of source.matchAll(re)) {
    out.push({ path: m[1] as string, scope: m[2] as string })
  }
  return out
}

describe('the detector itself', () => {
  const sample = `
    export const ROUTES: Route[] = [
      { method: 'GET', path: '/api/health', scope: 'public', handle: h },
      { method: 'GET', path: '/api/buildings', scope: 'owner', handle: h },
    ]`

  it('finds every declaration', () => {
    expect(declaredRoutes(sample)).toEqual([
      { path: '/api/health', scope: 'public' },
      { path: '/api/buildings', scope: 'owner' },
    ])
  })

  it('finds nothing in a file with no routes', () => {
    expect(declaredRoutes('const x = 1')).toEqual([])
  })
})

describe('the router', () => {
  const source = readFileSync(ROUTER, 'utf8')
  const routes = declaredRoutes(source)

  it('declares some routes at all', () => {
    // Without this, every assertion below is vacuously true the day the regex
    // stops matching -- which is exactly how this kind of test rots.
    expect(routes.length).toBeGreaterThan(5)
  })

  it('gives every route a known scope', () => {
    for (const r of routes) {
      expect(['public', 'self', 'owner'], r.path).toContain(r.scope)
    }
  })

  it('exposes exactly the public routes on the allowlist', () => {
    expect(routes.filter((r) => r.scope === 'public').map((r) => r.path).sort()).toEqual(
      [...PUBLIC].sort(),
    )
  })

  it('exposes exactly the self-scoped routes on the allowlist', () => {
    expect(routes.filter((r) => r.scope === 'self').map((r) => r.path).sort()).toEqual(
      [...SELF_SCOPED].sort(),
    )
  })

  it('leaves everything else owner-scoped', () => {
    const named = new Set([...PUBLIC, ...SELF_SCOPED])
    for (const r of routes) {
      if (!named.has(r.path)) expect(r.scope, r.path).toBe('owner')
    }
  })
})
