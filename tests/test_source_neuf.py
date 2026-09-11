"""New housing, the second ADEME source.

`dpe02neuf` publishes 1 424 502 certificates in 212 columns: 210 of existing
housing's, two of its own (`deperditions_totales_batiment`, `_logement`), and
not the other 20. It is built in its own database, published under `v1/neuf/`,
and renamed with its own labels -- eight of which are not its keys
(`conso_5 usages_ef`, `Conso_ecs_ef_energie_n2`), because that is what its
export serves. See ADR-0025.
"""

from __future__ import annotations

import csv
import io
from pathlib import Path

import pytest

from ademe import api, db, export_parquet, ingest, mapping, reconstruct, schema, spec
from ademe.config import SOURCES
from tests.test_export_parquet import SCALES, _equal, _row

# The header line of `dpe02neuf/lines?format=csv`, as served on 2026-09-10.
HEADER = Path(__file__).parent / "fixtures" / "dpe02neuf-csv-header-2026-09-10.txt"

NEW_COLUMNS = {"deperditions_totales_batiment", "deperditions_totales_logement"}


def _reaches_every_column_once(headers: list[str]) -> bool:
    neuf = SOURCES["neuf"]
    to_key = spec.csv_header_to_key(neuf)
    keys = [to_key.get(h, h) for h in headers]
    wanted = {f["key"] for f in spec._raw(neuf.schema_json)} - neuf.mapping.internal
    return len(set(keys)) == len(keys) and set(keys) == wanted


def test_new_housing_is_a_source_of_its_own():
    neuf = SOURCES["neuf"]
    assert (neuf.dataset, neuf.subdir, neuf.db_path.name) == ("dpe02neuf", "neuf", "ademe-neuf.sqlite")
    assert neuf.db_path != SOURCES["existant"].db_path


def test_every_new_housing_column_has_a_place():
    neuf = SOURCES["neuf"]
    cov = mapping.check_coverage(list(spec.load(source=neuf)), neuf.mapping)
    assert NEW_COLUMNS <= set(cov.dpe)


def test_the_vendored_labels_are_the_header_new_housing_served():
    line = HEADER.read_text(encoding="utf-8-sig")
    assert _reaches_every_column_once(next(csv.reader(io.StringIO(line))))


@pytest.mark.live
def test_the_vendored_labels_are_the_header_new_housing_serves_today():
    r = api._get(api.client(), f"{SOURCES['neuf'].api}/lines", {"size": 1, "format": "csv"})
    assert _reaches_every_column_once(next(csv.reader(io.StringIO(r.content.decode("utf-8-sig")))))


def test_its_search_index_is_declared_and_its_columns_exist():
    columns, sort = export_parquet.SEARCH["neuf"]
    have = set(spec.load(source=SOURCES["neuf"])) | {"lat", "lon"}
    assert set(columns) <= have and set(sort) <= set(columns)


def test_a_new_housing_certificate_round_trips(tmp_path):
    neuf = SOURCES["neuf"]
    path = tmp_path / "neuf.sqlite"
    schema.build(path, scales=SCALES, source=neuf)
    conn = db.connect(path, bulk=True)
    row = _row(
        "2409N0000001",
        "09001",
        "09",
        deperditions_totales_batiment="1234",
        deperditions_totales_logement="567",
    )
    ingest.Loader(conn, spec.load(SCALES, source=neuf), source=neuf).load_page([row])
    conn.commit()

    rebuilt = reconstruct.Reconstructor(conn, source=neuf).row("2409N0000001")
    numeric = {
        r[0] for r in conn.execute("SELECT column_name FROM column_meta WHERE encoding IN ('scaled','int')")
    }
    assert all(_equal(k, v, rebuilt[k], numeric) for k, v in row.items()), {
        k: (v, rebuilt[k]) for k, v in row.items() if not _equal(k, v, rebuilt[k], numeric)
    }

    export_parquet.export(path, tmp_path / "out", source=neuf)
    published = export_parquet.read_rows(tmp_path / "out" / "v1" / "neuf", ["2409N0000001"])["2409N0000001"]
    bad = [c for c, v in rebuilt.items() if not _equal(c, v, published.get(c, ""), numeric)]
    assert not bad, bad[:10]
    assert published["deperditions_totales_batiment"] == "1234"
