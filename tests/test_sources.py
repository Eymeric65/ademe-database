"""A second dataset must be read with its own schema, from its own URL.

ADEME publishes the DPE family as separate Data Fair datasets -- existing
housing, new housing, tertiary, audits -- and the ETL was written against one of
them: `config.DATASET` was a constant, `spec` cached the one vendored schema and
`api` built every URL from the one `API`. Pointed at another dataset, none of it
would fail. It would fetch that dataset's rows and rename their CSV headers with
*existing housing's* labels, which is the `adresse_brut` swap documented in
`spec.csv_header_to_key`: values in the wrong columns, not missing ones.

So the source is a parameter everywhere a dataset is touched, defaulting to
existing housing so the running base build and every caller written before this
behave exactly as they did. See ADR-0017.
"""

from __future__ import annotations

import json

import httpx
import pytest

from ademe import api, config, mapping, spec
from ademe.config import EXISTANT, SOURCES, Source

# `adresse_brut` is the trap: in existing housing the HEADER `adresse_brut`
# carries the column keyed `adresse_complete_brut`. Here it means itself, so a
# rename done with the wrong schema moves the value into a different column.
FIELDS = [
    {"key": "numero_dpe", "label": "numero_dpe", "type": "string", "x-cardinality": 10},
    {"key": "surface_utile", "label": "surface_utile", "type": "number"},
    {"key": "adresse_brut", "label": "adresse_brut", "type": "string", "x-cardinality": 5_000_000},
]


@pytest.fixture
def other(tmp_path) -> Source:
    path = tmp_path / "other-schema.json"
    path.write_text(json.dumps(FIELDS))
    return Source(
        slug="other",
        dataset="other-dataset",
        schema_json=path,
        db_path=tmp_path / "other.sqlite",
        subdir="other",
        # No repeating groups and no address to deduplicate: three columns.
        mapping=mapping.Mapping(repeats=(), commune={}, adresse={}, adresse_brut={}),
    )


def test_spec_reads_the_schema_of_the_source_it_is_given(other):
    assert list(spec.load(source=other)) == ["numero_dpe", "surface_utile", "adresse_brut"]
    # The existing-housing schema is not displaced by having read another one:
    # the cache is per source, not the single slot it used to be.
    assert len(spec.load()) == len(json.loads(EXISTANT.schema_json.read_text()))
    assert "surface_utile" not in spec.load()


def test_headers_are_renamed_with_the_sources_own_labels(other):
    row = {"numero_dpe": "2409E0000001", "adresse_brut": "3 rue de Test"}
    assert spec.rename_row(row, source=other) == row
    # The same header means a different column in existing housing -- which is
    # exactly what the other source's rows would have been given before.
    assert spec.rename_row(row)["adresse_complete_brut"] == "3 rue de Test"


def _server(seen: list[httpx.Request]) -> httpx.Client:
    """A stand-in for Data Fair's three endpoints, recording what was asked."""

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if "/values/" in request.url.path:
            return httpx.Response(200, json=["09"])
        if request.url.params.get("size") == "0":
            return httpx.Response(200, json={"total": 1})
        return httpx.Response(200, text="numero_dpe,adresse_brut\n2409E0000001,3 rue de Test\n")

    return httpx.Client(transport=httpx.MockTransport(handle))


def test_the_api_asks_the_sources_own_dataset(other):
    seen: list[httpx.Request] = []
    cl = _server(seen)

    assert api.total(cl, source=other) == 1
    assert api.values(cl, "code_departement_ban", source=other) == ["09"]
    pages = list(api.iter_pages(cl, source=other))

    base = "/data-fair/api/v1/datasets/other-dataset/"
    assert [r.url.path for r in seen] == [
        base + "lines",
        base + "values/code_departement_ban",
        base + "lines",
    ]
    # Renamed with the other source's labels, so `adresse_brut` stays put.
    assert pages[0].rows == [{"numero_dpe": "2409E0000001", "adresse_brut": "3 rue de Test"}]


def test_existing_housing_is_still_the_default_everywhere():
    """The base build is running on these values; nothing here may move them."""
    assert config.DATASET == EXISTANT.dataset == "dpe03existant"
    assert config.API == EXISTANT.api == "https://data.ademe.fr/data-fair/api/v1/datasets/dpe03existant"
    assert config.SCHEMA_JSON == EXISTANT.schema_json
    assert EXISTANT.db_path == config.DEFAULT_DB
    # Its Parquet stays at the root of v1/, where the deployed app reads it.
    assert EXISTANT.subdir == ""


def test_no_two_sources_share_a_database_or_a_tree():
    """One SQLite file and one Parquet tree per source (ADR-0017).

    With one source this holds trivially; it binds the moment a second entry is
    added, which is when a copy-pasted `db_path` would send a new dataset into
    the existing-housing build and corrupt it.
    """
    assert all(key == s.slug for key, s in SOURCES.items())
    paths = [s.db_path for s in SOURCES.values()]
    subdirs = [s.subdir for s in SOURCES.values()]
    assert len(set(paths)) == len(paths)
    assert len(set(subdirs)) == len(subdirs)
