---
status: accepted
date: 2026-09-11
area: data plane
supersedes: 0028
superseded-by:
---

# ADR-0030 — The export narrows each partition in SQLite, where the indexes are

**Status:** accepted · **Decided:** 2026-09-11 · **Area:** data plane · **Supersedes:** the mechanism of [ADR-0028](0028-the-export-narrows-each-table-to-the-partition-before-joining.md)

## Context and Problem Statement

ADR-0028 narrows every per-certificate table to the partition before the wide join, which fixed
the national export's 24.5 GiB OOM. It narrows on DuckDB's side, in temp tables filled by
`SELECT * FROM sq.<table> WHERE dpe_id IN (…)`, and DuckDB's SQLite scanner pushes no filter
down. So every partition still streams all nine per-certificate tables out of SQLite whole:
~110M child rows plus the 15.5M-row `dpe`. The rerun measured about **2 minutes per partition**
(seven partitions between 23:51:32 and 00:04:12). For about 100 partitions, that is **3.5–4
hours**, mostly spent reading rows that are thrown away.

SQLite itself answers the same question through its indexes. `dpe`'s partition comes through
`ix_commune_dept` → `ix_adresse_commune` → `ix_dpe_adresse`, and the child tables are `WITHOUT
ROWID`, clustered on `dpe_id`. Measured on the national build, copying one partition's rows of
every per-certificate table into a scratch SQLite file:

| partition | certificates | child rows | SQLite narrowing | DuckDB reads the scratch file |
|---|---|---|---|---|
| dept 09 | 31 157 | 222 856 | 0.7 s | 0.3 s |
| dept 75 (the largest) | 840 697 | 5 669 573 | 23.6 s | 7.3 s |

## Decision Drivers

* ADR-0028's bound stays: memory is one partition's rows.
* The reads should be proportional to the partition, not to France.
* No new dependency, and the Parquet written is unchanged.

## Considered Options

* Narrow in SQLite into a scratch file per partition, then let DuckDB read it whole
* Keep narrowing in DuckDB (ADR-0028)
* Copy the whole SQLite build into a native DuckDB file once

## Decision Outcome

Chosen option: **"narrow in SQLite into a scratch file"**. For each partition, `export()`
attaches an empty scratch SQLite file to its own connection. It copies into it:

* the partition's `dpe` rows, with the partition's `WHERE`, now in SQLite;
* their `adresse` rows;
* their rows of `dpe_adresse_brut` and every repeating-group table.

DuckDB then attaches the scratch file, and `wide_select(tables=…)` joins it. The file sits beside
the output tree (never inside `v1/`), and it is deleted once the partition is written.

A native DuckDB copy would be as fast. It is a second multi-GB artefact, and a larger change for
the same result.

Profiling the result found the rest of the time. The derived coordinates went into DuckDB through
`executemany`, which inserts a row at a time: 1 619 rows/s, 19.2 of departement 09's 31.6 s, and
about 2.7 hours for France. They now go into the same scratch file, through SQLite's own
`executemany`, and DuckDB copies them in bulk. Measured whole partitions, on the national build:

| partition | ADR-0028 | narrowed in SQLite | + coordinates in bulk |
|---|---|---|---|
| dept 09 (31 157) | 98.8 s | 31.6 s | 8.2 s |
| dept 75 (840 697) | — | 556.9 s | 54.3 s |

### Consequences

* Good, because a partition costs index seeks for its own rows: France in about half an hour,
  where ADR-0028 took four.
* Good, because ADR-0028's memory bound holds. DuckDB never sees another partition's rows.
* Neutral, because the scratch file needs disk. The largest is Paris, at 505 MB.
* Neutral, because the ungeocoded partition (NG) has no index path. Its `LEFT JOIN … IS NULL`
  reads `dpe` once.

### Confirmation

`tests/test_export_parquet.py::test_a_partitions_export_reads_from_sqlite_only_its_own_rows`
totals DuckDB's `SQLITE_SCAN` `operator_rows_scanned`, from its JSON profile, while exporting a
one-certificate partition. It does this before and after 3M rows of other certificates join its
tables, and fails if the second reads 1 000 rows more than the first. It counts rather than times
anything, so it cannot flake. ADR-0028's memory test still holds.

## More Information

* Related: [ADR-0028](0028-the-export-narrows-each-table-to-the-partition-before-joining.md).
