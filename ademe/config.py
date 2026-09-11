"""Paths and tunables. One place, so nothing is hard-coded in the ETL."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from ademe import mapping as _mapping

REPO = Path(__file__).resolve().parent.parent

# The database is ~10-16 GB. /home had 7.5 GB free when this was chosen, so it
# lives on the 990 Pro. Override with ADEME_DB or --db-path.
DEFAULT_DB = Path(
    os.environ.get("ADEME_DB", "/run/media/eymericchauchat/990 Pro/database/ademe.sqlite")
)

@dataclass(frozen=True)
class Source:
    """One ADEME dataset: where it is published, the schema that describes it,
    the SQLite file it is built in and the Parquet tree it is published to.
    See ADR-0017."""

    slug: str
    dataset: str  # Data Fair id
    schema_json: Path  # its labels drive the CSV header rename -- never another's
    db_path: Path  # one file per source; two sources in one file corrupt both
    subdir: str  # tree under v1/; "" is v1/ itself
    # Where its columns go. Not compared: a source is its name, and a
    # Mapping holds dicts, which cannot be hashed.
    mapping: _mapping.Mapping = field(compare=False)

    @property
    def api(self) -> str:
        return f"https://data.ademe.fr/data-fair/api/v1/datasets/{self.dataset}"


EXISTANT = Source(
    slug="existant",
    dataset="dpe03existant",
    schema_json=REPO / "schema" / "ademe-schema.json",
    db_path=DEFAULT_DB,
    subdir="",
    mapping=_mapping.EXISTANT,
)
SOURCES = {s.slug: s for s in (EXISTANT,)}

# Existing housing, under the names every module used before there was a second.
SCHEMA_JSON = EXISTANT.schema_json
DATASET = EXISTANT.dataset
API = EXISTANT.api
LICENCE = "Licence Ouverte 2.0 (Etalab)"



def _dotenv(path: Path) -> None:
    """Read `KEY=value` lines from `.env` into the environment, if it exists.

    The repo root, because a key passed on the command line lands in shell
    history and a key exported from `~/.bashrc` lands in every process on the
    machine. `.env` is git-ignored.

    TRAP: `uv run` does NOT read `.env` -- it needs `--env-file .env` or
    `UV_ENV_FILE`, and forgetting either is silent. The ingest simply runs at
    the anonymous rate and finishes in twice the time. Reading the file here
    is what makes every entry point behave the same way.

    A real environment variable always wins, so `ADEME_API_KEY=... uv run ...`
    still overrides the file for a one-off.
    """
    try:
        text = path.read_text()
    except OSError:
        return
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


_dotenv(REPO / ".env")

# Optional. ADEME rate-limits per caller: an anonymous one gets 500 kB/s of
# dynamic responses, an authenticated one 1 MB/s. Absent is the supported
# state -- the weekly delta is minutes either way, and only the once-ever base
# build is long enough for the difference to matter. See ADR-0013.
API_KEY = os.environ.get("ADEME_API_KEY") or None

# Measured: 40 s per 10 000 rows. Larger pages do not go faster (the server is
# the limit) and cost more to re-fetch on a retry.
PAGE_SIZE = 10_000

# Set before the first CREATE TABLE or it is silently ignored. 16384 cuts leaf
# page slack from ~7% to ~2.3% at this row width.
SQLITE_PAGE_SIZE = 16384

# A closed vocabulary is pre-built from /values and FK-enforced. Above this the
# endpoint returns nothing (the field is free text, not keyword-indexed) and the
# dictionary has to be built during ingest instead.
CLOSED_VOCAB_MAX = 1_000

# A repeating group's slots share one vocabulary table holding the union of the
# values each slot happens to use. Measured largest union: 163
# (type_generateur across four slots). Well past this and the "controlled
# vocabulary" premise is wrong and it should be an open dictionary instead.
SLOT_UNION_MAX = 5_000

# Above this a text column is left inline: dictionary encoding stops paying when
# nearly every value is distinct.
OPEN_DICT_MAX = 2_000_000
