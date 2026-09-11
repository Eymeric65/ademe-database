---
status: accepted
date: 2026-09-10
area: data plane
supersedes:
superseded-by:
---

# ADR-0019 — RNB is published per département, without its polygons or its validators

**Status:** accepted · **Decided:** 2026-09-10 · **Area:** data plane

## Context and Problem Statement

The multi-source data plane joins a certificate to the cadastre. ADEME's own column is the way in:
`id_rnb` names a building in the RNB (Référentiel National des Bâtiments), and each RNB building
lists the cadastre parcels it stands on and the BAN addresses it carries. Measured on
département 09 on 2026-09-10:

* 12 016 of 31 061 certificates carry an `id_rnb` (39 %; nationally 8.0 M of 15.56 M, 51 %).
* 7 349 of the 7 373 distinct values resolve in RNB's export (99.7 %), every one with at least one
  parcel.

RNB publishes a weekly CSV per département, zipped, on a Scaleway S3 bucket listed in the
data.gouv.fr catalogue (110 files: every département, 2A/2B, 971–978, 984–989, and a national file
of 11.7 GB). Licence Ouverte 2.0. The columns are
`rnb_id;point;shape;status;ext_ids;addresses;plots;validated_by`, and the last four but one are JSON.

## Decision Drivers

* The owner's scope: identifiers and attributes, **no polygons**. `shape` is ~90 % of the CSV
  (RNB_09: 231 MB of CSV, 22 MB of Parquet without it).
* What is published must be what RNB published, provably — the round-trip rule of §11, applied to a
  source we do not control the shape of.
* `validated_by` names the person who validated a building: a username and their organisation, in
  5 of RNB_09's 246 526 rows. It is personal data and nothing here needs it.
* RNB is not ADEME, so ADEME's rate limit does not bind it, but the same politeness does: one
  stream, no retry storm.

## Considered Options

* Typed nested columns (`LIST<STRUCT>`), polygon and validator dropped
* The JSON columns kept verbatim as text
* The national file, one partition

## Decision Outcome

Chosen option: **"typed nested columns, polygon and validator dropped"**, because it is both the
smallest (19.9 MB for RNB_09 against 22.2 MB as text) and the one a join can read without parsing,
and because parsing it once, at build time, is where a change upstream can be caught.

```
v1/rnb/dept=<code>/part-0000.parquet   rnb_id, status, point,
                                       ext_ids   LIST<STRUCT<id, source, created_at, source_version>>,
                                       addresses LIST<STRUCT<cle_interop_ban, street_number,
                                                             street_rep, street, city_zipcode,
                                                             city_name>>,
                                       plots     LIST<STRUCT<id VARCHAR, bdg_cover_ratio DOUBLE>>
                                       sorted by rnb_id, row groups 10k, zstd level 9 (ADR-0016)
v1/rnb/manifest.json                   version, source, built_at, licence, origin, columns, dropped,
                                       partitions[{dept, rows, etag, last_modified, sha256}]
```

**Lossless means value-equal after parsing.** RNB writes `"id" : "…"` with spaces around the colon,
so the published bytes cannot be the source's bytes. Every kept field must equal the source field
once both are parsed as JSON: `null` stays `null` and `""` stays `""` (`street_rep` uses both), an
empty field stays NULL and `[]` stays an empty list (RNB uses both on `plots` and `ext_ids`, and
they mean different things), and `bdg_cover_ratio` round-trips as a double —
`1.0000000000000002` included. Over all of RNB_09: **0 mismatches in 246 526 buildings.**

**A new field fails the build.** `json_transform` drops a key it was not told about, and a SELECT
of known columns drops a new one, so either change upstream would publish less than RNB did with
every test green. `convert` checks the header and every nested key set first, and raises.

**One partition per RNB file**, named by RNB's own code. There is no `DOM` merge: nothing scans RNB
by range, and the crosswalk reads the partitions the manifest lists.

**Refresh is conditional.** Each département is fetched with `If-None-Match` on the ETag in the
previous manifest. An unchanged file answers 304 and its partition is left alone. A changed one is
downloaded, converted beside the output (not `/tmp`, which is RAM on Fedora), and replaces its
partition whole. A failure aborts before the manifest is written, so the published manifest never
names a half-built set. A build of some départements keeps the others' entries.

The client is RNB's own. `api.client()` carries the ADEME key, which is a credential for one
operator and is not sent to another.

### Consequences

* Good, because the crosswalk reads `plots[].id` and `addresses[].cle_interop_ban` directly.
* Good, because an unchanged week costs 110 conditional requests and no download.
* Bad, because only `status = constructed` appears in the export (all 246 526 rows of RNB_09), so an
  `id_rnb` naming a demolished building does not resolve. The crosswalk records it as unresolved.
* Neutral, because building geometry stays available upstream if a later decision wants it.

### Confirmation

`tests/test_rnb.py`: three pinned real lines round-trip every kept field; the published schema is
exactly the kept columns; NULL and `[]` stay apart; a new column or nested key raises; 304 leaves a
partition untouched and a new ETag replaces it; a failed département leaves the manifest unchanged;
a partial build keeps the other entries; the ADEME key is never sent. Marked `live`: all of RNB_09
against the file it came from.

## More Information

* Related: [ADR-0016](0016-zstd-level-nine-for-the-published-parquet.md) (the compression reused),
  [ADR-0017](0017-each-ademe-dataset-is-a-source-with-its-own-database.md) (sources).
