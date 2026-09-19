---
status: accepted
date: 2026-09-19
area: identity
supersedes:
superseded-by:
---

# ADR-0038 — A paid plan is a column on the account, and the gate reads it

**Status:** accepted · **Decided:** 2026-09-19 · **Area:** identity

## Context and Problem Statement

Every account starts free. A paid member will see the certificates of the last
two months; a free member will not. Today every signed-in caller downloads each
département's whole Parquet, recent rows included, so hiding them in the UI
would protect nothing. The refusal has to be on the server, which needs to know
two things it does not know today: which accounts are paid, and which files are
paid-only.

Payment is out of scope. An account becomes paid by an operator's `UPDATE` on
D1, and nothing over HTTP can make one paid.

## Decision Drivers

* A caller must not be able to make themselves paid, through any endpoint.
* A downgrade takes effect on the next request, not when a session expires.
* Fail closed: an unknown account, an empty subject or an odd value is free.
* The gate stays one default-deny list applied once in the router (ADR-0003).
* `/data/v1/*` must never be able to name a paid file.
* Append-only migrations, and no table rebuild of `user` (CLAUDE.md §10).

## Considered Options

* A `plan` column on `user` that Better Auth is never told about, read by a
  scoped `planOf` in the gate.
* The same column, registered in Better Auth's `user.additionalFields` so it
  arrives on the session.
* A separate `subscription` table keyed by `user_id`.

## Decision Outcome

Chosen option: **"a `plan` column Better Auth does not know about"**, because
Better Auth copies only the fields it knows from a sign-up or `update-user`
body, so the column is out of every caller's reach, and it is the smallest
change that carries the one fact needed.

| column | type | meaning |
|---|---|---|
| `plan` | `text NOT NULL DEFAULT 'free'`, CHECK in `free, paid` | what the account may read |

When Better Auth creates a user it does not name `plan`, so the column default
fills it: every account, old or new, is free.

The migration is written by hand, as 0002 was (ADR-0034). `drizzle-kit
generate` answered the CHECK with a rebuild of `user` whose `INSERT … SELECT`
reads a `plan` the old table does not have, and whose `DROP TABLE user`
cascades to every session, account and saved row. SQLite accepts
`ADD COLUMN … NOT NULL DEFAULT … CHECK (…)` directly, so the file is one
`ALTER TABLE`. The generated snapshot is kept, so `db:check` stays clean.

The router gains a scope and a route:

* `'paid'` is `signed-in` plus the caller's plan. It is checked after the
  401/404 checks, in the same place, by `planOf(env, caller)` in
  `server/db.ts`. `planOf` reads the `user` row by primary key on every
  request and answers `'paid'` only for exactly `'paid'`. A free caller gets
  403.
* `/data/recent/*` is the one `'paid'` route. Paid files live under their own
  top-level R2 prefix, `recent/`, so no `/data/v1/*` key can reach one, and
  `serveObject` already refuses `..`. It answers `Cache-Control: no-store`:
  the browser cache is keyed by URL, not by account, so a paid file kept there
  would reach the next account to sign in on that browser.
* `/api/me` also returns `plan`, for the UI to decide what to fetch. The UI is
  never what enforces it.

To make an account paid, or free again:

```bash
wrangler d1 execute ademe-app --remote \
  --command "UPDATE user SET plan='paid', updated_at=unixepoch() WHERE email='…'"
```

On a preview, the same against `ademe-app-preview`.

### Consequences

* Good, because no request body can reach the column: it is unknown to Better
  Auth, and no route writes it.
* Good, because a downgrade is refused on the very next request.
* Good, because a new paid route is one scope word, gated by the router rather
  than by whoever adds it.
* Bad, because every request to a paid route costs one extra D1 read by
  primary key. Only paid routes pay it.
* Bad, because paid files are never cached by the browser, so a paid member
  re-downloads the ranges they read. The recent tree is small.
* Neutral, because `/data/*` no longer "scopes nothing": the recent tree is
  scoped by plan, though still not by owner.

### Confirmation

* `test/unit/authorization.test.ts`: the `'paid'` routes equal a `PAID`
  allowlist, no `/api` route is `'paid'`, and no other route covers
  `/data/recent/…`. The last check is itself tested against a synthetic
  `/data/*` route.
* `test/db/gate.test.ts`: a free account gets 403 on GET, ranged GET and ranged
  HEAD; a paid one gets 206 with `no-store`; a downgrade is refused on the next
  request; encoded traversal from `/data/v1/` or `/data/vendor/` never works.
* `test/db/cross-tenant.test.ts`: every `'paid'` route in `ROUTES` answers 403
  to a signed-in free account, and A paid never lends the tree to B free.
* `test/db/auth.test.ts`: `/api/me` reports the plan, and a `plan` sent in a
  sign-up or `update-user` body leaves the account free. Registering `plan` in
  `additionalFields` turns both red.
* `test/db/migrate.test.ts`: a database at 0002 with a user and a session,
  account and saved row upgrades to `plan = 'free'` with every row kept, and
  the CHECK refuses `'gold'`.

## Pros and Cons of the Options

### Registered in `additionalFields`

* Good, because the plan would arrive on the session with no extra read.
* Bad, because Better Auth then accepts the field from sign-up and
  `update-user` bodies, and any caller makes themselves paid. The test that
  proves this is in `test/db/auth.test.ts`.

### A `subscription` table

* Good, because it has room for billing state when payment arrives.
* Bad, because none of that exists yet, and a second table with its own FK and
  scoped reads is more to get wrong for one bit of information.

## More Information

* Related: [ADR-0003](0003-d1-has-no-rls-and-what-replaces-it.md),
  [ADR-0008](0008-better-auth-per-request-google-only-in-production.md),
  [ADR-0012](0012-the-data-plane-is-served-through-the-worker.md),
  [ADR-0034](0034-a-saved-building-names-its-source-and-partition.md)
