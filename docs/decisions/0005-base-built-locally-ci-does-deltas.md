---
status: accepted
date: 2026-09-04
area: data plane
supersedes:
superseded-by:
---

# ADR-0005 — The base dataset is built by hand, once; CI only ever applies deltas

**Status:** accepted · **Decided:** 2026-09-04 · **Area:** data plane

## Context and Problem Statement

The published Parquet has to be built from ADEME's API and refreshed weekly. The obvious shape — a
scheduled GitHub Actions job that rebuilds everything — does not fit, and the reason is documented
by ADEME rather than guessed.

## Decision Drivers

* ADEME publishes its limits: anonymous callers get 600 req/min, **500 kB/s**, and 20 seconds of
  processing per 60. An API key doubles the bandwidth and triples the processing budget.
* Measured: fetching all 226 columns runs at ~247 rows/s, so a full build is **17.4 hours**.
* **A GitHub Actions job is capped at 6 hours.**
* Parallelism does not help from one address: 1, 3 and 6 concurrent connections all measured
  ~315 rows/s.
* ADEME is a public agency and this is a personal project.

## Considered Options

* Scheduled CI job that rebuilds everything — impossible inside the job limit
* CI matrix of 104 runners, one per département, each with its own address
* Build the base locally once, and let CI only ever apply deltas

## Decision Outcome

Chosen option: **"local base, CI deltas"**.

The matrix would work — the rate limit is per caller, so 104 runners really would parallelise — but
it points a hundred concurrent scrapers at a public agency's API to save a one-off overnight run.
`local-database-agregator/CLAUDE.md` already forbids exactly this for its own rate-limited source:
*"One download, no parallelism, no retry storms."* The same restraint applies here.

The weekly job is small because ADEME says how to make it small. `date_derniere_modification_dpe`
carries one of only five field descriptions in the entire schema:

> À utiliser pour mettre en place une alimentation incrémentale.

A week is roughly 150k changed rows — minutes, not hours. Each touched département's Parquet is read
from R2, merged, and written back; the manifest is swapped last. Roughly 4.5 GB of I/O, free on R2,
comfortably inside the job limit.

### Consequences

* Good, because the weekly job is minutes and cannot outgrow the CI limit.
* Good, because ADEME sees one polite stream instead of a hundred.
* Bad, because the base is not reproducible from CI alone; rebuilding from scratch is a manual
  overnight run. The ingest is resumable per département, which makes that survivable.
* Neutral: an ADEME API key would halve the base build. Not required, and not requested for a
  once-ever job.
