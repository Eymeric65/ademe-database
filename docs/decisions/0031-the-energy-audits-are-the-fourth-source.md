---
status: accepted
date: 2026-09-11
area: data plane
supersedes:
superseded-by:
---

# ADR-0031 — The energy audits are the fourth source, one row per step

**Status:** accepted · **Decided:** 2026-09-11 · **Area:** data plane

## Context and Problem Statement

ADEME publishes its energy audits (dataset `ync2epx48x9azbdnggbygqp0`): 3 237 797 rows in 232
columns. The data was updated 2026-09-06 and the schema 2026-06-30. An audit (`n_audit`, 713 680
of them) proposes renovation scenarios in steps. Each step is one row with its own `id_etape`, and
the audit's `numero_dpe` is the DPE it starts from.

The dataset differs from the DPE datasets in four ways that matter to the ETL:

* **Its row key is `id_etape`.** It is unique over all 3 237 797 rows, checked by paging the
  column. ADEME declares `n_audit` the primary concept, but `n_audit` repeats across an audit's
  steps. ADR-0029 made the key a per-source field.
* **Its BAN columns are renamed:** `n_departement_ban`, `n_region_ban`, `n_voie_ban`,
  `nom_voie_ban`. Its modification date is `date_derniere_modification`, and its raw address is
  four columns, including `n_et_nom_voie_brut`.
* **Its repeating groups are its own**, each a clean grid over the schema's keys:
  * heating installations: 8 fields × 2;
  * their generators: 4 fields × 2 generators × 2 installations;
  * energies: 10 fields × 3;
  * a hot-water generator: 7 fields × 1.
* **Only 46 of its columns carry a `label`.** For the other 186, ADEME's CSV header is the key
  itself (`conso_5_usages`, `ep_conso_ch`…). For the 46, it is the label (`identifiant_BAN`,
  `n_departement_BAN`, `id_RNB`). `spec._header_to_key` already maps an unlabelled field to its
  key, and the served header, pinned in a fixture, reaches every column exactly once.

Like existing housing, it is a virtual view filtered on a flag (`in_desactive = 0`), so a
deactivated audit step leaves it silently. Reconciliation by count (ADR-0007) applies unchanged.

## Decision Drivers

* Lossless, as every source is: every column reconstructed and compared.
* The same machinery: no audit-specific code outside its `Mapping`, its search columns and its
  registry entry.

## Considered Options

* A source of its own, one row per step
* One row per audit, steps nested
* Only the audits' link columns (`n_audit`, `numero_dpe`, `id_rnb`), in the crosswalk

## Decision Outcome

Chosen option: **"a source of its own, one row per step"**:

* **Registry:** `config.AUDIT`, with its own database (`ademe-audit.sqlite`) and its tree under
  `v1/audit/`.
* **Mapping:** `mapping.AUDIT`, with its four repeating groups, its commune, address and raw-address
  columns, and `key="id_etape"`, `departement="n_departement_ban"`,
  `modified="date_derniere_modification"`.
* **Search columns:** its own, under `export_parquet.SEARCH["audit"]`. They carry the step, the
  scenario and the audit's DPE, sorted by postcode, audit and step.
* **Weekly job:** after tertiary.

One row per audit would invent a shape ADEME does not publish, and could not be reconstructed as
ADEME's rows. Link columns alone would drop 229 columns that some reader will want.

### Consequences

* Good, because an audit step joins a DPE on `numero_dpe` and a building on `id_rnb`, like the
  others.
* Neutral, because the vendored labels are ADEME's as served. A header that drifts fails the live
  test, as for the other sources (ADR-0023).
* Bad, because the base build is ADEME's largest after existing housing: 3.2M rows at ADEME's
  keyed rate, about an hour.

### Confirmation

`tests/test_source_audit.py` checks five things:

* the source's registration and its three fields;
* every column's place and the four groups' slot counts;
* the served header reaching every column once;
* the search columns;
* two steps of one audit round-tripping through the load, `finalise`, reconstruction and the
  export.

## More Information

* Related: [ADR-0029](0029-each-source-names-its-key-departement-and-modified-fields.md),
  [ADR-0026](0026-the-tertiary-dpe-is-the-third-source.md),
  [ADR-0027](0027-the-weekly-job-updates-every-source-in-turn.md).
