/**
 * Applies db/migrations.generated.ts to a D1 database.
 *
 * TRAP: migrations are tracked BY NAME, never by a high-water mark or an index
 * into the array. Two branches can each add a migration and land in either
 * order, so what has run is a set, not a position. A runner that remembered
 * "applied up to 0003" would silently skip a migration that merged after it.
 *
 * The handle arrives as a parameter and is never opened here, which is what
 * keeps server/db.ts the only module that can reach D1 (CLAUDE.md section 9).
 */

import { MIGRATIONS } from './migrations.generated'

/** Applies whatever has not run yet. Returns the names applied by this call. */
export async function migrate(db: D1Database): Promise<string[]> {
  await db
    .prepare(
      'CREATE TABLE IF NOT EXISTS _migration (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)',
    )
    .run()

  const seen = await db.prepare('SELECT name FROM _migration').all<{ name: string }>()
  const done = new Set(seen.results.map((r) => r.name))

  const applied: string[] = []
  for (const migration of MIGRATIONS) {
    if (done.has(migration.name)) continue
    // D1 takes one statement per call, which is why bundle-migrations.ts splits
    // them. Recording the name last means a half-applied migration is retried
    // rather than skipped.
    for (const statement of migration.statements) {
      await db.prepare(statement).run()
    }
    await db
      .prepare('INSERT INTO _migration (name, applied_at) VALUES (?, ?)')
      .bind(migration.name, Math.floor(Date.now() / 1000))
      .run()
    applied.push(migration.name)
  }
  return applied
}
