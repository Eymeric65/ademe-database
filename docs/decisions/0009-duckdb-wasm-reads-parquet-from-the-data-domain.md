---
status: superseded
date: 2026-09-05
area: frontend
supersedes:
superseded-by: 0012
---

# ADR-0009 — DuckDB-WASM in the browser, reading Parquet from the data domain

**Status:** superseded by [ADR-0012](0012-the-data-plane-is-served-through-the-worker.md) ·
**Decided:** 2026-09-05 · **Area:** frontend

## Context and Problem Statement

ADR-0002 put the certificates on R2 as Parquet, read **directly by the browser** with no server in
between — that is what makes the data plane free of an authorization surface (ADR-0001). ADR-0006
shaped those files around the dominant query. What was never decided is what runs the query.

The search predicates are not trivial: equality on postcode or a LIKE on commune, two class
letters, a month, a range on floor area, optional ±5% ranges on kWh/m² and kgCO₂/m², ordered by
closeness on area. Doing that in JavaScript means fetching a whole partition and filtering it.

## Decision Drivers

* The browser must read Parquet with range requests, or ADR-0006's row-group sort buys nothing.
* No server may sit between the user and the data, or the app plane grows an authorization surface.
* The engine is several megabytes; somebody who lands and leaves must not pay for it.
* Cloudflare Workers Assets **refuses any file over 25 MB**.

## Considered Options

* Fetch the Parquet and filter in JavaScript
* A Worker endpoint that queries on the server
* DuckDB-WASM in the browser

## Decision Outcome

Chosen option: **"DuckDB-WASM"**, `@duckdb/duckdb-wasm` 1.33.

It reads Parquet over HTTP range requests natively, so ADR-0006's sort keys and row-group
statistics do the work they were designed for. A Worker endpoint was rejected because it would put
a server in front of public data and hand the app plane an authorization question it does not
currently have.

### The `eh` bundle, `mvp` as the floor, and never `coi`

`coi` is deliberately not offered. It requires cross-origin isolation — COOP and COEP headers on
every response from the app — which would break any third-party embed and is a heavy, global change
to serve one screen. `eh` (exception handling) covers every browser this targets and `mvp` is the
fallback.

### The WASM comes from the data domain, not the app bundle

This is forced, not preferred. The binaries are **36 MB (`eh`) and 41 MB (`mvp`)**, and Workers
Assets caps a file at 25 MB — `wrangler dev` fails outright with `Asset too large`.

Between a public CDN (jsDelivr, which is duckdb-wasm's own default) and the data domain, the data
domain wins on a specific argument: **the search screen already cannot work without the data
domain**, because that is where the Parquet is. Hosting the engine there adds no new point of
failure, while jsDelivr would add a second, independent one.

The **worker JS stays in the app bundle**: `new Worker()` cannot load a cross-origin script, whereas
fetching the module cross-origin is fine. `scripts/stage-duckdb.mjs` copies the binaries out of
`node_modules` for the e2e fixture server and for upload to R2.

The files must be served as `application/wasm`. `WebAssembly.compileStreaming` refuses anything else
with `Incorrect response MIME type`, naming neither the file nor the header.

### Initialised on the first search, never on first paint

The bundle is megabytes. `manifest()` and the engine are both lazy and both memoised.

### The file list comes from the manifest

HTTP has no globbing, so a client cannot discover partitions. The manifest is the index, and every
build swaps it **last** (ADR-0002), so it never names a file that is not there yet.

`partitionFor` maps a postcode to a partition: `97*`/`98*` to `DOM` (ADR-0006 merges them), `20*` to
Corsica's two, everything else to its first two digits. An unrecognised postcode falls back to every
partition rather than to none — a slow answer beats a wrong empty one.

### Consequences

* Good, because a search reads a few row groups of one ~19 kB–800 kB file, not a partition.
* Good, because the data plane keeps no server and therefore no authorization surface.
* Bad, because the first search costs a multi-megabyte download. Measured at 2.4–3.0 s cold in the
  e2e harness, and it is once per session.
* Bad, because 77 MB of engine now lives in the R2 bucket and has to be re-uploaded on a
  duckdb-wasm upgrade.
* Neutral, because DECIMAL columns are cast to DOUBLE **for display**. ADR-0004's scaled integers
  are about storing and reconstructing the source, which the ETL has already done by the time these
  bytes reach a browser.

### Confirmation

* `test/e2e/search.spec.ts` — a real certificate from the fixture is found from the facts a listing
  publishes; **changing the DPE class by one letter excludes it**, which is what stops the first
  assertion passing against a search that returns everything.
* `test/e2e/search.spec.ts` → "a result links to the map at real coordinates" — asserts the link's
  actual latitude and longitude fall inside Ariège, not merely that a link exists. This caught a
  real bug: Arrow returns a DECIMAL as its **unscaled integer**, so `42.971021` arrived as
  `42971021` and `176.4 m²` rendered as `1764 m²` — plausible enough that neither earlier assertion
  noticed.
* `test/e2e/global-setup.ts` — refuses to start unless the fixture server answers **206** to a
  `Range` request. A server that ignores Range makes DuckDB fail deep in the WASM with a message
  about anything but ranges, and without this the whole search suite could pass against a harness
  that never worked.

## More Information

* Related: [ADR-0002](0002-parquet-on-r2-for-the-data-plane.md),
  [ADR-0006](0006-search-index-and-detail-parquet-per-departement.md),
  [ADR-0011](0011-overseas-coordinates-are-published-as-null.md) — why some results have no map link.
