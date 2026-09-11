/**
 * The only module in this repository that may hold a database handle.
 *
 * D1 has no row-level security -- no roles, no policies, no SECURITY DEFINER,
 * no current_setting. The mechanism that protects the sibling Postgres
 * projects does not exist here, and ADR-0003 records that this was chosen
 * knowingly. Since the database can no longer refuse, the refusal has to be
 * structural instead:
 *
 *   - `db` is never exported. Route handlers get scoped functions and cannot
 *     build a query, so there is no place to forget a predicate.
 *   - Every exported function takes a `Caller` and filters on `caller.sub`.
 *   - A missing subject becomes '' rather than null, so every predicate against
 *     a NOT NULL column is FALSE and an unauthenticated request reads ZERO ROWS
 *     rather than everything. Fail closed by construction, not by remembering.
 *
 * test/unit/no-raw-db.test.ts fails the build if `drizzle(` or `env.DB` appears
 * anywhere outside this file. That test is doing the job the owner-exemption
 * used to do for free.
 */

import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { and, desc, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { migrate } from '../db/migrate'
import * as s from '../db/schema'

export type Caller = { sub: string }

/**
 * Build a caller from whatever the session layer produced.
 *
 * TRAP: the empty-string fallback is load-bearing. Returning null here, or
 * making `sub` optional, would let a query be built with no predicate value and
 * match every row. Keep it a non-nullable string that is never a real id.
 */
export function callerFrom(sub: string | null | undefined): Caller {
  return { sub: sub ?? '' }
}

function open(env: { DB: D1Database }) {
  return drizzle(env.DB, { schema: s })
}

// --- saved buildings -------------------------------------------------------

export async function listSavedBuildings(env: { DB: D1Database }, caller: Caller) {
  return open(env)
    .select()
    .from(s.savedBuilding)
    .where(eq(s.savedBuilding.userId, caller.sub))
    .orderBy(desc(s.savedBuilding.createdAt))
    .all()
}

export async function getSavedBuilding(
  env: { DB: D1Database },
  caller: Caller,
  id: string,
) {
  const rows = await open(env)
    .select()
    .from(s.savedBuilding)
    .where(and(eq(s.savedBuilding.id, id), eq(s.savedBuilding.userId, caller.sub)))
    .limit(1)
    .all()
  return rows[0] ?? null
}

export async function saveBuilding(
  env: { DB: D1Database },
  caller: Caller,
  input: { id: string; numeroDpe: string; note?: string | null },
) {
  const at = Math.floor(Date.now() / 1000)
  return open(env)
    .insert(s.savedBuilding)
    .values({
      id: input.id,
      userId: caller.sub,
      numeroDpe: input.numeroDpe,
      note: input.note ?? null,
      createdAt: at,
      updatedAt: at,
    })
    .onConflictDoUpdate({
      target: [s.savedBuilding.userId, s.savedBuilding.numeroDpe],
      set: { note: input.note ?? null, updatedAt: at },
    })
    .returning()
}

export async function deleteSavedBuilding(
  env: { DB: D1Database },
  caller: Caller,
  id: string,
) {
  return open(env)
    .delete(s.savedBuilding)
    .where(and(eq(s.savedBuilding.id, id), eq(s.savedBuilding.userId, caller.sub)))
    .returning()
}

// --- saved searches --------------------------------------------------------

export async function listSavedSearches(env: { DB: D1Database }, caller: Caller) {
  return open(env)
    .select()
    .from(s.savedSearch)
    .where(eq(s.savedSearch.userId, caller.sub))
    .orderBy(desc(s.savedSearch.createdAt))
    .all()
}

export async function saveSearch(
  env: { DB: D1Database },
  caller: Caller,
  input: { id: string; name: string; spec: unknown; visibility?: 'private' | 'unlisted' },
) {
  const at = Math.floor(Date.now() / 1000)
  return open(env)
    .insert(s.savedSearch)
    .values({
      id: input.id,
      userId: caller.sub,
      name: input.name,
      spec: input.spec,
      visibility: input.visibility ?? 'private',
      createdAt: at,
      updatedAt: at,
    })
    .returning()
}

export async function deleteSavedSearch(
  env: { DB: D1Database },
  caller: Caller,
  id: string,
) {
  return open(env)
    .delete(s.savedSearch)
    .where(and(eq(s.savedSearch.id, id), eq(s.savedSearch.userId, caller.sub)))
    .returning()
}

// --- migrations ------------------------------------------------------------

/**
 * Runs pending migrations once per isolate.
 *
 * The Worker has no deploy-time hook that can reach D1, so the schema is
 * brought up to date on the first request an isolate serves. The promise is
 * memoised rather than the result: without that, concurrent first requests each
 * start their own run and race on the same CREATE TABLE.
 */
let migrated: Promise<string[]> | null = null

export function ensureMigrated(env: { DB: D1Database }): Promise<string[]> {
  migrated ??= migrate(env.DB)
  return migrated
}

// --- sessions --------------------------------------------------------------

/**
 * Better Auth, built for one request.
 *
 * Per request rather than per module because the D1 handle arrives on `env`,
 * which only exists inside `fetch`. A module-level instance would have to
 * capture the first request's binding and hand it to every later one.
 *
 * The drizzle handle goes INTO the adapter and never comes back out, so this
 * module is still the only place that holds one and the grep test stays green.
 *
 * see ADR-0008
 */
export function authFor(env: Env, origin?: string) {
  return betterAuth({
    database: drizzleAdapter(open(env), { provider: 'sqlite', schema: s }),
    secret: env.BETTER_AUTH_SECRET,
    // Production pins this to the domain Google was told about. Previews leave
    // it unset and fall back to the request's own origin, because every branch
    // gets its own <alias>-ademe-app-preview host and no single value could be
    // right for all of them.
    baseURL: env.BETTER_AUTH_URL || origin,
    basePath: '/api/auth',
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID ?? '',
        clientSecret: env.GOOGLE_CLIENT_SECRET ?? '',
      },
    },
    // TRAP: production must never set AUTH_TEST_CREDENTIALS. This provider
    // exists so CI can sign in as two users and prove one cannot read the
    // other's rows -- a Google round-trip cannot be automated. Enabling it in
    // production would add a password surface nobody intended to run.
    emailAndPassword: { enabled: env.AUTH_TEST_CREDENTIALS === '1' },
  })
}
