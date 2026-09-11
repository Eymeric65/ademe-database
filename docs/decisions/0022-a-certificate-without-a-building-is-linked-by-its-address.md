---
status: accepted
date: 2026-09-10
area: data plane
supersedes:
superseded-by:
---

# ADR-0022 — A certificate that names no building is linked by its BAN address, to every candidate

**Status:** accepted · **Decided:** 2026-09-10 · **Area:** data plane

## Context and Problem Statement

The crosswalk (ADR-0021) links a certificate to a building only when ADEME filled `id_rnb`. In
département 09 that is 12 020 of 31 157 certificates (38.6 %); nationally about half. The rest
still carry `identifiant_ban`, the BAN address key, and RNB lists the BAN keys each building carries
(`addresses[].cle_interop_ban`, ADR-0019). An address is not a building, though. One address can be
on several buildings — a farm and its barns, a block of houses — so a match through it is a set of
candidates, not an answer.

Measured on the published département 09 tree:

| | certificates |
|---|---|
| name no building | 19 137 |
| … carry a BAN key | 19 089 |
| … whose key is on at least one RNB building | 8 204 |
| … on exactly one building | 2 761 |
| candidates per matched certificate | mean 2.52, max 48 |
| crosswalk rows this adds (candidate × parcel) | 37 731 |

## Decision Drivers

* The owner decided on 2026-09-10 that ambiguous matches are **published as flagged candidates**
  rather than dropped.
* ADEME's `id_rnb` is an assertion about the certificate. An address guess must never sit beside it
  looking like an equal.
* A reader must be able to keep only certain links with one predicate.

## Considered Options

* Every candidate, flagged with how many there are
* Only unambiguous matches (one building)
* The candidate with the largest footprint or cover ratio

## Decision Outcome

Chosen option: **"every candidate, flagged with how many there are"**. It is the owner's call, and
the only one of the three that throws nothing away while still letting a reader throw it away.

* `match_method = 'ban'`, one row per (certificate, candidate building, parcel), or one row with a
  NULL parcel when that building lists none.
* A new column, **`ban_candidates INTEGER`**, holds how many distinct buildings carry the
  certificate's BAN key. It is NULL on `id_rnb` and `unresolved` rows.
  `match_method = 'id_rnb' OR ban_candidates = 1` keeps only single links.
* **Only when `id_rnb` is NULL.** A certificate whose `id_rnb` RNB does not know stays `unresolved`
  rather than being re-guessed from its address: ADEME named something, and a guess would hide that
  it is gone.
* RNB is matched across every département, as for `id_rnb`. Each (building, key) pair is counted
  once, so a building that lists the same key twice, or is filed twice, does not become two
  candidates.

The coverage block gains `ban_matched` (certificates linked through their address) and
`ban_single` (through an address on exactly one building). `with_parcel` and `parcel_in_cadastre`
keep counting ADEME's own links only, so the headline rate cannot be inflated by guesses. The
95 % floor stays on `id_rnb` resolution.

### Consequences

* Good, because certificates linked to a building rise from 38.6 % to 64.9 % in département 09,
  and single links from 38.6 % to 47.3 %.
* Bad, because a naive `JOIN` without the flag counts a 48-building address 48 times. The column
  exists to make that avoidable, not to make it impossible.
* Neutral, because the reserved `spatial` method (a point-in-parcel match on the coordinates) would
  cover much of the 35 % that neither key reaches. It is deferred.

### Confirmation

`tests/test_crosswalk.py`: the fixture's two address-only certificates get exactly one and two
candidates with the right `ban_candidates`; a certificate with an `id_rnb` gets no `ban` row even
though its address matches; a building filed under another département is still a candidate;
`ban_matched` and `ban_single` count them. The département 09 numbers above come from
`python -m ademe.crosswalk` over the real trees.

## More Information

* Related: [ADR-0019](0019-rnb-is-published-without-its-polygons.md),
  [ADR-0021](0021-the-crosswalk-is-built-from-the-published-trees.md).
