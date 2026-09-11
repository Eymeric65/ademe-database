"""The crosswalk: a certificate, the RNB building it names, the parcels under it.

Built from the published trees alone -- the certificates' `id_rnb`, RNB's
`plots`, the cadastre's parcel ids -- so it can be rebuilt by anyone holding the
files, and it joins in DuckDB exactly the way a reader will. See ADR-0021.

The fixture is four certificates, one for each outcome:

  2409E0000001  names a building on two parcels, one of which the cadastre edition lacks
  2409E0000002  names a building RNB does not know        -> unresolved
  2409E0000003  names no building                         -> no row (the BAN fallback's job)
  2409E0000004  names a building RNB lists without plots  -> resolved, no parcel

Two of the three that name a building resolve, which is below the production
floor on purpose -- the fixture exists to show every outcome -- so these builds
pass their own floor.
"""

from __future__ import annotations

import json

import duckdb
import pytest

from ademe import crosswalk

PLOTS = "STRUCT(id VARCHAR, bdg_cover_ratio DOUBLE)[]"
FLOOR = 0.5


def _write(d: duckdb.DuckDBPyConnection, sql: str, path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    d.execute(f"COPY ({sql}) TO '{path}' (FORMAT parquet)")


def _manifest(path, **body) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"version": "v1", "built_at": "2026-09-10T00:00:00+00:00", **body}))


def make_tree(root, *, rnb_dept: str = "09", buildings: bool = True) -> None:
    """A v1/ tree shaped like the published one, with only the columns the
    crosswalk reads."""
    d = duckdb.connect()
    _write(
        d,
        "SELECT * FROM (VALUES"
        " ('2409E0000001', 'RNBTWOPLOTS', '09001_0001'),"
        " ('2409E0000002', 'RNBUNKNOWN0', '09001_0002'),"
        " ('2409E0000003', NULL,          '09001_0003'),"
        " ('2409E0000004', 'RNBNOPLOTS0', '09001_0004'))"
        " AS t(numero_dpe, id_rnb, identifiant_ban)",
        root / "dpe" / "dept=09" / "part-0000.parquet",
    )
    _manifest(
        root / "manifest.json",
        partitions=[{"dept": "09", "rows": 4, "dpe": {"path": "dpe/dept=09/part-0000.parquet"}}],
    )

    rows = (
        "('RNBTWOPLOTS', [{'id': '090010000A0001', 'bdg_cover_ratio': 0.9},"
        f"                {{'id': '090010000A0002', 'bdg_cover_ratio': 0.1}}]::{PLOTS}),"
        f" ('RNBNOPLOTS0', NULL::{PLOTS})"
        if buildings
        else f"('RNBSOMEONE0', NULL::{PLOTS})"
    )
    _write(
        d,
        f"SELECT * FROM (VALUES {rows}) AS t(rnb_id, plots)",
        root / "rnb" / f"dept={rnb_dept}" / "part-0000.parquet",
    )
    _manifest(root / "rnb" / "manifest.json", source="rnb", partitions=[{"dept": rnb_dept, "rows": 2}])

    # 090010000A0002 is absent: RNB and the cadastre are different vintages.
    _write(
        d,
        "SELECT '090010000A0001' AS id, '09001' AS commune, 535::BIGINT AS contenance",
        root / "cadastre" / "dept=09" / "part-0000.parquet",
    )
    _manifest(root / "cadastre" / "manifest.json", source="cadastre", partitions=[{"dept": "09", "rows": 1}])


def _rows(root) -> set[tuple]:
    d = duckdb.connect()
    return set(
        d.execute(
            "SELECT source, record_key, rnb_id, match_method, parcel_id, bdg_cover_ratio"
            f" FROM read_parquet('{root / 'crosswalk' / 'dept=09' / 'part-0000.parquet'}')"
        ).fetchall()
    )


@pytest.fixture
def built(tmp_path):
    root = tmp_path / "v1"
    make_tree(root)
    return root, crosswalk.build(root, min_resolved=FLOOR)


def test_every_outcome_gets_exactly_its_rows(built):
    root, _manifest = built
    assert _rows(root) == {
        ("existant", "2409E0000001", "RNBTWOPLOTS", "id_rnb", "090010000A0001", 0.9),
        ("existant", "2409E0000001", "RNBTWOPLOTS", "id_rnb", "090010000A0002", 0.1),
        ("existant", "2409E0000002", "RNBUNKNOWN0", "unresolved", None, None),
        ("existant", "2409E0000004", "RNBNOPLOTS0", "id_rnb", None, None),
    }


def test_coverage_is_counted_and_matches_the_files(built):
    root, manifest = built
    assert manifest["coverage"] == {
        "certificates": 4,
        "with_id_rnb": 3,
        "resolved": 2,
        "with_parcel": 1,
        "parcel_in_cadastre": 1,
    }
    assert manifest["partitions"][0]["rows"] == len(_rows(root))
    assert json.loads((root / "crosswalk" / "manifest.json").read_text()) == manifest


def test_a_building_in_another_departements_file_still_resolves(tmp_path):
    """A certificate near a border can name a building RNB files under the
    neighbouring département. Joining partition to partition would call it
    unresolved."""
    root = tmp_path / "v1"
    make_tree(root, rnb_dept="31")
    crosswalk.build(root, min_resolved=FLOOR)
    methods = {r[1]: r[3] for r in _rows(root)}
    assert methods["2409E0000001"] == "id_rnb"


def test_an_rnb_tree_that_resolves_nothing_refuses_to_publish(tmp_path):
    """An empty or stale RNB tree would publish a crosswalk saying every
    certificate's building is unknown -- green, and wrong."""
    root = tmp_path / "v1"
    make_tree(root)
    first = crosswalk.build(root, min_resolved=FLOOR)
    published = (root / "crosswalk" / "manifest.json").read_text()

    make_tree(root, buildings=False)
    with pytest.raises(ValueError, match="resolve"):
        crosswalk.build(root, min_resolved=FLOOR)
    assert (root / "crosswalk" / "manifest.json").read_text() == published
    assert json.loads(published) == first


def test_the_production_floor_is_not_the_fixtures():
    """The floor above is loosened for a four-row fixture; the one the weekly
    build uses must stay strict. Département 09 resolves 99.69%."""
    assert crosswalk.MIN_RESOLVED >= 0.95


def test_the_manifest_names_the_inputs_it_was_built_from(built):
    root, manifest = built
    inputs = manifest["inputs"]
    assert set(inputs) == {"existant", "rnb", "cadastre"}
    for name, sub in (("existant", ""), ("rnb", "rnb"), ("cadastre", "cadastre")):
        path = root / sub / "manifest.json"
        assert inputs[name]["sha256"] == crosswalk._sha256(path)
        assert inputs[name]["built_at"] == "2026-09-10T00:00:00+00:00"
