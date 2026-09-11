# DPE platform on Cloudflare — Parquet data plane, D1 app plane

> **Status: reviewed 2026-09-04.** Corrections from the review are in the section "Review
> 2026-09-04" at the end; the PR sequence that executes this plan is `docs/roadmap.md`. Every
> number in "Measured facts" was verified live against `data.ademe.fr` or by local experiment
> during design — none are estimates unless labelled as such. The decisions this plan depends on are recorded separately as
> ADR-0001 to ADR-0005 in `docs/decisions/`.

## Context

Personal project: an authenticated web app over the ADEME DPE open data, where users compose their own analysis rather than browse a fixed list. Everything on Cloudflare.

**Primary product goal (stated 2026-09-04):** reverse-locate a property from the DPE facts a listing publishes — postcode or city, DPE and GES class, month and year of the DPE, surface, sometimes kWh/m²/an and kgCO₂/m²/an, building type, construction period — and return the few matching certificates with their exact address and coordinates, which the user can then save. National aggregates are secondary. The dominant query is therefore a multi-predicate filter returning a handful of rows from one département, followed by a detail read of one certificate; the data-plane layout in ADR-0006 is shaped for that.

The previous plan in this file (a local lossless SQLite build) is **superseded as a product design but kept as tooling** — its Python ETL is what builds the Parquet, and its round-trip test is what proves the build is correct. What changed is the conclusion: measurement showed that importing 15.5M rows into a *serving* database was solving a problem that does not exist. The product is analytical, so the data belongs in columnar files the client queries directly.

The architecture is **two planes that never share a schema**, which is the property that keeps the authorization surface small:

- **Data plane** — public, read-only, no owner, no auth. Parquet on R2, partitioned by département, rebuilt weekly by CI. Read directly by DuckDB-WASM in the browser.
- **App plane** — private, owned, needs authorization. Worker + D1 + Drizzle + Better Auth, holding accounts, saved buildings and saved searches.

The DPE data is Licence Ouverte and **no row belongs to a user**, so there is nothing to scope on it. All authorization lives in the app plane, which is a handful of small tables.

**Decisions taken:** all reads go through Parquet (no runtime dependency on ADEME); base built locally once, CI only ever applies deltas; weekly refresh rewrites changed partitions; app plane on D1 with enforcement in code; Better Auth with Google OAuth.

## Measured facts

All verified live during design, not estimated:

| | |
|---|---|
| Dataset | 15,512,658 rows × 226 real columns (+4 Data Fair internals) |
| Raw CSV | 2,012 B/row → 31 GB |
| **Columnar + compression** | **~289 B/row → 4.48 GB** (conservative: measured on 4k rows, so dictionaries are not yet amortised) |
| **R2 cost** | **$0.067/month**, egress free |
| ADEME limit (anonymous) | 600 req/min, **500 kB/s** (FAQ, verified); the "20s processing per 60s" budget is an estimate, not published |
| ADEME limit (API key) | 1200 req/min, 1 MB/s (FAQ, verified); "60s processing per 60s" is an estimate |
| Full fetch, 226 columns | **17.4 h** — exactly the 500 kB/s cap (2,012 B × 247 rows/s); GitHub Actions caps a job at 6 h |
| Fetch, 14 columns | 1.0 h — the cost is per byte transferred, so narrow selects are cheap |
| Local fixture | département 09 fully ingested: **31,157 rows** in the local SQLite (2026-09-03) |
| Départements | 104, from **838,532** (Paris) to **2** (Saint-Pierre-et-Miquelon) |
| Query latency, live API | filter 0.07–0.21s · facets 0.11s · `geo_distance` 0.17s |
| CORS on data.ademe.fr | `access-control-allow-origin: *` |

Traps found the hard way, all now covered by tests in `ademe/`:

- **CSV headers are the schema's `label`, not its `key`.** 16 columns differ and two collide destructively: header `adresse_brut` carries the field keyed `adresse_complete_brut`, while key `adresse_brut` is published as `numero_voie_brut`. Reading by key swaps values silently.
- **`score_ban`, `statut_geocodage` and the coordinates are per-certificate, not per-address.** 0.8% of BAN ids carry more than one distinct `coord_x`. Deduplicating them corrupts data.
- **Address dedup must key on the whole tuple**, not `identifiant_ban`: the source disagrees with itself on street spelling (`Parc d’Espagne` vs mojibake `dâ€™Espagne`) and on empty `nom_rue`.
- **96 numeric columns carry exactly one decimal**, 3 carry two, coordinates carry up to six. Integer scaling is lossless; `REAL` is not, and `NUMERIC` affinity is byte-identical to `REAL`.
- ADEME documents `date_derniere_modification_dpe` as the incremental key: *"À utiliser pour mettre en place une alimentation incrémentale."*
- **`numero_dpe[2:4]` is the issuing département** and matches the building's in 99.4% of rows — a point-lookup hint, not an authority.

## Data plane — Parquet on R2

**Layout**

```
r2://ademe-dpe/
  v1/dpe/dept=75/part-0000.parquet     one directory per departement
  v1/dpe/dept=09/part-0000.parquet
  v1/dpe/dept=DOM/part-0000.parquet    975/976/977/978 merged: 2-row files are pure overhead
  v1/rollup/by-dept-class.parquet      precomputed national aggregates, ~2 MB
  v1/rollup/by-commune.parquet
  v1/index/numero-exceptions.parquet   the 0.6% whose id prefix lies about their departement
  v1/manifest.json                     partition list, row counts, build time, source schema sha
```

- **Versioned prefix (`v1/`), swapped by manifest.** A failed build never takes the app down, and rollback is a manifest edit.
- **Row groups ~50k rows.** Smaller than the Parquet default so DuckDB-WASM range-requests less per query; large enough that group overhead stays negligible.
- **Sorted within partition by `(etiquette_dpe, surface_habitable_logement)`** — the dominant browse shape, so min/max statistics prune row groups. Point lookup by `numero_dpe` reads one column of one partition (~1–5 MB, acceptable) after using the id prefix to pick the partition.
- **R2 bucket needs CORS** allowing `GET` and the `Range` header from the app origin, or DuckDB-WASM cannot read it.
- All 226 columns are published. Columnar storage means carrying them costs nothing at query time — this is exactly the case where width is free.

**Build**

- **Bootstrap once, locally.** `ademe.ingest --all` (already written, resumable per département) fills the SQLite build over ~17 h, then a one-shot exporter writes Parquet and uploads. CI never does this: a 6-hour job cannot, and 104 parallel runners against a public agency violates the politeness rule in `local-database-agregator/CLAUDE.md`.
- **Weekly delta in CI.** Query `date_derniere_modification_dpe > <high-water mark>`; ~150k rows, minutes. For each touched département: read its Parquet from R2, merge, write back, update the manifest. ~4.5 GB of I/O, free on R2, well inside the job limit.
- DuckDB (the CLI, in CI) does the merge and the Parquet writing. The Python ETL supplies the rows and the schema.

## App plane — Worker + D1 + Drizzle

Tables, deliberately few: `user`, `session`, `account`, `verification` (Better Auth), plus `saved_building`, `saved_search`, `user_quota`.

Schema conventions lifted verbatim from `modescore-activescore-online-platform/db/schema.ts` (ADR-0016 there), all of which port to SQLite unchanged:

- **`text` with a CHECK, never an enum type.**
- **Foreign keys everywhere, each with an explicit `onDelete`, none with `onUpdate`.**
- **`updated_at` written by the handler, never by a trigger** — a trigger is invisible in the schema file, which is the single source of truth.

Migrations follow the same house pattern: Drizzle generates, a hand-rolled runner applies by name (not high-water mark), append-only, never edited once applied. `scripts/bundle-migrations.ts` from modescore is **directly reusable** — esbuild does not bundle `.sql`, and D1 takes one statement at a time, which is what that script already assumes.

### Authorization — the part that does not port, and what replaces it

`local-database-agregator` and `modescore` both converged on **scope roles + `SECURITY DEFINER` entry points + `pgPolicy` declared in the Drizzle schema**, for a reason stated in `db/migrations/0007_company_scoping.sql`:

> the entry-point functions are SECURITY DEFINER and owned by `modescore_scoped`, a role that owns nothing … which is the whole reason for doing this in the database instead of in a WHERE clause a future handler can forget.

**D1 has no roles, no RLS, no policies, no `SECURITY DEFINER`, no `current_setting`. None of that mechanism exists.** Enforcement is therefore 100% application-level — the shape that produced ADR-0022's `updateMyPerson` incident, where deleting one `.where()` would have rewritten every row in the register *and reported success*.

Since the braces are gone, the belt has to be structural. Four controls, all lifted from the existing repos:

1. **One choke point.** `server/db.ts` exports scoped functions and nothing else — no raw `db` handle escapes the module. Every exported function takes a `Caller` built by `callerFrom(sub)` and builds its own owner predicate. Modelled on `local-database-agregator/viewer/server/db.ts`, including its fail-closed detail: a missing subject becomes `''`, never `NULL`, so predicates are FALSE and an unauthenticated request reads **zero rows rather than everything**.
2. **A lint test that greps for escapes.** Fails if `drizzle(` or a bare `env.DB` appears anywhere outside `server/db.ts`. This is what substitutes for the owner-exemption that policies gave for free.
3. **Default-deny gate stated as an exception list**, copied from `viewer/server/auth.ts`: routes are authenticated unless explicitly named public, applied **once** in the router. A route added later is gated by default rather than by whoever adds it remembering.
4. **An allowlist test that greps the route declaration**, after `modescore/test/unit/authorization.test.ts`: an operation is owner-scoped unless named in a `SELF_SCOPED` map, so widening one is an edit somebody has to justify in review.

**This trade-off gets its own ADR**, recording that D1 was chosen knowing the RLS mechanism does not port, and what replaced it.

## Frontend

Vite + React 19, matching the house style found in both repos: **no Tailwind, no react-query, no react-router.** Hand-written CSS with the documented three-layer token system (`modescore/src/index.css`), hash-based routing, plain `fetch` behind one typed wrapper (`viewer/src/api.ts`).

DuckDB-WASM loads on demand — not on first paint — and queries R2 over HTTP range requests. National dashboards read the small rollup Parquet; drill-down fetches one département.

Reusable as-is: `viewer/src/usePersisted.ts`, `useCopyToClipboard.ts`, `colorscale.ts`, `theme.ts`; `modescore/src/components/Smart{Table,Form,Select}.tsx`, `ConfirmDelete.tsx`. Role/nav gating follows `viewer/src/roles.ts` with its disclaimer intact: the UI gate is a courtesy, the API is the enforcement point.

## Repo conventions

`CLAUDE.md` adapted from `local-database-agregator/CLAUDE.md` §§1,2,3,8,9 — never touch `main`, worktrees in `.claude/worktrees/<slug>` off `origin/dev`, non-vacuous tests, smallest possible diff, ADRs for trade-offs. §§11–13 are rewritten for D1/R2 rather than Postgres.

ADRs in `docs/decisions/NNNN-slug.md` using `local-database-agregator/docs/decisions/adr-template.md` (MADR: Context · Drivers · Options · Outcome · Consequences). Numbers permanent and never reused; an accepted ADR is never edited, only superseded.

Opening set: `0001` two-plane split · `0002` Parquet over D1 for the data plane · `0003` D1 without RLS and what replaces it · `0004` scaled integers and lossless encoding · `0005` local bootstrap, CI deltas only.

## CI and the preview workflow

Workflows follow the existing house shape: `pull_request`/`push` on `dev`, `concurrency` with `cancel-in-progress: true` (false for anything that deploys), Node 22 with `npm ci`, `astral-sh/setup-uv` for Python, artifacts on failure with `retention-days: 7`.

- **`ci.yml`** — typecheck, unit, db, e2e. Includes the staleness gate from modescore: `npm run db:check` regenerates migrations and fails on `git diff --exit-code`, because editing the schema without regenerating reaches a database as *nothing at all*.
- **`etl-weekly.yml`** — the repo's first `schedule:` cron. Fetches the delta, merges partitions, uploads to R2, swaps the manifest. Alerts when a run's row count departs sharply from the weekly norm, which is how an upstream schema change announces itself.

**Preview before PR.** `wrangler versions upload` publishes a version without deploying and returns a preview URL shaped `<version-prefix>-<worker>.<subdomain>.workers.dev` (workers.dev subdomain required; the URL is parsed from wrangler's stdout, as there is no documented JSON output). Wrapped as `npm run preview` and bound into the working agreement: **on finishing a branch, deploy the preview, hand over the URL, and only then open the PR** — with the URL in the PR body next to the red-then-green test output. Previews bind a separate `ademe-app-preview` D1 so a preview can never write to real user data.

## Testing

Their rule, kept: **a feature's test is red before the feature exists and green after**, and the failure output goes in the PR body. And **a skip is not a pass** — when `CI` is set, a missing dependency is a hard failure, because a green run that silently tested nothing is worse than red.

- **Unit** — vitest. Authorization allowlist test and the raw-handle grep test live here.
- **DB** — against real Miniflare D1 (genuine SQLite), never a mock. `local-database-agregator/CLAUDE.md` §3 is explicit that a fake database asserts the fake.
- **ETL** — the existing `tests/test_roundtrip.py` already reconstructs all 226 columns from the normalised store and diffs them against live ADEME. Extend it to read back the published **Parquet** so the file that ships is the thing proved lossless. `test_scales.py` and `test_vocab_aliases.py` carry over unchanged.
- **E2E — Playwright**, chromium only, `--with-deps`, run against `wrangler dev` locally and against the uploaded preview URL in CI.
- **Cross-tenant probe** — the missing-test shape from `~/rls-role-management-_probe.mjs`. Sign in as two real users, walk every route, assert each cannot read or write the other's rows. On D1 this is the **only** thing standing between a forgotten predicate and a full-table update, so it runs on every PR, not on demand. The equivalent bug last time *"was found on the sandbox with a real token, not by the suite."*

## Order of work

1. Repo scaffolding: `CLAUDE.md`, ADR template, ADRs 0001–0005, `wrangler.jsonc`, Vite + React, Drizzle with the sqlite dialect.
2. App plane: D1 schema, migration runner, `withCaller` choke point, Better Auth + Google. Authorization tests written **first**, red.
3. Worker routes for saved buildings and searches, behind the default-deny gate. Cross-tenant probe green.
4. `ademe.export_parquet` — SQLite → partitioned Parquet, round-trip test extended to the Parquet.
5. Bootstrap locally, upload `v1/`, configure R2 CORS.
6. Frontend: DuckDB-WASM wired to R2, browse and one real analysis screen.
7. `etl-weekly.yml`, first delta run verified against the manifest.
8. Playwright e2e, preview workflow, first PR into `dev` with a preview link.

## Verification

- `npm run db:check` clean; `foreign_key_check` empty.
- Round-trip: 226 columns reconstructed from published Parquet, byte-exact for text/vocab/date and value-exact for numerics, against live ADEME records.
- Manifest row counts equal ADEME's `total` per département.
- Cross-tenant probe green with two real Google accounts.
- Playwright: sign in, save a building, run an analysis, sign out — locally and against the preview URL.
- A measured cost line in ADR-0002: actual R2 storage, ops and Workers spend after the first month against the $0.067 + $5 estimate.

## Review 2026-09-04

Fact-check of every external claim above, live against `data.ademe.fr` and the Cloudflare and
GitHub documentation. Everything not listed here was confirmed as written.

**Corrections, each carried by a PR in `docs/roadmap.md`:**

1. **The weekly delta cannot see deletions.** `dpe03existant` is a Data Fair *virtual* dataset
   (id `meg-83tjwtg8dyz4vv7h1dqe`) over a private child, filtered `dpe_desactive = 0`; the field is
   absent from the public schema. A deactivated certificate simply leaves the view, and
   `date_derniere_modification_dpe > mark` never returns it. The upsert-only merge in "Build" would
   keep it forever, and the verification line "manifest row counts equal ADEME's total" fails after
   the first deactivation. Fix: a per-département reconciliation step (count check, one-column id
   pull on mismatch) — ADR-0007, PR 9.
2. **`r2.dev` public URLs are rate-limited and documented as dev-only.** The bucket must sit behind
   a custom domain (available) with CORS set through `wrangler r2 bucket cors set`. PR 8.
3. **The cross-tenant probe cannot sign in with two real Google accounts in CI.** Better Auth's
   email+password provider is enabled only when `AUTH_TEST_CREDENTIALS=1` is set in dev and
   preview; production never sets it. The probe signs two users up through the real HTTP auth
   routes — ADR-0008, PRs 3 and 4.
4. **ADR-0002's consequence "point lookups are rare" is false for the primary goal.** Parquet
   still wins (a filtered search touching a few row groups of a narrow file is cheap), but the
   layout changes: a narrow per-département search index sorted by
   `(code_postal_ban, etiquette_dpe, surface_habitable_logement)` next to the wide 226-column
   detail file sorted by `numero_dpe`. National rollups are deferred — ADR-0006, PR 7.

**Smaller corrections:** the "20s / 60s processing" budgets are not in ADEME's FAQ (labelled as
estimates above); R2's free tier covers 10 GB-month, so the real storage cost is $0 rather than
$0.067; `wrangler versions upload --preview-alias` gives a deterministic preview URL, so nothing
needs to parse stdout; the higher 2 MB/s static-file lane in the FAQ is unavailable because the
underlying dataset has no public data files; the schema's `x-originalName` differs from `key` for
13 fields (9 real, 4 Data Fair internals) rather than 16, and the `adresse_brut` collision is
confirmed; the Python export needs a Parquet writer — `duckdb` — which is a runtime dependency
recorded in ADR-0006; `server/db.ts` shipped with per-function `Caller` arguments rather than a
`withCaller` wrapper, and that is the shape kept.

**Order of work** is superseded by the dependency graph in `docs/roadmap.md`.
