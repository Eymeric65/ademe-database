---
status: accepted
date: 2026-09-11
area: data plane
supersedes:
superseded-by:
---

# ADR-0029 — Each source names its record key, département and modification fields

**Status:** accepted · **Decided:** 2026-09-11 · **Area:** data plane

## Context and Problem Statement

Three column names are written into the ETL as constants:

* `numero_dpe` is the record key. It is `dpe`'s `NOT NULL` column and `ux_dpe_numero`. The load
  skips a conflicting key (`ON CONFLICT(numero_dpe) DO NOTHING`), and the export sorts on it.
  The weekly merge anti-joins on it, and reconciliation pulls it.
* `code_departement_ban` is the partition field. Every département query uses it, and so does the
  export's partitioning.
* `date_derniere_modification_dpe` is the incremental key: the delta's query and the manifest's
  `high_water`.

The three post-2021 DPE datasets share all three names. ADEME's energy audits (dataset
`ync2epx48x9azbdnggbygqp0`) share none:

* **The key is `id_etape`.** An audit publishes one row per step. `n_audit` repeats across an
  audit's steps, and `numero_dpe` is the DPE the audit refers to, so it repeats too. Checked on
  2026-09-10 by paging `n_audit,id_etape` over every row: 3 237 797 rows, 3 237 797 distinct
  `id_etape`, no nulls. The plan assumed a composite `(n_audit, id_etape)` key. It is not needed.
* **The département is `n_departement_ban`,** and **the modification date is
  `date_derniere_modification`.**

With `numero_dpe` as the key, the load keeps one step of each audit and silently drops the rest.
The weekly merge, anti-joined on `numero_dpe`, deletes every step of an audit to put back the one
that changed.

## Decision Drivers

* Existing housing's schema must not move a byte (the golden sha in `test_mapping_per_source.py`).
* One key column per source is what the data needs. A tuple would thread through every site for
  no dataset that uses it.

## Considered Options

* Three fields on `Mapping`, defaulting to today's names
* A composite key
* Renaming the audit columns to existing housing's names at load

## Decision Outcome

Chosen option: **"three fields on `Mapping`"**: `key`, `departement` and `modified`. Their
defaults are today's names, so every existing source is unchanged. Every site above reads them
from the source:

* The DDL gives `dpe` a `NOT NULL` column and a unique index on `mapping.key`. For the audits,
  `numero_dpe` becomes an ordinary column.
* The load, reconstruction, the export's sort and `read_rows`, the weekly merge, the deletions and
  reconciliation all use `mapping.key`. The manifest records it as `key`, so a reader of the
  published files needs no source registry.
* Département queries and the export's partitioning use `mapping.departement`. The delta's query
  and `high_water` use `mapping.modified`.
* `index/numero-exceptions.parquet` serves the detail view's `numero_dpe[2:4]` shortcut, so it is
  filled only for a source keyed on `numero_dpe`. For any other source, it is written empty.

A composite key answered a question the data does not ask. Renaming at load would publish an audit
under column names ADEME does not use: the files would no longer be ADEME's data under ADEME's
names, which is what the round-trip means by lossless.

### Consequences

* Good, because the audits can be a source with nothing special-cased beyond their mapping.
* Neutral, because the published index table's column is named after the key (`id_etape` in the
  audits' `scale-violation.parquet`). Existing housing's files are unchanged.
* Bad, because `numero_dpe`'s name in a query is now a lookup, one step further from the reader.

### Confirmation

`tests/test_source_keys.py`, on an audit-like source (existing housing's schema, renamed, plus
`id_etape`). It checks four things:

* two steps of one audit both load and reconstruct;
* the export partitions, sorts and reads back by the source's own fields;
* the weekly merge replaces one step and keeps its sibling;
* the API queries name the source's fields.

`test_existing_housings_schema_is_unchanged` holds the golden sha.

## More Information

* Related: [ADR-0017](0017-each-ademe-dataset-is-a-source-with-its-own-database.md),
  [ADR-0018](0018-each-source-publishes-its-own-tree.md),
  [ADR-0007](0007-the-delta-cannot-see-deletions-so-reconcile-by-count.md).
