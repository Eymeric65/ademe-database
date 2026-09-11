---
status: accepted
date: 2026-09-10
area: data plane
supersedes:
superseded-by:
---

# ADR-0028 — The export narrows each table to the partition before joining

**Status:** accepted · **Decided:** 2026-09-10 · **Area:** data plane

## Context and Problem Statement

The first national export ran out of memory on its first partition:

```
_duckdb.OutOfMemoryException: Out of Memory Error: failed to allocate data of size 32.0 KiB (24.5 GiB/24.5 GiB used)
  export_parquet.py:348  CREATE OR REPLACE TEMP TABLE wide AS …
```

It wrote no partition and no manifest. Every export before this one had run on one département.

Each partition's wide query LEFT JOINs the attached SQLite tables whole, and keeps only the
partition's rows in a final `WHERE`. A repeating group is joined once per slot, so each slot
hashes the whole national table. Row counts in the national build, from `sqlite_stat1`:

| table | rows |
|---|---|
| `dpe_bilan_energie` | 26 615 994 |
| `dpe_generateur_chauffage` | 19 277 434 |
| `dpe_installation_chauffage` | 17 841 752 |
| `dpe_adresse_brut`, `dpe` | 15 548 832 |
| `dpe_generateur_ecs` | 15 093 413 |
| `dpe_installation_ecs` | 15 092 606 |
| `adresse` | 5 446 535 |

The largest vocabulary is 1.4M entries (`vocab_numero_dpe_remplace`), and the others are smaller.
They are not the problem.

DuckDB's SQLite scanner does not push a filter down. Measured on the national build,
`WHERE dpe_id BETWEEN …` is a DuckDB `FILTER` node above a whole-table `SQLITE_SCAN`. A range of
10 001 rows took 1.72 s, and the whole 15.5M-row table took 1.16 s. So a narrower `WHERE` saves no
reading. It does save memory, as long as it runs in the scan, before any hash table is built.

## Decision Drivers

* Memory has to be bounded by the largest partition, not by the country. The machine has 30 GB,
  already swapping.
* There must be no reliance on `dpe_id` being contiguous per département. It is today: every
  département's id span equals its row count. But a delta appends a certificate wherever the
  sequence is.
* The smallest change to the export. The Parquet it writes must stay byte-for-byte the same data.

## Considered Options

* Narrow each per-certificate table to the partition in a DuckDB temp table, then join those
* A lower `memory_limit` with spilling to disk
* A `dpe_id` range per partition
* Copy the whole SQLite into a native DuckDB file once, then partition from it

## Decision Outcome

Chosen option: **"narrow each per-certificate table to the partition first"**. For each partition,
`export()` copies these tables into temp tables, holding only the partition's rows:

* `dpe`, with the partition's `WHERE`;
* `adresse`, by the copied certificates' `adresse_id`;
* `dpe_adresse_brut` and every repeating-group table, by `dpe_id IN` the copied certificates.

`IN (SELECT …)` is a semi-join whose hash side is the partition's ids, so each SQLite table
streams through the scan, and only the partition's rows are kept. `wide_select(tables=…)` then
joins the copies. `commune` and the vocabularies are small and are still read from `sq`.

A lower memory limit with spilling was the national run's own setting: the in-memory database
spilled, and it still ran out. A `dpe_id` range is exact today, but only by luck of the load
order. A native DuckDB copy would be faster, but it is a larger change and a second multi-GB file
to manage.

### Consequences

* Good, because peak memory is one partition's rows. It no longer grows with the rest of France.
  Measured on one certificate, with one thread, as the export's growth in peak RSS:

  | rows outside the partition | 0 | 1M | 3M |
  |---|---|---|---|
  | before | 138 MB | 252 MB | 491 MB |
  | after | 139 MB | 139 MB | 140 MB |

* Neutral, because each partition still reads every per-certificate table whole from SQLite. That
  is fewer reads than before, when each slot of a repeating group read its table again.
* Bad, because a partition costs about nine whole-table scans however small it is. The overseas
  partitions pay the same as Paris.

### Confirmation

`tests/test_export_parquet.py::test_a_partitions_export_memory_does_not_grow_with_rows_outside_it`
exports a one-certificate partition twice: before and after 3M rows of other certificates are
added to the tables it joins. It measures the peak RSS each export adds (VmHWM, reset through
`/proc/self/clear_refs`), and fails if the second adds 100 MB more than the first. Before this
change: 431 MB against 137 MB.

The bound is relative, and DuckDB's `memory_limit` is not the yardstick. Even two certificates
did not export under an 800 MB limit, although they peaked at ~195 MB of RSS. Each of the wide
query's ~150 hash joins reserves memory against the limit whether or not it touches it.

## More Information

* Related: [ADR-0006](0006-search-index-and-detail-parquet-per-departement.md),
  [ADR-0024](0024-ungeocoded-certificates-are-the-ng-partition.md).
