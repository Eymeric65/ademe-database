---
status: accepted
date: 2026-09-10
area: data plane
supersedes:
superseded-by:
---

# ADR-0015 — A certificate that cannot be loaded is quarantined, not fatal

**Status:** accepted · **Decided:** 2026-09-10 · **Area:** data plane

## Context and Problem Statement

The national import is a 15.5M-row unattended job. It has been attempted twice and stopped twice,
both times on **one row**:

| | rows in | stopped by |
|---|---|---|
| 2026-09-06 | 3 062 035 | `OverflowError` — one certificate declaring a ceiling 5.5 × 10^181 m high |
| 2026-09-10 | 3 142 035 | `IntegrityError` — one certificate re-served by a resumed cursor |

Each was fixed on its merits (ADR-0004's encoding contract; ADR-0014's idempotence). But fixing two
specific rows is not the lesson. **The resumability spine was never the problem** — the ledger keeps
a cursor per département, a page loads in a transaction, and no row was ever lost: both crashes
resumed exactly where they stopped. What failed both times was that the *process* died, and a
machine that has stopped at 03:00 stays stopped until somebody notices.

`load_page` iterates certificates and any exception on any one of them propagates out through
`main()`. With 15.5M rows from a public API nobody validates, the next unknown-shaped value is not a
risk to be eliminated; it is a certainty to be survived.

## Decision Drivers

* Two crashes, two single rows, ~19 hours of wall clock lost between them — none of it to lost data.
* The unknown next one. Two of 3M rows were fatal, so the rate is real but tiny, and every one of
  them costs the rest of the run.
* Silence is not an acceptable alternative to crashing. A load that swallowed every bad row would
  turn a schema change upstream into a build that publishes empty and green — §3's exact warning,
  and worse than the crash it replaced.
* Speed. The per-row path runs 15.5M times; child rows are inserted with `executemany` across seven
  tables because a round trip per certificate is the difference between 500 rows/s and a crawl.

## Considered Options

* Keep fixing each failure class as it appears
* Validate every value before insert
* Quarantine the row, continue the load, and refuse to publish an unreviewed quarantine

## Decision Outcome

Chosen option: **"quarantine, continue, refuse to publish unreviewed"**.

A certificate that raises goes to `bad_row` with its raw CSV and the exception text, and the load
carries on. `finalise` then refuses to do anything with a database whose `bad_row` is non-empty
unless the count is acknowledged with `--allow-bad-rows N`. Quarantine buys the run's survival; the
gate is what stops it also buying silence.

Validating every value up front was rejected for the reason the first crash exists: the schema does
not describe the data. `hauteur_sous_plafond` is a documented decimal, and the value that broke it
was a documented decimal. Only the write knows what SQLite will take.

### Two paths, so the common one pays nothing

The fast path is the existing batched load. It runs inside `SAVEPOINT page`. If it raises, the page
is rolled back whole and replayed one certificate at a time, each in `SAVEPOINT row`, and whatever
fails is quarantined. **A page has to actually break before anything is slower.**

TRAP, and the reason a savepoint alone is not enough: `adresse_id` and `commune_id` write a row and
*cache its id*. Roll the write back and the id is gone, but a cache still handing it out would give
every later certificate at that address a dangling `adresse_id` — accepted in silence, because the
load runs with `PRAGMA foreign_keys = OFF`, and surfacing twelve hours later as a
`foreign_key_check` failure in `finalise`. The caches are therefore trimmed back alongside every
rollback.

### Consequences

* Good, because the next unknown row costs one line in `bad_row` instead of the remaining hours.
* Good, because the raw CSV is kept, so a quarantined certificate can be diagnosed rather than
  guessed at — the two rows above each took a live API refetch to identify.
* Good, because `finalise` checks the quarantine *before* the hour of index building, so a broken
  build fails in seconds.
* Bad, because a build can now be published knowingly incomplete. `--allow-bad-rows` is deliberately
  awkward: it requires a number, so acknowledging is an act rather than a flag.
* Neutral on speed for a clean load; a page containing a bad row is replayed once, row by row.

### Confirmation

`tests/test_quarantine.py`. A page with one poisoned certificate loads the other two and files the
poisoned one with its raw CSV; the rolled-back row leaves no dangling reference, asserted through
`PRAGMA foreign_key_check` on an address the poisoned row *created* and a later row needs; a clean
page never enters the slow path, asserted by spying on it, so the fast path stays fast; and
`finalise` refuses an unreviewed quarantine before creating any index, then proceeds when
acknowledged.

Reverting the implementation fails four of the five with `ValueError: simulated bad value`
propagating out of `load_page` — which is the defect itself.

## More Information

* Related: [ADR-0004](0004-scaled-integers-are-the-only-lossless-encoding.md),
  [ADR-0005](0005-base-built-locally-ci-does-deltas.md),
  [ADR-0014](0014-the-resume-cursor-has-a-shelf-life.md)
