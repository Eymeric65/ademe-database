---
status: accepted
date: 2026-09-05
area: identity
supersedes:
superseded-by:
---

# ADR-0008 — Better Auth built per request, Google-only in production, passwords behind a switch

**Status:** accepted · **Decided:** 2026-09-05 · **Area:** identity

## Context and Problem Statement

The app plane needs real sessions: every row in `saved_building` and `saved_search` has an owner,
and ADR-0003 records that D1 has no row-level security to fall back on, so `caller.sub` is the only
thing standing between one account and another. It has to be a genuine subject, not a stub.

Two constraints shape the answer. A Worker's bindings arrive on `env`, which exists only inside
`fetch` — there is no module-level moment at which a database handle is available. And the control
that matters most, the cross-tenant probe ADR-0003 calls the only real guard, requires **being two
different users inside CI**. A Google OAuth round-trip cannot be automated.

## Decision Drivers

* `server/db.ts` must remain the only module holding a database handle (CLAUDE.md §9).
* Production's authentication surface should be exactly as large as it needs to be.
* The cross-tenant test has to be able to sign in as two users, headlessly, on every PR.
* A preview must be usable by a human, on a host that changes per branch.

## Considered Options

* Google only, and no automated cross-tenant test
* Google only, with CI fabricating session rows directly
* Google in production, email+password behind an environment switch

## Decision Outcome

Chosen option: **"Google in production, email+password behind `AUTH_TEST_CREDENTIALS`"**.

```ts
emailAndPassword: { enabled: env.AUTH_TEST_CREDENTIALS === '1' }
```

The variable is set in `env.preview` in `wrangler.jsonc` and by the test runner's bindings. **It is
never set in production.**

Fabricating session rows was rejected outright. A test that writes its own session proves the
schema accepts a row; it proves nothing about whether signing in produces a caller the router
agrees with, which is the part that can break. The cross-tenant probe has to travel the same path a
real request does or it is asserting the wrong thing.

### Built per request

`authFor(env, origin)` constructs the instance inside `fetch`. The drizzle handle goes **into**
`drizzleAdapter` and never comes back out, so `server/db.ts` is still the only module that holds
one and `test/unit/no-raw-db.test.ts` stays green without an exemption.

`baseURL` is `env.BETTER_AUTH_URL || origin`. Production pins it to `https://recherche-maison.com`,
which is the host Google was told about. Previews leave it unset and fall back to the request's own
origin, because `wrangler versions upload --preview-alias` gives every branch its own
`<alias>-ademe-app-preview` host and no single static value could be right for all of them.

### Two schema changes, both forced by the library

* **`account.issuer`** — Better Auth 1.7's Drizzle adapter refuses the whole `account` model at
  runtime if the column is absent, with `BetterAuthError: The field "issuer" does not exist`.
  Appended as `db/migrations/0001_account_issuer.sql`; `0000` is untouched (CLAUDE.md §10).
* **`{ mode: 'timestamp' }` on every Better Auth timestamp column.** The library binds `Date`
  objects. A plain `integer` column takes them verbatim and D1 rejects the statement, surfacing as
  a bare `FAILED_TO_CREATE_USER` that names nothing. The mode changes the TypeScript type only —
  the generated SQL is identical, so there is no migration and `db:check` stays clean. That is
  exactly what makes it dangerous: it is invisible in a migration diff, which is why it is a trap
  comment in `db/schema.ts`.

The owned tables keep plain integers; their handlers write `Math.floor(Date.now() / 1000)` and
CLAUDE.md §10 requires that to stay in the handler.

### Consequences

* Good, because production's password surface does not exist, and the ADR names the one variable
  that would create it.
* Good, because the cross-tenant probe in PR 4 can be two real users on every CI run.
* Good, because an auth failure resolves to `callerFrom(null)` — an empty subject, matching zero
  rows — so an auth outage cannot become an authorization bypass.
* Bad, because a misconfigured `env.preview` would enable passwords somewhere unintended. The blast
  radius is the preview D1, which holds no real user data.
* Neutral, because `/api/auth/*` is a wildcard route in `ROUTES`: Better Auth owns many paths and
  routes them itself, so enumerating them would mean the router drifting on every upgrade.

### Confirmation

* `test/db/auth.test.ts` — sign-up then `/api/me` returns that email; no cookie is 401; two users
  never see each other's identity.
* `test/db/auth.test.ts` → "the AUTH_TEST_CREDENTIALS switch, in its OFF position" — `authFor` built
  without the variable refuses the identical request that it accepts with the variable set. Both
  directions, so neither half is vacuous.
* `test/unit/authorization.test.ts` (PR 4) — `/api/auth/*` is in the `public` allowlist, so
  widening that set is an edit somebody has to justify.

## More Information

* Related: [ADR-0003](0003-d1-has-no-rls-and-what-replaces-it.md) — the reason the subject has to
  be real.
