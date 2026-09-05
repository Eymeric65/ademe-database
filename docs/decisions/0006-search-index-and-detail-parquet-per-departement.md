---
status: accepted
date: 2026-09-05
area: data plane
supersedes:
superseded-by:
---

# ADR-0006 — Two Parquet files per département: a narrow search index and the wide detail

**Status:** accepted · **Decided:** 2026-09-05 · **Area:** data plane

## Context and Problem Statement

ADR-0002 put the public certificates on R2 as Parquet, read directly by the browser, but did not
say what the files contain or how they are cut. That question is decided by the dominant query,
which is not the one ADR-0002 assumed.

The product's primary use case is reverse-locating a property from a listing: the user types the
facts an advert publishes — postcode, DPE and GES letter, floor area, the month the certificate
was issued, sometimes the kWh/m² — and gets back the certificates that match, with the address and
coordinates the advert withheld. That is a **scan with predicates over a handful of columns**,
repeated for every search. The detail view that follows is a **point lookup of one certificate over
all 226 columns**, and happens at most once per search.

One file shape cannot serve both. A 226-column file scanned for six predicates reads far more than
it needs even with column pruning, because the row groups are sized for the wide row. A file narrow
enough to scan cheaply cannot answer the detail view at all.

## Decision Drivers

* The search predicate set is small, fixed and known; the detail set is everything.
* R2 egress is per byte, and the browser fetches over HTTP range requests.
* HTTP has no globbing: the client must be told which files exist.
* Whatever is published must still be provably identical to the source (ADR-0004's contract).
* A rebuild must be atomic from the reader's point of view (ADR-0002).

## Considered Options

* One wide file per département
* One wide file per département plus a narrow search index
* A single national file per shape, sorted by postcode

## Decision Outcome

Chosen option: **"a wide file plus a narrow search index, both partitioned by département"**.

```
v1/search/dept=NN/part-0000.parquet   17 columns, sorted (code_postal_ban, etiquette_dpe,
                                      surface_habitable_logement), row groups 50k
v1/dpe/dept=NN/part-0000.parquet      all 226 columns + lat, lon, sorted by numero_dpe,
                                      row groups 10k
v1/index/numero-exceptions.parquet    numero_dpe, dept  where numero_dpe[2:4] != the partition
v1/index/scale-violation.parquet      numero_dpe, column_name, raw_value
v1/manifest.json                      version, built_at, schema_sha256, high_water,
                                      column_meta, search_columns, partitions[]
```

Measured on département 09 (31,157 certificates): the search file is **797 kB** against **7.2 MB**
for the wide one — a 9× reduction on the file every query touches.

The sort keys are the predicates in the order they narrow: a postcode selects one or two row
groups out of the partition through Parquet's own min/max statistics, before any value is decoded.
The wide file is sorted by `numero_dpe` so a detail read is one 10k row group of one partition.

**Départements 975/976/977/978 merge into `dept=DOM`.** They are a few thousand rows each; four
partitions would mean four files a search has to consider for no benefit.

### Types

| source encoding | Parquet type |
|---|---|
| scaled integer, scale 10^s | `DECIMAL(18, s)` |
| date (day count) | `DATE` |
| vocabulary | `VARCHAR`, dictionary-encoded |
| plain integer | `BIGINT` |

`DECIMAL` is ADR-0004's encoding stated natively: Parquet stores an integer with a scale
annotation, which is byte-for-byte what SQLite holds. The division back to a decimal is done **as
DECIMAL, never as DOUBLE** — a DOUBLE round-trip would discard exactly the precision the scaled
integer exists to keep. The stored value is cast to `DECIMAL(38,0)` before dividing, because
casting it straight to `DECIMAL(18,s)` overflows: `6478894912345` as a `DECIMAL(18,6)` needs
nineteen digits.

### lat/lon are derived at export, in Python

The source carries `coordonnee_cartographique_x_ban` / `_y_ban` in Lambert-93 (EPSG:2154). The
browser needs degrees.

`ademe/ingest.py` already parses Data Fair's `_geopoint`, which is WGS84 — but **that path never
fires**: the CSV export does not carry Data Fair internals unless they are named in `select`, and
`iter_pages` does not name them. Every row in the built database has `lat IS NULL`. So the
projection has to be inverted at export.

It is inverted in `ademe/geo.py`, in closed form, rather than through DuckDB's `spatial` extension:

* `INSTALL spatial` downloads a binary at first use, which makes the offline suite depend on the
  network. CLAUDE.md §3 is explicit that a skip is not a pass.
* Thirty lines of Lambert Conformal Conic 2SP with no state is easier to check than an extension.
* It is checkable against something that did not come from the same arithmetic: ADEME's own
  `_geopoint`, requested explicitly. Agreement is **~1e-13 degrees** — double-precision exact, and
  eight orders of magnitude inside the 1e-5 the map needs. Stored as `DECIMAL(10,6)`, ~0.1 m.

### `duckdb` becomes a runtime dependency

A new dependency of consequence, in a repository whose `pyproject.toml` says the ETL is stdlib
plus httpx because "every dependency is a variable in that measurement".

It earns it by being **one engine at both ends**. DuckDB `ATTACH`es the SQLite file and writes the
Parquet; DuckDB reads the files back in the tests; DuckDB merges the weekly delta (PR 8). A
different reader and writer would let the type mapping disagree with itself, and the failure mode
of that is a silently wrong DECIMAL scale in one column — the exact thing this layout has to rule
out. The alternative, streaming 15.5M × 226 values through Python, is not a Python loop.

The projection SELECT is **generated** from `column_meta` and `mapping.REPEATS`, exactly as
`ademe/reconstruct.py` is, so the export cannot drift from the schema.

### Consequences

* Good, because a search reads ~800 kB per département instead of 7 MB, and often one row group of
  that.
* Good, because the manifest is swapped last, so a failed build cannot take the app down and a
  rollback is a manifest edit (ADR-0002's property, preserved).
* Good, because `column_meta` travels in the manifest, so the weekly delta can rebuild a partition
  without the SQLite build.
* Bad, because every certificate's search columns are stored twice. Measured at 11% overhead on
  total bytes, paid once at build time.
* Bad, because a schema change now touches two files and the manifest rather than one.
* Neutral, because **ADR-0002's consequence "point lookups are rare, so a wide file is fine" is
  amended by this record.** ADR-0002 stays accepted and is not edited; this is the record that
  changes what follows from it.

### Confirmation

* `tests/test_export_parquet.py` — 1,131,130 field comparisons between the SQLite reconstruction
  and the published Parquet on a synthetic build; the search file's column set and row-group
  ordering; the manifest's counts; the scale-violation side file. Proven non-vacuous by perturbing
  the exporter's scale divisor (35,034 mismatches) and by dropping the violation overlay.
* `tests/test_roundtrip.py::test_published_parquet_round_trips` (`live`) — 40 published
  certificates against live ADEME, all 226 columns.
* `tests/test_roundtrip.py::test_published_coordinates_match_ademes_own_geopoint` (`live`) — the
  derived lat/lon against `_geopoint`.
* `tests/test_export_parquet.py::test_lambert93_inverse_matches_ademes_own_geopoint` — the
  projection alone, offline, against three pinned real certificates.

## More Information

* Related: [ADR-0002](0002-parquet-on-r2-for-the-data-plane.md) (amended, not superseded),
  [ADR-0004](0004-scaled-integers-are-the-only-lossless-encoding.md) (the DECIMAL mapping is its
  encoding stated in Parquet's own terms).
