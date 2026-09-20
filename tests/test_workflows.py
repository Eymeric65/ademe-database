"""The weekly job updates every source, each in a job of its own, one at a time.

ADEME allows one polite stream per caller (CLAUDE.md §11), so the source jobs
run one after another, never side by side. Each has its own runner, disk and
timeout, so one source failing or running long no longer takes the others down
with it. A source registered in `config.SOURCES` but missing from the matrix
would simply stop being updated, with nothing anywhere to say so. See ADR-0042.

Read as text rather than as YAML: the assertions are about order and presence,
and a YAML parser would be a dependency for one test.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from ademe.config import SOURCES

WORKFLOW = Path(__file__).resolve().parent.parent / ".github" / "workflows" / "etl-weekly.yml"


def _text() -> str:
    return WORKFLOW.read_text(encoding="utf-8")


def _jobs() -> dict[str, str]:
    """Each job in etl-weekly.yml, by name, as its text."""
    jobs = _text().split("\njobs:\n", 1)[1]
    parts = re.split(r"^  ([\w-]+):\s*$", jobs, flags=re.M)
    return dict(zip(parts[1::2], parts[2::2]))


def _steps() -> list[str]:
    return re.split(r"^      - ", _text(), flags=re.M)[1:]


def _matrix() -> list[str]:
    """The sources a scheduled run updates, in the order it updates them."""
    whole = re.search(r"^      matrix:\n        source: \$\{\{ (.+) \}\}$", _text(), re.M)
    assert whole, "the matrix is not a single `source:` list"
    # The other list in the expression is the one-source template, `["{0}"]`.
    lists = [s for s in re.findall(r"'(\[[^']*\])'", whole.group(1)) if "{0}" not in s]
    assert len(lists) == 1, f"expected the full source list once in the matrix: {whole.group(1)}"
    return json.loads(lists[0])


def test_each_source_is_its_own_job_one_at_a_time():
    """A matrix without `max-parallel: 1` fetches every source at once from one
    address; with `fail-fast` left on, one source failing cancels the rest."""
    jobs = _jobs()
    assert list(jobs) == ["source"], f"expected the one matrix job, got {list(jobs)}"
    job = jobs["source"]
    assert re.search(r"^      max-parallel: 1$", job, re.M), "source jobs may run side by side"
    assert re.search(r"^      fail-fast: false$", job, re.M), "one source failing cancels the others"
    assert re.search(r"^    timeout-minutes: \d+$", job, re.M), "no per-source timeout"


def test_every_registered_source_is_updated_in_registry_order():
    assert _matrix() == list(SOURCES)


def test_each_job_takes_its_tree_from_the_registry():
    """`v1` for existing housing and `v1/<subdir>` for the rest, from
    `Source.subdir` rather than a second copy of the paths here."""
    text = _text()
    assert "SOURCES[sys.argv[1]].subdir" in text
    assert 'echo "TREE=v1${sub:+/$sub}" >> "$GITHUB_ENV"' in text
    assert re.search(r"^      SOURCE: \$\{\{ matrix\.source \}\}$", text, re.M)


def test_a_manual_run_can_target_one_source():
    inputs = _text().split("  workflow_dispatch:\n", 1)[1].split("\nconcurrency:", 1)[0]
    source = re.search(r"^      source:\n(.*?)(?=^      \w)", inputs, re.M | re.S)
    assert source, "workflow_dispatch has no `source` input"
    options = re.search(r"options: \[([^\]]*)\]", source.group(1))
    assert options and [o.strip() for o in options.group(1).split(",")] == ["all", *SOURCES]
    matrix = re.search(r"^        source: \$\{\{ (.+) \}\}$", _text(), re.M)
    assert matrix and "inputs.source" in matrix.group(1)


def test_a_dry_run_uploads_nothing():
    """So a branch can be run live against the real bucket without publishing."""
    assert re.search(r"^      dry_run:\n(?:        .*\n)*?        type: boolean$", _text(), re.M)
    uploads = [s for s in _steps() if re.search(r"rclone copy(?:to)? publish/", s)]
    assert uploads, "the weekly job uploads nothing"
    for step in uploads:
        guard = re.search(r"^\s*if:\s*(.+?)\s*$", step, re.M)
        assert guard and "!inputs.dry_run" in guard.group(1), f"uploads on a dry run: {step.splitlines()[0]}"


def test_each_source_is_reconciled_and_checked_before_it_is_uploaded():
    text = _text()
    steps = [
        'ademe.recent join --from bucket --out base --source "$SOURCE"',
        'ademe.delta --source "$SOURCE" --base-url "base/$TREE"',
        'scripts/reconcile.py --source "$SOURCE"',
        'scripts/check_delta.py --source "$SOURCE"',
        'ademe.recent split --from "$from" --out publish --source "$SOURCE"',
        "rclone copy publish/",
    ]
    missing = [s for s in steps if s not in text]
    assert not missing, missing
    where = [text.index(s) for s in steps]
    assert where == sorted(where), f"out of order: {steps}"


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
    fetch = re.search(r"rclone copy(?:to)? r2:ademe-dpe/\$TREE/\S* bucket/\$TREE/", text)
    join = text.find('ademe.recent join --from bucket --out base --source "$SOURCE"')
    delta = text.find('ademe.delta --source "$SOURCE" --base-url "base/$TREE"')
    assert fetch, "no download from R2"
    assert fetch.start() < join < delta, "the download is not joined into base before the delta"


def test_the_weekly_job_prints_as_it_goes_and_uses_the_api_key():
    """Run #2 (2026-09-14) was killed after 60 minutes in which reconcile had
    printed nothing: Python block-buffers a piped stdout, and a killed process
    never flushes. And without the key every step ran at ADEME's anonymous
    rate. Both are job-wide, so every step inherits them."""
    env = _text().split("\n    env:\n", 1)[1].split("\n    steps:\n", 1)[0]
    assert re.search(r'^      PYTHONUNBUFFERED: "1"$', env, re.M)
    assert re.search(r"^      ADEME_API_KEY: \$\{\{ secrets\.ADEME_API_KEY \}\}$", env, re.M)


def _upload(text: str, local: str) -> int:
    """Where `publish/<local>` is uploaded; -1 when it never is."""
    line = re.search(rf"rclone copy(?:to)? publish/{re.escape(local)}\s", text)
    return line.start() if line else -1


def test_each_source_uploads_its_manifest_after_its_files():
    """The recent tree, then the counts, then the base files, the base manifest
    LAST: it names the other three, and a reader must never be pointed at a file
    that is not there yet. See ADR-0039."""
    text = _text()
    stages = [
        [f"recent/$TREE/{kind}" for kind in ("search", "dpe", "index", "manifest.json")],
        ["$TREE/recent-counts"],
        [f"$TREE/{kind}" for kind in ("search", "dpe", "index")],
        ["$TREE/manifest.json"],
    ]
    where = [[_upload(text, local) for local in stage] for stage in stages]
    never = [local for stage, at in zip(stages, where) for local, i in zip(stage, at) if i < 0]
    assert not never, f"never uploaded: {never}"
    for before, after in zip(where, where[1:]):
        assert max(before) < min(after), f"uploaded out of order: {stages}"


def test_each_source_is_joined_after_its_recent_download_and_split_before_its_upload():
    """The delta, reconcile and checks run on the whole tree, so the paid tree is
    joined back in first; nothing is published until it is split out again. A
    recent row uploaded unsplit would be in `v1/`, which every signed-in caller
    reads. See ADR-0039."""
    text = _text()
    fetch = re.search(r"rclone copy r2:ademe-dpe/recent/\$TREE/\S* bucket/recent/\$TREE/", text)
    join = text.find('ademe.recent join --from bucket --out base --source "$SOURCE"')
    delta = text.find('ademe.delta --source "$SOURCE"')
    split = text.find('ademe.recent split --from "$from" --out publish --source "$SOURCE"')
    upload = re.search(r"rclone copy(?:to)? publish/", text)
    assert fetch, "the recent tree is never downloaded"
    assert upload, "never uploaded"
    order = [fetch.start(), join, delta, split, upload.start()]
    assert -1 not in order and order == sorted(order), f"not download < join < delta < split < upload: {order}"


def test_every_upload_is_from_the_split_tree_to_the_same_path():
    """`publish/` mirrors the bucket, so a file lands at the key it was split to:
    recent files only ever under `recent/`, and nothing unsplit is published."""
    uploads = re.findall(r"rclone copy(?:to)? (\S+)\s+r2:ademe-dpe/(\S+)", _text())
    assert uploads, "the weekly job uploads nothing"
    wrong = [(local, remote) for local, remote in uploads if local != f"publish/{remote}"]
    assert not wrong, f"uploaded from somewhere other than its split path: {wrong}"


def test_a_source_is_split_and_uploaded_even_when_nothing_changed():
    """TRAP: rows age out of the paid window every week whether or not ADEME
    changed anything. A split or an upload gated on the delta would leave them
    paid-only for as long as the source stays quiet."""
    steps = _steps()
    n = sum("ademe.recent split" in step for step in steps)
    assert n == 1, f"{n} split step(s); the matrix job splits once per source"
    for step in steps:
        splits = "ademe.recent split" in step
        if not (splits or re.search(r"rclone copy(?:to)? publish/", step)):
            continue
        guard = re.search(r"^\s*if:\s*(.+?)\s*$", step, re.M)
        assert not (guard and "changed" in guard.group(1)), f"gated on a change: {step.splitlines()[0]}"
        if splits:
            head = step[: step.index("ademe.recent split")]
            assert "exit 0" not in head, f"a quiet week exits before the split: {step.splitlines()[0]}"


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
