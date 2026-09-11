---
status: accepted
date: 2026-09-11
area: data plane
supersedes:
superseded-by:
---

# ADR-0033 — The weekly job reads the published trees from R2, so the public domain can go

**Status:** accepted · **Decided:** 2026-09-11 · **Area:** data plane

## Context and Problem Statement

ADR-0012 put the certificates behind the Worker's `/data/*` route, which requires a session. But
the bucket `ademe-dpe` still has its old custom domain, `data.recherche-maison.com`, and that
domain serves every file to anyone. The login gate can be walked around. The bucket also still
carries CORS rules for browsers reading it directly (`infra/r2-cors.json`), which nothing needs
since the Worker serves the files same-origin. The `r2.dev` URL is already disabled.

The domain could not simply be removed, because `etl-weekly.yml` read the published trees through
it: `DATA_BASE_URL=https://data.recherche-maison.com/v1`. That covered each source's "published?"
probe, the delta's base (its manifest and the partitions it merges or copies), and the
sharp-departure check. Removing the domain first would break the next Monday run.

## Decision Drivers

* Nothing should read the bucket over a public URL. The app goes through the Worker; the job has
  its own credentials.
* No change to the ETL code. `ademe.delta`, `scripts/reconcile.py` and `scripts/check_delta.py`
  already accept a local directory as the published tree.
* The job already holds an R2 key (`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`/`R2_ENDPOINT`) for its
  uploads.

## Considered Options

* Download each published tree from R2 with `rclone` and the job's credentials, and read the copy
* Read through the Worker's `/data/*` route with a machine credential
* Keep the domain, behind a WAF rule that only admits a secret header

## Decision Outcome

Chosen option: **"download from R2 with the job's own credentials"**. The R2 credentials move from
the upload steps to the job, and `rclone` is installed once, first. Each source's "published?"
step becomes a download of its tree (`r2:ademe-dpe/v1/<subdir>` → `base/v1/<subdir>`). A source
is published when its manifest arrived. The delta, the reconciliation and the check read that
copy.

A machine credential on the Worker is a new path through the authorization model, for a job that
already has storage credentials. A WAF rule keeps a public endpoint, and moves the secret into a
header anyone can replay.

### Consequences

* Good, because once this runs from `main`, the domain and the bucket's CORS rules can be removed
  (below). After that, every read of the data is either a signed-in browser through the Worker, or
  the job with its key.
* Bad, because the job downloads the trees it updates, about 5.6 GB a week. R2 does not charge
  for it, but the runner's disk is tight. A first step frees space by removing preinstalled
  toolchains the job does not use.
* Neutral, because `infra/r2-cors.json` is deleted. Its rules only served direct browser reads.

### Removing the domain cleanly

After this PR is merged and promoted to `main`, where scheduled workflows run:

1. Run the weekly job once from the Actions tab (*Run workflow*) and let it go green.
2. `npx wrangler r2 bucket domain remove ademe-dpe --domain data.recherche-maison.com`, or in the
   dashboard: R2 → `ademe-dpe` → Settings → Custom Domains → Remove. The DNS record Cloudflare
   created for it goes with it.
3. `npx wrangler r2 bucket cors delete ademe-dpe` (or the dashboard's CORS policy), since the rules
   only served the domain.
4. Check:
   * `curl -sI https://data.recherche-maison.com/v1/manifest.json` no longer answers 200;
   * the Worker's `/data/v1/manifest.json` answers 401 signed out and 200 signed in;
   * `npx wrangler r2 bucket domain list ademe-dpe` is empty;
   * `npx wrangler r2 bucket dev-url get ademe-dpe` still says disabled.

### Confirmation

`tests/test_workflows.py::test_the_weekly_job_reads_the_published_trees_from_r2_not_the_public_domain`
checks that the workflow names neither the domain nor `DATA_BASE_URL`, that each registered
source's tree is downloaded from R2 before its delta, and that the delta reads that copy.

## More Information

* Related: [ADR-0012](0012-the-data-plane-is-served-through-the-worker.md),
  [ADR-0027](0027-the-weekly-job-updates-every-source-in-turn.md).
