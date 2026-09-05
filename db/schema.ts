/**
 * App-plane schema. Accounts and saved state, nothing else.
 *
 * The 15.5M public certificates are Parquet on R2 and never appear here --
 * they have no owner, so there is nothing to scope. See ADR-0001.
 *
 * Three conventions, carried from the sibling Postgres projects because they
 * are about correctness rather than dialect:
 *
 *  - `text` with a CHECK, never an enum type.
 *  - Foreign keys everywhere, each with an explicit onDelete and none with
 *    onUpdate: ids never change.
 *  - `updatedAt` is set by the handler that writes the row, never by a trigger.
 *    A trigger would be invisible in this file, which is the single source of
 *    truth.
 *
 * Every table that belongs to somebody carries `userId`. That column is the
 * only thing standing between one account and another -- D1 has no row-level
 * security to fall back on, which is what ADR-0003 is about.
 */

import { sql } from 'drizzle-orm'
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

const now = sql`(unixepoch())`

// --- Better Auth -----------------------------------------------------------
// Shape is dictated by Better Auth's Drizzle adapter; only the FK actions are
// ours.
//
// TRAP: every timestamp here is `{ mode: 'timestamp' }`, and that is not
// cosmetic. Better Auth binds Date objects, and a plain `integer` column takes
// them verbatim -- D1 then rejects the statement and sign-up fails with a bare
// FAILED_TO_CREATE_USER that names nothing. The mode changes the TypeScript
// type only; the generated SQL is identical, so there is no migration for it
// and `db:check` stays clean. See ADR-0008.

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(now),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(now),
}, (t) => [uniqueIndex('user_email_unique').on(t.email)])

export const session = sqliteTable('session', {
  id: text('id').primaryKey(),
  token: text('token').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(now),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(now),
}, (t) => [
  uniqueIndex('session_token_unique').on(t.token),
  index('session_user_idx').on(t.userId),
])

export const account = sqliteTable('account', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp' }),
  refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp' }),
  scope: text('scope'),
  idToken: text('id_token'),
  // Better Auth 1.7 writes this for OIDC providers. Absent, the adapter
  // refuses the whole account model at runtime rather than at build time.
  issuer: text('issuer'),
  password: text('password'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(now),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(now),
}, (t) => [
  uniqueIndex('account_provider_unique').on(t.providerId, t.accountId),
  index('account_user_idx').on(t.userId),
])

export const verification = sqliteTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(now),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(now),
}, (t) => [index('verification_identifier_idx').on(t.identifier)])

// --- Owned application state ----------------------------------------------

/**
 * A certificate the user kept. `numeroDpe` is a reference into the data plane,
 * deliberately NOT a foreign key: the data plane is a set of files that get
 * rebuilt weekly, and a certificate can be superseded or withdrawn upstream.
 * A dangling reference is a fact about ADEME's data, not a broken row here.
 */
export const savedBuilding = sqliteTable('saved_building', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  numeroDpe: text('numero_dpe').notNull(),
  note: text('note'),
  createdAt: integer('created_at').notNull().default(now),
  updatedAt: integer('updated_at').notNull().default(now),
}, (t) => [
  // One row per certificate per user; saving twice updates the note.
  uniqueIndex('saved_building_user_dpe_unique').on(t.userId, t.numeroDpe),
  index('saved_building_user_idx').on(t.userId),
])

/** A filter the user named and kept. `spec` is the serialised QuerySpec. */
export const savedSearch = sqliteTable('saved_search', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  spec: text('spec', { mode: 'json' }).notNull(),
  visibility: text('visibility').notNull().default('private'),
  createdAt: integer('created_at').notNull().default(now),
  updatedAt: integer('updated_at').notNull().default(now),
}, (t) => [
  index('saved_search_user_idx').on(t.userId),
  // text + CHECK, never an enum type.
  check('saved_search_visibility_known', sql`${t.visibility} in ('private', 'unlisted')`),
])

export type User = typeof user.$inferSelect
export type SavedBuilding = typeof savedBuilding.$inferSelect
export type SavedSearch = typeof savedSearch.$inferSelect
