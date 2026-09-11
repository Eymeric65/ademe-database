---
status: accepted
date: 2026-09-11
area: performance
supersedes:
superseded-by:
---

# ADR-0035 — The browser reads Parquet by ranges, and DuckDB is told it can

**Status:** accepted · **Decided:** 2026-09-11 · **Area:** performance

## Context and Problem Statement

The national tree reached R2 on 2026-09-11, and the search screen started
timing out. ADR-0006's whole design is that the browser reads a Parquet footer
and then only the row groups it needs. Measured through the browser on the
preview, it was reading every file whole:

| scenario (national tree, preview) | requests | bytes | wall |
|---|---|---|---|
| search 75011, class D, 45 m² | 4 | 15.2 MB, the whole partition | 3.9–4.4 s |
| detail of `2475E2178628K`, Paris | 6 | **152 MB**: the 146 MB wide file and the 2.3 MB exceptions index | 10–17 s on fibre |
| one gated request vs one public request (median of 20) | — | — | 153 vs 143 ms |

The gate costs about 10 ms per request, so the session lookup was not the cause.
The request log was: `HEAD` (no Range) → 200, then `GET` (no Range) → 200 and
the whole object. Two things combined:

* DuckDB-WASM, left at its default filesystem settings, never attempts a range.
  Its ranged path opens a file with `HEAD` and `Range: bytes=0-` and continues
  only on a **206**.
* The Worker (ADR-0012) answered every `HEAD` with 200, ignoring `Range`, as
  HTTP says a server may. Even a DuckDB that tried would have fallen back.

Département 09 alone, the only data on R2 until that day, is small enough that
nobody noticed.

Two smaller costs sat on top: the first detail loaded the whole exceptions
index (670 302 rows) into a JavaScript Map, and a search by commune alone read
all 103 partitions.

## Decision Drivers

* A detail must cost what ADR-0006 promises: a footer and one row group.
* The fix must be visible to a test, since a silent full-file fallback looks
  exactly like success on screen.
* No change to the Parquet layout, and none to authentication.

## Considered Options

* Ranged reads end to end: a Worker that answers a ranged `HEAD` with 206, and
  a DuckDB told to trust it.
* Keep full reads and shrink the files (an ETL layout change).
* Fetch each search partition whole with one `fetch()` and hand DuckDB the
  buffer, keeping ranges for the detail.

## Decision Outcome

Chosen option: **"ranged reads end to end"**, because it is the only one that
makes a Paris detail a footer and one row group again without touching the
published layout.

* `serveObject` answers a `HEAD` carrying `Range` with 206, `Content-Range` and
  the span's `Content-Length`; a plain `HEAD` still gets 200.
* `duck.ts` opens the engine with `filesystem: { reliableHeadRequests: true,
  allowFullHTTPReads: false, forceFullHTTPReads: false }`. All three: this
  build (1.33.1-dev57) behaves as if full reads were forced, and skips the
  ranged `HEAD` entirely unless told otherwise -- with only the first two set,
  every file failed to open without a single ranged request being sent.
* A result link carries its partition (`#/<source>/<dept>/<key>`), so a detail
  reads one known file. A link without one -- the old `#/dpe/<numero>`, or a
  row saved before ADR-0034 -- asks the exceptions index with a point query
  (`WHERE numero_dpe = ?`, the file is sorted) instead of loading it.
* A search reads only the partitions its postcode names, or the département
  picked. A commune narrows a search but no longer locates one.
* `castDecimalToDouble` replaces the per-column `CAST … AS DOUBLE` list, for
  every tree at once.

After, same scenarios on the same preview:

| scenario | requests | bytes | wall |
|---|---|---|---|
| search 75011, class D, 45 m² | AFTER | AFTER | AFTER |
| detail of `2475E2178628K`, opened from its link | AFTER | AFTER | AFTER |

### Consequences

* Good, because a detail no longer downloads its whole département.
* Good, because every Parquet `GET` is now checked to be a range.
* Bad, because a detail is now many small sequential range reads rather than
  one large one; on a fast link with a small partition the old way could be
  quicker. The table above is the trade.
* Good, because `allowFullHTTPReads: false` makes a server that stops
  answering the ranged `HEAD` fail loudly ("Failed to open file") instead of
  quietly downloading every partition whole.

### Confirmation

* `test/db/gate.test.ts`: a ranged `HEAD` answers 206 with the whole length,
  public and gated; a plain `HEAD` still answers 200.
* `test/e2e/perf.spec.ts`: no Parquet `GET` is answered 200, and a detail
  opened from its link reads no exceptions index. Run with `E2E_BASE_URL` set,
  the same specs read the national tree and print the tables above.

## More Information

* Related: [ADR-0006](0006-search-index-and-detail-parquet-per-departement.md),
  [ADR-0012](0012-the-data-plane-is-served-through-the-worker.md),
  [ADR-0024](0024-ungeocoded-certificates-are-the-ng-partition.md)
