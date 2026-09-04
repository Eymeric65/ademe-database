"""Per-column storage decisions, derived from the vendored ADEME schema.

Four encodings, chosen per column:

  SCALED   numeric stored as INTEGER x 10^d. Measured: 96 of the numeric
           columns carry exactly one decimal, 3 carry two, one is a true
           float. Verified empirically that NUMERIC affinity is byte-identical
           to REAL (both 8 body bytes for "12.3") and that scaling is 5.47 B
           per column per row cheaper, with no round-trip loss.
  DATE     ISO date stored as INTEGER days since 1970-01-01. 2 B against 10.
  VOCAB    text replaced by a FK. `closed` vocabularies (<= 1000 distinct) are
           pre-built from /values; `open` ones are free text that /values
           refuses to enumerate and must be accumulated during ingest.
  TEXT     stored inline, because nearly every value is distinct and a
           dictionary would cost more than it saves.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import lru_cache

from ademe.config import (
    CLOSED_VOCAB_MAX,
    OPEN_DICT_MAX,
    SCHEMA_JSON,
    SLOT_UNION_MAX,
)

CLOSED_VOCAB_MAX_UNION = SLOT_UNION_MAX

SCALED, DATE, VOCAB_CLOSED, VOCAB_OPEN, TEXT, PLAIN_INT = (
    "scaled",
    "date",
    "vocab_closed",
    "vocab_open",
    "text",
    "int",
)

# Slot indices, anywhere in the name. Stripping ONLY these is what lets the
# slots of one repeating group share a vocabulary table:
#   type_generateur_n1_installation_n2 -> type_generateur_installation
# Stripping more than this merges genuinely different vocabularies -- an
# earlier version collapsed twelve columns spanning 3 to 162 distinct values
# into a single `type` domain, and put a 15-value controlled list in the same
# table as a 107 977-entry free-text dictionary.
_SLOT = re.compile(r"_n[123](?=_|$)")

# Vocabularies that are genuinely the same list under different names, keyed by
# stem. Verified against /values by tests/test_vocab_aliases.py: every member's
# value set must be a subset of the union, so this stays a checked claim. The
# energy list was confirmed as 15 values with all eleven columns subsets of it.
_ALIASES = {
    "type_energie_principale_chauffage": "type_energie",
    "type_energie_principale_ecs": "type_energie",
    "type_energie_generateur_installation": "type_energie",
    "type_energie_generateur_ecs": "type_energie",
    "etiquette_ges": "etiquette",
    "etiquette_dpe": "etiquette",
}

# A column with no slot index whose name collides with a slot stem is a
# DIFFERENT vocabulary and must not share the table. `type_installation_chauffage`
# is the dwelling-level summary (collectif / individuel / mixte);
# `type_installation_chauffage_n1` is a per-installation kind, a 4-value list
# with no values in common. Merging them was a live bug caught by the alias
# check against /values.
_GLOBAL_SUFFIX = "_global"


@dataclass(frozen=True)
class Column:
    key: str
    type: str
    format: str | None
    cardinality: int | None
    group: str | None
    encoding: str
    domain: str | None = None   # vocabulary table stem, for VOCAB_*
    scale: int = 1              # 10^d, for SCALED

    @property
    def sql_type(self) -> str:
        return "TEXT" if self.encoding == TEXT else "INTEGER"


def _stem(key: str) -> tuple[str, bool, bool]:
    """(stem, had_slot_index, was_aliased)."""
    stem = _SLOT.sub("", key)
    had_slot = stem != key
    stem = re.sub(r"_ban$", "", stem)
    aliased = stem in _ALIASES
    return (_ALIASES.get(stem, stem) or key), had_slot, aliased


@lru_cache(maxsize=1)
def _domains() -> dict[str, str]:
    """column -> vocabulary domain, resolved with a view of every column.

    Precedence matters. An explicit alias is a verified semantic claim and wins
    over the collision rule; without that, aliasing `type_energie_principale_*`
    onto `type_energie` was silently undone and the energy list split across two
    tables. The collision suffix is only for *accidental* stem matches.
    """
    stems = {f["key"]: _stem(f["key"]) for f in _raw()}
    slot_stems = {s for s, had, _ in stems.values() if had}
    out: dict[str, str] = {}
    for key, (stem, had_slot, aliased) in stems.items():
        if had_slot or aliased:
            out[key] = stem
        elif stem in slot_stems:
            out[key] = stem + _GLOBAL_SUFFIX
        else:
            out[key] = stem
    return out


def domain_of(key: str) -> str:
    return _domains().get(key) or key


def _encoding(f: dict, scales: dict[str, int]) -> tuple[str, str | None, int]:
    key, typ, fmt = f["key"], f.get("type"), f.get("format")
    card = f.get("x-cardinality")

    if fmt == "date":
        return DATE, None, 1
    if typ in ("number", "integer"):
        scale = scales.get(key, 1)
        if scale == 0:
            # More decimals than an integer encoding can hold losslessly.
            return TEXT, None, 0
        return (SCALED if scale > 1 else PLAIN_INT), None, scale
    # strings
    if card is None or card > OPEN_DICT_MAX:
        return TEXT, None, 1
    if card <= CLOSED_VOCAB_MAX:
        return VOCAB_CLOSED, domain_of(key), 1
    return VOCAB_OPEN, domain_of(key), 1


@lru_cache(maxsize=1)
def _raw() -> list[dict]:
    return json.loads(SCHEMA_JSON.read_text(encoding="utf-8"))


def load(scales: dict[str, int] | None = None) -> dict[str, Column]:
    """Column specs. `scales` comes from `ademe.scales` once discovered;
    without it every numeric column falls back to unscaled INTEGER, which is
    lossy for decimals -- so ingest requires it."""
    scales = scales or {}
    out: dict[str, Column] = {}
    for f in _raw():
        enc, dom, sc = _encoding(f, scales)
        out[f["key"]] = Column(
            key=f["key"],
            type=f.get("type", "string"),
            format=f.get("format"),
            cardinality=f.get("x-cardinality"),
            group=f.get("x-group"),
            encoding=enc,
            domain=dom,
            scale=sc,
        )
    return out


@lru_cache(maxsize=1)
def csv_header_to_key() -> dict[str, str]:
    """CSV headers are the schema's `label`, which is NOT always the `key`.

    16 real columns differ, and two of them collide destructively: the header
    `adresse_brut` carries the field whose key is `adresse_complete_brut`,
    while the key `adresse_brut` is published under the header
    `numero_voie_brut`. Reading a row by key therefore silently loads the wrong
    values into the wrong columns -- not a missing value, a swapped one.

    The rename must be applied to the whole header row at once, never key by
    key, or the collision resolves in the wrong direction.
    """
    return {(f.get("label") or f["key"]): f["key"] for f in _raw()}


def rename_row(row: dict[str, str]) -> dict[str, str]:
    m = csv_header_to_key()
    return {m.get(h, h): v for h, v in row.items()}


def vocab_domains(cols: dict[str, Column]) -> dict[str, list[str]]:
    """domain -> the columns that share it."""
    out: dict[str, list[str]] = {}
    for c in cols.values():
        if c.encoding in (VOCAB_CLOSED, VOCAB_OPEN):
            out.setdefault(c.domain, []).append(c.key)
    return out


def numeric_columns(cols: dict[str, Column]) -> list[str]:
    return [c.key for c in cols.values() if c.type in ("number", "integer")]
