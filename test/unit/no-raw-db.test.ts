/**
 * D1 has no row-level security, so `server/db.ts` being the only module that
 * can build a query is the control -- not a convention. See ADR-0003.
 *
 * The detector is tested against synthetic input as well as the real tree. A
 * test that only scans a clean tree passes when the detector is broken, which
 * would make it worse than nothing: it would look like evidence.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../..')

/** The one module allowed to open a database. */
const CHOKE_POINT = 'server/db.ts'

/**
 * D1 tests are allowed a handle, and only D1 tests.
 *
 * They run against real Miniflare D1 because there is no mock database here
 * (CLAUDE.md section 3), and a test that cannot touch the database cannot prove
 * the schema actually landed -- which is the one thing test/db/migrate.test.ts
 * exists to prove. The exemption is a path prefix, not a per-file opt-out, so
 * it cannot spread to a route handler by somebody adding a comment.
 */
const ALLOWED_PREFIX = 'test/db/'

/** Ways to get a handle. Adding a way to reach D1 means adding it here. */
const PATTERNS = [
  { name: 'drizzle(', re: /\bdrizzle\s*\(/ },
  { name: 'env.DB', re: /\benv\s*\.\s*DB\b/ },
  { name: 'DB.prepare(', re: /\bDB\s*\.\s*prepare\s*\(/ },
]

export type SourceFile = { path: string; text: string }

export function findRawDbUses(files: SourceFile[]): string[] {
  const found: string[] = []
  for (const f of files) {
    if (f.path === CHOKE_POINT || f.path.startsWith(ALLOWED_PREFIX)) continue
    for (const p of PATTERNS) {
      if (p.re.test(f.text)) found.push(`${f.path}: ${p.name}`)
    }
  }
  return found
}

function walk(dir: string, out: SourceFile[] = []): SourceFile[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(entry) && !full.includes('test/unit/no-raw-db'))
      out.push({ path: relative(ROOT, full), text: readFileSync(full, 'utf8') })
  }
  return out
}

describe('the detector itself', () => {
  it('flags a handle opened outside the choke point', () => {
    const found = findRawDbUses([
      { path: 'server/routes/buildings.ts', text: 'const db = drizzle(env.DB)' },
    ])
    expect(found).toHaveLength(2) // both drizzle( and env.DB
    expect(found[0]).toContain('server/routes/buildings.ts')
  })

  it('allows the choke point to open one', () => {
    expect(
      findRawDbUses([{ path: CHOKE_POINT, text: 'return drizzle(env.DB, { schema: s })' }]),
    ).toEqual([])
  })

  it('allows a D1 test to open one, and only under test/db/', () => {
    expect(
      findRawDbUses([{ path: 'test/db/migrate.test.ts', text: 'await migrate(env.DB)' }]),
    ).toEqual([])
    expect(
      findRawDbUses([{ path: 'test/unit/sneaky.test.ts', text: 'await migrate(env.DB)' }]),
    ).toHaveLength(1)
  })

  it('does not flag ordinary code', () => {
    expect(
      findRawDbUses([{ path: 'src/App.tsx', text: 'const rows = await api.get("/buildings")' }]),
    ).toEqual([])
  })
})

describe('the repository', () => {
  it('opens a database in exactly one place', () => {
    const files = walk(ROOT)
    expect(files.length).toBeGreaterThan(3) // the walk found something to scan
    expect(findRawDbUses(files)).toEqual([])
  })
})
