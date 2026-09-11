---
status: accepted
date: 2026-09-11
area: app plane
supersedes:
superseded-by:
---

# ADR-0034 — A saved building names its source and its partition

**Status:** accepted · **Decided:** 2026-09-11 · **Area:** app plane

## Context and Problem Statement

`saved_building` held a `numero_dpe` and nothing else, which was enough while
existing housing was the only tree. The search now reads four (ADR-0018): a
new-build certificate saved from `v1/neuf` came back as an existing-housing
link, and the unique index on `(user_id, numero_dpe)` could not hold the same
numero from two trees.

An audit is worse. Its key is `id_etape`, a UUID that says nothing about where
it lives, and its `numero-exceptions` index is empty (ADR-0031). Saved without
its partition, an audit step could never be opened again.

## Decision Drivers

* A saved row must reopen the record it was saved from, in every source.
* Rows saved before today keep working with no data migration.
* Append-only, idempotent migrations applied by name (CLAUDE.md §10).
* `text` with a CHECK, never an enum.
* The smallest change to a table real users write to.

## Considered Options

* Add `source` and `dept`; `numero_dpe` holds the source's own key.
* Rename `numero_dpe` to `record_key` and add `source` and `dept`.
* Keep the schema and resolve a numero by trying each tree in turn.

## Decision Outcome

Chosen option: **"add `source` and `dept`"**, because it is the only one that
reaches an audit again without a rename or a table rebuild.

| column | type | meaning |
|---|---|---|
| `source` | `text NOT NULL DEFAULT 'existant'`, CHECK in `existant, neuf, tertiaire, audit` | which tree |
| `dept` | `text`, nullable | the partition the row was read from |
| `numero_dpe` | unchanged | the source's key: `numero_dpe`, or `id_etape` for an audit |

The unique index becomes `(user_id, source, numero_dpe)`. `POST /api/buildings`
defaults a missing `source` to `existant` (what a client from before this
meant), refuses an unknown one, refuses a `dept` that is not a partition name,
and refuses an audit without a `dept`.

The migration is written by hand. `drizzle-kit generate` answered the new CHECK
with a table rebuild whose `INSERT … SELECT` copies `source` and `dept` out of
the old table, which does not have them; it also toggles `PRAGMA foreign_keys`
and is not atomic under a runner that sends one statement at a time. SQLite
accepts `ADD COLUMN … NOT NULL DEFAULT … CHECK (…)` directly, so the file is two
`ALTER TABLE`s and an index swap. The generated snapshot is kept, so
`db:check` stays clean.

### Consequences

* Good, because the same numero in two trees is two rows, and each reopens in
  its own tree.
* Good, because every existing row reads as `existant` with no data rewrite.
* Bad, because the column is still called `numero_dpe` while holding an audit's
  `id_etape`. The API field keeps its name too; renaming both is a rebuild.
* Bad, because a failure between the two `ALTER`s would leave that isolate's
  memoised migration rejected until it restarts -- the same exposure 0001 has.
* Neutral, because `dept` is a hint for the existing trees (their numero and
  exceptions index still locate a row) and a requirement only for audits.

### Confirmation

* `test/db/cross-tenant.test.ts`: one row per source, B cannot see or delete
  A's, and the three refusals answer 400.
* `test/db/migrate.test.ts`: a database at 0001 with a saved row upgrades to
  `source = 'existant'`, and the CHECK refuses an unknown source.
* `test/unit/search.test.ts`: the browser's `SOURCES` equals `SAVED_SOURCES`.
* `test/e2e/save.spec.ts`: a saved new-build certificate and a saved audit step
  reopen in their own tree.

## More Information

* Related: [ADR-0003](0003-d1-has-no-rls-and-what-replaces-it.md),
  [ADR-0018](0018-each-source-publishes-its-own-tree.md),
  [ADR-0031](0031-the-energy-audits-are-the-fourth-source.md)
