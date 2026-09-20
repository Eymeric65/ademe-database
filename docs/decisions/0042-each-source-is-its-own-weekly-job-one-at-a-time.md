---
status: accepted
date: 2026-09-19
area: data plane
supersedes: 0027
superseded-by:
---

# ADR-0042 — Each source is its own weekly job, and they run one at a time

**Status:** accepted · **Decided:** 2026-09-19 · **Area:** data plane

## Context and Problem Statement

ADR-0027 put the four sources in one job, as sequential steps, so that ADEME never sees two streams
from this repo at once (CLAUDE.md §11). That holds, and it is the part worth keeping. What it also
did was share one timeout, one runner and one failure across every source.

The scheduled run of 2026-09-14 (run 34829784527) was cancelled at the job's 120-minute limit inside
`reconcile.py --source audit`. Existing housing, new housing and the tertiary DPE had all finished
their own work by then — and published none of it, because the steps that upload them come after in
the same job. One slow source cost the week for all four. The manual run of 2026-09-19
(35462845962) was stopped 13 minutes into the first fetch, with the same consequence.

The step list had also been copied four times, once per source, and differed between copies:
existing housing reconciled unconditionally where the others exited first on a quiet week, and its
paths were spelled `v1/…` where the others were `v1/<subdir>/…`. A fifth source meant a fifth copy.

## Decision Drivers

* ADEME allows one polite stream per caller. Whatever replaces this must still fetch one source at
  a time, by construction and not by luck.
* A source's tree is replaced, manifest last, only after its own reconciliation and check pass. One
  source's failure must not stop another from publishing.
* A source registered in `config.SOURCES` but absent from the job would stop being updated with
  nothing to say so.
* The time budget belongs to a source, not to the week.

## Considered Options

* Sequential steps in one job (ADR-0027, the status quo)
* A matrix over the sources with `max-parallel: 1`
* Four jobs chained with `needs:`
* One workflow per source, on staggered schedules
* A matrix run in parallel

## Decision Outcome

Chosen option: **"a matrix over the sources with `max-parallel: 1`"**, with `fail-fast: false`.

* `max-parallel: 1` is what keeps ADEME's one stream. It is in the workflow rather than in the
  schedule, so nothing about timing has to hold for it to be true.
* `fail-fast: false` is what the 09-14 run needed: audits failing no longer cancels anything.
* Each source gets its own runner, its own free disk and its own `timeout-minutes: 120`.
* The steps exist **once**, templated on `$SOURCE` and `$TREE`. `$TREE` is `v1` for existing
  housing and `v1/<subdir>` otherwise, read at run time from `config.SOURCES`, so the registry
  stays the only place a source's tree is named.
* `workflow_dispatch` takes `source` (one slug, or `all`), the existing `since`, and a new
  `dry_run` that runs everything except the uploads — which is how a branch is proved against the
  real bucket without publishing from it.

Why not the others:

* **Four jobs chained with `needs:`.** Same shape, but the step list is written four times again,
  or hidden in a reusable workflow whose inputs then restate the registry.
* **One workflow per source, on staggered schedules.** Sequential only by luck: a slow week
  overlaps them. Sharing a concurrency group does not fix it, because a group holds one *pending*
  run — a third arrival cancels the one waiting, and that source silently misses its week.
* **A matrix in parallel.** It was asked for, on the grounds that it finishes sooner. It breaks
  §11, and it would not buy much: of the 48 minutes of the last complete run (2026-09-11), 44 were
  spent inside ADEME fetches and reconciliation, and every job would be sharing the one API key's
  rate. Runner minutes are free on this repository, which is public, so the wall-clock is the only
  thing at stake. `max-parallel` is one line if that trade ever changes.

### Consequences

* Good: a source that fails or times out costs its own week only, and the three others publish.
* Good: the time budget is per source — audits' reconcile has its own 120 minutes.
* Good: one step list instead of four, and adding a source is adding it to `config.SOURCES`.
* Good: `dry_run` makes the whole job runnable from a feature branch without writing to R2.
* Bad: each job repeats the setup — free disk, checkout, `uv sync`, rclone — about 90 seconds,
  four times.
* Neutral: existing housing now skips its reconcile on a week where the delta fetched nothing, as
  the other three already did. It has never had such a week.
* Neutral: the artifact is per source (`delta-manifest-<source>`).
* Neutral: RNB, the cadastre and the crosswalk are still not refreshed here (ADR-0027's last note
  stands).

### Confirmation

`tests/test_workflows.py`, which still reads the file as text:

* `test_each_source_is_its_own_job_one_at_a_time` — one matrix job, `max-parallel: 1`,
  `fail-fast: false`, a per-source timeout.
* `test_every_registered_source_is_updated_in_registry_order` — the matrix equals `SOURCES`.
* `test_each_job_takes_its_tree_from_the_registry` — `$TREE` comes from `Source.subdir`.
* `test_a_dry_run_uploads_nothing`, `test_a_manual_run_can_target_one_source`.
* The ADR-0039 ordering tests are unchanged in meaning: download < join < delta < reconcile <
  check < split < upload, and the manifest last.

Live, from the branch: `gh workflow run etl-weekly.yml --ref feat/weekly-per-source-jobs
-f source=tertiaire -f dry_run=true`.

## More Information

* Supersedes [ADR-0027](0027-the-weekly-job-updates-every-source-in-turn.md), whose one-stream rule
  it keeps.
* Related: [ADR-0039](0039-the-last-two-months-are-published-in-a-tree-of-their-own-beside-a-counts-only-index.md)
  for the join/split around each source, [ADR-0033](0033-the-weekly-job-reads-the-published-trees-from-r2.md)
  for reading the trees from R2.
