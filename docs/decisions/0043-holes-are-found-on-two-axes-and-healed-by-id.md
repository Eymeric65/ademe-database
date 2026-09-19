---
status: accepted
date: 2026-09-20
area: data plane
supersedes:
superseded-by:
---

# ADR-0043 — A hole is found on two axes and healed by id

**Status:** accepted · **Decided:** 2026-09-20 · **Area:** data plane

## Context and Problem Statement

Reconciliation finds two kinds of divergence and can act on only one. `Divergence.gone` is deleted
(ADR-0007, narrowed by key range in ADR-0040). `Divergence.appeared` — the ids ADEME holds and the
published tree does not — is printed as a `::warning::` telling a person to re-run the delta with an
earlier `--since`. Nobody does that every Monday. The weekly run has reported the same ~7,300 ids
"new upstream" in départements 01–2B on every pass since the base build, and the 11.7k-row hole of
ADR-0041 was patched by hand.

There is also a hole no count per département can see at all. If we hold a certificate at an older
version than ADEME's — the row is here, the id is here, the département is here, only the content is
stale — every count agrees. That is what a mark set too late produces: ADR-0041 fixed where the mark
comes from, so no new such row is created, but it says nothing about the ones already published.

ADR-0041 left both out by name: "feeding them back into the delta … is a separate change."

## Decision Drivers

* A hole that needs a person is a hole that stays. The weekly job runs unattended.
* The ETL is polite: one stream, and no work ADEME did not have to do (CLAUDE.md §11).
* A wrong deletion is worse than a late one, and a repair rewrites published files.
* The runner's disk already holds the published tree, its merge and a reconciled copy.

## Considered Options

* Keep warning, and re-run the delta by hand with `--since`
* Re-run the delta automatically from an earlier mark
* Fetch the missing ids by id, and find them on two axes: the key and the modification date
* Sample published rows at random each week and compare them whole

## Decision Outcome

Chosen option: **"fetch by id, found on two axes"**.

**Axis 1 — the key, which exists.** `reconcile` already produces `appeared` for the price of the
counts it was making anyway.

**Axis 2 — the modification date.** `delta.date_holes` counts published rows per month of the
modified field and asks ADEME for the same window. A month that agrees costs one request. Only a
month that disagrees is split into days, and only a day that disagrees has its ids pulled
(`select=<key>`) and diffed against the ids published under that date. What comes back is what
upstream holds and we do not: **missing, or here under another date, which is a stale version.**

Measured live, 2026-09-20, over each source's whole history:

| source | months | counting them | the counts add up to |
|---|---|---|---|
| existing housing | 63 | **6.7 s** (106 ms each) | 15,604,436 = its total, 0 undated |
| energy audits | 69 | **8.9 s** (129 ms each) | 3,259,086 = its total, 0 undated |

So a clean week's second axis is about seven seconds, and the sums show the windows tile the source
with no gap and no overlap.

**The repair.** The union of both axes goes back through `delta.fetch_ids`: `key:("a" OR "b" …)`,
in chunks of `ID_CHUNK` (100), loaded by the SAME `ingest.Loader` and exported by the SAME exporter
as everything else, then merged. A term must be **quoted** here — the opposite of a range bound,
which Data Fair rejects quoted (ADR-0040).

**One rewrite, not two.** `merge` takes the deletions as well, so the additions and the deletions
land in a single pass over the tree. A repair pass of its own would mean a third whole copy on the
runner.

**The arithmetic is settled before anything is written.** For each partition about to change:
published, less what left, plus what is genuinely new, must equal what ADEME counted this run. Where
it does not, that partition is narrowed again with the incoming ids counted as present — and this is
how **the blind spot of ADR-0007 comes out**: a deletion and an addition that cancelled in the count
no longer cancel once the addition has been found on the date axis. At most two fetch rounds; then
it raises and publishes nothing.

**Two limits, because a repair is ADEME's time too.**

* `MAX_REPAIR` (50,000 rows, a `workflow_dispatch` input): past it, publish nothing and say what to
  run by hand.
* `MAX_HOLE_DAYS` (60): more days than that disagreeing is a republication upstream, not a hole.

**TRAP, and the reason this ADR is not just "fetch the ids": the repair must not move the mark.**
Its rows are fetched by id, of any age, and the newest of them says nothing about what ADEME held
when anything was fetched. Adopting it as `high_water` would skip every modification in between —
the hole of ADR-0041, dug again by the thing that fills it. `merge(keep_mark=True)` pins it.

Why the others fail:

* **Re-running the delta from an earlier mark.** It refetches every row modified since, whole, to
  find a handful — 9–17 months of France in the case ADR-0041 measured, every week.
* **A random sample.** It gives a rate, not the rows, and no week's sample proves anything about a
  particular hole.

### Consequences

* Good: the ~7,300 ids reported every week since the base build are fetched and published, and the
  next week's report is empty rather than identical.
* Good: a stale version is now detectable at all, which no count per partition could do.
* Good: the blind spot of ADR-0007 narrows — a swap now has to cancel in the same key range **and**
  on the same day.
* Bad: about seven to nine seconds a week per source for the month counts, plus the day counts and
  id pulls of any month that disagrees.
* Bad: a hole bigger than the cap stops the source's job, which publishes nothing that week. That is
  the existing fail-closed behaviour, and the message says what to run.
* Neutral: the reconcile step now runs in a quiet week too, where it used to be skipped for the
  sources whose delta wrote no tree. A hole is not made by this week's modifications.
* Residual blind spot: a row ADEME holds under a date outside the months walked (older than the
  oldest month published here) is invisible to the date axis — the key axis finds it, by count. A
  swap inside one key range *and* one day is invisible to both.

### Confirmation

`tests/test_delta.py`, each proven by putting the defect back:

* `test_an_id_missing_here_is_fetched_whole_and_published`, and
  `test_a_row_older_than_anything_published_is_found_by_the_key_axis` — with the key axis removed:
  `assert [] == ['2409E0000009']`.
* `test_a_stale_version_is_found_by_its_date_and_replaced` and
  `test_a_swap_that_hides_from_the_key_ranges_is_found_by_date` — with the date axis removed:
  `assert [] == ['2409E0000002']` and `assert [] == ['2409E0000099']`.
* `test_a_repair_never_moves_the_mark` — without `keep_mark`: `assert '2026-09-30' == '2026-08-02'`.
* `test_a_repair_over_the_cap_publishes_nothing_and_names_the_command` and its script twin —
  without the cap: `Failed: DID NOT RAISE ReconcileError`.
* `test_a_repair_refuses_when_upstream_will_not_hand_over_what_it_counted`,
  `test_a_republication_is_not_repaired_quietly`, `test_agreeing_months_pull_no_ids`.
* `test_the_weekly_job_repairs_through_the_script` runs `scripts/reconcile.py --repair`, which is
  what the job runs.
* Live: `test_an_id_list_query_returns_exactly_those_ids` (all four sources, 100 ids in one query)
  and `test_month_windows_tile_the_source`.
* `tests/test_workflows.py::test_a_hole_is_repaired_every_week_even_when_the_delta_fetched_nothing`.

## More Information

* Refines [ADR-0007](0007-the-delta-cannot-see-deletions-so-reconcile-by-count.md): counts first
  still stands, and reconciliation is no longer deletions-only.
* Refines [ADR-0040](0040-reconcile-narrows-a-mismatch-by-counting-key-ranges.md): the same
  narrowing, now on a second axis.
* Completes [ADR-0041](0041-a-builds-high-water-mark-is-the-oldest-snapshot-it-was-fetched-from.md):
  that one stopped new holes; this one closes the ones already published.
