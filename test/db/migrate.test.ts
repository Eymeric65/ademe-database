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

  it('upgrades a database from before sources: its saved rows are existing housing', async () => {
    // What a deployed database holds today: 0000 and 0001, and one saved row.
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS _migration (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)',
    ).run()
    for (const m of MIGRATIONS.filter((m) => m.name < '0002')) {
      for (const statement of m.statements) await env.DB.prepare(statement).run()
      await env.DB.prepare('INSERT INTO _migration (name, applied_at) VALUES (?, 0)').bind(m.name).run()
    }
    await env.DB.prepare("INSERT INTO user (id, name, email) VALUES ('u1', 'u', 'u@example.test')").run()
    await env.DB.prepare(
      "INSERT INTO saved_building (id, user_id, numero_dpe) VALUES ('b1', 'u1', 'X')",
    ).run()

    expect(await migrate(env.DB)).toContain('0002_saved_building_source')
    expect(
      await env.DB.prepare("SELECT source, dept FROM saved_building WHERE id = 'b1'").first(),
    ).toEqual({ source: 'existant', dept: null })

    // The same numero in another source is a second row; twice in one is not.
    const save = (id: string) =>
      env.DB.prepare(
        "INSERT INTO saved_building (id, user_id, numero_dpe, source) VALUES (?, 'u1', 'X', 'neuf')",
      )
        .bind(id)
        .run()
    await save('b2')
    await expect(save('b3')).rejects.toThrow(/UNIQUE/i)
  })

  it('refuses a source outside the list', async () => {
    await migrate(env.DB)
    await env.DB.prepare("INSERT INTO user (id, name, email) VALUES ('u1', 'u', 'u@example.test')").run()
    await expect(
      env.DB.prepare(
        "INSERT INTO saved_building (id, user_id, numero_dpe, source) VALUES ('b1', 'u1', 'X', 'bogus')",
      ).run(),
    ).rejects.toThrow(/CHECK/i)
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
