---
status: accepted
date: 2026-09-19
area: data plane
supersedes:
superseded-by:
---

# ADR-0039 — The last two months are published in a tree of their own, beside a counts-only index

**Status:** accepted · **Decided:** 2026-09-19 · **Area:** data plane

## Context and Problem Statement

A paid member sees the certificates of the last two months; a free member does
not (ADR-0038). Today each source's tree holds every row of a département in
one `dpe` and one `search` file, and every signed-in caller reads them whole
or by ranges. The Worker can refuse a file but not a row, so the rows a free
member must not see have to be in files of their own. A free member is still
shown how many newer certificates match the search, which needs something to
count that does not identify what it counts.

## Decision Drivers

* The refusal is a whole key prefix the Worker can gate (`/data/recent/*`),
  never a filter in the browser.
* The weekly delta, reconciliation and checks keep running unchanged on the
  whole tree, which ADEME's counts are compared against.
* `rclone copy` never deletes: a file the job stops writing keeps being served.
* The round-trip test (CLAUDE.md §11) still covers every published row.

## Considered Options

* A separate tree under its own top-level prefix, `recent/v1/<subdir>/…`, split
  from and joined back to the whole tree around the weekly job
* A `recent/` subdirectory inside each source's tree, `v1/<subdir>/recent/…`
* One more Hive partition level on the date, `v1/<subdir>/dpe/dept=P/recent=true/…`

## Decision Outcome

Chosen option: **"a separate tree under `recent/`"**, because it is the only
one where no route serving `v1/` can reach a recent file: `/data/v1/*` and
`/data/recent/*` are disjoint prefixes, and `serveObject` already refuses `..`.
Inside `v1/`, the existing signed-in route would serve the paid files unless
every future route remembered to exclude them.

`python -m ademe.recent split --from ROOT --out ROOT --source S [--cutoff D]`
turns one whole tree into three, under a ROOT shaped like the bucket:

| file | tree | who reads it |
|---|---|---|
| `dpe/dept=P/part-0000.parquet`, `search/…` | `v1/<subdir>` | signed in |
| `recent-counts/dept=P/part-0000.parquet` | `v1/<subdir>` | signed in |
| `dpe/dept=P/part-0000.parquet`, `search/…`, `index/*`, `manifest.json` | `recent/v1/<subdir>` | paid |

* **The cutoff** is two calendar months before the run, clamped to the end of
  the month (`cutoff_for`). A row is recent when its establishment date —
  `date_etablissement_dpe`, or `date_etablissement_audit` for audits — is on or
  after it. A row with no date is not recent: nothing says it is.
* **An audit is split whole.** Its steps go to the recent side together if any
  of them is recent, so a detail view never shows half an audit. In the e2e
  fixture all 52 audits have one date across their steps, so this is a guard.
  It is not something the data needs today.
* **The counts file** holds, for each recent row, exactly the columns the app's
  `searchQuery` filters on (`export_parquet.RECENT`). It holds no key, address
  or coordinate. It is cut from the search file, so its columns are a subset of
  `SEARCH`.
* **The indexes follow their key.** `numero-exceptions` and `scale-violation`
  are split by the row they describe.
* **Every file is written for every partition, even empty.** An empty recent
  file overwrites last week's in the bucket, and an unwritten one would not.
* **The manifest is written last.** It gains a top-level
  `recent{cutoff, date_column, counts_columns, tree}`. Each partition gains
  `recent{rows, search, dpe}` and `counts`. Its `rows` stays the whole
  partition's, so `reconcile` and `check_delta` compare the same number to
  ADEME as before. The recent tree gets a manifest of its own, written before
  the base manifest.
* **`split` refuses a tree that is already split.** `join` is its inverse. It
  unions both sides back into one whole tree, and it copies a tree that was
  never split. It raises when a partition joins to a different row count than
  the manifest records, because a recent file that failed to download would
  otherwise join to a smaller whole, and the delta would publish it.

The weekly job (a later PR) therefore runs **join → delta → reconcile →
check_delta → split**. It always splits, even when nothing changed, because rows
still age out. It uploads the recent tree, then the counts, then the base
files, and the manifest last.

### Consequences

* Good, because the paid boundary is a key prefix, and a key prefix is what the
  Worker already gates.
* Good, because every existing step of the weekly job still sees one whole tree.
* Bad, because a row stays paid-only for two months **plus up to seven days**.
  The cutoff moves once a week, not daily.
* Bad, because **every partition that has rows ageing out is rewritten every
  week**. Before, a partition was rewritten only when the delta touched it. In
  practice this is most partitions, every week: more bytes uploaded and new
  checksums, even for a département where nothing changed upstream.
* Bad, because **the counts file leaks filter-level facts at row level**. A
  signed-in free caller can read that a D-rated 78 m² home in postcode 09000
  was certified on a given recent date, and can guess which building it was
  from a listing. This is accepted: a count that could not be filtered would
  not answer "how many matches am I missing", and every column in it is a
  filter the search already offers. It carries no address, key or coordinate.
* Neutral, because the old unsplit files stay readable in the bucket until the
  first split run overwrites them. That run writes every partition.

**Two preconditions for publishing split trees:**

1. **`crosswalk.build` runs only on a split base tree.** It reads the base
   manifest's `dpe` files, so on a split tree it sees no recent certificate.
   Run on a joined tree, it would publish recent certificates' keys in a file
   every signed-in caller reads.
2. **The old public R2 domain must be gone** before the weekly job publishes
   under `recent/`. Otherwise anyone could read `recent/` directly, around the
   Worker:
   * `curl -sI https://data.recherche-maison.com/v1/manifest.json` must not
     answer 200.
   * `wrangler r2 bucket domain list ademe-dpe` must come back empty.

**Rollout order.** Nothing in this ADR's PR publishes anything: it adds the
library and the CLI, not a workflow step. The UI that reads the split trees
ships before the weekly job that writes them. The first weekly run joins the
unsplit production trees (a copy), splits them and publishes. Until then, free
members still see recent rows, as today.

### Confirmation

* `tests/test_delta.py` covers the split:
  * every row lands on exactly one side, including a row on the cutoff and a
    row with no date;
  * the base tree holds nothing on or after the cutoff;
  * the counts file's columns and row count;
  * indexes follow their key;
  * manifest checksums and totals;
  * empty files are written;
  * a split tree is refused;
  * `join(split(T)) == T`;
  * an unsplit tree is copied;
  * a short join is refused;
  * a later cutoff moves rows back;
  * join → `delta.merge` → split keeps a changed recent row recent with its
    new value;
  * `cutoff_for`.
* `tests/test_export_per_source.py`:
  * every source's counts columns are search columns and name no row;
  * an audit's steps land together;
  * `read_rows(recent_dir=)` reads both trees.
* `tests/test_roundtrip.py` (live) samples keys from the recent tree too. Under
  `CI`, a split manifest with no recent tree present is a failure, not a skip.

## More Information

* Related: [ADR-0038](0038-a-paid-plan-is-a-column-on-the-account-and-the-gate-reads-it.md),
  [ADR-0006](0006-search-index-and-detail-parquet-per-departement.md), [ADR-0033](0033-the-weekly-job-reads-the-published-trees-from-r2.md)
