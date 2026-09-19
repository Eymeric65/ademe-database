---
status: accepted
date: 2026-09-19
area: data plane
supersedes:
superseded-by:
---

# ADR-0040 — Reconcile narrows a mismatch by counting ranges of the key, not by pulling every id

**Status:** accepted · **Decided:** 2026-09-19 · **Area:** data plane

## Context and Problem Statement

ADR-0007 reconciles each partition by count and, on a mismatch, pulls every id of the département
and set-differences it. That was costed on existing housing: 16 B a row and 4.2 s for département 09.

The scheduled run of 2026-09-14 (run 34829784527, #2) was cancelled at the job's 120-minute limit
inside `reconcile.py --source audit`. Every other step had finished in 88 minutes. The audits delta
since 2026-08-31 had grown to 28,477 rows, so the audit partitions' counts no longer matched ADEME's,
and each mismatch pulled its whole département. Audit ids are much dearer than housing ids:

| `select=<key>`, 10,000-row pages, with a key | ids/s | per page | B/row |
|---|---|---|---|
| existing housing, `numero_dpe`, département 09 | 7,400 | 1.2 s | 16.0 |
| audits, `id_etape`, départements 09 and 75 | ~800 | ~13 s | 39.0 |

About 1 ms of server time per audit row. No query shape changed it much: without sort, as JSON, or
without the département filter, pages still took 4–13 s. The whole audits set (3.2M ids) is ~67 minutes
with a key, and CI had none (ADEME grants anonymous callers 20 s of processing per minute).

## Decision Drivers

* The ETL is polite: one stream, and no work ADEME did not have to do (CLAUDE.md §11).
* A wrong deletion is worse than a late one; upstream must agree with itself before a row is deleted.
* The same code reconciles every source, whatever its key looks like.

## Considered Options

* Raise the job's time limit and keep pulling whole départements
* Narrow by counts over ranges of the partition's own key
* Narrow by counts over another field (commune, establishment date)

## Decision Outcome

Chosen option: **"narrow by counts over ranges of the key"**. A count costs one request of 0.1–0.8 s
on either source, and an id costs 1 ms of ADEME's time on audits. So a mismatch is followed down
with counts, and only the ranges that still disagree are pulled.

`delta._narrow`, per mismatched partition, with the partition's published keys sorted:

1. Cut the range at its published quantiles into up to `FANOUT` (8) sub-ranges `key:[lo TO hi}`,
   the first and last open-ended so ids that appeared outside the published span are counted too.
2. Count each sub-range upstream (AND-ed with the département's clause, summed over its codes).
   A sub-range whose count equals its published rows is done.
3. Split a disagreeing sub-range again, until it holds `LEAF` (2,000) published rows or fewer. Then
   pull its ids alone, check they number exactly its count (else `ReconcileError`), and diff.

Measured live on audits, département 09 (12,968 rows), with 3 ids gone and 1 appeared: **8 counts
and 3,240 ids, 6.8 s**, where the whole-département pull was 12,968 ids. The report is unchanged,
so `apply_deletions`, `scripts/reconcile.py` and `check_delta.py` did not move.

Why the key and not another field: the key is in both the Parquet and the API, is exact, and is
unique, so ranges of it tile a département with no overlap and no gaps. A commune or a date would
need to be identical on both sides. A modification date is not: it moves under a row.

### Consequences

* Good: the cost of a mismatch follows the number of rows that differ, not the size of the département.
* Good: nothing changes where every count agrees, which is most partitions in most weeks.
* Bad: the blind spot ADR-0007 records remains, only narrower. A deletion and an addition inside
  the same range still cancel. Before, they had to share a département.
* Bad: a département republished wholesale costs slightly more than before (the counts, then the
  same pulls).
* Neutral: Data Fair's `qs` parser rejects a quoted range bound (`Expected "."`), so bounds go in
  bare. Reconcile only cuts at a key matching `[A-Za-z0-9-]+`, which is every `numero_dpe` and
  `id_etape` seen, and pulls a range whole when it has no such cut.

### Confirmation

* `tests/test_delta.py::test_a_mismatch_pulls_the_ids_of_the_ranges_that_disagree_not_the_partition`:
  a 64-row partition with two gone and one appeared pulls at most 8 ids. The old code pulled 63.
* `test_a_key_that_cannot_be_a_bare_range_bound_is_never_cut_at`.
* Live: `test_a_key_range_count_agrees_with_the_ids_behind_it` shows that range counts equal the
  ids behind them for housing and audits, and that ranges tile the ungeocoded bucket.
* The existing reconcile tests are unchanged in meaning: matching counts pull nothing, a lying total
  raises, and the equal-swap blind spot is still pinned.

## More Information

* Refines [ADR-0007](0007-the-delta-cannot-see-deletions-so-reconcile-by-count.md): counts first
  still stands. This changes only what happens after a mismatch.
* Run #2's log was also silent for those 60 minutes, because Python buffers stdout under CI. That,
  and the missing `ADEME_API_KEY` in the workflow, are a separate change.
