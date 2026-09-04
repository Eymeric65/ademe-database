---
status: accepted
date: 2026-09-04
area: security
supersedes:
superseded-by:
---

# ADR-0003 — D1 has no row-level security, so the controls move into code and into tests

**Status:** accepted · **Decided:** 2026-09-04 · **Area:** security

## Context and Problem Statement

The sibling projects `modescore-activescore-online-platform` and `local-database-agregator` both
converged, independently, on the same authorization mechanism: **scope roles, `SECURITY DEFINER`
entry points owned by a role that owns nothing, and `pgPolicy` declared in the Drizzle schema.**
Its migration header states why:

> the entry-point functions are SECURITY DEFINER and owned by `modescore_scoped`, a role that owns
> nothing … which is the whole reason for doing this in the database instead of in a WHERE clause a
> future handler can forget.

That mechanism cost two weeks. **D1 has none of its primitives** — no roles, no RLS, no policies,
no `SECURITY DEFINER`, no `current_setting`. Choosing D1 for the app plane throws the mechanism away
and returns enforcement to application code, which is the shape that produced the incident recorded
in that project's ADR-0022, where deleting one `.where()` would have rewritten every row in the
register *and reported success*.

## Decision Drivers

* Eymeric wants this project entirely on Cloudflare.
* The app plane is tiny: accounts and a little saved state.
* The failure mode is silent in the dangerous direction and unbounded in blast radius.
* Postgres would keep the mechanism but adds an external dependency and a connection path.

## Considered Options

* D1, with enforcement in application code
* Neon Postgres via Hyperdrive, keeping the existing RLS mechanism verbatim
* D1 now behind an interface shaped so the queries could move to Postgres later

## Decision Outcome

Chosen option: **"D1, with enforcement in application code"** — taken knowingly, with the loss
recorded here rather than discovered later.

Because the database can no longer refuse, the controls have to make a mistake hard to write and
easy to catch. Four, all lifted from the sibling repos:

1. **One choke point.** `server/db.ts` is the only module that may hold a handle. It exports scoped
   functions, never `db`. A missing caller subject becomes `''` rather than `NULL`, so predicates
   against `NOT NULL` columns are FALSE and an unauthenticated request reads **zero rows rather than
   everything**.
2. **A grep test** that fails if `drizzle(` or `env.DB` appears outside that module. This is what
   substitutes for the owner-exemption that policies gave for free.
3. **A default-deny route gate stated as an exception list**, applied once in the router, so a route
   added later is protected by default.
4. **An allowlist test that greps the route declaration**: an operation is owner-scoped unless named
   in `SELF_SCOPED`, so widening one is an edit somebody justifies in review.

And the test that actually stands in for the policy: **a cross-tenant probe signing in as two real
users and asserting neither can reach the other's rows, run on every PR.** The equivalent bug in the
sibling project *"was found on the sandbox with a real Cognito token, not by the suite"*, because
every local test connected as a superuser and was exempt from the policy. Here there is no policy to
be exempt from, which makes the probe the only real guard.

### Consequences

* Good, because the whole stack stays on Cloudflare and the app plane costs ~$0.
* Good, because the controls are cheap on day one; they are expensive only if retrofitted.
* **Bad, because a forgotten predicate is a full-table read or write, and nothing in the database
  will stop it.** This is the known cost of the decision.
* Neutral: ADR-0001's separation means moving the app plane to Postgres later touches nothing else.
