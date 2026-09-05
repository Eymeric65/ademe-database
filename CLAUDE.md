# CLAUDE.md

Working rules for this repository. They are not suggestions: a change that breaks one of them is
wrong even if it works.

This project is two applications that share a repository and nothing else:

- **The data plane** — public ADEME DPE data, published as Parquet on R2 and read directly by the
  browser. No owner, no auth, no authorization. Built by the Python ETL in `ademe/`.
- **The app plane** — a Cloudflare Worker with D1 holding accounts, saved buildings and saved
  searches. Everything here has an owner and every read must be scoped to it.

Keeping them apart is what keeps the authorization surface small. See ADR-0001.

## 1. Never touch `main`

`main` is production. No commits, no pushes, no merges into it, no force-pushes anywhere near it.
Every piece of work targets `dev`.

`dev` is the integration branch and what the persistent preview tracks. Feature work flows
`feat/* → dev → main`. **Only Eymeric promotes `dev → main`.** Claude does not open or merge that
PR unless asked for it by name.

## 2. One worktree per feature, off the remote tip of `dev`

The local checkout goes stale. Fetch first, branch from `origin/dev`, never from a stale local
`dev` and never from `main`.

Worktrees live in **`.claude/worktrees/<slug>`, inside the repository**. Never in `~`, never as a
sibling of the repo.

```bash
git fetch origin dev
git worktree add .claude/worktrees/<slug> -b feat/<slug> origin/dev
```

One feature per branch. If you discover a second thing that needs doing, it gets its own branch.

The local SQLite build is multi-gigabyte and lives outside the repo (see `ademe/config.py`).
Worktrees share it by path, so nothing needs copying and nothing can leak into a commit.

## 3. Tests must be non-vacuous

**A feature's test is red before the feature exists and green after.** Write it first, run it, and
keep the failure output — it goes in the PR body next to the passing run. If it passes before you
have implemented anything, it is asserting nothing and must be rewritten.

Prove a regression test is not vacuous by removing the fix and watching it fail with the *real*
error, not a different one.

**A skip is not a pass.** When `CI` is set, a missing dependency is a hard failure. A green run that
silently tested nothing is worse than a red one, because it looks like evidence.

Assert through the transport the user actually uses. A green database-level test and a broken
screen are compatible states — which is why Playwright exists here.

There is no mock database. D1 tests run against real Miniflare D1, which is real SQLite; a fake
would assert the fake. Do not introduce one.

## 4. Run the checks before pushing

```bash
npm run check          # tsc --noEmit, vitest, test:db, db:check
uv run pytest -m "not live"
```

`db:check` regenerates migrations and fails on a dirty diff. Editing the schema without regenerating
reaches a database as **nothing at all** — no error, no missing column until the first query needs
it.

## 5. Deploy a preview and hand over the link before opening the PR

```bash
npm run preview        # wrangler versions upload; prints the preview URL
```

`wrangler versions upload` publishes a version **without** deploying it and returns a URL shaped
`<version-prefix>-<worker>.<subdomain>.workers.dev`. Previews bind the separate
`ademe-app-preview` D1, so a preview can never write to real user data.

**Give Eymeric the URL and let him try it before the PR exists.** Then open the PR with that URL in
the body, next to the red-then-green test output. A PR that arrives without a preview link is
incomplete.

## 6. Open the PR yourself, always to `dev`

`gh pr create --base dev --head feat/<slug>`. Pass `--base dev` explicitly every time. Do not ask
permission first. **Claude never merges.** On a multi-PR plan, keep going to the next PR without
being told.

## 7. Smallest possible diff

A PR carries one feature and nothing else. No drive-by refactors, no reformatting, no renames, no
dependency bumps, no "while I was here". A genuinely necessary refactor is its own PR, merged
first. Prefer extending an existing file to adding a new one. Delete nothing that is merely
unfamiliar.

## 8. ADRs, and what belongs in them

A trade-off, a measurement or a postmortem goes in `docs/decisions/NNNN-slug.md`, never in a code
comment and never in this file. Leave a one-line `// see ADR-000N` pointer at the code.

What stays inline is a trap — a short warning where deleting it would let someone reintroduce a
specific bug. The test: *would deleting this comment cause a bug, or merely a question?*
Bug → inline. Question → ADR.

**An ADR is required, in the same PR as the change,** for: a schema change in either plane; a change
to the authentication or authorization model; a change to the Parquet layout, partitioning or
encoding; a new runtime dependency of consequence; a change to how the ETL decides what to fetch.

No ADR for UI work, copy, tests, or a bug fix with no structural change.

Numbers are permanent and never reused. An accepted ADR is never edited — supersede it with a new
one and mark the old `Superseded by ADR-NNNN`.

## 9. App-plane database access

**D1 has no row-level security.** No roles, no policies, no `SECURITY DEFINER`, no
`current_setting`. The mechanism that protects the sibling Postgres projects does not exist here,
and ADR-0003 records that this was chosen knowingly. Everything below is what replaces it.

- **`server/db.ts` is the only module that may hold a database handle.** It exports scoped
  functions, each taking a `Caller` built by `callerFrom(sub)`. It does not export `db`, and no
  route handler ever builds a query.
  `test/unit/no-raw-db.test.ts` fails the build if `drizzle(` or `env.DB` appears anywhere else.
- **Every exported function takes the caller's subject and filters on it.** A missing subject is
  coerced to `''`, never `NULL`, so every predicate against a `NOT NULL` column is FALSE and an
  unauthenticated request reads **zero rows rather than everything**. Fail closed by construction,
  not by remembering.
- **The route gate is a default-deny exception list**, applied once in the router. A route added
  later is protected by default rather than by whoever adds it remembering. Never give a module its
  own gate — then adding a module is what forgets it.
- **`test/unit/authorization.test.ts` greps the route declaration.** An operation is owner-scoped
  unless named in `SELF_SCOPED`, so widening one is an edit somebody has to justify in review.
  Adding a name there is the moment the control binds: **the same PR must carry a cross-tenant test
  proving the second user cannot reach the first's rows.**

SQL uses qmark `?` placeholders, matching the sibling repos and SQLite natively.

## 10. Migrations

**Append only. Never edit or reorder an applied migration.** Drizzle generates them; `db/migrate.ts`
applies them by name, not by high-water mark — two branches can add migrations concurrently and land
in either order, so the set matters and the position does not.

Every migration must be idempotent. `scripts/bundle-migrations.ts` compiles `db/migrations/*.sql`
into a committed module because esbuild does not bundle `.sql` and D1 takes one statement at a time.

Schema conventions, carried from the sibling repos:

- **`text` with a CHECK, never an enum type.**
- **Foreign keys everywhere, each with an explicit `onDelete`, none with `onUpdate`.**
- **`updated_at` is set by the handler that writes the row, never by a trigger.** A trigger would be
  invisible in `db/schema.ts`, which is the single source of truth.

## 11. The data plane is immutable and versioned

Parquet files are never edited in place. A build writes a whole partition and the manifest is
swapped last, so a failed build cannot take the app down and a rollback is a manifest edit.

**The ETL is polite.** ADEME publishes 500 kB/s and 20s of processing per minute for anonymous
callers. One stream, no parallel scrapers, no retry storms. The weekly job fetches only rows whose
`date_derniere_modification_dpe` moved — ADEME documents that column as the incremental key. The
full 17-hour base build is done locally, once, by hand.

Anything published must pass the round-trip test: all 226 columns reconstructed from the Parquet and
compared against live ADEME records. That test is the definition of "lossless" here.

## Commands

| | |
|---|---|
| `npm run dev` | Vite + `wrangler dev` with local D1 |
| `npm run check` | tsc, vitest, test:db, db:check |
| `npm run test:db` | vitest against real Miniflare D1 (`test/db/`) |
| `npm run test:e2e` | Playwright, chromium |
| `npm run db:generate` | Drizzle generate + bundle migrations |
| `npm run db:check` | regenerate and fail on a dirty diff |
| `npm run preview` | upload a version, print the preview URL |
| `uv run pytest -m "not live"` | ETL tests, offline |
| `uv run pytest -m live` | ETL tests against the live ADEME API |
| `uv run python -m ademe.ingest --dept 09` | load one département into the local SQLite build |
| `uv run python -m ademe.export_parquet` | SQLite → partitioned Parquet |

## Layout

| | |
|---|---|
| `ademe/` | Python ETL: fetch, normalise, verify, export Parquet |
| `schema/` | vendored ADEME schema JSON; the SQLite DDL is generated by `ademe/ddl.py` |
| `tests/` | ETL tests (pytest) |
| `db/` | Drizzle schema, migrations, migration runner |
| `server/` | Worker: router, auth, `db.ts` choke point |
| `src/` | React app, DuckDB-WASM queries |
| `test/` | Worker and UI tests (vitest), `e2e/` (Playwright) |
| `docs/decisions/` | ADRs |
