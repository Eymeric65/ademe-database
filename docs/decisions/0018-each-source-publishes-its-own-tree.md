---
status: accepted
date: 2026-09-10
area: data plane
supersedes:
superseded-by:
---

# ADR-0018 — Each ADEME source publishes its own tree under `v1/`, shaped like existing housing's

**Status:** accepted · **Decided:** 2026-09-10 · **Area:** data plane

## Context and Problem Statement

ADR-0017 made each ADEME dataset a source with its own schema, SQLite file and `subdir`, and the
next change gave each its own column structure. The export still wrote one tree: `v1/`, whatever
database it was handed, with existing housing's search columns. Pointed at new housing's database
it succeeds, because the projection is driven by `column_meta` and new housing has every child
table existing housing has, and it overwrites the files the app reads. Pointed at a source whose
repeating groups differ, it joins tables that database does not have. That covers a dataset
lacking a group entirely, and a tertiary DPE's energy group, which existing housing does not have.

The deployed app reads `v1/manifest.json`, `v1/search/` and `v1/dpe/`, and the Worker serves all
of `v1/*` (ADR-0012). RNB, the cadastre and the crosswalk already publish as siblings under `v1/`
(ADR-0019, ADR-0020, ADR-0021).

## Decision Drivers

* Existing housing's paths and files may not move: the app and its manifest depend on them.
* Every source must be provably lossless on its own, so each needs its own `read_rows` root.
* A search index is a product decision per dataset. A tertiary DPE has no `surface_habitable`, so
  existing housing's 17 columns cannot be a silent default.

## Considered Options

* One tree per source at `v1/<subdir>/`, existing housing's `subdir` being `""`
* All sources in one tree, with a `source` column and partitions `source=…/dept=…`
* A `v2/` layout moving existing housing too

## Decision Outcome

Chosen option: **"one tree per source at `v1/<subdir>/`"**, because it is the only one that
leaves every existing path byte-for-byte where it is.

```
v1/manifest.json, v1/{search,dpe,index}/                      existing housing, unchanged
v1/<subdir>/manifest.json, v1/<subdir>/{search,dpe,index}/    every other ADEME source
```

A source's tree has exactly existing housing's shape, so the tools that take a tree root —
`read_rows`, and next the delta and the reconciliation — work on any source by being given its
root.

**The projection follows the source's structure.** `Plan` and `wide_select` read the source's
repeating groups instead of existing housing's, so a column a dataset lacks is never named.

**Search columns are declared per source, with no default.** `export_parquet.SEARCH` maps a
source's slug to its search columns and sort order. A source missing from it fails the export,
naming the slug. Existing housing's entry is today's 17 columns and sort, and the old names
`SEARCH_COLUMNS` and `SEARCH_SORT` stay as aliases of it.

An index of the published sources (`v1/sources.json`) waits until there is a second source to
list.

### Consequences

* Good, because nothing the app reads changes, and a new source is invisible to it until something
  asks for it.
* Good, because a new source's tree can be built, verified and uploaded without touching existing
  housing's.
* Bad, because a reader wanting "every certificate of every kind" unions the trees. That is what
  the crosswalk's `source` column is for.

### Confirmation

`tests/test_export_per_source.py`: a new-housing-shaped source exports to `v1/<subdir>/`, every
column of every row reads back equal to the SQLite reconstruction, and nothing is written at `v1/`
itself. A source with no declared search columns is refused. `tests/test_export_parquet.py`,
unchanged, keeps pinning existing housing's files, columns, sort and compression.

## More Information

* Related: [ADR-0006](0006-search-index-and-detail-parquet-per-departement.md),
  [ADR-0012](0012-the-data-plane-is-served-through-the-worker.md),
  [ADR-0017](0017-each-ademe-dataset-is-a-source-with-its-own-database.md).
