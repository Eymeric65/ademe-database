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

/**
 * Reachable without a session. Sign-in cannot require being signed in, and the
 * DuckDB engine has to load before the app can tell anybody to sign in.
 *
 * Stripe's webhook carries no session. It is checked by signature instead, and
 * it can only update subscription rows an owner's checkout already created --
 * it never inserts one. See ADR-0047.
 */
const PUBLIC = ['/api/health', '/api/auth/*', '/data/vendor/*', '/api/billing/webhook']

/**
 * Needs a caller and reads data that has no owner -- the public certificates.
 * There are no rows to cross tenants over, which is exactly why this is its own
 * scope rather than a second name in SELF_SCOPED: `self` and `owner` both mean
 * "belongs to somebody", and this does not. See ADR-0012.
 */
const SIGNED_IN = ['/data/v1/*']

/**
 * Needs a caller whose account is on the paid plan: the last two months of
 * certificates, published in their own tree. Checked in the gate after the
 * caller, so it is strictly narrower than `signed-in`. See ADR-0038.
 */
const PAID = ['/data/recent/*']

/** The paid tree, as a concrete path a route pattern either covers or does not. */
const RECENT_PROBE = '/data/recent/x'

/**
 * Reads or acts on the caller's own identity and nothing owned. Every addition
 * here needs a cross-tenant test in the same PR.
 *
 * Checkout opens a subscription for the caller alone: test/db/
 * cross-tenant.test.ts proves A's payment never makes B paid.
 */
const SELF_SCOPED = ['/api/me', '/api/billing/checkout']

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

/**
 * Does a declared path cover `concrete`? The same rule as `match` in the
 * router: a trailing `/*` takes the whole subtree, anything else is exact.
 */
export function covers(pattern: string, concrete: string): boolean {
  return pattern.endsWith('/*') ? concrete.startsWith(pattern.slice(0, -1)) : pattern === concrete
}

/** Routes that would serve the paid tree to somebody the paid gate never saw. */
export function leaksRecent(routes: Declared[]): Declared[] {
  return routes.filter((r) => r.scope !== 'paid' && covers(r.path, RECENT_PROBE))
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

  it('flags a wider data route that would swallow the paid tree', () => {
    // `/data/*` signed-in would answer /data/recent/... without the plan check.
    expect(
      leaksRecent([
        { path: '/data/*', scope: 'signed-in' },
        { path: '/data/v1/*', scope: 'signed-in' },
        { path: '/data/recent/*', scope: 'paid' },
      ]),
    ).toEqual([{ path: '/data/*', scope: 'signed-in' }])
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
      expect(['public', 'signed-in', 'paid', 'self', 'owner'], r.path).toContain(r.scope)
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

  it('exposes exactly the signed-in routes on the allowlist', () => {
    expect(routes.filter((r) => r.scope === 'signed-in').map((r) => r.path).sort()).toEqual(
      [...SIGNED_IN].sort(),
    )
  })

  it('exposes exactly the paid routes on the allowlist', () => {
    expect(routes.filter((r) => r.scope === 'paid').map((r) => r.path).sort()).toEqual(
      [...PAID].sort(),
    )
  })

  it('leaves everything else owner-scoped', () => {
    const named = new Set([...PUBLIC, ...SELF_SCOPED, ...SIGNED_IN, ...PAID])
    for (const r of routes) {
      if (!named.has(r.path)) expect(r.scope, r.path).toBe('owner')
    }
  })

  it('never lets an /api route take the signed-in scope', () => {
    // `signed-in` is weaker than `owner`: it asks for a caller and then filters
    // on nothing. On a route that returns rows, that is every row. The scope
    // exists for data with no owner, and /api/* has an owner for everything.
    for (const r of routes) {
      if (r.path.startsWith('/api/')) expect(r.scope, r.path).not.toBe('signed-in')
    }
  })

  it('never lets an /api route take the paid scope', () => {
    // `paid` checks a plan and filters on nothing, like `signed-in`. The paid
    // tree is data with no owner; /api has an owner for everything.
    for (const r of routes) {
      if (r.path.startsWith('/api/')) expect(r.scope, r.path).not.toBe('paid')
    }
  })

  it('never lets a non-paid route cover the paid tree', () => {
    // The router takes the FIRST match, so a wider route declared above the
    // paid one would answer /data/recent/* without ever asking for a plan.
    expect(leaksRecent(routes)).toEqual([])
  })
})
