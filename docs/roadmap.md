# Roadmap — the PR sequence that executes `docs/plan.md`

Written 2026-09-04 after the plan review (see the "Review 2026-09-04" section of `docs/plan.md`).
Each PR below is a brief for one Claude session that has only this repository, `CLAUDE.md`,
`docs/` and the brief. **Read `CLAUDE.md` first**; every rule there applies to every PR here.

## How to execute one PR

```bash
git fetch origin dev
git worktree add .claude/worktrees/<slug> -b feat/<slug> origin/dev
```

Then, in order: write the test(s) named in the brief and run them — keep the red output; implement;
run `npm run check` and `uv run pytest -m "not live"` (both must be green; when `CI` is set a missing
dependency is a failure, not a skip); if the Worker or UI changed, `npm run preview` and hand the
URL to Eymeric before opening the PR; `gh pr create --base dev --head feat/<slug>` with the preview
URL and the red-then-green output in the body. Never merge. One PR per branch, smallest diff, no
drive-by changes.

**ADR numbers are allocated here** so parallel worktrees cannot collide: **0006** search/detail
Parquet layout and the `duckdb` dependency · **0007** deletion reconciliation · **0008** identity
model · **0009** DuckDB-WASM in the browser. No other PR in this roadmap gets an ADR. A new ADR uses
`docs/decisions/adr-template.md` **including its Confirmation section** (which ADR-0001..0005 omit).

## Dependency graph

```
Wave A:  PR1 scaffold             PR6 finalise             PR7 export (ADR-0006)
Wave B:  PR2 e2e-harness (1)      PR3 auth (1, ADR-0008)   PR8 weekly-delta (7)
Wave C:  PR4 routes+probe (3)     PR5 shell+sign-in (2,3)  PR9 reconcile (8, ADR-0007)
Wave D:  PR10 search-screen (5,7, ADR-0009)  →  PR11 detail+save (10,4)
```

PRs on one line can run at the same time in separate worktrees. The ETL track (6 → 7 → 8 → 9) and
the app track (1 → 2/3 → 4/5) share no files; PR10 is where they join. PR1 and PR6 both add a line
to the Commands table in `CLAUDE.md`; whichever lands second rebases.

Sizes: S fits comfortably in one session, M is one focused session, L is one long session — if an L
brief is not finished, split it at the point named in the brief rather than shipping a partial PR.

---

## PR 1 — `repair-scaffolding` (M) — no dependencies

**Goal:** make the tree runnable. Several files are named by the existing code and never written:
`server/index.ts` (`wrangler.jsonc` `main`), `db/migrate.ts` (`drizzle.config.ts` header,
CLAUDE.md §10), `scripts/preview.ts` (`npm run preview`), `test/db/` (`vitest.config.ts` comment),
and there is no `.github/`.

**Files**

- create `server/index.ts` — `export default { fetch(request, env, ctx) }`. Declare the routes as a
  single exported constant `ROUTES: Array<{ method, path, scope: 'public' | 'self' | 'owner', handle }>`.
  The gate is one function applied **before** dispatch: a request to any `/api/*` path whose matched
  route is not `scope: 'public'` and that has no caller → 401. An unmatched `/api/*` path is also
  gated (401 without a caller, 404 with one) so default-deny precedes routing. Only route in this PR:
  `GET /api/health` (`public`) → `{ ok: true, migrations: <number applied> }`. Non-`/api` requests →
  `env.ASSETS.fetch(request)`. Caller resolution is a stub returning `callerFrom(null)`; PR3 replaces it.
- create `db/migrate.ts` — `export async function migrate(db: D1Database): Promise<string[]>`.
  `CREATE TABLE IF NOT EXISTS _migration (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`; read
  the applied names; for each entry of `MIGRATIONS` (from `db/migrations.generated.ts`) whose name is
  not in that set, run its statements one at a time, then insert the name. **By set membership, never
  by index** — two branches can add migrations concurrently and land in either order. Returns the
  names applied by this call. The handle arrives as a parameter named `db`, so
  `test/unit/no-raw-db.test.ts` stays green.
- modify `server/db.ts` — add `export async function ensureMigrated(env: { DB: D1Database })` that
  calls `migrate(env.DB)` once per isolate (memoised promise). `server/index.ts` awaits it at the top
  of `fetch`.
- modify `package.json` — add `"test:db": "vitest run -c test/db/vitest.config.ts"` and make
  `check` = `tsc --noEmit && vitest run && npm run test:db && npm run db:check`. Remove
  `db:migrate:local`: wrangler's own runner and `_migration` applying the same non-`IF NOT EXISTS`
  DDL would collide. Leave `migrations_dir` in `wrangler.jsonc` alone.
- create `test/db/vitest.config.ts` — `defineWorkersConfig` from
  `@cloudflare/vitest-pool-workers/config`, `wrangler: { configPath: '../../wrangler.jsonc' }`,
  `include: ['test/db/**/*.test.ts']`, `isolatedStorage: true`.
- create `test/db/migrate.test.ts`, `test/db/gate.test.ts` (below).
- create `scripts/preview.ts` — alias from `git rev-parse --abbrev-ref HEAD`: strip `feat/`,
  lowercase, `[^a-z0-9-]` → `-`, trim so `alias + '-ademe-app-preview'` ≤ 63 characters (DNS label);
  run `wrangler versions upload --env preview --preview-alias <alias>`; print
  `https://<alias>-ademe-app-preview.<subdomain>.workers.dev`. The alias makes the URL deterministic;
  only the account subdomain is read, from `WORKERS_SUBDOMAIN` if set, else from the `.workers.dev`
  host in wrangler's stdout. Note in a comment that `--env preview` suffixes the Worker name.
- create `.github/workflows/ci.yml` — on `pull_request` and `push` to `dev`; `concurrency` with
  `cancel-in-progress: true`; job `node`: Node 22, `npm ci`, `npm run check`; job `etl`:
  `astral-sh/setup-uv`, `uv sync`, `CI=1 uv run pytest -m "not live"`. No e2e job yet (PR2).
- modify `CLAUDE.md` — Commands table gains the `npm run test:db` line. Nothing else.

**Tests first (red → green)**

- `test/db/migrate.test.ts` on Miniflare D1 through the workers pool: (a) `migrate(env.DB)` on a
  fresh database returns `['0000_init_app_plane']`; (b) a second call returns `[]` and `_migration`
  has exactly `MIGRATIONS.length` rows; (c) after migrating, `INSERT INTO saved_building` with a
  `user_id` that does not exist throws a foreign-key error — proof the schema really landed.
  Non-vacuity of (c): point it at a table that is not in the migration and watch it fail with
  "no such table", a different error. Red before the PR: `db/migrate.ts` does not exist.
- `test/db/gate.test.ts`: `SELF.fetch('http://x/api/health')` → 200 and `ok: true`;
  `SELF.fetch('http://x/api/anything-else')` → **401, not 404**. Red: `server/index.ts` missing.

**Done when:** `npm run check` is green including `test:db`; `npm run preview` prints a URL whose
`/api/health` answers with `migrations: 1` (proof the runner ran on `ademe-app-preview`); CI green.

**Fallback split:** if the workers-pool harness eats the session, ship `server/index.ts`,
`db/migrate.ts`, `scripts/preview.ts`, `ci.yml` here and move `test/db/` + `test:db` to a
follow-up S PR `d1-test-harness`.

**Owner steps before the preview:** `wrangler login`; `wrangler d1 create ademe-app` and
`wrangler d1 create ademe-app-preview`, then paste both ids into `wrangler.jsonc` (both are still the
`PLACEHOLDER_SET_BY_WRANGLER_D1_CREATE` string); one `wrangler deploy --env preview` so the preview
Worker exists with workers.dev enabled; `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as
repository secrets for CI.

---

## PR 2 — `e2e-harness` (S) — depends on PR1

**Goal:** Playwright runs one real browser test against the Worker (built assets and API on one
origin), locally and in CI.

**Files**

- create `playwright.config.ts` — chromium only; `webServer: { command: 'npm run build && wrangler
  dev --port 8787', url: 'http://localhost:8787/api/health', reuseExistingServer: !process.env.CI }`;
  `baseURL` overridable by `E2E_BASE_URL` so CI can run a second pass against the preview URL.
- create `index.html`, `src/main.tsx`, `src/App.tsx` — a heading "DPE" and a `<nav>` placeholder,
  hash-routing stub; `src/index.css` hand-written (no Tailwind, no react-router, no react-query).
- create `test/e2e/smoke.spec.ts`.
- modify `.github/workflows/ci.yml` — job `e2e`: `npx playwright install --with-deps chromium`,
  `CI=1 npm run test:e2e`; upload `playwright-report` on failure with `retention-days: 7`.

**Test first:** `smoke.spec.ts` — `/` renders the heading through the ASSETS binding, and
`page.request.get('/api/health')` → 200. The second assertion guards the assets/API wiring, which is
what breaks silently. Red: no `playwright.config.ts`.

**Done when:** `npm run test:e2e` green locally and in CI; preview URL in the PR body.

---

## PR 3 — `better-auth-google` (M) — depends on PR1 — **ADR-0008**

**Goal:** real sessions. Google OAuth in production; email+password enabled **only** when
`AUTH_TEST_CREDENTIALS=1`, which dev and preview set and production never does.

**Files**

- modify `server/db.ts` — `export function authFor(env)` returning
  `betterAuth({ database: drizzleAdapter(open(env), { provider: 'sqlite', schema }), socialProviders:
  { google: { clientId, clientSecret } }, emailAndPassword: { enabled: env.AUTH_TEST_CREDENTIALS ===
  '1' }, secret: env.BETTER_AUTH_SECRET, baseURL: env.BETTER_AUTH_URL })`. Built per request with
  that request's `env.DB`; the drizzle handle is passed into the adapter and never returned, so the
  choke point holds and the grep test stays green. Leave `// see ADR-0008`.
- modify `server/index.ts` — mount `authFor(env).handler` on `/api/auth/*` (`scope: 'public'`);
  replace the caller stub with `auth.api.getSession({ headers })` → `callerFrom(session?.user.id)`;
  add `GET /api/me` (`scope: 'self'`) → `{ id, name, email }`.
- create `server/env.d.ts` — `Env` with `DB`, `ASSETS` and the string vars above.
- modify `test/db/vitest.config.ts` — `miniflare.bindings: { AUTH_TEST_CREDENTIALS: '1',
  BETTER_AUTH_SECRET: 'test-secret', BETTER_AUTH_URL: 'http://x' }`.
- modify `wrangler.jsonc` — `vars.AUTH_TEST_CREDENTIALS = "1"` under `env.preview` only, with a
  comment that production never sets it.
- check `db/schema.ts` against what Better Auth 1.7's Drizzle adapter expects for `user`, `session`,
  `account`, `verification` (field names are the TypeScript keys). If a column is missing, append a
  migration through `npm run db:generate` — never edit `0000_init_app_plane.sql`. That schema change
  is covered by ADR-0008.
- create `test/db/auth.test.ts`, `test/db/helpers.ts` (`signUp(SELF, email) → cookie`).
- create `docs/decisions/0008-better-auth-google-per-request-test-credentials.md` — per-request
  instantiation, Google-only production, the env-gated credential provider and why (the cross-tenant
  probe has to sign in as two users in CI), Confirmation = `test/db/auth.test.ts` case (d).

**Tests first:** (a) `POST /api/auth/sign-up/email` then `GET /api/me` with the returned cookie →
200 with that email; (b) `GET /api/me` without a cookie → 401; (c) two sign-ups, A's cookie on
`/api/me` never returns B; (d) with `AUTH_TEST_CREDENTIALS` unset (a separate describe with its own
bindings), sign-up returns 4xx — proof the switch is real. Red: `/api/auth/*` is 401 from the gate.

**Done when:** preview URL where "Sign in with Google" round-trips (Eymeric tries it); CI green.

**Owner steps:** Google OAuth web client with redirect URIs for
`https://<prod-domain>/api/auth/callback/google` and the preview host; `wrangler secret put` for
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `BETTER_AUTH_SECRET`, both for the default env and
`--env preview`; `BETTER_AUTH_URL` as a var per env.

---

## PR 4 — `saved-routes-and-cross-tenant-probe` (M) — depends on PR3

**Goal:** the six functions in `server/db.ts` behind HTTP, the allowlist test from CLAUDE.md §9, and
the cross-tenant probe that ADR-0003 calls the only real guard.

**Files**

- modify `server/index.ts` — add to `ROUTES`: `GET /api/buildings`, `POST /api/buildings`,
  `DELETE /api/buildings/:id`, `GET /api/searches`, `POST /api/searches`,
  `DELETE /api/searches/:id`, all `scope: 'owner'`; ids from `crypto.randomUUID()`; request bodies
  validated by hand (no new dependency). Handlers only call `server/db.ts` exports.
- create `test/unit/authorization.test.ts` — reads `server/index.ts` as text, extracts every
  `path` + `scope` pair with a regex, and asserts: every route has a scope; the `public` set is
  exactly `['/api/health', '/api/auth/*']`; the `self` set equals `SELF_SCOPED = ['/api/me']`
  declared in the test. Test the detector on synthetic input first, in the same shape as
  `test/unit/no-raw-db.test.ts`, so a regex that matches nothing fails.
- create `test/db/cross-tenant.test.ts`.

**Tests first:** `cross-tenant.test.ts` — sign up A and B through HTTP; A `POST /api/buildings
{ numeroDpe: 'X' }`; B `GET /api/buildings` → `[]`; B `GET` and `DELETE /api/buildings/<A's id>` →
404 and A still lists it; B posts the same `numeroDpe` → its own row, A still has exactly one; the
same sequence for searches; then import `ROUTES`, walk it, and assert every non-public route → 401
without a cookie. Red: the routes are 404 before this PR. **Non-vacuity, in the PR body:** remove
the `userId` predicate from `getSavedBuilding` in `server/db.ts`, run, paste the failure (B reads
A's row), restore.

**Done when:** CI green, preview URL, PR body shows the predicate-removal failure.

---

## PR 5 — `app-shell-and-sign-in` (M) — depends on PR2 and PR3 — no ADR

**Goal:** the React shell: header with sign-in and sign-out, hash routes `#/` and `#/saved`, one
typed fetch wrapper.

**Files:** modify `src/App.tsx`, `src/main.tsx`, `src/index.css`; create `src/api.ts` (one `fetch`
wrapper, `credentials: 'same-origin'`, throws on non-2xx), `src/auth.ts` (`useSession()` reading
`/api/me`), `src/routes.ts` (hash router); create `test/e2e/sign-in.spec.ts` and
`test/e2e/helpers.ts` (`signUpViaApi(page, email)` through `page.request`, so the cookie lands in
the browser context).

**Test first:** signed-out `/` shows "Se connecter avec Google" and no "Enregistrés" entry; after
`signUpViaApi` and a reload, the header shows the email and the nav entry; clicking
"Se déconnecter" returns to the signed-out state (this exercises `POST /api/auth/sign-out` through
the real UI). Red: the shell has no header.

**Done when:** preview URL where Eymeric signs in with Google and sees his name.

---

## PR 6 — `finalise-indexes-and-fk-check` (S, ETL) — no dependencies

**Goal:** the `finalise` step that `ademe/ddl.py` (lines 41 and 180) and `ademe/db.py` (line 29)
name and that was never written: `indexes_ddl()` has no caller, and `connect(bulk=True)` turns
foreign keys off with nothing re-checking them.

**Files**

- create `ademe/finalise.py` — `finalise(conn)`: run `ddl.indexes_ddl()`, `PRAGMA
  foreign_key_check` (raise, naming the table and the first 10 offending rows, if non-empty),
  `ANALYZE`, and write the `dpe` row count into `data_source`. Refuse to run while any
  `ingest_departement` row has `completed_at IS NULL` unless `--partial`. CLI
  `python -m ademe.finalise [--db-path PATH] [--partial]`.
- modify `CLAUDE.md` — Commands table gains the line.
- create `tests/test_finalise.py`.

**Test first (pytest, offline):** build a temporary database with `schema.build(tmp, scales=...)`,
insert two synthetic rows through `ingest.Loader.load_page` (no network; closed vocabularies accept
inserts through `vocab_id`), mark the ledger complete, call `finalise`; assert `ux_dpe_numero`
exists in `sqlite_master` and `foreign_key_check` is empty; then a deliberately orphaned
`dpe.adresse_id` makes `finalise` raise naming `dpe` — that case is the non-vacuity proof. Red:
`import ademe.finalise` fails.

**Done when:** offline pytest green. Eymeric runs it after the base build (checklist at the end).

---

## PR 7 — `export-parquet` (L, ETL) — no dependencies — **ADR-0006**

**Goal:** `python -m ademe.export_parquet`: SQLite → per-département narrow search index + wide
detail Parquet + manifest, provably lossless. Disjoint files from PR6, so both run in parallel.

**Layout** (recorded in ADR-0006; ADR-0002 stays accepted and its "point lookups are rare"
consequence is noted as amended by 0006, never edited):

```
v1/search/dept=NN/part-0000.parquet   numero_dpe, code_departement_ban, code_postal_ban, code_insee_ban,
                                      nom_commune_ban, adresse_ban, etiquette_dpe, etiquette_ges,
                                      date_etablissement_dpe, surface_habitable_logement,
                                      conso_5_usages_par_m2_ep, emission_ges_5_usages_par_m2,
                                      type_batiment, periode_construction, annee_construction, lat, lon
                                      sorted (code_postal_ban, etiquette_dpe, surface_habitable_logement)
                                      row groups 50k
v1/dpe/dept=NN/part-0000.parquet      all 226 columns + lat, lon; sorted by numero_dpe; row groups 10k
                                      (a detail read is one row group of one partition, a few MB)
v1/index/numero-exceptions.parquet    numero_dpe, dept  where numero_dpe[2:4] != the partition
v1/index/scale-violation.parquet      numero_dpe, column_name, raw_value  (expected empty; readers prefer it)
v1/manifest.json                      version, built_at, schema_sha256,
                                      high_water = max(date_derniere_modification_dpe),
                                      column_meta (encoding + scale per column, so CI can rebuild a delta),
                                      partitions[{ dept, rows, search: {path, bytes, sha256}, dpe: {...} }]
```

All keys above exist in `schema/ademe-schema.json`. `dept=DOM` merges 975/976/977/978 through a
`partition_of(code)` helper. Types: scaled → `DECIMAL(18, s)` (Parquet stores an integer with a scale
annotation — ADR-0004's encoding, natively); date → `DATE`; vocab → `VARCHAR` (dictionary-encoded);
int → `BIGINT`. Divide as DECIMAL, never DOUBLE.

**lat/lon:** the source coordinates `coordonnee_cartographique_x_ban` / `_y_ban` are Lambert-93
(EPSG:2154). Derive WGS84 at export with DuckDB's `spatial` extension:
`ST_Transform(ST_Point(x, y), 'EPSG:2154', 'EPSG:4326')`, stored as `DECIMAL(10, 6)`. The live
round-trip sample compares them against ADEME's `_geopoint` ("lat,lon") within 1e-5.

**Writer:** the `duckdb` Python package — a new runtime dependency of consequence, recorded in
ADR-0006 as part of the layout decision: one engine writes, reads (tests), and merges (PR8), so the
type mapping is identical at both ends. It `ATTACH`es the SQLite file and runs a SELECT generated
from `column_meta` and `mapping.REPEATS` (vocab joins, slot unpivot back to `_n1.._n3`), so the
export cannot drift from the schema any more than `ademe/reconstruct.py` can.

**Files**

- create `ademe/export_parquet.py` — `wide_select(conn) -> str`, `export(db_path, out_dir,
  depts=None)`, `write_manifest(out_dir)`, `read_rows(out_dir, numeros) -> dict[str, dict[str, str]]`
  (DECIMAL formatted with the declared scale, DATE as ISO; used by tests and by PR9); CLI
  `--out DIR [--dept NN ...]`.
- modify `pyproject.toml` — add `duckdb`; run `uv lock`.
- create `infra/r2-cors.json` — `AllowedMethods: ["GET", "HEAD"]`, `AllowedHeaders: ["Range"]`,
  `ExposeHeaders: ["Content-Range", "Content-Length", "ETag"]`, origins = the production domain,
  `https://*.workers.dev`, `http://localhost:8787`, `http://localhost:5180`.
- modify `tests/test_roundtrip.py` — add `test_published_parquet_round_trips` (`live`): sample 40
  `numero_dpe` from the Parquet under `ADEME_PARQUET_DIR` (default `<DEFAULT_DB.parent>/parquet/v1`),
  `read_rows`, diff against `_fetch` with the same `_equal`; skip only when the directory is unset
  and `CI` is not set.
- create `tests/test_export_parquet.py`.
- create `docs/decisions/0006-search-index-and-detail-parquet-per-departement.md` — the dominant
  query (reverse-locate from listing facts), the two-file layout, sort keys, row-group sizes, the
  DECIMAL mapping, the `duckdb` dependency, the lat/lon derivation, and the note amending
  ADR-0002's consequence. Confirmation = `tests/test_export_parquet.py` +
  `test_published_parquet_round_trips`.

**Tests first (pytest, offline):** `test_export_parquet.py` — temporary SQLite through
`schema.build` + `Loader.load_page` with about six synthetic rows across two départements,
including the values `117.1`, `38`, `6478894.912345` (coordinate precision), a repeating-group row
with slots n1 and n3 only, one address shared by two certificates, and one `scale_violation`; export;
assert (a) `read_rows` returns every column of every source row equal under `_equal`, (b) the search
file has exactly the listed columns and its row-group min/max on `code_postal_ban` are sorted
(query `parquet_metadata()`), (c) manifest row counts equal the database, (d) the violation row
round-trips from the side file. Red: the module is missing. Non-vacuity: change one column's scale
in the fixture and watch (a) fail on that value.

**Done when:** offline green; `uv run python -m ademe.export_parquet --dept 09 --dept 975 --dept 977
--dept 978` on the local build produces `dept=09` and `dept=DOM` (Eymeric ingests the three DOM
codes first — minutes); the live Parquet round-trip is green on that directory. No Worker change, so
no preview. **Split point** if the session runs long: ship the wide file + manifest + round-trip
first; the search file and `infra/r2-cors.json` become `export-parquet-search-index` (S).

---

## PR 8 — `weekly-delta-merge` (M, ETL + CI) — depends on PR7 — no ADR (ADR-0005 decides this shape)

**Goal:** `python -m ademe.delta` fetches rows with `date_derniere_modification_dpe >
manifest.high_water`, normalises them through the same `Loader` into a temporary SQLite, exports
them with PR7's code, and merges per touched partition with DuckDB; `etl-weekly.yml` on
`workflow_dispatch` only (the cron arrives with PR9, once deletions are handled).

**Files**

- modify `ademe/api.py` — `iter_pages(client, *, qs: str | None = None, select: list[str] | None
  = None, ...)`; `departement=` becomes sugar for `qs`. Keep `sort=_i` and the cursor handling.
- create `ademe/delta.py` — `fetch_delta(client, since) -> Path` (temporary SQLite via
  `schema.build(tmp, scales=manifest.column_meta)` and `Loader`); `merge_partition(old_url,
  delta_dir, dept, out)`: DuckDB `httpfs` reads the current partition from the public data domain,
  `anti-join on numero_dpe UNION ALL delta`, re-sort, rewrite both the search and the wide file;
  `new_manifest(...)` with the new `high_water` and counts. CLI `--since`, `--out`, `--base-url`.
- create `.github/workflows/etl-weekly.yml` — `workflow_dispatch`; `concurrency` with
  `cancel-in-progress: false`; setup-uv; run the delta; upload every rewritten file, then
  `v1/manifest.json` **last**; fail the run when `rows_changed > 3 × median of the last 8 runs`
  recorded in a `v1/runs.jsonl` object (the "sharp departure" alert from the plan). Upload tool:
  check `wrangler r2 object put`'s size limit against the Paris wide file (~240 MB); if it is over,
  use `rclone` with an R2 S3 token instead.
- create `tests/test_delta.py`.

**Tests first:** offline — build two tiny partitions with PR7's exporter, a delta with one updated
and one new `numero_dpe`, merge, assert row count, that the updated row's new value wins, that the
sort order is preserved, and that `high_water` equals the delta's max date. Live (`-m live`) —
`iter_pages(qs='date_derniere_modification_dpe:[<today-2d> TO *]', select=['numero_dpe',
'date_derniere_modification_dpe'])` returns at least one row and every row's date is ≥ the bound
(proves the range syntax on this Data Fair instance). Red: `ademe.delta` missing, `iter_pages`
rejects `qs`.

**Done when:** a manual `workflow_dispatch` run rewrites at least one partition on R2 and the log
shows the manifest swap as the last step.

**Owner steps:** create bucket `ademe-dpe`; attach the custom domain; `wrangler r2 bucket cors set
ademe-dpe --file infra/r2-cors.json`; repository secret with R2 write access.

---

## PR 9 — `reconcile-deletions` (M, ETL) — depends on PR8 — **ADR-0007**

**Goal:** the delta cannot see rows that left the `dpe_desactive = 0` virtual view (see the review
section of `docs/plan.md`); reconcile per-département totals every week and only then enable the cron.

**Files**

- modify `ademe/delta.py` — `reconcile(client, manifest, base_url) -> dict[dept, (gone, new)]`:
  for every partition compare `api.total(departement=code)` with the manifest's row count; on
  mismatch pull only `numero_dpe` (`select=['numero_dpe']`, about 15 B/row: Paris ≈ 13 MB, the whole
  dataset ≈ 8 minutes at 500 kB/s) and set-difference it against the partition's `numero_dpe`
  column; delete ids gone upstream (anti-join rewrite); fetch ids new upstream through the delta path
  with `qs=numero_dpe:(a OR b OR ...)` in batches of 50; re-check equality and **fail the job without
  swapping the manifest** if still unequal. Leave `// see ADR-0007`.
- modify `.github/workflows/etl-weekly.yml` — reconcile step after the merge; add `schedule:` weekly,
  off-peak CET.
- create `docs/decisions/0007-weekly-delta-cannot-see-deletions-reconcile-totals.md` — context: the
  virtual dataset over a private child, the filter, the absent field; options (full rebuild every
  week, trust the delta, reconcile by ids); cost table; Confirmation = `tests/test_delta.py::
  test_reconcile_*` plus the job's post-check.
- extend `tests/test_delta.py`.

**Tests first:** offline — stub at the `api` boundary with monkeypatch: partition {a, b, c},
upstream {a, c, d} → b deleted, d fetched, rewritten partition equals {a, c, d}; a stub whose
`total` disagrees with its own id list makes `reconcile` raise and leaves the manifest untouched.
Live — `total(departement='975')` equals the number of ids returned by the one-column pull for 975.
Red: `reconcile` missing.

**Done when:** the first scheduled run is green and the log shows `total == manifest` for every
partition.

---

## PR 10 — `search-screen` (L, frontend) — depends on PR5 and PR7 — **ADR-0009**

**Goal:** the primary use case: enter a listing's DPE facts, get the matching certificates with
address and coordinates. Eymeric should have at least one département uploaded so the preview is
meaningful.

**Files**

- add `@duckdb/duckdb-wasm` to `dependencies`. ADR-0009 records: the browser engine, the `eh`
  bundle with `mvp` fallback and never `coi` (it needs cross-origin isolation headers), data read
  from `VITE_DATA_BASE_URL` (the R2 custom domain), and the file list taken from the manifest
  because HTTP has no globbing. Confirmation = `test/e2e/search.spec.ts`.
- create `src/data/duck.ts` — lazy initialisation on the first search, never on first paint;
  `manifest()` cached; `search(spec) -> rows` builds one parameterised SQL over
  `<base>/v1/search/dept=NN/part-0000.parquet` where NN comes from the postcode (`97x` → `DOM`);
  predicates: `code_postal_ban = ?` or `nom_commune_ban ILIKE ?`, `etiquette_dpe = ?`,
  `etiquette_ges = ?`, `date_etablissement_dpe` within the month, `surface_habitable_logement`
  within ± tolerance, optional kWh/m² and kgCO₂/m² within ± 5 %, `type_batiment`,
  `periode_construction`; `ORDER BY` closeness on surface; `LIMIT 50`.
- create `src/search/SearchForm.tsx`, `src/search/Results.tsx` (address, commune, classes,
  surface, date, lat/lon with an OpenStreetMap link), `src/search/spec.ts` (the `QuerySpec` type —
  the same shape `saved_search.spec` stores).
- create `test/e2e/fixtures/v1/...` — the exporter's `dept=DOM` output plus its manifest, committed
  once (a few hundred rows, well under 1 MB). `playwright.config.ts` gains a second `webServer`
  serving that directory with Range support, and a `globalSetup` that does a `GET` with
  `Range: bytes=0-99` and fails unless the answer is 206 — a server without Range makes DuckDB fail
  obscurely, and this makes the harness itself non-vacuous. `VITE_DATA_BASE_URL` points at it for e2e.
- create `test/e2e/search.spec.ts`,
  `docs/decisions/0009-duckdb-wasm-reads-parquet-from-r2-custom-domain.md`.

**Test first:** pick one certificate from the fixture (hard-code its numero, postcode, classes,
surface, month); fill the form; assert its address appears; change the DPE class by one letter;
assert it does not. Red: no form. The second assertion is the non-vacuity proof.

**Done when:** preview URL where Eymeric reverse-locates a real listing in an uploaded département;
CI e2e green offline on the fixture. **Split point** if long: ship `duck.ts` + fixture + harness
first, the form and results as `search-form` (M).

---

## PR 11 — `detail-and-save` (M, frontend) — depends on PR10 and PR4 — no ADR

**Goal:** the detail view from the wide file, and the save / saved flow.

**Files:** `src/data/duck.ts` gains `detail(numero)` (partition from `numero[2:4]`, falling back to
`v1/index/numero-exceptions.parquet`, then `SELECT * ... WHERE numero_dpe = ?` on the wide file —
one row group thanks to the sort); create `src/detail/Detail.tsx` (all columns, grouped),
`src/saved/Saved.tsx` (`GET /api/buildings`, delete); an "Enregistrer" button → `POST
/api/buildings`; create `test/e2e/save.spec.ts`.

**Test first:** a signed-in user opens a result → the detail shows a column that only the wide file
has (e.g. `conso_5_usages_ef`) → saves → `#/saved` lists it → a second user signed up in a fresh
browser context sees an empty `#/saved` (UI-level cross-tenant). Red: no detail route.

**Done when:** preview URL; CI green.

**Deferred after this roadmap:** map view (MapLibre), `user_quota`, `v1/rollup/*`, an ADEME API key.

---

## Owner task — the local base build (not a PR; after PR6 and PR7 are merged)

The default database path is `ademe/config.py`'s `DEFAULT_DB` on the 990 Pro drive; it already holds
the schema, the scales and département 09.

1. Mount the drive; keep ≥ 25 GB free (database 10–16 GB plus index-build spill next to the file).
2. `uv sync`
3. `uv run python -m ademe.schema` (idempotent)
4. `uv run python -m ademe.scales` (already done once; idempotent)
5. `uv run python -m ademe.vocab`
6. `nohup uv run python -m ademe.ingest --all > ingest.log 2>&1 &` — about 17 h at 500 kB/s; one
   stream, no second process; resumable per page, so if it dies rerun the same command.
7. `uv run python -m ademe.finalise` (PR6) — indexes, `foreign_key_check`, row count.
8. `uv run pytest -m live` — the SQLite round-trip must be green before exporting.
9. `uv run python -m ademe.export_parquet --out "/run/media/eymericchauchat/990 Pro/database/parquet"`
   then `ADEME_PARQUET_DIR=<that>/v1 uv run pytest -m live -k parquet`.
10. Upload `v1/search/`, `v1/dpe/`, `v1/index/` and **then** `v1/manifest.json`, last (rclone with an
    R2 S3 token). Verify `curl -r 0-99 -H 'Origin: https://<app-domain>' https://<data-domain>/v1/manifest.json`
    answers 206 with the CORS headers.
11. After a month, record the actual R2 and Workers spend as a new note — never by editing ADR-0002.

## Owner infrastructure steps, collected

| When | Step |
|---|---|
| before PR1's preview | `wrangler login`; `wrangler d1 create ademe-app` and `ademe-app-preview`, ids into `wrangler.jsonc`; one `wrangler deploy --env preview`; `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` repo secrets |
| PR3 | Google OAuth client (prod + preview callbacks); `wrangler secret put` ×3 for both envs; `BETTER_AUTH_URL` var per env |
| PR7 / PR10 | `uv run python -m ademe.ingest --dept 975 --dept 977 --dept 978` for the DOM fixture (minutes) |
| PR8 | R2 bucket `ademe-dpe`, custom domain, CORS from `infra/r2-cors.json`, R2 write token as repo secret |
| after PR6 + PR7 | the base build checklist above |
