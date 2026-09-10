---
status: accepted
date: 2026-09-10
area: data plane
supersedes:
superseded-by:
---

# ADR-0020 — Cadastre parcels are published as attributes only, streamed one feature at a time

**Status:** accepted · **Decided:** 2026-09-10 · **Area:** data plane

## Context and Problem Statement

The crosswalk (ADR-0021) takes a certificate to the parcels its building stands on, through RNB's
`plots` (ADR-0019). What the parcel *is* — its commune, section, number and area — comes from the
cadastre. Etalab republishes the DGFiP's cadastre quarterly as one gzipped GeoJSON
`FeatureCollection` per département. The URL
`https://cadastre.data.gouv.fr/data/etalab-cadastre/latest/…` redirects to a dated edition, which is
`2026-06-01` today.

Measured on the `2026-06-01` edition:

* 101 départements: 01–95, 2A, 2B, 971–974 and 976. **There is no file for 975, 977 or 978.**
* Département 09: 1 152 197 parcels, 150 MB gzipped, 212 MB even as properties-only NDJSON. Every
  geometry is a `Polygon`. The properties are `id, commune, prefixe, section, numero, contenance,
  arpente, created, updated`, always the same types, never `null`, and ids are unique, 14
  characters, and equal to the feature's own `id`.
* **`contenance` is absent — the key missing, not null — on 410 parcels.**
* 215 556 of the 216 185 parcel ids RNB_09 lists (99.71 %) are in this edition.

## Decision Drivers

* The owner's scope: identifiers and attributes, **no polygons**.
* What is published must equal what Etalab published, field for field.
* A département file is one JSON object: `json.load` on a large one needs several gigabytes, on a
  machine that already swaps during the base build.
* One polite stream, and no download when nothing has changed.

## Considered Options

* Stream one feature per line, write the properties as NDJSON, bulk-load that into DuckDB
* DuckDB `read_json` on the whole `FeatureCollection`, with a very large `maximum_object_size`
* DuckDB's spatial extension (`ST_Read`)

## Decision Outcome

Chosen option: **"stream one feature per line"**, because Etalab writes exactly one feature per line
(RNB_09's cadastre: 1 152 197 lines of one feature, a header line, the last feature closed by `]}`).
That makes streaming a line reader rather than a JSON tokenizer: 16 s and 157 MB peak for
département 09, and the bulk load into Parquet takes half a second. The other two need the whole
object in memory, or a runtime extension download for geometry that is then thrown away.

```
v1/cadastre/dept=<code>/part-0000.parquet   id, commune, prefixe, section, numero  VARCHAR
                                            contenance BIGINT, arpente BOOLEAN,
                                            created, updated DATE
                                            sorted by id, row groups 10k, zstd level 9 (ADR-0016)
v1/cadastre/manifest.json                   version, source, built_at, licence, origin, columns,
                                            partitions[{dept, edition, rows, etag, last_modified,
                                            sha256}]
```

Département 09 goes from 150 MB gzipped to **4.5 MB**.

**Lossless means value-equal.** Every property equals the source's: text byte for byte, integers and
booleans by value, and dates as the same ISO string. An absent `contenance` becomes NULL, which is
safe to read back as absent only because Etalab never writes `null`, and the reader checks that.

**The layout is checked, not assumed.** The first line must be the `FeatureCollection` header; each
line after it must be one `Feature` followed by exactly `,`, or by `]}` on the last line. The
feature's `id` must equal `properties.id`, and a property key outside the nine known ones fails the
build rather than vanishing.

**The edition is recorded and the refresh is conditional.** The dated edition is read off the
redirect and stored on each partition, not once for the manifest: a partial build that straddles a
quarterly release holds two editions, and the manifest must say which is which. Each département is fetched with `If-None-Match` on the
previous ETag: the host answers 304 through the `latest` redirect, verified. A changed file replaces
its partition whole, and the manifest is written last, as for RNB. The départements are read from
the edition's index page.

### Consequences

* Good, because a parcel's area and commune join to the crosswalk by id with no geometry anywhere.
* Bad, because 975, 977 and 978 have no cadastre, so certificates in the `DOM` partition from those
  three reach no parcel. The manifest lists what exists, and the crosswalk reports the gap rather
  than hiding it.
* Bad, because RNB and the cadastre are different vintages: 0.29 % of RNB_09's parcel ids are not in
  this edition (renumbered or merged since). The crosswalk keeps those ids with NULL attributes.
* Neutral, because the same stream could keep the geometry if a later decision wants it.

### Confirmation

`tests/test_cadastre.py`:

* three pinned real features round-trip every property, including a parcel with no `contenance`;
* the published schema has no geometry;
* a malformed line, a new property and a mismatched id each raise;
* a 304 leaves the partition alone, a new ETag replaces it, and a failure leaves the manifest
  untouched.

Marked `live`: every parcel of département 75 against the file it came from.

## More Information

* Related: [ADR-0019](0019-rnb-is-published-without-its-polygons.md) (the building register whose
  `plots` point here).
