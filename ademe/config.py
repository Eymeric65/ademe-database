"""Paths and tunables. One place, so nothing is hard-coded in the ETL."""
from __future__ import annotations

import os
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# The database is ~10-16 GB. /home had 7.5 GB free when this was chosen, so it
# lives on the 990 Pro. Override with ADEME_DB or --db-path.
DEFAULT_DB = Path(
    os.environ.get("ADEME_DB", "/run/media/eymericchauchat/990 Pro/database/ademe.sqlite")
)

SCHEMA_JSON = REPO / "schema" / "ademe-schema.json"

DATASET = "dpe03existant"
API = f"https://data.ademe.fr/data-fair/api/v1/datasets/{DATASET}"
LICENCE = "Licence Ouverte 2.0 (Etalab)"

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
