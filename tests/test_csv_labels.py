"""The CSV header rename, against the header ADEME actually serves.

Data Fair's CSV export names each column by its schema `label`, not its `key`,
and `spec.rename_row` maps labels back to keys with the vendored schema. When
ADEME renames a header the vendored labels go stale, and nothing fails. By
2026-09 the export headed `adresse_brut` and `adresse_complete_brut` with their
own keys, while the vendored labels still said `numero_voie_brut` and
`adresse_brut`. The rename sent the `adresse_brut` values onto
`adresse_complete_brut`, where the real ones overwrote them, so `adresse_brut`
was stored empty for every certificate loaded: 7.9M of them, and the published
departement 09. The round-trip test could not see it, because its reference
records went through the same rename. See ADR-0023.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from ademe import api, spec
from ademe.config import API, SCHEMA_JSON
from ademe.mapping import INTERNAL_COLUMNS

# The full header line of `lines?format=csv`, as served on 2026-09-10.
HEADER = Path(__file__).parent / "fixtures" / "dpe03existant-csv-header-2026-09-10.txt"


def _headers(line: str) -> list[str]:
    return [h.strip('"') for h in line.strip().lstrip("﻿").split(",")]


def _check(headers: list[str]) -> tuple[list[str], list[str], list[str]]:
    """(keys two headers land on, schema keys no header reaches, keys not in
    the schema) -- all empty when the labels match the export."""
    keys = [spec.csv_header_to_key().get(h, h) for h in headers]
    schema = {f["key"] for f in spec._raw(SCHEMA_JSON)} - INTERNAL_COLUMNS
    collided = sorted({k for k in keys if keys.count(k) > 1})
    return collided, sorted(schema - set(keys)), sorted(set(keys) - schema)


def test_the_header_served_on_2026_09_10_reaches_every_column_once():
    assert _check(_headers(HEADER.read_text(encoding="utf-8"))) == ([], [], [])


def test_two_headers_landing_on_one_key_are_refused(monkeypatch):
    """The loss above was silent because a dict comprehension lets the second
    header overwrite the first. It has to be an error on the first page, not
    an empty column after seventeen hours."""
    monkeypatch.setattr(
        spec, "csv_header_to_key", lambda source=None: {"adresse_brut": "adresse_complete_brut"}
    )
    with pytest.raises(ValueError, match="adresse_complete_brut"):
        spec.rename_row(
            {
                "adresse_brut": "2 Allée des Lilas",
                "adresse_complete_brut": "2 Allée des Lilas 09300 VILLENEUVE D OLMES",
            }
        )


@pytest.mark.live
def test_the_vendored_labels_are_the_header_ademe_serves_today():
    """The pinned header above goes stale the day ADEME renames another
    column. This is the check that notices."""
    r = api._get(api.client(), f"{API}/lines", {"size": 1, "format": "csv"})
    assert _check(_headers(r.content.decode("utf-8-sig").splitlines()[0])) == ([], [], [])
