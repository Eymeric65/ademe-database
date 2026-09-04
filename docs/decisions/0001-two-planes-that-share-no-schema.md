---
status: accepted
date: 2026-09-04
area: architecture
supersedes:
superseded-by:
---

# ADR-0001 — Public data and user data are two applications that share no schema

**Status:** accepted · **Decided:** 2026-09-04 · **Area:** architecture

## Context and Problem Statement

The product joins a large public dataset (ADEME DPE, 15.5M certificates, Licence Ouverte) to a
small amount of user-owned state (accounts, saved buildings, saved searches). A previous project of
Eymeric's put both kinds of data in one database and accumulated authorization debt that took two
weeks to repay: `updateMyPerson` there ran as a table owner, `person` had a SELECT policy and no
UPDATE policy, and the only thing deciding which rows an UPDATE wrote was one `.where()` clause.
Deleting that line would have rewritten every row in the register and reported success.

## Decision Drivers

* The failure mode above is silent in the dangerous direction — a too-wide read looks like a working app.
* DPE rows have **no owner**: the licence is open and no row belongs to a user, so there is nothing to scope.
* Authorization effort should be proportional to the data that actually needs it.
* The two datasets differ by four orders of magnitude in size and by everything in access pattern.

## Considered Options

* One database holding both, scoped by policy or by predicate
* Two schemas in one database, one connection
* Two separate stores that never share a schema or a connection

## Decision Outcome

Chosen option: **"two separate stores"**, because the authorization surface then equals the user
data — a handful of small tables — instead of equalling the whole system. Mixing the two is what
makes every query a place to forget a predicate.

| Plane | Contents | Store | Auth |
|---|---|---|---|
| Data | 15.5M public certificates | Parquet on R2 | none — it is public |
| App | accounts, saved buildings, saved searches | D1 | every read owner-scoped |

The contract that keeps them separate: **the app plane reads the data plane through the same public
interface the browser uses.** No shared connection, no shared schema, no join across the boundary.
Violating that puts the two back in one place with mixed ownership, which is the state this record
exists to prevent.

### Consequences

* Good, because the authorization review surface is a handful of tables rather than the whole system.
* Good, because the public plane can be cached, versioned and rebuilt without touching user data.
* Bad, because a query wanting both must fetch from two places and combine client-side.
* Neutral: the app plane could later move to Postgres without the data plane noticing (see ADR-0003).
