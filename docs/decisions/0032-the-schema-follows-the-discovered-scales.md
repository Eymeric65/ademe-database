---
status: accepted
date: 2026-09-11
area: data plane
supersedes:
superseded-by:
---

# ADR-0032 — The schema follows the discovered scales, and scales are fixed before the load

**Status:** accepted · **Decided:** 2026-09-11 · **Area:** data plane

## Context and Problem Statement

A source is built by hand in this order:

1. `ademe.schema` creates the SQLite database;
2. `ademe.scales` samples ADEME and records each numeric column's scale;
3. `vocab`, then `ingest`, `finalise` and the export.

`schema` generates the DDL before any scale is known, so every numeric column is declared
`INTEGER`. `scales.store` then rewrote only `column_meta`. For a scaled column that is harmless,
since an integer is what it stores. For a column **too precise to scale** (more than six decimals,
or a stray non-number), the encoding becomes `text` and the loader stores ADEME's string.
Declared `INTEGER`, SQLite's type affinity converts that string: `"78.50"` becomes REAL 78.5,
`"100.0"` becomes INTEGER 100. The source's text is gone. Tests and the weekly delta call
`schema.build(…, scales=…)` directly, so no test ever saw it.

It went unnoticed for three sources, because none has a column too precise to scale. The energy
audits have **119**: ADEME publishes their consumptions and costs as unrounded floats with twelve
or more decimals. Their national build stored millions of these values as REALs:
3 233 722 in `besoin_chauffage` alone.

The export surfaced it. DuckDB refuses a REAL in a column SQLite declares as integer:

```
_duckdb.TypeMismatchException: Mismatch Type Error: Invalid type in column "conso_ef": column was declared as integer, found "612.422291773342" of type "float" instead.
```

## Decision Drivers

* The DDL must say what `column_meta` says, or the round-trip contract (byte-exact text) is broken
  by the storage engine, silently.
* Scales encode the load. They cannot change once a row is stored.

## Considered Options

* `scales` rebuilds the still-empty data tables under the scales it found, and refuses once rows
  are loaded
* Run `scales` before `schema`
* Declare every numeric column with no affinity (`BLOB`/none), whatever its encoding

## Decision Outcome

Chosen option: **"`scales` rebuilds the empty tables, and refuses after the load"**.

* **Before the load,** `scales.store` drops the data tables (`dpe`, its side and child tables,
  `adresse`, `commune`), all still empty, and re-runs `schema.build` with the scales. Every column
  is then declared by its real encoding, and `column_meta` is written by the same code that wrote
  the DDL. The vocabulary tables are kept, so `vocab` may run before or after.
* **Once `dpe` holds a row,** `store` refuses. Rewriting scales under stored integers would decode
  them with a scale they were not encoded with.

Running `scales` before `schema` would still leave the two steps free to disagree, since `schema`
upserts `column_meta` from its own defaults. Declaring numeric columns without affinity would
change existing housing's schema, published and golden-sha'd, to fix a case it does not have.

### Consequences

* Good, because the build order that bit the audits now produces the right DDL, and the wrong
  order (scales after the load) fails loudly.
* Bad, because the audits' first national build is unusable, and is rebuilt from scratch: about
  3.5 hours at ADEME's keyed rate.
* Neutral, because existing housing, new housing and tertiary are unaffected. Their builds have no
  numeric column encoded `text`, checked on each database.

### Confirmation

`tests/test_scales.py`:

* `test_a_column_too_precise_to_scale_keeps_its_text_through_the_build_order` follows the CLI
  order, and expects `"78.50"` back from a `TEXT` column. Before this change it got `"78.5"`, from
  a column declared `INTEGER`.
* `test_scales_cannot_change_under_loaded_rows` checks the refusal.

## More Information

* Related: [ADR-0004](0004-scaled-integers-are-the-only-lossless-encoding.md), [ADR-0031](0031-the-energy-audits-are-the-fourth-source.md).
