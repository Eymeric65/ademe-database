---
status: accepted
date: 2026-09-10
area: data plane
supersedes:
superseded-by:
---

# ADR-0024 — Certificates ADEME could not geocode are fetched and published as partition `NG`

**Status:** accepted · **Decided:** 2026-09-10 · **Area:** data plane

## Context and Problem Statement

The ingest asks ADEME for one département at a time, filtering on `code_departement_ban`, and the
export partitions by the département of the certificate's commune. A certificate whose address the
BAN could not match — `statut_geocodage = "adresse non géocodée ban car aucune correspondance
trouvée"` — carries **no BAN field at all**, `code_departement_ban` included. No département query
ever returns it.

Measured when the national build finished on 2026-09-10:

* ADEME: 15 557 428 certificates; **531 646 with no `code_departement_ban`** (3.4 %).
* The build: 15 017 183, which is every département's total, exactly.
* Of the 531 646, all carry `code_postal_brut` and the raw address; 34 346 carry a
  `code_insee_ban`. Their numéros still embed a département (`2684E…`).

Nothing noticed. The ledger matched ADEME per département because the missing rows belong to none;
the round-trip samples what was loaded; the reconciliation compares partitions by département.

## Decision Drivers

* The data plane is the whole dataset, losslessly; 3.4 % absent is not a rounding error.
* A certificate with no BAN address cannot be found by postcode anyway — the question is only
  whether it exists in the published data at all, and whether the detail view reaches it by numéro.
* The ingest, the delta and the reconciliation already work per partition code; a new code costs
  them nothing, a new mechanism costs each of them one.

## Considered Options

* One pseudo-département, `NG`, from the ADEME query to the published partition
* Place each in the partition its numéro or raw postcode points at
* Leave them out and document it

## Decision Outcome

Chosen option: **"one pseudo-département, `NG`"** (non géocodé, in ADEME's own words), because it
reaches every one of them through the machinery that already exists, where guessing a partition
from a numéro or a hand-typed postcode would put a certificate in a département its data does not
support.

* **Query.** `api._departement_qs("NG")` is `NOT _exists_:code_departement_ban`. `ingest --all`
  appends `NG` to ADEME's list; the ledger, `ingest --dept NG`, the reconciliation's totals and id
  pulls all work unchanged, because they only ever pass a code.
* **Export.** A certificate whose commune carries no département — no commune at all, or a commune
  with an INSEE code and no département — goes to `v1/{search,dpe}/dept=NG/`. Its numéro's digits
  never match `NG`, so every one is in `index/numero-exceptions.parquet`, which is how the detail
  view already finds a certificate outside its guessed partition.
* **Delta.** The weekly fetch filters on the modification date, not the département, so it already
  returns them; the delta's export puts them in `NG`, and the merge treats `NG` like any partition.

### Consequences

* Good, because the published dataset is ADEME's whole dataset again.
* Bad, because `NG` is ~0.5 M rows in one partition and its search file answers no postcode query
  (the BAN postcode is empty). It is the detail view's, not the search's.
* Neutral, because a later geocoding of these addresses by ADEME moves a certificate out of `NG`
  through the ordinary delta: it becomes a modification with a département.

### Confirmation

`tests/test_ungeocoded.py`: `NG` asks for rows with no département and ordinary codes are
unchanged; `--all` includes `NG`; certificates with no BAN, and with an INSEE code but no
département, are published in `dept=NG` with every column intact and listed in the exceptions
index; a weekly delta merges into `NG`.

## More Information

* Related: [ADR-0006](0006-search-index-and-detail-parquet-per-departement.md),
  [ADR-0007](0007-the-delta-cannot-see-deletions-so-reconcile-by-count.md).
