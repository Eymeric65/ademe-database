---
status: accepted
date: 2026-09-10
area: data plane
supersedes:
superseded-by:
---

# ADR-0026 — The tertiary DPE (`dpe01tertiaire`) is the third source, with one repeating group of its own

**Status:** accepted · **Decided:** 2026-09-10 · **Area:** data plane

## Context and Problem Statement

The scope includes ADEME's tertiary DPE: certificates for offices, shops and public buildings.
Measured on 2026-09-10:

* `dpe01tertiaire`: 562 695 certificates, 69 columns.
* 46 of those columns are also in existing housing, including every address and commune column
  that existing housing deduplicates (`commune`, `adresse`, `dpe_adresse_brut`).
* **One repeating group:** six `_energie_n1..n3` families. Each slot records an energy, its use,
  its final and primary consumption, its annual cost, and the year the consumption was read.
* Eight top-level columns of its own: `methode_dpe`, `categorie_erp`, `secteur_activite`,
  `surface_shon`, `surface_utile`, `nombre_occupant`, `conso_kwhep_m2_an` and
  `emission_ges_kg_co2_m2_an`.
* It has no dwelling floor area, no dwelling type and no heating installations.
* Its CSV header matches its labels, with one exception. The metadata labels `date_reception_dpe`
  as "Date de réception du DPE", but the export serves the key.

Existing housing's structure (`mapping.EXISTANT`) cannot be reused with `without()`. Too much is
missing, and the energy group is not existing housing's `dpe_bilan_energie`.

## Decision Drivers

* Lossless per source.
* No change to existing housing or new housing.
* A search index that answers a question someone asks of a tertiary building. Its area is
  `surface_utile`, not a dwelling's.

## Considered Options

* A structure of its own: shared reference tables, and one energy repeat
* Every tertiary column top-level on `dpe`
* Existing housing's structure with the tertiary columns squeezed in

## Decision Outcome

Chosen option: **"a structure of its own"**. It is the same shape of decision as existing housing's
(ADR-0001, `mapping.py`), applied to the columns this dataset has.

| | |
|---|---|
| schema | `schema/dpe01tertiaire-schema.json`, vendored 2026-09-10. The `date_reception_dpe` label is set to the served header (ADR-0023) |
| structure | `mapping.TERTIAIRE`: existing housing's commune, address and raw-address dictionaries, plus `dpe_energie` (3 slots: `type_energie`, `type_usage`, `conso_ef`, `conso_ep`, `frais_annuel`, `annee_releve`) |
| database | `ademe-tertiaire.sqlite` |
| tree | `v1/tertiaire/` |
| search | numero, BAN address and commune, both labels, date, `surface_utile`, `conso_kwhep_m2_an`, `emission_ges_kg_co2_m2_an`, `secteur_activite`, `categorie_erp`, construction year and period, lat/lon; sorted by postcode, DPE label, `surface_utile` |

Its `numero_dpe` (562 597 distinct) and `adresse_ban` (378 515) are below the dictionary threshold.
They take the two rules new housing's first build introduced (ADR-0025): the record key stays text,
and a dictionary column that would take a table key is renamed.

### Consequences

* Good, because every tertiary column has a place, and its energies are rows, not 18 sparse
  columns.
* Good, because building it is the ordinary sequence with `--source tertiaire`: about 20 minutes of
  fetching.
* Neutral, because the crosswalk (ADR-0021) still covers existing housing only. Tertiary
  certificates carry `id_rnb` on 43 % and join the same way when that is extended.

### Confirmation

`tests/test_source_tertiaire.py`:

* the registration;
* every column has a place, and the energy group is 18 columns over three slots;
* the pinned header, and its live twin, reach every column exactly once;
* the search columns exist, and are the tertiary ones;
* a certificate with two energies round-trips through SQLite and through `v1/tertiaire/` Parquet.

## More Information

* Related: [ADR-0017](0017-each-ademe-dataset-is-a-source-with-its-own-database.md),
  [ADR-0025](0025-new-housing-is-the-second-source.md).
