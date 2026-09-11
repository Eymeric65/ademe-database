---
status: accepted
date: 2026-09-10
area: data plane
supersedes:
superseded-by:
---

# ADR-0016 — The published Parquet is written at zstd level 9, not DuckDB's default

**Status:** accepted · **Decided:** 2026-09-10 · **Area:** data plane

## Context and Problem Statement

`export_parquet` wrote `COMPRESSION zstd` and took DuckDB's default level, which is 3. Nobody had
measured whether that was the right point on the curve, and it is a decision that has to be made
*before* the base export: changing it afterwards means re-exporting and re-uploading every
partition.

Every byte in these files is a byte the browser pulls over an HTTP range request (ADR-0009,
ADR-0012), so the size is not a storage question. It is latency on every search.

## Decision Drivers

* 15 557 428 certificates at the measured 231 B/row is ~3.6 GB of detail Parquet.
* The export runs once for the base and weekly for the deltas, on a laptop. Write time matters, but
  it is not the binding constraint.
* ADR-0006 fixes the detail file's row groups at 10 000 so a point lookup pulls one row group rather
  than a whole file. Compression must not be bought by widening them.
* The engine is DuckDB-WASM in a browser. A codec change is a compatibility question; a *level*
  change is not — any zstd decoder reads any level.

## Considered Options

Measured on the real département 09 export: 31 157 certificates, 229 columns, 7 199 033 B.

| variant | bytes | B/row | vs shipped | write |
|---|---|---|---|---|
| zstd 3 (DuckDB default) | 7 199 785 | 231 | — | 0.5 s |
| **zstd 9** | **6 736 845** | **216** | **−6.4%** | **0.6 s** |
| zstd 15 | 6 820 641 | 219 | −5.3% | 1.3 s |
| zstd 22 | 6 585 827 | 211 | −8.5% | 3.1 s |
| brotli | 6 107 906 | 196 | −15.2% | 10.4 s |
| gzip | 7 379 959 | 237 | +2.5% | 0.8 s |
| snappy | 10 581 637 | 340 | +47.0% | 0.4 s |
| uncompressed | 21 777 135 | 699 | +202.5% | 0.4 s |
| zstd 3, Parquet V2 pages | 7 236 819 | 232 | +0.5% | 0.4 s |
| zstd 3, row group 100 000 | 6 791 421 | 218 | −5.7% | 0.5 s |

## Decision Outcome

Chosen option: **zstd level 9**.

6.4% for an extra tenth of a second a partition — about 230 MB off the national build, and off every
range request the browser makes for the life of the data.

**Level 15 is worse than level 9 here**, which is the reason this record exists as a measurement
rather than a preference: "turn it up" is not a strategy, and the curve for this data is not
monotonic in the region that matters. Level 22 buys a further 2 points for six times the write.

Brotli is the smallest by a wide margin and was still rejected. It is 20× the write time, and more
importantly it changes the codec rather than a parameter — the deployed data plane is already
serving zstd to DuckDB-WASM, and a codec swap is a compatibility question that a level change simply
is not. If the 15% is ever wanted, it should be its own record with a browser test behind it.

The 100 000-row group is 5.7% for free on paper and was rejected outright: it multiplies the cost of
the point lookup ADR-0006 exists to make cheap, which is the detail view's entire read path.

### Consequences

* Good, because ~230 MB less on R2 and on the wire, decided before the one-off base export rather
  than after it.
* Good, because the level is a write-side parameter: nothing about reading the files changes, and
  files already published stay readable.
* Bad, because the export is fractionally slower — 0.1 s a partition, so about 10 s nationally.
* Neutral, because the choice is now written down with the numbers, and re-checking it later means
  re-running one benchmark rather than re-deriving the question.

### Confirmation

`tests/test_export_parquet.py::test_the_compression_level_actually_reaches_the_files`.

The level is not recorded in Parquet metadata, so size is the only place it is observable — which
makes the comparison easy to get wrong, and the first version of this test was wrong. It rewrote the
shipped file with DuckDB at the default level and compared; it **passed with the change reverted**,
because a round trip through DuckDB costs ~194 B of metadata whatever the level, and that artefact
was a quarter of the gap it claimed to be measuring.

Both sides now go through `export()` itself, on the same database, with only the constant differing,
so the artefact cancels exactly. With the constant set back to level 3 the assertion reads
`45,551 B shipped against 45,551 B` and fails.

## More Information

* Related: [ADR-0006](0006-search-index-and-detail-parquet-per-departement.md),
  [ADR-0009](0009-duckdb-wasm-reads-parquet-from-the-data-domain.md),
  [ADR-0002](0002-parquet-on-r2-for-the-data-plane.md)
