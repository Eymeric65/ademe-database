---
status: accepted
date: 2026-09-19
area: data plane
supersedes:
superseded-by:
---

# ADR-0041 — A build's high-water mark is the oldest snapshot it was fetched from, not its newest row

**Status:** accepted · **Decided:** 2026-09-19 · **Area:** data plane

## Context and Problem Statement

The weekly delta asks ADEME for `modified:[high_water TO *]` (ADR-0005). The export set
`high_water = MAX(modified)` over the whole build. That is only right if the whole build saw one
snapshot of ADEME, and a base build does not.

ADEME republishes in batches, not continuously, and each batch adds rows dated up to a few days
before it. The existant base ingest walked the départements from 2026-09-06 20:46 to 09-10 21:29,
with a pause between. A batch landed during the pause. The 31 départements loaded before it
(01–29, 2A, 2B) saw ADEME's rows up to 08-31. Those loaded after saw rows up to 09-07. The mark came
out at 09-07, from the late départements. So the early départements' rows dated 09-01..09-06 lay
below the mark, and no delta would ever ask for them. Measured on 2026-09-19 against ADEME:

| modification date | local build | ADEME | gap |
|---|---|---|---|
| 09-01 → 09-03 | 27 211 | 33 471 | **+6 260** |
| 09-04 → 09-06 | 11 217 | 16 298 | **+5 081** |

The gap sat entirely in départements that finished before 2026-09-07 12:05 (dept 05 alone: 2 641).
Reconcile saw these ids appear upstream but only deletes. R2 was patched by hand with a delta
`--since 2026-09-01`. This ADR fixes where the mark comes from.

## Decision Drivers

* A mark that is too late loses rows silently and for good. A mark that is too early only costs a
  refetch, and the merge's anti-join on the key makes the overlap harmless.
* A mark that is too early by months costs hours of ADEME's time every week (CLAUDE.md §11).
* One rule for the base build and the weekly delta, which share `write_manifest`.

## Considered Options

* `MAX(modified)` over the build (the status quo)
* The minimum, over départements, of each département's newest row
* Each département's `started_at`, less a safety margin
* ADEME's own newest modification date, recorded when each fetch starts, and the minimum of those

## Decision Outcome

Chosen option: **"ADEME's newest modification date, recorded at each fetch's start"**. It is the one
option that measures what the fetch actually saw, rather than what it happened to load.

* `api.high_water` asks `GET {api}/metric_agg?metric=max&field=<modified>`. That is one request,
  and it returned 2026-09-14 for dpe03existant on 2026-09-19.
* `ingest_departement` records the answer in `ingest_departement.upstream_high_water` **at a
  département's first start only**. A resumed département's early pages are the older snapshot, as
  with dept 30, which resumed across the same window.
* `fetch_delta` records it before its first page, in its `'delta'` ledger row. That closes the same
  race inside a weekly run: a batch landing mid-pass puts rows behind the cursor.
* `write_manifest` publishes the minimum of the recorded marks. The published format is unchanged
  (an ISO date).

A pass that starts at time T fetches every row dated up to ADEME's maximum at T. The rule assumes a
later batch adds no row dated before that maximum. The measurement supports it: dates ≤ 08-31 showed
no gap in any département. Rows dated on that day are covered because the bound is inclusive.

Why the other options fail:

* **Minimum of each département's newest row.** Measured on the local builds, it gives 2025-12-18
  for existant (dept 975 holds 2 certificates), 2025-12-18 for neuf, 2025-04-29 for tertiaire and
  2026-01-05 for audits. Overseas départements barely change, so every delta would refetch 9–17
  months of France.
* **`started_at` less a margin.** A wall-clock time is not a data date. ADEME dates a row before it
  publishes it, and the margin would be a guess about batch timing.

### Consequences

* Good: a batch landing mid-build or mid-delta can no longer hide rows below the mark.
* Good: the mark is independent of how sparse a département is.
* Bad: one more request per département (105 for existant) and one per delta.
* Neutral: builds made before this ADR recorded no mark. When no ledger row has one, the export
  keeps `MAX(modified)` and says on stderr that the mark may hide a hole. Direct-load test builds,
  which have no ledger rows, stay silent.
* Neutral: a build where some départements recorded a mark and some did not is an old build resumed
  with this code. It publishes `high_water: null`, so `ademe.delta` stops and asks for `--since`
  rather than guessing.
* Neutral: `Loader` adds the column to an older build before resuming it, as it does for `bad_row`.
* Out of scope: reconcile still only deletes the ids it sees appear upstream. Feeding them back into
  the delta, and one weekly job per source, are a separate change.

### Confirmation

* `tests/test_delta.py`:
  * `test_a_build_spanning_a_batch_marks_the_oldest_snapshot` gives 08-31, where it used to give 09-07.
  * `test_the_hole_is_fetched_by_the_next_delta` replays the incident end to end: the missed
    certificate is published after the next delta.
  * `test_a_resumed_departement_keeps_the_mark_of_its_first_start`.
  * `test_a_delta_marks_what_ademe_held_when_it_started` gives 09-14 with a row of 09-16 landing
    mid-pass.
  * `test_a_build_with_some_marks_missing_publishes_no_mark`.
  * `test_a_build_without_marks_keeps_the_max_and_says_so`.
* `test_a_quiet_departement_does_not_drag_the_mark_back` pins the rejected rule. With that rule
  swapped in, it fails with `'2025-12-18' == '2026-09-07'`.
* Live: `test_ademe_names_its_newest_modification` checks all four sources. The mark is an ISO date
  and `[mark TO *]` matches rows.

## More Information

* Refines [ADR-0005](0005-base-built-locally-ci-does-deltas.md): the incremental key is unchanged,
  and this changes where its lower bound comes from.
* Related: [ADR-0014](0014-the-resume-cursor-has-a-shelf-life.md), the other trap of resuming
  across a batch.
