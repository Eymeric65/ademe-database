---
status: accepted
date: 2026-09-04
area: data plane
supersedes:
superseded-by:
---

# ADR-0002 — The public data plane is Parquet on R2, not a serving database

**Status:** accepted · **Decided:** 2026-09-04 · **Area:** data plane

## Context and Problem Statement

The product lets users compose their own analysis over 15.5M certificates rather than browse a fixed
list. Earlier designs assumed the data had to be imported into a serving database — first D1, then
Postgres with PostGIS at roughly $50/month — and the plan grew a weekly ETL, a storage budget and a
migration path to match. Before committing, the actual query shapes were measured.

## Decision Drivers

* The dominant query is analytical: filter and aggregate a few columns over many rows.
* Cost matters; this is a personal project.
* 226 columns is wide, and most queries want a handful of them.
* The alternative had a hard 10 GB ceiling that the full dataset does not fit under.

## Considered Options

* D1 — SQLite, row-oriented, queried from a Worker
* Postgres + PostGIS on RDS or Neon
* Parquet on R2, read by DuckDB-WASM in the browser
* No copy at all — query `data.ademe.fr` live

## Decision Outcome

Chosen option: **"Parquet on R2"**, because a national group-by on two columns reads 17 MB of a
columnar file and 15,512,658 rows of a row-oriented one.

Measured, not assumed:

| | Parquet | D1 |
|---|---|---|
| National group-by, 2 columns | **17 MB** (0.38% of the file) | **15,512,658 rows**, all of them |
| Latency | ~1s, on the user's machine | 10–20s |
| Cost of that query | $0 | $0.0155 |
| Full 226-column footprint | **4.48 GB** | ~9–11 GB, against a 10 GB cap |
| Monthly storage | **$0.067** | included, but the cap is a wall |

D1's problem is not the money. It runs **one query at a time**, so ten users each running an
analytical query is a three-minute queue. Parquet moves that compute to the client, where it scales
with users instead of against them.

Live querying (`data.ademe.fr`) was measured and is genuinely capable — filter 0.07–0.21s, facets
0.11s, `geo_distance` 0.17s, CORS open — but it makes the product's availability equal to ADEME's.

**Where D1 wins and this record accepts the loss:** point lookups. "Show me certificate X" is a
sub-millisecond index seek in D1 and a one-column partition scan (~1–5 MB) in Parquet. Point lookups
are rare enough in this product to pay that.

### Consequences

* Good, because query cost is $0 and storage is $0.067/month.
* Good, because carrying all 226 columns is free — columnar storage reads only what is asked for.
* Good, because a rebuild is a file swap, with no schema drift and no partial state.
* Bad, because DuckDB-WASM is a 3–10 MB download before the first query.
* Bad, because point lookups and small filtered lists are the one shape columnar storage is bad at.
* Bad, because Parquet is immutable: an update rewrites a partition (see ADR-0005).
