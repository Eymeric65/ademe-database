---
status: accepted
date: 2026-09-10
area: data plane
supersedes:
superseded-by:
---

# ADR-0013 — An ADEME API key halves the base build, and a wrong one fails open

**Status:** accepted · **Decided:** 2026-09-10 · **Area:** data plane

## Context and Problem Statement

ADR-0005 closed with "an ADEME API key would halve the base build. Not required, and not requested
for a once-ever job." The once-ever job then ran, and the estimate turned out to be conservative
rather than wrong — but the run also showed how tightly the anonymous cap binds.

The national ingest of 2026-09-06 loaded 3 062 035 certificates before dying on an unrelated bug.
Per-département, away from the stalls, it moved at a very flat **~240 rows/s**. At the measured
2 012 B/row that is **483 kB/s** — the anonymous limit, to within measurement noise:

| départements | rows/s |
|---|---|
| 01, 02, 04, 05, 07, 08, 10, 11, 12, 13, 14, … | 226 – 250 |

So the ETL is not CPU-bound, not SQLite-bound and not latency-bound. It is sitting exactly on the
number ADEME publishes, and the only lever that moves it is the caller's identity.

## Decision Drivers

* data.ademe.fr documents the two budgets: an anonymous caller gets **600 requests / 60 s and
  500 kB/s** of dynamic response; an authenticated one — *"session ou clé d'API"* — gets
  **1200 requests / 60 s and 1 MB/s**.
* The full base is 15 557 428 certificates. At 483 kB/s that is ~18 h; at 1 MB/s, ~9 h.
* A key must not become a requirement. The weekly delta is ~150 k rows and takes minutes on either
  budget, and it runs in CI, where a secret is a liability rather than a speed-up.
* **The server does not reject a key it has never seen.** Verified against the live API on
  2026-09-10: `x-apiKey: not-a-real-key-0000` on `/lines?size=0` answers `200` with the correct
  body. There is no field in the response that says which budget is in force.

## Considered Options

* Stay anonymous, as ADR-0005 decided
* Require an API key for the ingest
* Optional key, off by default, with a way to measure whether it is in force

## Decision Outcome

Chosen option: **"optional key, off by default, with a measurement"**.

`ADEME_API_KEY` in the environment becomes the `x-apiKey` request header. Absent is the supported
state and changes nothing. The header name is not taken from documentation but from the server's own
OpenAPI, `https://data.ademe.fr/data-fair/api/v1/api-docs.json`:

```json
"apiKey": { "type": "apiKey", "in": "header", "name": "x-apiKey" }
```

The third option exists because of the last driver. Every ordinary way of being wrong here — a
truncated paste, a key scoped to the wrong function, a variable exported in the wrong shell —
produces a run that is correct, silent, and twice as long as planned. Nothing surfaces it, so the
feature ships with the thing that does: `python -m ademe.api` downloads one page at the ingest's own
page size and prints the measured kB/s against the two published budgets.

### Where the key lives

`.env` in the repository root, git-ignored, read by `ademe/config.py` at import. A key passed on the
command line lands in shell history; a key exported from `~/.bashrc` lands in every process on the
machine. A real environment variable still wins, so a one-off `ADEME_API_KEY=... uv run ...`
overrides the file.

`config.py` reads the file itself rather than delegating, because **`uv run` does not read `.env`**.
It needs `--env-file .env` or `UV_ENV_FILE`, verified against uv 0.12.4, and forgetting either is
silent in exactly the way the rest of this record is about: the ingest runs anonymously and takes
twice as long, and nothing says so.

The key stays out of the repository and out of Cloudflare. It authenticates
a local Python process to a public open-data API; it is not an app-plane secret and must never be
added to `wrangler.jsonc`, a Worker binding, or a GitHub Actions secret. ADR-0001's separation of the
two planes is what makes that a rule rather than a preference: nothing in the app plane talks to
ADEME.

### Consequences

* Good, because the once-ever base build drops from ~18 h to ~9 h, which is one overnight run.
* Good, because ADEME still sees one polite stream — the key raises this caller's own budget and
  changes nothing about ADR-0005's refusal to parallelise across a hundred runners.
* Good, because the weekly CI delta is untouched: no secret, no new failure mode.
* Bad, because there is now a configuration that changes performance by 2× and cannot be inferred
  from the code. `python -m ademe.api` is the mitigation and the reason it exists.
* Neutral, because ADR-0005's decision is unchanged — the base is still built locally by hand. Only
  its closing "not required, not requested" is overtaken, and that was a note, not the decision.

### Confirmation

`tests/test_api_key.py`. Offline: `.env` reaches the environment (and is read from the repo root,
and does not override a variable already set), the environment reaches the config, an empty variable
reads as absent, and the config reaches the header — four links, each of which fails silently. Live (`-m live`): the server's OpenAPI still declares
`x-apiKey` — the one assertion that would catch a rename, since every request would go on returning
200 — and, when `ADEME_API_KEY` is set, one real page must measure above the midpoint of the two
published budgets. That last one skips without a key, because without a key there is nothing to
assert; it is the only honest skip here, and it is the reason the manual `python -m ademe.api`
exists alongside it.

## More Information

* Related: [ADR-0005](0005-base-built-locally-ci-does-deltas.md),
  [ADR-0001](0001-two-planes-that-share-no-schema.md)
* Source for the limits: <https://data.ademe.fr/pages/faq>
