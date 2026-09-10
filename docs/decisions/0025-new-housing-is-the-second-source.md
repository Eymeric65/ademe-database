---
status: accepted
date: 2026-09-10
area: data plane
supersedes:
superseded-by:
---

# ADR-0025 — New housing (`dpe02neuf`) is the second ADEME source

**Status:** accepted · **Decided:** 2026-09-10 · **Area:** data plane

## Context and Problem Statement

The owner's scope for the unified dataset (2026-09-10) includes ADEME's other post-2021 DPE
listings, starting with new housing. The machinery for a second source now exists: a registry
(ADR-0017), per-source structure, per-source trees (ADR-0018), a per-source weekly delta, and build
commands that take `--source`. What remains is to declare the dataset.

Measured against the live catalogue on 2026-09-10:

* `dpe02neuf`: 1 424 502 certificates, 212 columns.
* **210 of them are existing housing's.** Two are its own: `deperditions_totales_batiment` and
  `deperditions_totales_logement`.
* **It lacks 20 of existing housing's.** Eight are top-level. The other twelve are *whole* columns
  of a repeating group: `description_generateur_chauffage_n{g}_installation_n{i}` is gone from all
  four generator slots, not from one.
* Its CSV header matches its published labels exactly. Eight of those labels are not their keys,
  for example `conso_5 usages_ef` and `Conso_ecs_ef_energie_n2`.

## Decision Drivers

* Lossless per source, as for existing housing.
* Existing housing's database, schema and tree must not move.
* One ADEME stream at a time (§11), so a new source is fetched after, never alongside.

## Considered Options

* Its own source: vendored schema, existing housing's structure minus the 20, its own database
  and tree
* Load it into existing housing's database with a `source` column
* Leave new housing out

## Decision Outcome

Chosen option: **"its own source"**. ADR-0017 already rejected a shared database, because the
bookkeeping keys collide. The structure carries over almost unchanged.

| | |
|---|---|
| schema | `schema/dpe02neuf-schema.json`, vendored from the live metadata on 2026-09-10 |
| structure | `mapping.NEUF = EXISTANT.without(NEUF_ABSENT)`, the 20 columns listed explicitly |
| database | `ademe-neuf.sqlite`, beside `ademe.sqlite` |
| tree | `v1/neuf/` |
| search | existing housing's 17 columns and sort, all of which new housing has |

**The 20 are listed rather than derived** from the difference between the two schemas. If ADEME
drops another column, `mapping.classify` must fail on it ("the export shape changed") instead of
the structure silently shrinking to match. The two new columns need nothing: an unclaimed column
lands on `dpe`.

**The vendored labels are the ones the export serves**, including the odd ones. A pinned copy of the
2026-09-10 header is checked offline, and its live twin checks the header ADEME serves at the time.
That is the check whose absence cost existing housing its `adresse_brut` (ADR-0023).

**Two columns come out differently because new housing is smaller.** Encodings follow each
dataset's own cardinality (ADR-0004), and at 1.4 M rows the 2 M threshold for inline text is out
of reach. New housing's first build found two places where that is wrong:

* `numero_dpe` (1.42 M distinct) became a dictionary. But `dpe` stores it raw, as its own
  `TEXT NOT NULL` key (`ddl.dpe_ddl`). So `column_meta` pointed reconstruction and the export at a
  `numero_dpe_id` column that does not exist. **The record key is text, whatever its cardinality**
  (`spec._encoding`).
* `adresse_ban` (177 929 distinct, against existing housing's 5 056 366) became a dictionary. Its
  column in `adresse` is `adresse` + `_id`, which is that table's primary key. **A dictionary column
  that would take one of the three table keys is named `<name>_vocab_id`** (`ddl._col_sql`).

Neither applies to existing housing, whose generated DDL hashes as before.

Building it is the ordinary sequence with `--source neuf`: `schema`, `vocab`, `scales`,
`ingest --all`, `finalise`, `export`. That is about an hour of fetching at the authenticated rate,
after existing housing's work on ADEME's stream is done.

### Consequences

* Good, because existing housing is untouched and new housing is invisible to the app until
  something reads `v1/neuf/`.
* Bad, because the crosswalk (ADR-0021) still joins existing housing only. New housing's
  certificates carry `id_rnb` too, and adding them is a separate change.
* Neutral, because the tertiary DPE and the audits follow the same pattern, but each needs a
  structure of its own.

### Confirmation

`tests/test_source_neuf.py`:

* the registration, and a database file distinct from existing housing's;
* every column has a place, and the two new ones land on `dpe`;
* the pinned header, and its live twin, reach every column exactly once;
* the search columns exist;
* a certificate round-trips through SQLite and through `v1/neuf/` Parquet.

`tests/test_sources.py`'s check that no two sources share a database or a tree now binds.

## More Information

* Related: [ADR-0017](0017-each-ademe-dataset-is-a-source-with-its-own-database.md),
  [ADR-0018](0018-each-source-publishes-its-own-tree.md),
  [ADR-0023](0023-the-vendored-csv-labels-are-checked-against-the-export.md).
