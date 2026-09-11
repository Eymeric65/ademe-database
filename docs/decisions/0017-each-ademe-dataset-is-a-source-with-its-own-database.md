---
status: accepted
date: 2026-09-10
area: data plane
supersedes:
superseded-by:
---

# ADR-0017 — Each ADEME dataset is a source, with its own schema, SQLite file and Parquet tree

**Status:** accepted · **Decided:** 2026-09-10 · **Area:** data plane

## Context and Problem Statement

The data plane is to become multi-source: ADEME's other post-2021 DPE datasets alongside the
existing-housing one, then RNB and the cadastre joined to them through a crosswalk. The ETL was
written against exactly one dataset. `config.DATASET = "dpe03existant"` was a constant, `API` was
derived from it, `spec` cached the one vendored schema in an `lru_cache(maxsize=1)`, and every URL in
`api` came from the module-level `API`.

Measured against the live catalogue on 2026-09-10:

| dataset | rows | columns | shared with existing housing |
|---|---|---|---|
| `dpe03existant` DPE logements existants | 15 557 428 | 230 | — |
| `dpe02neuf` DPE logements neufs | 1 424 502 | 212 | 210 |
| `dpe01tertiaire` DPE tertiaire | 562 695 | 69 | 46 |
| `ync2epx48x9azbdnggbygqp0` audits logement | 3 237 797 | 236 | 89 |

Pointing the existing code at a second dataset would not fail. It would fetch that dataset's rows
and rename their CSV headers with *existing housing's* labels — the header `adresse_brut` carries
the column keyed `adresse_complete_brut` there — so values would land in the wrong columns, silently.

## Decision Drivers

* The national existing-housing build is running while this lands. Nothing may change its schema,
  its database file or its published paths.
* Each source must stay provably lossless on its own (§11's round-trip), so its schema must be the
  one that reads it.
* The bookkeeping tables are keyed for one dataset: `column_meta` on `column_name` (210 names are
  shared between neuf and existant), `ingest_departement` on `code_departement`, and `data_source`
  is updated by `DATASET`. Vocabulary domains are derived from which columns exist in one schema.
* The deployed app reads `v1/manifest.json` and `v1/{search,dpe}/`; those paths may not move.

## Considered Options

* One SQLite file per source, selected by a source registry
* One SQLite file for every source, with a `source` column on every table and key
* One SQLite file, tables prefixed per source

## Decision Outcome

Chosen option: **"one SQLite file per source, selected by a source registry"**, because it is the
only one that leaves the running build's file and every one of its keys untouched, where the others
would change the schema of a database that is half loaded.

`config.Source(slug, dataset, schema_json, db_path, subdir)` names a dataset; `config.SOURCES`
holds them by slug. Every function that touches a dataset — `spec.load`, `spec.rename_row`,
`api.total`, `api.values`, `api.page`, `api.iter_pages` — takes `source=` and defaults to
`EXISTANT`. The old module globals `DATASET`, `API` and `SCHEMA_JSON` remain, as aliases of
`EXISTANT`, so every caller written before this is unchanged.

`subdir` names the source's Parquet tree under `v1/`. Existing housing's is `""`, which is `v1/`
itself, where the app already reads it. The shape of the other trees is ADR-0018's.

The registry holds `existant` alone in the change that introduces it. Each further source arrives in
its own change, with its vendored schema and its mapping.

### Consequences

* Good, because a source cannot be read with another source's labels by accident: the rename and the
  URL come from the same object.
* Good, because a failed or abandoned build of a new source cannot touch the existing-housing file.
* Bad, because cross-source questions cannot be answered in SQLite. They are answered in DuckDB
  over the published Parquet, which is where the crosswalk is built anyway.
* Neutral, because the structural mapping (`mapping.classify`, `ddl`, `ingest.Loader`) is still
  existing housing's. Making it per source is the next change and does not need another record.

### Confirmation

`tests/test_sources.py`:

* a source's schema, header rename and URLs are the ones it names, and reading one does not displace
  existing housing's cached schema;
* `DATASET`, `API`, `SCHEMA_JSON`, `DEFAULT_DB` and existing housing's `subdir` are unchanged;
* no two sources share a `db_path` or a `subdir`. This is trivially true with one source and binds
  from the second.

## More Information

* Related: [ADR-0004](0004-scaled-integers-are-the-only-lossless-encoding.md) (the per-column
  encoding each schema drives), [ADR-0006](0006-search-index-and-detail-parquet-per-departement.md)
  (the tree existing housing keeps).
