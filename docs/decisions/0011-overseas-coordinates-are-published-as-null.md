---
status: accepted
date: 2026-09-05
area: data plane
supersedes:
superseded-by:
---

# ADR-0011 — Overseas coordinates are published as NULL rather than as ADEME's wrong ones

**Status:** accepted · **Decided:** 2026-09-05 · **Area:** data plane

## Context and Problem Statement

ADR-0006 derives `lat`/`lon` at export by inverting Lambert-93 (EPSG:2154), because the loader's
`_geopoint` path never fires. That is correct for metropolitan France to ~1e-13 degrees, checked
against ADEME's own values.

Building the overseas fixture for the search screen exposed that it is **not** correct anywhere
else. The overseas départements do not publish Lambert-93 coordinates — the Antilles use UTM 20N,
Guyane UTM 22N, Réunion and Mayotte UTM 40S. Applying the Lambert-93 inverse to those does not
fail; it returns a plausible-looking number that is thousands of kilometres wrong.

**ADEME's own `_geopoint` has exactly this bug.** Measured live, one certificate per département:

| département | ADEME's `_geopoint` | where that is |
|---|---|---|
| 971 Guadeloupe | 6.124, 2.662 | Benin |
| 972 Martinique | 4.873, 3.141 | Gulf of Guinea |
| 973 Guyane | −2.594, 0.733 | Atlantic Ocean |
| 974 Réunion | 56.007, −3.001 | **Scotland** |
| 976 Mayotte | 63.992, −0.457 | **Norway** |

So the exporter had a choice between reproducing a known-wrong value and publishing nothing.

## Decision Drivers

* A pin on the wrong continent is indistinguishable from a correct one until somebody opens the map.
* Losslessness is a claim about the *source record*, and the source record is `x`/`y` — which is
  published intact and correct either way. `_geopoint` is ADEME's derived field, not a source column.
* Implementing three more projections is real surface for 8,700 of 15.5M certificates (0.06%).

## Considered Options

* Publish what the Lambert-93 inverse returns, matching ADEME
* Implement UTM 20N / 22N / 40S and publish correct coordinates
* Publish NULL for départements outside Lambert-93's domain

## Decision Outcome

Chosen option: **"NULL outside Lambert-93's domain"**.

`geo.is_lambert93(dept)` is a prefix test on the département code — `97*` is overseas — rather than
a range check on the coordinates. The code is the fact that determines the projection; a coordinate
range check would be inferring it back from the answer, and would silently misclassify a
metropolitan outlier.

The certificates themselves are still published in full, including `coordonnee_cartographique_x_ban`
and `_y_ban` byte-exact, and including the address text — which is what the product is actually
for. Only the derived `lat`/`lon` are withheld.

Implementing the three UTM zones was rejected for now on cost, not on principle: it is ~40 lines per
zone plus a département→zone table, for 0.06% of the data, and it can be added later without
changing anything published — NULL becomes a value, and no reader has to be told.

### Consequences

* Good, because no map pin can be thousands of kilometres wrong.
* Good, because this repository is now *more* correct than the source on this field, and says so.
* Bad, because overseas certificates have no map link. They keep their address, commune and
  postcode.
* Neutral, because the round-trip contract is unaffected: `lat`/`lon` are derived columns, not
  source columns, and every one of the 226 source columns still comes back byte-exact.

### Confirmation

* `tests/test_export_parquet.py::test_overseas_coordinates_are_published_as_null_not_as_the_wrong_continent`
  — parametrised over the five départements above with their real coordinates. It first asserts
  that `to_wgs84` **does** return ADEME's wrong answer, so the bug being avoided is demonstrated
  rather than described, then asserts `wgs84_for` returns `(None, None)`.
* `tests/test_export_parquet.py::test_metropolitan_coordinates_are_still_derived` — the other half:
  the guard must not blank the 99.94% that are right.
* Proven non-vacuous by removing the `is_lambert93` check and watching the overseas cases fail.

## More Information

* Related: [ADR-0006](0006-search-index-and-detail-parquet-per-departement.md) — the derivation this
  bounds.
