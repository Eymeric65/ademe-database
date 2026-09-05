---
status: accepted
date: 2026-09-05
area: data plane
supersedes:
superseded-by:
---

# ADR-0007 — The weekly delta cannot see deletions, so counts are reconciled every run

**Status:** accepted · **Decided:** 2026-09-05 · **Area:** data plane

## Context and Problem Statement

`dpe03existant` is a Data Fair **virtual** dataset (`meg-83tjwtg8dyz4vv7h1dqe`) over a private
child, filtered `dpe_desactive = 0`. That field is **not in the public schema**.

The consequence is specific and it breaks the weekly job. When a certificate is deactivated
upstream it simply *leaves the view*. It is not marked; it is not returned with a new
modification date; it is not returned at all. `date_derniere_modification_dpe > mark` can never
see it, and the merge in ADR-0005 is upsert-only, so the published files keep it **forever**.

Two things follow. The published row count drifts upwards without bound, one deactivation at a
time. And the plan's own verification line — "manifest row counts equal ADEME's total" — becomes
false after the first deactivation, so the check that would notice is the check that breaks.

## Decision Drivers

* The ETL is polite: ADEME publishes 500 kB/s to anonymous callers, one stream, no retry storms.
* A wrong deletion is worse than a late one — this job rewrites published files unattended.
* Whatever is chosen runs every week, forever, without a person watching it.

## Considered Options

* Rebuild the whole dataset every week
* Trust the delta and accept the drift
* Reconcile per département: compare counts, pull ids only on a mismatch

## Decision Outcome

Chosen option: **"reconcile per département, counts first"**.

Every run, for every partition: ask ADEME for `total`, compare with the manifest's row count. On a
mismatch — and only then — pull `numero_dpe` alone for that département and set-difference it
against the partition's own ids. Ids missing upstream are deleted by an anti-join rewrite; ids new
upstream come back through the ordinary delta path, which knows how to normalise a whole record.

### The cost, measured

| | |
|---|---|
| bytes per row, `select=numero_dpe` | **16.0 B** (measured, département 09) |
| département 09 (31,157 certificates) | 0.50 MB, **4.2 s** |
| whole dataset (15.5M) | ~248 MB, **~8 minutes** at 500 kB/s |

Checking the count first is what keeps this affordable: in an ordinary week almost every partition
matches and costs one request. A full rebuild — the rejected option — is 17 hours and 31 GB every
week to find a handful of deletions.

### Two properties that are not obvious

**Upstream must agree with itself before we act on it.** If `total` says one thing and the id pull
returns a different number, `reconcile` raises and the manifest is not swapped. Deleting published
rows on the strength of a number already known to be wrong is the one failure this job could cause
that nobody would notice until the data was gone.

**A deletion and an addition in the same partition in the same week net out and the count still
matches.** This is a real blind spot of counting, and it is accepted rather than solved, because
the job runs the delta *first*: an addition raises the published count before reconciliation looks,
so a deletion then shows as a shortfall. `test_equal_numbers_of_deletions_and_additions_hide_from_
the_count` pins the limitation so it is a known property rather than a surprise.

### One operational fact, observed while building this

ADEME's API **intermittently returns HTTP 500 during deep pagination**. Pulling Paris's ids
(838,532 rows, 84 pages) failed once at `after=33554660655676,701900` after exhausting all five
retries, and completed cleanly on the next two attempts — 86 s and 88 s. It is transient, not a
depth limit: `total` and the id pull agree exactly at 838,532.

The handling is the job failing, which is already the right answer: reconciliation runs before the
upload, so a failed run has published nothing, the manifest still points at the previous good
files, and the next scheduled run tries again. `api._get`'s retry policy is left alone —
lengthening it for one caller would slow the 17-hour ingest for everyone.

### Only now does the cron turn on

`etl-weekly.yml` was `workflow_dispatch` only in PR 8, deliberately. Scheduling a delta that cannot
see deletions would have automated the drift. The `schedule:` trigger is added in this PR, and the
reconciliation step runs after the merge and before the upload — so a run that cannot reconcile has
published nothing.

### Consequences

* Good, because the published row count is checked against the source every week rather than
  asserted once.
* Good, because an ordinary week costs one request per partition, not 248 MB.
* Bad, because a partition that diverges costs a full id pull for that département — up to ~13 MB
  for Paris. Bounded, and only on a mismatch.
* Bad, because the count check is blind to an equal-and-opposite swap. Mitigated by ordering, and
  pinned by a test.
* Neutral, because reconciliation only ever deletes. Additions are the delta's job, and a
  reconciliation that tried to insert would be normalising a record it only has an id for.

### Confirmation

* `tests/test_delta.py::test_reconcile_finds_what_left_the_dataset` — a certificate that left the
  view is found and reported.
* `tests/test_delta.py::test_reconcile_pulls_no_ids_when_every_count_agrees` — the politeness
  property, asserted rather than assumed.
* `tests/test_delta.py::test_reconcile_refuses_when_upstream_contradicts_itself` — proven
  non-vacuous by removing the check: `Failed: DID NOT RAISE ReconcileError`.
* `tests/test_delta.py::test_apply_deletions_rewrites_the_partition_without_the_gone_rows` — proven
  non-vacuous by skipping the filter: `assert ['2409E0000001', '2409E0000002'] == ['2409E0000001']`.
* `tests/test_delta.py::test_the_id_pull_agrees_with_the_total_upstream` (`live`) — the two numbers
  this decision trusts actually agree at the source.
* The job's own post-check: `total == manifest` for every partition, in the run log.

## More Information

* Related: [ADR-0005](0005-base-built-locally-ci-does-deltas.md) — the shape this repairs.
  [ADR-0002](0002-parquet-on-r2-for-the-data-plane.md) — the manifest-last swap that makes a failed
  reconciliation harmless.
