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

  it('upgrades a database from before plans: every account is free and keeps its rows', async () => {
    // What a deployed database holds today: 0000 to 0002, one user and a row
    // in every table that cascades from it. A table rebuild would drop them.
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS _migration (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)',
    ).run()
    for (const m of MIGRATIONS.filter((m) => m.name < '0003')) {
      for (const statement of m.statements) await env.DB.prepare(statement).run()
      await env.DB.prepare('INSERT INTO _migration (name, applied_at) VALUES (?, 0)').bind(m.name).run()
    }
    await env.DB.batch([
      env.DB.prepare("INSERT INTO user (id, name, email) VALUES ('u1', 'u', 'u@example.test')"),
      env.DB.prepare(
        "INSERT INTO session (id, token, user_id, expires_at) VALUES ('s1', 't1', 'u1', 4102444800)",
      ),
      env.DB.prepare(
        "INSERT INTO account (id, user_id, account_id, provider_id) VALUES ('a1', 'u1', 'g1', 'google')",
      ),
      env.DB.prepare("INSERT INTO saved_building (id, user_id, numero_dpe) VALUES ('b1', 'u1', 'X')"),
    ])

    expect(await migrate(env.DB)).toContain('0003_user_plan')
    expect(await env.DB.prepare("SELECT plan FROM user WHERE id = 'u1'").first()).toEqual({ plan: 'free' })
    for (const table of ['session', 'account', 'saved_building']) {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = 'u1'`).first()
      expect(row, table).toEqual({ n: 1 })
    }
  })

  it('renames paid to decouverte without dropping a single owned row', async () => {
    // What a deployed database holds today: 0000 to 0004, a comped account
    // with a row in every table that cascades from `user`, and a free one.
    // D1 enforces foreign keys whatever PRAGMA says, so a `user` table rebuild
    // would cascade-delete all of them. See ADR-0049.
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS _migration (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)',
    ).run()
    for (const m of MIGRATIONS.filter((m) => m.name < '0005')) {
      for (const statement of m.statements) await env.DB.prepare(statement).run()
      await env.DB.prepare('INSERT INTO _migration (name, applied_at) VALUES (?, 0)').bind(m.name).run()
    }
    await env.DB.batch([
      env.DB.prepare("INSERT INTO user (id, name, email, plan) VALUES ('u1', 'u', 'u@example.test', 'paid')"),
      env.DB.prepare("INSERT INTO user (id, name, email) VALUES ('u2', 'v', 'v@example.test')"),
      env.DB.prepare(
        "INSERT INTO session (id, token, user_id, expires_at) VALUES ('s1', 't1', 'u1', 4102444800)",
      ),
      env.DB.prepare(
        "INSERT INTO account (id, user_id, account_id, provider_id) VALUES ('a1', 'u1', 'g1', 'google')",
      ),
      env.DB.prepare("INSERT INTO saved_building (id, user_id, numero_dpe) VALUES ('b1', 'u1', 'X')"),
      env.DB.prepare(
        `INSERT INTO saved_search (id, user_id, name, spec) VALUES ('q1', 'u1', 'q', '{}')`,
      ),
      env.DB.prepare(
        "INSERT INTO subscription (id, user_id, subscription_id, status) VALUES ('c1', 'u1', 'sub_1', 'active')",
      ),
    ])

    const applied = await migrate(env.DB)
    expect(applied.filter((n) => n >= '0005')[0]).toMatch(/^0005_/)
    expect(
      (await env.DB.prepare('SELECT id, plan FROM user ORDER BY id').all()).results,
    ).toEqual([
      { id: 'u1', plan: 'decouverte' },
      { id: 'u2', plan: 'free' },
    ])
    for (const table of ['session', 'account', 'saved_building', 'saved_search', 'subscription']) {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = 'u1'`).first()
      expect(row, table).toEqual({ n: 1 })
    }
    // Idempotent: a second run applies nothing and changes nothing.
    expect(await migrate(env.DB)).toEqual([])
    expect(await env.DB.prepare("SELECT plan FROM user WHERE id = 'u1'").first()).toEqual({
      plan: 'decouverte',
    })
  })

  it('retries a migration that failed halfway as if it had never started', async () => {
    // 0005 is four statements. If the third fails, the first must not stay
    // behind: a retry would then die on "duplicate column" for ever.
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS _migration (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)',
    ).run()
    for (const m of MIGRATIONS.filter((m) => m.name < '0005')) {
      for (const statement of m.statements) await env.DB.prepare(statement).run()
      await env.DB.prepare('INSERT INTO _migration (name, applied_at) VALUES (?, 0)').bind(m.name).run()
    }
    await env.DB.prepare("INSERT INTO user (id, name, email, plan) VALUES ('u1', 'u', 'u@example.test', 'paid')").run()
    // An index on `plan` makes DROP COLUMN refuse: a failure after ADD.
    await env.DB.prepare('CREATE INDEX blocker ON user (plan)').run()
    await expect(migrate(env.DB)).rejects.toThrow()
    const columns = await env.DB.prepare("SELECT name FROM pragma_table_info('user')").all<{ name: string }>()
    expect(columns.results.map((c) => c.name)).not.toContain('plan_next')

    await env.DB.prepare('DROP INDEX blocker').run()
    expect((await migrate(env.DB)).some((n) => n.startsWith('0005_'))).toBe(true)
    expect(await env.DB.prepare("SELECT plan FROM user WHERE id = 'u1'").first()).toEqual({ plan: 'decouverte' })
  })

  it('refuses a plan outside the list, paid included', async () => {
    await migrate(env.DB)
    await env.DB.prepare("INSERT INTO user (id, name, email) VALUES ('u1', 'u', 'u@example.test')").run()
    for (const plan of ['gold', 'paid']) {
      await expect(
        env.DB.prepare('UPDATE user SET plan = ? WHERE id = ?').bind(plan, 'u1').run(),
        plan,
      ).rejects.toThrow(/CHECK/i)
    }
    await env.DB.prepare("UPDATE user SET plan = 'decouverte' WHERE id = 'u1'").run()
    // A new account is still free by default.
    await env.DB.prepare("INSERT INTO user (id, name, email) VALUES ('u2', 'v', 'v@example.test')").run()
    expect(await env.DB.prepare("SELECT plan FROM user WHERE id = 'u2'").first()).toEqual({ plan: 'free' })
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
