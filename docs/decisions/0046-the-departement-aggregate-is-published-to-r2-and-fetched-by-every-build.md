---
status: accepted
date: 2026-09-20
area: data plane
supersedes:
superseded-by:
---

# ADR-0046 — The département aggregate is published to R2 by the weekly job and fetched by every build

**Status:** accepted · **Decided:** 2026-09-20 · **Area:** data plane

## Context and Problem Statement

The site has nothing a search engine can read. Everything behind the Worker's `/data/*` route needs
a session (ADR-0012), and that gate is the whole reason the certificates can be served at all
without becoming a republication of ADEME's file under our name.

We want ~101 public pages, one per département, carrying statistics: how many certificates, how the
classes are distributed, what share are *passoires thermiques*, what a typical consumption and
surface look like, which communes have the most. Those are numbers about a place, not certificates
about an address — nobody can find a building in them. So the question is not whether the pages may
exist but **where their numbers come from at build time**, given that `npm run build` has no
credentials for the bucket.

The numbers are one small JSON, ~350 kB for all 103 partitions. The tree they are computed from is
not small, and the computation is not cheap: nine columns across 103 `search/` partitions, ~7
DuckDB queries each, then the whole thing again as a national scan. It is minutes against a local
copy and much worse over the network — for numbers that move once a week, on the Monday the weekly
job runs.

## Decision Drivers

* The gate stays exactly where it is. A public page may carry aggregates and nothing else: no
  address, no `numero_dpe`, no individual certificate, ever.
* **A build with no credentials must still produce pages.** CI's `e2e` job and a laptop both run
  `npm run build`, and neither has, or should have, a key to the bucket.
* **No deploy may silently ship fewer pages than the last one.** Workers ASSETS replaces `dist/`
  whole, per version, so a build that quietly found no aggregate would turn 101 indexed URLs into
  404s, green and unremarked.
* The refresh must not depend on one laptop holding a multi-gigabyte tree.
* The published `v1/` tree is structurally two to three months behind live ADEME, because the
  recent window is paid and lives in its own tree (ADR-0039). Whatever the pages say, they must say
  as of when.
* The repository is source. A dataset that changes weekly is not source.

## Considered Options

* The weekly job computes the aggregate, publishes it to R2, and every build fetches it
* One JSON committed to the repository, refreshed by hand from the machine holding the tree
* The Worker computes the numbers live from R2 on each request
* The site build computes the aggregate itself from R2, on every push

## Decision Outcome

Chosen option: **"the weekly job publishes it to R2 and every build fetches it"**.

`ademe.aggregate` reads the published `search/` tree with DuckDB, the way ADR-0033 already has the
weekly job read published trees — partitions enumerated from `manifest["partitions"]`, never a
glob, `hive_partitioning = false` on every read. It is run by a `pages` job in `etl-weekly.yml`,
after the source jobs, and the result lands at `v1/aggregates.json` beside the manifest:

```
rclone copy   r2:ademe-dpe/v1/search        tree/v1/search
rclone copyto r2:ademe-dpe/v1/manifest.json tree/v1/manifest.json
uv run python -m ademe.aggregate --root tree/v1 --out publish/v1/aggregates.json
rclone copyto publish/v1/aggregates.json    r2:ademe-dpe/v1/aggregates.json
```

Every build then fetches that one object before `vite build` prerenders the pages from it. The
`deploy` job in `ci.yml` does it with the same key, and the `pages` job does it for itself and
deploys, so the numbers refresh on the Monday rather than waiting for somebody to push.

**The producer lands first, on its own.** This decision is implemented across two pull requests, in
that order and not the other: the `pages` job that publishes the object, then the fetch and the
prerender that consume it. A fetch merged before the first weekly run has put `v1/aggregates.json`
on the bucket would fail every deploy — correctly, by the rule below, which is exactly why it must
not be merged first.

Three things make that safe rather than merely convenient:

**The fetch is unguarded.** No `|| true`, no `continue-on-error`, no `if:`. A missing object or a
wrong key fails the deploy before `npm run build` runs. A red deploy is a far better outcome than a
green one that removed a hundred and one pages.

**A build with no key falls back to a committed fixture.** `src/seo/aggregates.sample.json` is 6 kB:
Ariège, Haute-Garonne and the national block, communes trimmed to three, marked `"sample": true`.
`npm run build` on a laptop and in CI's `e2e` job produces two real pages and a two-entry sitemap
from it. That is what keeps the e2e spec — the only proof that ASSETS resolves `/departement/ariege`
without JavaScript — runnable by anyone. The real aggregate is `.gitignore`d, and
`tests/test_aggregate.py` fails if it is ever committed again or if the sample grows past 30 kB.

**The weekly deploy is production, and only from `main`.** A scheduled run checks out the default
branch, which is `main`, so the code it deploys is the code already in production and only the
numbers have moved. `workflow_dispatch` runs from whatever branch it was launched on, so the step
checks `github.ref == 'refs/heads/main'` rather than assuming it; a dispatch from a feature branch
refreshes the aggregate and deploys nothing. A dry run does neither.

### What this gives up

The previous draft of this decision committed the JSON. It was chosen for two properties, and both
are genuinely lost here:

* **The build is no longer reproducible from the commit alone.** The same commit renders different
  pages on different days. That is correct for data and would be wrong for code, and the pages say
  their cut-off on their face, but it is a real change: `git checkout` no longer reconstructs what
  was served.
* **An unattended job now changes what the public pages say.** No human reads `+1 516 358
  passoires` before it is public. What bounds it is that the job can only ever publish what the
  weekly run already put on R2 — through `reconcile`, `check_delta` and the round-trip test — and
  that only the *numbers* move unattended. The code that renders them still changes only through a
  reviewed pull request.

Against that: the refresh no longer requires one particular laptop, the repository stops carrying a
dataset, and the pages stop being as stale as the last time somebody remembered.

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

* Good, because the repository carries a 6 kB fixture instead of a 357 kB dataset that only one
  machine could refresh.
* Good, because the numbers refresh themselves the same morning the tree they describe is
  published.
* Good, because a build with no credentials still renders pages, so the e2e proof stays runnable
  and a laptop build is not a special case.
* Good, because the aggregate is computed from the published files with DuckDB, so it can only ever
  say what the published data supports, and anybody holding the tree can reproduce it.
* Bad, because the deploy now depends on the bucket, and an aggregate that is not there yet fails
  it. Deliberate: see the unguarded fetch above. The first weekly run must land the object before
  the fetch is merged.
* Bad, because the bucket key now reaches the `deploy` job, which previously held only the
  Cloudflare API token. Bounded by keeping it out of every other job, which
  `tests/test_workflows.py` asserts.
* Bad, because a preview built on a laptop shows the sample's two pages unless the aggregate is
  fetched first. The command is in CLAUDE.md's table.
* Neutral, because only `existant` is aggregated for now. `neuf`, `tertiaire` and `audit` have
  their own trees and would be a second phase.

### Confirmation

`tests/test_aggregate.py` builds a `search/` tree in `tmp_path` with DuckDB and pins every number
by hand: the A–G histogram, the F+G share as an exact fraction, the quartiles, the median surface,
one commune under two spellings coming back once under the modal one, `NG` and `DOM` coming back
`publishable: false` while still counting toward the national total, and the stamp coming from the
manifest. `test_no_address_and_no_certificate_id_reach_the_output` serialises the whole result and
fails if a `numero_dpe` or an address string appears anywhere in it — that one is the gate, and
`test_no_address_and_no_certificate_id_reach_the_sample` holds the same line over the committed
fixture, which is real ADEME data rather than the fixture's invented rows.

`tests/test_workflows.py` reads the workflow as text and asserts the order that matters: the tree is
downloaded before the aggregate is built, the wide `dpe/` tree is not downloaded at all, the
aggregate is uploaded from the path it was written to, and a dry run publishes nothing. The
consumer half brings its own: the `deploy` job fetches **before** it builds, the fetch carries no
`|| true` or `continue-on-error`, the weekly deploy is bare and gated on `main`, and the bucket
credentials appear in that one job and no other.

## Pros and Cons of the Options

### One JSON committed to the repository

* Good, because the build is hermetic and reproducible from the commit alone.
* Good, because a statistics refresh is a diff a reviewer can read.
* Bad, because it is a dataset in a source repository, re-written whole every refresh.
* Bad, because the refresh is a human running a command on the one machine that holds the tree, so
  in practice the pages are as fresh as somebody's memory.

### The Worker computes the numbers live from R2

* Good, because the numbers are never stale.
* Bad, because a public route that scans Parquet is a public route that scans Parquet: every
  crawler hit becomes R2 reads and CPU, for numbers that change once a week.
* Bad, because it puts a second, unauthenticated path onto the data the gate exists to cover, and
  an entry in `ROUTED_PREFIXES` to justify.

### The site build computes the aggregate itself

* Good, because there is no intermediate artifact at all.
* Bad, because it is ~7 DuckDB queries over 103 partitions plus a national scan, on **every push**,
  for a number that moves on Mondays.
* Bad, because it needs the bucket key *and* Python *and* DuckDB in a job that today is Node only,
  and still leaves the `e2e` job and the laptop needing a fallback.

## More Information

* Related: [ADR-0012](0012-the-data-plane-is-served-through-the-worker.md),
  [ADR-0024](0024-ungeocoded-certificates-are-the-ng-partition.md),
  [ADR-0033](0033-the-weekly-job-reads-the-published-trees-from-r2.md),
  [ADR-0039](0039-the-last-two-months-are-published-in-a-tree-of-their-own-beside-a-counts-only-index.md),
  [ADR-0042](0042-each-source-is-its-own-weekly-job-one-at-a-time.md).
