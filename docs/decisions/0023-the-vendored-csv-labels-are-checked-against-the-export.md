---
status: accepted
date: 2026-09-10
area: data plane
supersedes:
superseded-by:
---

# ADR-0023 — The vendored CSV labels are checked against the export, and a header collision stops the load

**Status:** accepted · **Decided:** 2026-09-10 · **Area:** data plane

## Context and Problem Statement

The ingest reads ADEME as CSV, which is 13× smaller than JSON (the `api` module docstring). Data
Fair heads each CSV column with the schema's `label`, not its `key`. `spec.rename_row` maps labels
back to keys through the vendored `schema/ademe-schema.json`.

A postmortem. On 2026-09-10 the header ADEME serves for two columns was their own key:

| key | vendored label | header served 2026-09-10 |
|---|---|---|
| `adresse_brut` | `numero_voie_brut` | `adresse_brut` |
| `adresse_complete_brut` | `adresse_brut` | `adresse_complete_brut` |

So the rename mapped the header `adresse_brut` onto the key `adresse_complete_brut`. The real
`adresse_complete_brut` header landed on the same key, and a dict comprehension let the second
overwrite the first. `adresse_complete_brut` came out right and **`adresse_brut` was stored
empty**. Checked against the whole served header, it is the only one of 226 columns affected.

* The national build: **7 922 848 certificates loaded, `adresse_brut` filled on none.**
* The published département 09 (built 2026-09-05): **31 157 rows, `adresse_brut` filled on none.**
  The change predates it.

Nothing failed, because the round-trip test, the definition of lossless (§11), fetched its reference
records through the same `api.page` rename. The column was lost identically on both sides of the
comparison.

## Decision Drivers

* The labels are ADEME's, and they change without notice.
* A national build is loading into this schema right now. Nothing may change its DDL.
* A lost column must be a loud failure on the first page, not an empty column after 17 hours.
* The losslessness test must not share a transport step with the code it checks.

## Considered Options

* Correct the drifted labels, refuse header collisions, check the labels against the live header,
  and make the round-trip reference independent of them
* Refresh the whole vendored schema from the live metadata
* Read the ingest as JSON, which is keyed and has no labels

## Decision Outcome

Chosen option: **the first**, because it is the only one that fixes the mapping without touching
the running build's schema or doubling its download.

* **Eight labels are corrected to the header served on 2026-09-10**: the two above, and six
  `conso_chauffage_*` fields whose vendored labels (`conso_chauffage_ef_*`) the export no longer
  uses. Those six happened to be harmless, because an unmapped header passes through as itself. A
  label that is not the served header is still a collision waiting for its pair. Nothing else in
  the file changes.
* **`rename_row` refuses a collision.** Two headers landing on one key raise `ValueError`, naming
  the key, on the first page of the load.
* **`tests/test_csv_labels.py`** checks that a pinned copy of the 2026-09-10 header reaches every
  schema column exactly once. A `live` twin checks the header ADEME serves at the time of the run.
* **The round-trip reference is renamed with the labels ADEME publishes today**, read from the
  dataset's metadata, not with the vendored ones. A stale vendored label now shows up as a
  mismatch instead of cancelling out.

The whole-schema refresh was rejected because `x-cardinality` drifts: 114 of the 230 fields had
moved by 2026-09-10. The encoding is chosen from it (`spec._encoding`), so a refresh could turn a
closed vocabulary into an open one, or a dictionary into inline text, under a half-loaded database.
JSON was rejected at 13× the bytes: a 17-hour build would become far longer.

### Consequences

* Good, because the next renamed header stops the ingest on its first page, and the live test says
  why.
* Bad, because **the running build keeps losing `adresse_brut` until it finishes**. Its code
  predates this change, and stopping it would not help. The recovery is one targeted pass over
  `select=numero_dpe,adresse_brut`, run before `finalise` and the export. That is a separate change.
* Bad, because the live round-trip now fails on the national build until that backfill runs. That
  is the test working.
* Neutral, because the published département 09 is replaced wholesale by the national export.

### Confirmation

`tests/test_csv_labels.py` (offline, and `live`). The live round-trip, `tests/test_roundtrip.py`,
compares against a reference that does not use the vendored labels. Existing housing's generated
DDL, `column_meta` rows and indexes hash identically before and after the labels change.

## More Information

* Related: [ADR-0004](0004-scaled-integers-are-the-only-lossless-encoding.md) (what "lossless" is
  held to).
