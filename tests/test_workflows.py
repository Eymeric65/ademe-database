"""The weekly job updates every source, one after another, in one job.

ADEME allows one polite stream per caller (CLAUDE.md §11). A matrix, or a job
per source, would run the sources' fetches in parallel from one address. And a
source registered in `config.SOURCES` but missing from the job would simply
stop being updated, with nothing anywhere to say so. See ADR-0027.

Read as text rather than as YAML: the assertions are about order and presence,
and a YAML parser would be a dependency for one test.
"""

from __future__ import annotations

import re
from pathlib import Path

from ademe.config import SOURCES

WORKFLOW = Path(__file__).resolve().parent.parent / ".github" / "workflows" / "etl-weekly.yml"


def _text() -> str:
    return WORKFLOW.read_text(encoding="utf-8")


def _others() -> list[str]:
    """Every source but existing housing, in registry order."""
    return [slug for slug in SOURCES if slug != "existant"]


def test_the_weekly_job_is_one_job_without_a_matrix():
    text = _text()
    assert "matrix" not in text
    jobs = text.split("\njobs:\n", 1)[1]
    names = re.findall(r"^  ([\w-]+):\s*$", jobs, re.M)
    assert names == ["delta"]


def test_every_registered_source_is_updated_by_the_weekly_job():
    text = _text()
    missing = [slug for slug in _others() if f"ademe.delta --source {slug}" not in text]
    assert not missing, f"registered but never updated weekly: {missing}"


def test_the_sources_run_after_existing_housing_in_registry_order():
    text = _text()
    first = text.index("uv run python -m ademe.delta \\")
    positions = [text.index(f"ademe.delta --source {slug}") for slug in _others()]
    assert [first, *positions] == sorted([first, *positions])


def test_each_source_is_reconciled_and_checked_before_it_is_uploaded():
    text = _text()
    for slug in _others():
        sub = SOURCES[slug].subdir
        steps = [
            f"ademe.delta --source {slug}",
            f"scripts/reconcile.py --source {slug}",
            f"scripts/check_delta.py --source {slug}",
            f"rclone copy out/v1/{sub}/search",
        ]
        where = [text.index(s) for s in steps]
        assert where == sorted(where), slug


def test_the_weekly_job_reads_the_published_trees_from_r2_not_the_public_domain():
    """`data.recherche-maison.com` served the bucket to anyone, past the login
    gate (ADR-0012). The weekly job read the published trees through it, so the
    domain could not be removed without breaking the next Monday run. Each tree
    is now downloaded from R2 with the job's own credentials, before its delta,
    and the delta reads that copy. See ADR-0033.
    """
    text = _text()
    assert "data.recherche-maison.com" not in text
    assert "DATA_BASE_URL" not in text
    for slug in SOURCES:
        sub = SOURCES[slug].subdir
        base = f"base/v1/{sub}".rstrip("/")
        delta = (
            text.index("uv run python -m ademe.delta \\")
            if slug == "existant"
            else text.index(f"ademe.delta --source {slug}")
        )
        fetch = re.search(rf"rclone copy(?:to)? r2:ademe-dpe/v1/{re.escape(sub)}\S* {re.escape(base)}", text)
        assert fetch and fetch.start() < delta, f"{slug}: no download from R2 before its delta"
        assert f'--base-url "{base}"' in text or f"--base-url {base}" in text, f"{slug}: delta not on the R2 copy"


def test_each_source_uploads_its_manifest_after_its_files():
    text = _text()
    for sub in ["", *(f"{SOURCES[s].subdir}/" for s in _others())]:
        manifest = text.index(f"rclone copyto out/v1/{sub}manifest.json r2:ademe-dpe/v1/{sub}manifest.json")
        for kind in ("search", "dpe", "index"):
            line = re.search(rf"rclone copy out/v1/{re.escape(sub)}{kind}\s", text)
            assert line and line.start() < manifest, f"{sub or 'v1/'}{kind}"


# CI deploys what it has just tested: dev to the stable preview host, main to
# production. Same text-not-YAML reading as above.
CI = WORKFLOW.parent / "ci.yml"


def _ci_jobs() -> dict[str, str]:
    """Each job in ci.yml, by name, as its text."""
    jobs = CI.read_text(encoding="utf-8").split("\njobs:\n", 1)[1]
    parts = re.split(r"^  ([\w-]+):\s*$", jobs, flags=re.M)
    return dict(zip(parts[1::2], parts[2::2]))


def test_ci_builds_every_push_to_dev_and_to_main():
    """Production is deployed from main's own green run, so main is built."""
    push = re.search(r"^  push:\n    branches: \[([^\]]*)\]", CI.read_text(encoding="utf-8"), re.M)
    assert push and {b.strip() for b in push.group(1).split(",")} == {"dev", "main"}


def test_a_push_run_is_never_cancelled_mid_deploy():
    cancel = re.search(r"^  cancel-in-progress:\s*(.+?)\s*$", CI.read_text(encoding="utf-8"), re.M)
    assert cancel and cancel.group(1) == "${{ github.event_name == 'pull_request' }}"


def test_the_deploy_waits_for_every_other_job_and_runs_only_on_a_push():
    jobs = _ci_jobs()
    assert "deploy" in jobs, "ci.yml has no deploy job"
    needs = re.search(r"^    needs:\s*\[([^\]]*)\]", jobs["deploy"], re.M)
    assert needs and {n.strip() for n in needs.group(1).split(",")} == set(jobs) - {"deploy"}
    assert re.search(r"^    if:\s*github\.event_name == 'push'\s*$", jobs["deploy"], re.M)


def test_dev_deploys_the_preview_and_only_main_deploys_production():
    """TRAP: a bare `wrangler deploy` ships the top-level config -- production's
    D1 and recherche-maison.com. Run from dev, it would put every merge in front
    of real users before anyone promoted it."""
    deploys = {}
    for name, job in _ci_jobs().items():
        for step in re.split(r"^      - ", job, flags=re.M)[1:]:
            run = re.search(r"run:\s*npx wrangler deploy\b(.*)$", step, re.M)
            if not run:
                continue
            guard = re.search(r"^\s*if:\s*(.+?)\s*$", step, re.M)
            assert guard, f"{name}: unguarded `wrangler deploy{run.group(1)}`"
            deploys[(name, guard.group(1))] = run.group(1).strip()
    assert deploys == {
        ("deploy", "github.ref == 'refs/heads/dev'"): "--env preview",
        ("deploy", "github.ref == 'refs/heads/main'"): "",
    }
