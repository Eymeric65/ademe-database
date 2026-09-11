/**
 * The migration runner, against Miniflare's D1 -- which is real SQLite.
 *
 * The interesting assertion is (c). (a) and (b) prove the bookkeeping table is
 * maintained; only a foreign key firing proves the DDL actually reached the
 * database. Editing db/schema.ts without regenerating leaves a database with
 * *nothing at all* in it, and nothing about that failure is loud.
 */

import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { MIGRATIONS } from '../../db/migrations.generated'
import { migrate } from '../../db/migrate'

async function appliedNames(): Promise<string[]> {
  const r = await env.DB.prepare('SELECT name FROM _migration ORDER BY name').all<{ name: string }>()
  return r.results.map((row) => row.name)
}

describe('migrate', () => {
  it('applies every migration to a fresh database and reports what it applied', async () => {
    const applied = await migrate(env.DB)
    expect(applied).toEqual(MIGRATIONS.map((m) => m.name))
    expect(applied).toContain('0000_init_app_plane')
  })

  it('is idempotent: a second call applies nothing and the ledger has one row each', async () => {
    await migrate(env.DB)
    expect(await migrate(env.DB)).toEqual([])
    expect(await appliedNames()).toHaveLength(MIGRATIONS.length)
  })

  it('really created the schema: a foreign key on saved_building fires', async () => {
    await migrate(env.DB)
    await expect(
      env.DB.prepare(
        "INSERT INTO saved_building (id, user_id, numero_dpe) VALUES ('b1', 'nobody', 'X')",
      ).run(),
    ).rejects.toThrow(/FOREIGN KEY/i)
  })
})
