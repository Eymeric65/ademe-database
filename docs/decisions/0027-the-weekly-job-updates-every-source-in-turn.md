---
status: accepted
date: 2026-09-10
area: data plane
supersedes:
superseded-by:
---

# ADR-0027 — The weekly job updates every ADEME source in turn, in one job

**Status:** accepted · **Decided:** 2026-09-10 · **Area:** data plane

## Context and Problem Statement

`etl-weekly.yml` runs the delta, the reconciliation, the sharp-departure check and the upload for
existing housing. New housing (ADR-0025) and the tertiary DPE (ADR-0026) are now sources with their
own trees under `v1/`, and the delta, the reconciliation and the check take `--source`. Nothing
schedules them, so a published new-housing tree would go stale from the day after it was uploaded.

## Decision Drivers

* ADEME allows one polite stream per caller (§11, ADR-0005). The sources must not be fetched in
  parallel.
* A source's tree is replaced, manifest last, only after its own reconciliation and check pass. One
  source's failure must not publish half of another.
* A source registered in `config.SOURCES` but absent from the job would stop being updated, with
  nothing to say so.
* A source is built by hand the first time. Until its tree is published, the weekly job has nothing
  to merge into.

## Considered Options

* Sequential steps per source, in the one existing job
* A matrix over the sources
* One workflow per source, on staggered schedules

## Decision Outcome

Chosen option: **"sequential steps per source, in the one existing job"**. A matrix is parallel by
construction. Staggered workflows are sequential only by luck: a slow week can overlap them, and
nothing then stops two fetches running at once.

Existing housing's steps are unchanged, and they run first. Each other source then has three steps:

1. **Published?** Probe `$DATA_BASE_URL/<subdir>/manifest.json`. If it is absent, skip the source
   with a notice. A first build is done by hand.
2. **Fetch, merge, reconcile, check**, each with `--source <slug>` against its own tree. If the delta
   found nothing, it writes no tree and the upload is skipped.
3. **Upload** `search/`, `dpe/` and `index/`, then **the manifest last**, under `v1/<subdir>/`.

`tests/test_workflows.py` reads the workflow and fails if:

* it gains a matrix or a second job;
* a registered source is not updated;
* the sources are out of registry order;
* a source is uploaded before it is reconciled and checked;
* a manifest goes up before its files.

The first two keep the next source (the audits) from being forgotten here.

### Consequences

* Good, because every published source is as fresh as existing housing, on the same Monday run.
* Bad, because the job takes longer: each source adds its week's modifications at ADEME's rate, a
  few minutes each today. `timeout-minutes` stays at 120.
* Neutral, because RNB, the cadastre and the crosswalk are not refreshed here yet. A partition's
  conditional fetch (ADR-0019, ADR-0020) needs the previous file on disk. On a runner there is none,
  so every run would download all of it. Making the build trust the published manifest's ETags is a
  separate change.

### Confirmation

`tests/test_workflows.py`.

## More Information

* Related: [ADR-0005](0005-base-built-locally-ci-does-deltas.md),
  [ADR-0007](0007-the-delta-cannot-see-deletions-so-reconcile-by-count.md),
  [ADR-0018](0018-each-source-publishes-its-own-tree.md).
