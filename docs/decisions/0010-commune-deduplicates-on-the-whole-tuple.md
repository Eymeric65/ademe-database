---
status: accepted
date: 2026-09-05
area: data plane
supersedes:
superseded-by:
---

# ADR-0010 — `commune` deduplicates on the whole tuple, not on the INSEE code

**Status:** accepted · **Decided:** 2026-09-05 · **Area:** data plane

## Context and Problem Statement

The Parquet round-trip added in ADR-0006 compared 40 published certificates against live ADEME and
found one field in 9,000 that did not match:

```
2109E0393491Q.nom_commune_ban: source='PAMIERS' parquet='Pamiers'
```

The export was faithful. **The SQLite build already held the wrong value**, so the defect predates
the data plane entirely and the SQLite round-trip test had simply never sampled a row that exposed
it.

`commune` was keyed on `code_insee` alone and written with `ON CONFLICT(code_insee) DO NOTHING`.
ADEME does not normalise `nom_commune_ban`, so certificates for one commune arrive carrying
different spellings, and whichever certificate was loaded first imposed its spelling on every later
one. Measured against the live API across all 31,157 certificates of département 09:

```
326 INSEE codes; 13 carry more than one spelling
  09306 ['TARASCON SUR ARIEGE', 'Tarascon-sur-Ariège']
  09225 ['PAMIERS', 'Pamiers']
  09122 ['FOIX', 'Foix']
  09261 ['SAINT-GIRONS', 'Saint-Girons']
  ...
```

13 of 326 is 4% of communes, but they are the *populous* ones — Pamiers, Foix, Lavelanet,
Saint-Girons — so the share of affected certificates is considerably higher.

This is the same failure `ademe/mapping.py` already records for `adresse`, where certificates
sharing a BAN identifier disagree on the street text and deduplicating on the identifier let one
spelling overwrite the others. That was fixed by keying on the whole address tuple. `commune` kept
the flaw.

## Decision Drivers

* Losslessness is the product's claim about its own data (ADR-0004); a text column must come back
  byte-exact.
* The deduplication that makes `commune` worth having must survive: agreeing certificates still
  have to collapse to one row.
* **Timing.** Fixing this after the 17-hour base build means re-ingesting everything. Before it,
  it costs nothing. That is what makes it urgent rather than merely correct.

## Considered Options

* Normalise `nom_commune_ban` to one canonical spelling and record the deviation
* Move `nom_commune_ban` off `commune` and onto `adresse`
* Give `commune` a surrogate key and deduplicate on the whole tuple

## Decision Outcome

Chosen option: **"surrogate key, tuple deduplication"** — the shape `adresse` already uses, for the
same reason.

```sql
CREATE TABLE commune (
    commune_id INTEGER PRIMARY KEY,
    code_insee TEXT NOT NULL,
    nom_id INTEGER REFERENCES vocab_nom_commune(id),
    code_departement_id INTEGER REFERENCES vocab_code_departement(id),
    code_region_id INTEGER REFERENCES vocab_code_region(id)
);
CREATE UNIQUE INDEX ux_commune_tuple
    ON commune(code_insee, nom_id, code_departement_id, code_region_id);
```

`adresse.code_insee` becomes `adresse.commune_id`. Two certificates at one address that disagree on
the commune's spelling therefore also differ in their address tuple, and get their own `adresse`
row — so the disagreement is preserved all the way down rather than being re-collapsed one level
lower.

The unique index is built by `finalise`, not during the load: the loader deduplicates through its
own cache, and the index is there so `finalise` fails loudly if that cache ever let a true
duplicate through.

Normalising was rejected because it decides, on ADEME's behalf, which spelling is right — and the
whole point of this repository is that the source record can be reproduced, not improved.

### Consequences

* Good, because `nom_commune_ban` now round-trips byte-exact, which was the claim.
* Good, because the `adresse` and `commune` deduplication now have one shape and one explanation
  instead of two.
* Bad, because `commune` grows: about 35k communes nationally, times ~1.04 spellings. Negligible
  against 15.5M certificates.
* Bad, because it invalidates any database built before it. Département 09 was re-ingested (three
  minutes); the national build had not started.
* Neutral, because `code_insee` is still stored and still queryable — it simply is not the key.

### Confirmation

* `tests/test_commune_variants.py::test_both_spellings_of_one_commune_survive` — two certificates
  differing only in the commune's spelling; red before this change with
  `('PAMIERS', 'PAMIERS') == ('PAMIERS', 'Pamiers')`.
* `tests/test_commune_variants.py::test_identical_communes_still_collapse` — the deduplication is
  still on.
* `tests/test_roundtrip.py::test_published_parquet_round_trips` (`live`) — green on a re-ingested
  département 09, where it was red on this exact field.

## More Information

* Related: [ADR-0006](0006-search-index-and-detail-parquet-per-departement.md) — its round-trip test
  is what found this. [ADR-0004](0004-scaled-integers-are-the-only-lossless-encoding.md) — the
  losslessness contract this restores.
