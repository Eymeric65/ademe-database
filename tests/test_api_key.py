"""The key that is silently ignored.

ADEME rate-limits per caller: 500 kB/s of dynamic response anonymously, 1 MB/s
authenticated (data.ademe.fr FAQ). The base build measured 483 kB/s sustained
over 3.06M certificates, which is the anonymous cap to within measurement
noise -- so the key is worth exactly one halving of a seventeen-hour run.

What makes this worth testing rather than just writing: a key the server does
not recognise is **not an error**. It answers 200 and applies the anonymous
limits, so a truncated paste is invisible until the run takes twice as long as
it was supposed to. Both halves of the plumbing therefore get asserted -- that
the environment reaches the config, and that the config reaches the header --
because a break in either is equally silent.
"""

from __future__ import annotations

import importlib
import os
import shutil
import subprocess
import sys

import pytest

from ademe import api, config


def test_no_key_means_no_header(monkeypatch):
    """Anonymous is the supported default, not a degraded mode."""
    monkeypatch.setattr(api, "API_KEY", None)
    assert "x-apiKey" not in api.client().headers


def test_the_key_is_sent_as_x_apikey(monkeypatch):
    monkeypatch.setattr(api, "API_KEY", "sekrit")
    assert api.client().headers["x-apiKey"] == "sekrit"


def test_the_environment_reaches_the_config(monkeypatch):
    monkeypatch.setenv("ADEME_API_KEY", "from-the-environment")
    assert importlib.reload(config).API_KEY == "from-the-environment"


def test_an_empty_variable_is_not_a_key(monkeypatch):
    """`export ADEME_API_KEY=` in a shell profile must read as absent, not as
    a key of zero length -- which the server would ignore, anonymously."""
    monkeypatch.setenv("ADEME_API_KEY", "")
    assert importlib.reload(config).API_KEY is None


def test_the_dot_env_reader_handles_a_real_file(monkeypatch, tmp_path):
    """Comments, blanks and quotes, because a key pasted from a web page
    arrives wrapped in whichever of them the page used."""
    monkeypatch.delenv("ADEME_API_KEY", raising=False)
    env = tmp_path / ".env"
    env.write_text("# ADEME\n\nADEME_API_KEY='from-the-file'\nNOT_AN_ASSIGNMENT\n")
    config._dotenv(env)
    assert os.environ["ADEME_API_KEY"] == "from-the-file"


def test_the_environment_still_beats_the_file(monkeypatch, tmp_path):
    """A one-off `ADEME_API_KEY=... uv run ...` must override the file, or the
    file becomes the only way to change the key."""
    monkeypatch.setenv("ADEME_API_KEY", "from-the-shell")
    env = tmp_path / ".env"
    env.write_text("ADEME_API_KEY=from-the-file\n")
    config._dotenv(env)
    assert os.environ["ADEME_API_KEY"] == "from-the-shell"


def test_a_missing_dot_env_is_not_an_error(tmp_path):
    config._dotenv(tmp_path / "does-not-exist")


def test_the_repo_root_dot_env_is_the_one_that_is_read(tmp_path):
    """The wiring, not the parser.

    `uv run` ignores `.env` unless you remember `--env-file` -- verified
    against uv 0.12.4, where a bare `uv run` reads nothing -- and forgetting it
    is silent: the ingest runs anonymously and takes twice as long. So the
    config reads the file itself, at import, and this asserts it reads the file
    next to the package rather than some other one.

    TRAP: this cannot be done by monkeypatching `config.REPO`. `REPO` is
    `Path(__file__).resolve().parent.parent`, so `importlib.reload` recomputes
    it from the module's own location and throws the patch away -- and
    `.resolve()` means a symlinked copy resolves straight back to the real
    repository. The package is therefore *copied* somewhere else and imported
    from there, in a subprocess, which is the only arrangement where `REPO` is
    genuinely somewhere a test may write.

    The version of this test that shipped in #19 wrote a probe `.env` into the
    real repository root and skipped when one already existed -- which is every
    developer who has an API key, i.e. exactly the people the feature is for. A
    skip is not a pass.
    """
    shutil.copytree(config.REPO / "ademe", tmp_path / "ademe")
    (tmp_path / ".env").write_text("# probe\nADEME_API_KEY='from-the-copied-repo'\n")

    env = {k: v for k, v in os.environ.items() if k != "ADEME_API_KEY"}
    env["PYTHONPATH"] = str(tmp_path)
    got = subprocess.run(
        [sys.executable, "-c", "from ademe.config import API_KEY; print(API_KEY)"],
        capture_output=True, text=True, env=env, cwd=tmp_path,
    )
    assert got.returncode == 0, got.stderr
    assert got.stdout.strip() == "from-the-copied-repo", (
        f"the config did not read the .env beside its own package: {got.stdout!r}"
    )


def test_a_repo_without_a_dot_env_reads_no_key(tmp_path):
    """The other half, and the reason the test above is not vacuous: the same
    copied package with no `.env` beside it must come back with nothing."""
    shutil.copytree(config.REPO / "ademe", tmp_path / "ademe")

    env = {k: v for k, v in os.environ.items() if k != "ADEME_API_KEY"}
    env["PYTHONPATH"] = str(tmp_path)
    got = subprocess.run(
        [sys.executable, "-c", "from ademe.config import API_KEY; print(API_KEY)"],
        capture_output=True, text=True, env=env, cwd=tmp_path,
    )
    assert got.returncode == 0, got.stderr
    assert got.stdout.strip() == "None"


@pytest.fixture(autouse=True)
def _restore_config():
    yield
    importlib.reload(config)


@pytest.mark.live
def test_the_server_still_documents_this_header():
    """The header name is the whole feature, and getting it wrong fails open.

    So it is checked against the server's own OpenAPI rather than against a
    string somebody once read in a FAQ. If ADEME ever renames it, this is the
    only thing that would say so -- every request would keep returning 200.
    """
    doc = api._get(api.client(), "https://data.ademe.fr/data-fair/api/v1/api-docs.json")
    schemes = doc.json()["components"]["securitySchemes"]
    assert schemes["apiKey"] == {"type": "apiKey", "in": "header", "name": "x-apiKey"}


@pytest.mark.live
def test_a_key_that_is_set_is_actually_honoured():
    """Skipped without a key, because there is nothing to prove without one --
    but never skipped into a false pass: with `ADEME_API_KEY` set, this is the
    assertion that the base build is going to run at the rate it was planned
    for. It downloads one real page, which is the only way to know."""
    if not api.API_KEY:
        pytest.skip("ADEME_API_KEY not set; nothing to verify")
    rate = api.measure()
    assert rate >= (api.ANON_KBPS + api.AUTH_KBPS) / 2, (
        f"{rate:,.0f} kB/s -- the key is set but the server is still applying "
        f"anonymous limits (~{api.ANON_KBPS} kB/s), so it is not being honoured"
    )
