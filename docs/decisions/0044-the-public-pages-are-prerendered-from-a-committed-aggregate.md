---
status: accepted
date: 2026-09-20
area: data plane
supersedes:
superseded-by:
---

# ADR-0044 — The public département pages are prerendered from one aggregate committed to the repository

**Status:** accepted · **Decided:** 2026-09-20 · **Area:** data plane

## Context and Problem Statement

The site has nothing a search engine can read. Everything behind the Worker's `/data/*` route needs
a session (ADR-0012), and that gate is the whole reason the certificates can be served at all
without becoming a republication of ADEME's file under our name.

We want ~101 public pages, one per département, carrying statistics: how many certificates, how the
classes are distributed, what share are *passoires thermiques*, what a typical consumption and
surface look like, which communes have the most. Those are numbers about a place, not certificates
about an address — nobody can find a building in them. So the question is not whether the pages may
exist but where their numbers come from at build time, given that the build has no credentials for
the bucket and must not acquire any.

## Decision Drivers

* The gate stays exactly where it is. A public page may carry aggregates and nothing else: no
  address, no `numero_dpe`, no individual certificate, ever.
* The site build must stay hermetic. `npm run build` runs in CI and on a laptop and must not need
  R2 credentials, network access to the bucket, or a multi-gigabyte download.
* A change to published numbers should be visible to a human before it is public.
* The published `v1/` tree is structurally two to three months behind live ADEME, because the
  recent window is paid and lives in its own tree (ADR-0039). Whatever the pages say, they must say
  as of when.
* CI cannot push to `dev` — `etl-weekly.yml` uploads to R2 and opens nothing.

## Considered Options

* A new ETL module writes one JSON, committed to the repository, and the site build reads the file
* The Worker computes the numbers live from R2 on each request
* The site build fetches the published tree (or a derived aggregate) from R2 at build time
* A step in `etl-weekly.yml` regenerates the aggregate every Monday

## Decision Outcome

Chosen option: **"one JSON committed to the repository"**. `ademe.aggregate` reads the published
`search/` tree with DuckDB, the way ADR-0033 already has the weekly job read published trees, and
writes `src/seo/aggregates.json` (~350 kB). It is run by hand, from the machine holding the tree,
after a weekly run has landed:

```
uv run python -m ademe.aggregate --root DIR/v1
```

`--root` takes a local directory or a URL, so the same command works against R2's tree through the
Worker-less path a holder of the files would use.

The artifact is derived data in the data plane, and it is the *only* thing that will ever leave the
gate: counts, A–G histograms for `etiquette_dpe` and `etiquette_ges`, the F+G share, quartiles of
`conso_5_usages_par_m2_ep`, a median surface, breakdowns by `periode_construction` and
`type_batiment`, certificates by year, and the twenty largest communes by count — each named by the
*most frequent* `nom_commune_ban` under one `code_insee_ban`, because ADEME does not normalise the
spelling and grouping on the name would publish Foix twice at half its size (ADR-0010).

Committed rather than fetched, because a fetch at build time would put R2 credentials into every
place the site is built and make the build's output depend on the day it ran. Committed, the build
reads a file that is in the tree, and a refresh of the statistics arrives as a pull request whose
diff is the numbers themselves — `+1 516 358 passoires` is a thing a reviewer can look at.

Refreshed by hand rather than weekly, because CI does not push to `dev`, and a job that could would
be a job that can change what the public pages say without anyone reading the change. The
consequence is that the numbers go stale between refreshes, so the artifact is stamped with the
manifest's `built_at` and `high_water` and every page displays its cut-off. Stale and *saying so* is
a different failure from stale and silent.

### What is not published

Two of the 103 partitions are marked `publishable: false` and get no page:

| partition | why |
|---|---|
| `NG` | the pseudo-département the certificates ADEME could not geocode land in (ADR-0024). It is a bucket, not a place; 531 646 certificates that belong to somewhere unknown. |
| `DOM` | Saint-Pierre-et-Miquelon, Mayotte, Saint-Barthélemy and Saint-Martin merged into one partition (`export_parquet.DOM`). A page titled "DOM" would be about four territories at once. |

Both are still aggregated and still counted in the national totals: `publishable` governs which
partitions get a page, not which are counted, and a national total that quietly dropped half a
million ungeocoded certificates would be wrong.

### Consequences

* Good, because the build stays hermetic. No R2 credentials, no network, no download; the pages are
  static and can be served to anyone without touching `/data/*`.
* Good, because a statistics refresh is a reviewable diff rather than an invisible change in
  production.
* Good, because the aggregate is computed from the published files with DuckDB, so it can only ever
  say what the published data supports, and anybody holding the tree can reproduce it.
* Bad, because the numbers are refreshed manually and will drift behind the weekly run. Mitigated,
  not solved, by stamping the cut-off on every page.
* Bad, because the JSON is ~350 kB of generated content in the repository, and a refresh touches
  every partition's block.
* Neutral, because only `existant` is aggregated for now. `neuf`, `tertiaire` and `audit` have
  their own trees and would be a second phase.

### Confirmation

`tests/test_aggregate.py` builds a `search/` tree in `tmp_path` with DuckDB and pins every number
by hand: the A–G histogram, the F+G share as an exact fraction, the quartiles, the median surface,
one commune under two spellings coming back once under the modal one, `NG` and `DOM` coming back
`publishable: false` while still counting toward the national total, and the stamp coming from the
manifest. `test_no_address_and_no_certificate_id_reach_the_output` serialises the whole result and
fails if a `numero_dpe` or an address string appears anywhere in it — that one is the gate.

## Pros and Cons of the Options

### The Worker computes the numbers live from R2

* Good, because the numbers are never stale.
* Bad, because a public route that scans Parquet is a public route that scans Parquet: every
  crawler hit becomes R2 reads and CPU, for numbers that change once a week.
* Bad, because it puts a second, unauthenticated path onto the data the gate exists to cover.

### The site build fetches from R2

* Bad, because R2 credentials move into every environment that builds the site, including a laptop.
* Bad, because the build stops being reproducible: the same commit renders different pages on
  different days, and nothing records which.

### A step in `etl-weekly.yml`

* Good, because it would never be forgotten.
* Bad, because the job cannot push to `dev` and giving it that ability makes an unattended job able
  to change what the public pages say.

## More Information

* Related: [ADR-0012](0012-the-data-plane-is-served-through-the-worker.md),
  [ADR-0024](0024-ungeocoded-certificates-are-the-ng-partition.md),
  [ADR-0033](0033-the-weekly-job-reads-the-published-trees-from-r2.md),
  [ADR-0039](0039-the-last-two-months-are-published-in-a-tree-of-their-own-beside-a-counts-only-index.md).
