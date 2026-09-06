---
status: accepted
date: 2026-09-06
area: security
supersedes: 0009
superseded-by:
---

# ADR-0012 — The certificates are served through the Worker and require a session

**Status:** accepted · **Decided:** 2026-09-06 · **Area:** security

## Context and Problem Statement

The product needs an account before it will search. The obvious implementation is a branch in
`src/App.tsx`: no session, no form. That is a conversion prompt, not a control — until this record
the Parquet sat on `data.recherche-maison.com`, a public R2 custom domain the browser read
directly, so anyone who opened the network tab could read every certificate with one `curl` and
never load the app at all.

So the question is not whether to hide the form. It is whether "search requires an account" is a
sentence about the interface or about the data. ADR-0009 answered a *different* question — what
runs the query — and in doing so rejected "a Worker endpoint that queries on the server" because it
"would put a server in front of public data and hand the app plane an authorization question it
does not currently have". That was correct when nobody wanted the question asked. Somebody now
does.

## Decision Drivers

* A control a person can step around by not using the UI is not a control.
* ADR-0006's row-group sort and ADR-0009's engine choice are both worthless without HTTP ranges, so
  whatever sits in front of the data must speak `Range` fluently.
* CLAUDE.md §9: the gate is a default-deny exception list applied **once**, in the router. A second
  gate somewhere else is how adding a module becomes the thing that forgets.
* The 77 MB engine has to load *before* the app can render the screen that asks someone to sign in.
* Cloudflare Workers Assets still refuses any file over 25 MB.

## Considered Options

* Hide the search form in React, leave the bucket public
* Presigned R2 URLs, minted by the Worker per file
* Serve `/data/*` from the Worker over an R2 binding, behind the existing route gate

## Decision Outcome

Chosen option: **"serve `/data/*` from the Worker"**, because it is the only one of the three where
the answer to "who may read a certificate" is given by the same line of code that answers it for
every other route.

```
before:  browser ──Range──> data.recherche-maison.com (public R2 domain)
after:   browser ──Range──> Worker /data/v1/*  ──binding──> R2 (no public domain)
                              └── the gate in server/index.ts
```

Presigned URLs were rejected on a specific ground: a signed URL is a bearer token with a lifetime.
It can be pasted into a chat window and it keeps working, and choosing its expiry means trading a
sharing hole against a query that dies halfway through reading a Parquet footer. The binding has
neither problem.

### A fourth scope, because three would have been a lie

```ts
type Scope = 'public' | 'signed-in' | 'self' | 'owner'
```

`owner` and `self` both mean *this row belongs to somebody*. A DPE row belongs to nobody — ADR-0001
is unchanged on that point, and this record does not give the data plane an owner. What it gives it
is a **precondition**: a caller must exist, and then nothing is filtered.

That makes `signed-in` strictly weaker than `owner`, which is a hazard rather than a convenience: on
a route that returns owned rows it would ask for a session and then return everybody's. So
`test/unit/authorization.test.ts` refuses the combination outright — no `/api/*` route may carry it
— on top of the exact-set allowlist it already applied to `public` and `self`.

### What stays public, and why that is not a hole

`/data/vendor/*` — the DuckDB-WASM binaries — is `public`. Gating them would gate the sign-in
screen, since the app cannot paint before the engine resolves. They are an open-source artifact
carrying no certificate data, and they are the one thing here worth caching at the edge:
`public, max-age=31536000, immutable`.

**The gated path gets `private, max-age=300` instead, and the distinction is load-bearing.** A
`public` directive on `/data/v1/*` would file one caller's bytes in a shared edge cache, where the
next request reads them without ever reaching the gate — a bypass built out of a cache header. It
is a trap comment in `server/index.ts` for exactly that reason.

### Measured cost

Against the deployed preview and the real bucket (dept 09, 31,157 certificates), 25 interleaved
ranged GETs of the same 64 kB span, same client:

| path | median | mean |
|---|---|---|
| `data.recherche-maison.com` (direct R2) | 128 ms | 143 ms |
| `/data/v1/…` through the Worker | 169 ms | 173 ms |

**+41 ms per ranged request.** The fear was that this multiplied by a large number. It does not:
one cold search issues **4 requests** under `/data/v1/` and one for the engine; a second search on
the same page issues **2**. ADR-0006's sort keys and row-group statistics are why — the engine reads
a footer and the row groups it needs, not a partition.

A cold search measured **2.86 s** end to end, which is inside the 2.4–3.0 s ADR-0009 recorded before
any of this existed: the engine download still dominates and the proxy is lost in it.

At roughly five Worker requests per search, the free plan's 100k requests/day is about 20k searches
a day. If the per-request cost ever does matter, the lever is Better Auth's signed cookie cache,
which would take the session lookup off the hot path — deliberately **not** taken here, because it
trades revocation latency for milliseconds nobody is currently spending.

### Consequences

* Good, because "the certificates require an account" is now true of the bytes, not of the screen.
* Good, because there is no CORS surface left: the data is same-origin with the app, and
  `infra/r2-cors.json` becomes dead config the day the custom domain is removed.
* Good, because the e2e harness lost an origin. The fixture server is gone; the local R2 bucket is
  seeded instead, so the suite exercises the same transport production does rather than a stand-in.
* Bad, because +41 ms per range request, and because Worker requests are now proportional to
  searches where they used to be zero.
* Bad, because **the bucket's public custom domain must be removed by hand.** Until it is, the old
  URL still serves every file and this record describes an intention rather than a state. It cannot
  be done before the deploy without breaking the running preview, so it is ordered after it.
* Neutral, because ADR-0001 still holds: two stores, no shared schema, no shared connection, no
  join across the boundary. The app plane reads the data plane through the public interface the
  browser uses — that interface simply now has a doorman.

### Confirmation

* `test/e2e/gate.spec.ts` → "the certificates answer 401 without a session" is the assertion the
  change exists for. A UI-only gate passes every other test in the file and fails this one.
  Non-vacuity proven by flipping the scope back to `public`: it returns **200**, the real error.
* `test/e2e/gate.spec.ts` → "with ranges intact" asserts **206**, a `Content-Range` matching
  `bytes 0-99/N`, and exactly 100 bytes. This caught a live bug: handing R2 the request headers and
  reading back `object.range` yields all three keys with the unused ones `undefined`, so an ordinary
  offset range took the suffix branch and produced `bytes NaN-30213/30214` **with status 206 and
  the whole file attached**. The header is parsed explicitly now.
* `test/e2e/global-setup.ts` refuses to start unless the Worker answers 206 to a Range request, so
  the search suite cannot pass against a proxy that silently serves whole files.
* `test/unit/authorization.test.ts` → "never lets an /api route take the signed-in scope", proven
  non-vacuous by flipping `/api/buildings` and watching three assertions fail by name.

## More Information

* Supersedes [ADR-0009](0009-duckdb-wasm-reads-parquet-from-the-data-domain.md). Everything 0009
  decided about the *engine* still stands and is restated by reference: DuckDB-WASM 1.33, the `eh`
  bundle with `mvp` as the floor and never `coi`, lazy initialisation on first search, the manifest
  as the file index, and the binaries served from the bucket because Workers Assets caps a file at
  25 MB. Only its transport decision is reversed.
* Related: [ADR-0001](0001-two-planes-that-share-no-schema.md),
  [ADR-0003](0003-d1-has-no-rls-and-what-replaces-it.md),
  [ADR-0006](0006-search-index-and-detail-parquet-per-departement.md),
  [ADR-0008](0008-better-auth-per-request-google-only-in-production.md).
