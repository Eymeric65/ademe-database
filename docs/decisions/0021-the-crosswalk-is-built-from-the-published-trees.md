---
status: accepted
date: 2026-09-10
area: data plane
supersedes:
superseded-by:
---

# ADR-0021 — The crosswalk is built from the published trees, and refuses to publish a broken join

**Status:** accepted · **Decided:** 2026-09-10 · **Area:** data plane

## Context and Problem Statement

The multi-source data plane is one lossless tree per source plus a crosswalk between them, joined
in DuckDB at query time — the shape the owner chose on 2026-09-10 over one wide table or a
building-centric one. The sources are the certificates (ADR-0006), RNB (ADR-0019) and the cadastre
(ADR-0020). The crosswalk is what makes them one dataset: for each certificate, the building it
names and the parcels under that building.

Measured on département 09 with the published certificates (31 157), RNB_09 and the cadastre's
`2026-06-01` edition:

| | certificates | share |
|---|---|---|
| name a building (`id_rnb`) | 12 020 | 38.6 % |
| … which RNB knows | 11 983 | 99.69 % of those naming one |
| … which stands on at least one parcel | 11 983 | all of them |
| … on a parcel in this cadastre edition | 11 959 | 38.4 % of all |

## Decision Drivers

* The crosswalk must mean what a reader of the files would compute. A join built from anything they
  cannot see (the SQLite build, BDNB) would be unverifiable.
* The inputs refresh on different days: certificates weekly, RNB weekly, the cadastre quarterly.
* A broken input — an empty RNB tree, a missing département — must not publish as a finding
  ("RNB does not know these buildings").
* Nationally this is ~8 M certificates naming a building, against ~50 M RNB buildings and ~90 M
  parcels. Each input should be scanned once, not once per partition.

## Considered Options

* Rebuild the whole crosswalk from the published Parquet on every run
* Maintain it incrementally, alongside each source's delta
* Denormalise parcel attributes onto each certificate row

## Decision Outcome

Chosen option: **"rebuild it whole from the published Parquet"**, because it has no state of its
own to drift: whatever the three trees say, the crosswalk says, and it is cheap because it reads only
`numero_dpe, id_rnb` from the certificates, `rnb_id, plots` from RNB and `id` from the cadastre.

```
v1/crosswalk/dept=<certificate partition>/part-0000.parquet
    source, record_key, rnb_id, match_method, parcel_id, bdg_cover_ratio
    one row per (certificate, parcel); sorted by record_key, parcel_id
v1/crosswalk/manifest.json
    version, source, built_at, methods, columns,
    inputs{existant, rnb, cadastre: {built_at, sha256 of that manifest}},
    coverage{certificates, with_id_rnb, resolved, with_parcel, parcel_in_cadastre},
    partitions[{dept, rows, sha256, coverage}]
```

**`match_method`** names how the building was reached. Values:

* `id_rnb` — ADEME named it and RNB knows it. One row per parcel, or one row with a NULL
  parcel when RNB lists none.
* `unresolved` — ADEME named a building RNB does not have. One row, no parcel. The export carries
  only `status = constructed` (ADR-0019), so a demolished building lands here.
* `ban` — reached through the certificate's BAN address when it names no building. Added by the BAN
  fallback. Every candidate is published, flagged, as the owner decided.
* `spatial` — **reserved**, for a point-in-parcel match on the coordinates. Deferred by the owner.

A certificate that names no building has no row until the BAN fallback lands. Absence from the
crosswalk means "no link", and a reader LEFT JOINs.

**Parcel attributes are not copied in.** `parcel_id` joins `v1/cadastre/` at query time. A parcel
missing from the current edition (24 in département 09, from RNB and the cadastre being different
vintages) keeps its id and simply finds no attributes.

**RNB is joined across every partition**, not département to département. A certificate near a
border can name a building filed under the neighbouring département. Duplicated `rnb_id`s are
reduced to one, or they would double their certificates' rows.

**It refuses to publish a join that did not happen.** When fewer than 95 % of the certificates that
name a building resolve in RNB (`MIN_RESOLVED`), the build raises before any published partition
is touched. Département 09 resolves 99.69 %. The manifest records the sha256 and `built_at` of each
input manifest, so a crosswalk says exactly which trees it describes.

### Consequences

* Good, because the three trees stay independently lossless; the crosswalk adds links, not copies.
* Good, because a stale input shows in `inputs`, and a broken one fails the build.
* Bad, because the trees refresh on different days, so a certificate newer than the crosswalk has no
  row until the next build. A LEFT JOIN makes that "no link yet", never a wrong link.
* Neutral, because other ADEME sources (new housing, tertiary, audits) join the same table under
  their own `source` when their trees exist.

### Confirmation

`tests/test_crosswalk.py`: a four-certificate fixture gives exactly its rows and coverage; a
building filed under another département resolves; an RNB tree that resolves nothing raises and
leaves the published manifest alone; the production floor stays ≥ 95 %; the manifest names each
input's sha256. The département 09 numbers above come from `python -m ademe.crosswalk` run over the
real trees.

## More Information

* Related: [ADR-0006](0006-search-index-and-detail-parquet-per-departement.md),
  [ADR-0019](0019-rnb-is-published-without-its-polygons.md),
  [ADR-0020](0020-cadastre-parcels-are-published-as-attributes-only.md).
