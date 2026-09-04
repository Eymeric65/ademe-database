---
status: accepted
date: 2026-09-04
area: encoding
supersedes:
superseded-by:
---

# ADR-0004 — Numeric columns are stored as integers with a declared scale

**Status:** accepted · **Decided:** 2026-09-04 · **Area:** encoding

## Context and Problem Statement

The DPE export has 127 numeric columns. The obvious encodings are TEXT (as published), REAL, or
SQLite's NUMERIC affinity. The requirement is that a published record can be reconstructed exactly,
so the choice is a correctness question before it is a size question.

## Decision Drivers

* Losslessness is the product's claim about its own data.
* 15.5M rows makes a per-value byte a gigabyte-scale decision.
* Whatever is chosen must survive a later move to Postgres.

## Considered Options

* TEXT, as published
* REAL / NUMERIC affinity
* INTEGER scaled by a per-column power of ten

## Decision Outcome

Chosen option: **"scaled INTEGER"**. Measured over 200k rows and five one-decimal columns:

| encoding | bytes vs scaled INTEGER |
|---|---|
| TEXT | +2.79 B per column per row |
| **NUMERIC** | **+5.47** |
| **REAL** | **+5.47 — byte-identical to NUMERIC** |

NUMERIC affinity compacts only values that are already whole; `12.3` becomes an 8-byte double
either way. Declaring numeric columns NUMERIC — which an earlier draft of the plan did — is *worse
than doing nothing*.

The stronger argument is correctness: **REAL is not lossless.** `text → double → text` does not
round-trip. An integer plus a declared scale is byte-exact by construction, and the scale lives in
`column_meta` so a Postgres migration can generate `NUMERIC(_,1)` from it.

Measured distribution: 96 columns carry exactly one decimal, 3 carry two, and the Lambert-93
coordinates carry up to six.

**A column too precise for its scale is stored as TEXT, never as a plain integer.** The first
implementation fell back to scale 1 — plain INTEGER — which silently truncated the decimals the cap
existed to protect, and the coordinate columns hit it. The fallback for "too precise to scale" must
be the exact encoding, never the lossy one. A value that fails to round-trip at ingest is written
verbatim to `scale_violation` and preferred on read.

### Consequences

* Good, because it is byte-exact and roughly 5.5 GB smaller than REAL at full scale.
* Good, because the scale is data, so reconstruction and migration both read it rather than assume it.
* Bad, because stored values are not human-readable; a view divides them back.
* Neutral: reconstruction emits the declared scale, so `38` returns as `38.0`. Losslessness is
  defined on the value for numeric columns and byte-exactly for everything else.
