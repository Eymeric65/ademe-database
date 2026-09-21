"""Per-departement statistics, aggregated from the published `search/` tree.

The public pages carry counts and medians and nothing else -- no address, no
`numero_dpe`, no individual certificate -- so the aggregate is the whole of what
leaves the login gate (ADR-0012, ADR-0046). These tests pin the arithmetic on a
fixture whose every number is known by hand.

The fixture is thirteen certificates in departement 09, plus two partitions that
are not places:

  ten carry a class A-G, a plausible consumption and a surface;
  one carries `N`, which is not a class;
  one carries a consumption of 99 999 kWh/m2, which is not a consumption;
  one carries a surface of 0, which is not a surface.

Three of the ten answer to `FOIX` and two to `Foix` under one INSEE code. ADEME
does not normalise `nom_commune_ban` (ADR-0010, `tests/test_commune_variants.py`),
so grouping on the name would publish Foix twice at half its size each.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import duckdb
import pytest

from ademe import aggregate

# dept, insee, commune, etiquette_dpe, etiquette_ges, conso, surface, type, periode, date
ROWS_09 = (
    ("09122", "FOIX", "A", "B", 100.0, 40.0, "maison", "avant 1948", "2021-07-01"),
    ("09122", "FOIX", "C", "B", 120.0, 50.0, "maison", "avant 1948", "2021-09-01"),
    ("09122", "FOIX", "C", "C", 140.0, 60.0, "maison", "1948-1974", "2022-01-01"),
    ("09122", "Foix", "D", "C", 160.0, 70.0, "appartement", "1948-1974", "2022-06-01"),
    ("09122", "Foix", "D", "C", 180.0, 80.0, "appartement", "1948-1974", "2023-02-01"),
    ("09225", "Pamiers", "D", "D", 220.0, 90.0, "appartement", "1948-1974", "2023-05-01"),
    ("09225", "Pamiers", "F", "D", 240.0, 100.0, "maison", "avant 1948", "2024-03-01"),
    ("09225", "Pamiers", "F", "E", 260.0, 110.0, "maison", "avant 1948", "2024-08-01"),
    ("09225", "Pamiers", "F", "E", 280.0, 120.0, "immeuble", "2006-2012", "2025-01-01"),
    ("09004", "Ax-les-Thermes", "G", "G", 300.0, 130.0, "immeuble", "2006-2012", "2025-04-01"),
    # Not a class: other values exist in the column and are not grades.
    ("09283", "Tarascon-sur-Ariege", "N", "N", None, None, None, None, "2025-06-01"),
    # Not a consumption: a keying error, which would drag every quantile up.
    ("09283", "Tarascon-sur-Ariege", None, None, 99999.0, None, None, None, "2025-07-01"),
    # Not a surface.
    ("09283", "Tarascon-sur-Ariege", None, None, None, 0.0, None, None, "2025-08-01"),
)

ROWS_NG = (
    ("", None, "D", "D", 150.0, 75.0, "maison", "1948-1974", "2024-01-01"),
    ("", None, "E", "E", 250.0, 85.0, "maison", "1948-1974", "2024-02-01"),
)

ROWS_DOM = (
    ("97501", "Saint-Pierre", "C", "C", 130.0, 65.0, "maison", "1948-1974", "2024-04-01"),
    ("97601", "Mamoudzou", "B", "B", 110.0, 55.0, "maison", "1948-1974", "2024-05-01"),
)


def _value(v) -> str:
    return "NULL" if v is None else repr(v)


def _write(d: duckdb.DuckDBPyConnection, rows: tuple, path) -> None:
    """One `search/` partition, with the column names and types the export
    writes -- the aggregate reads no others."""
    path.parent.mkdir(parents=True, exist_ok=True)
    values = ", ".join(
        f"('2409E000{i:04d}', {_value(insee)}, {_value(nom)}, '1 rue de Test',"
        f" {_value(dpe)}, {_value(ges)}, DATE {date!r},"
        f" {_value(conso)}, {_value(surface)}, {_value(bat)}, {_value(periode)})"
        for i, (insee, nom, dpe, ges, conso, surface, bat, periode, date) in enumerate(rows)
    )
    d.execute(
        f"COPY (SELECT numero_dpe, code_insee_ban, nom_commune_ban, adresse_ban,"
        f" etiquette_dpe, etiquette_ges, date_etablissement_dpe,"
        f" CAST(conso AS DECIMAL(18,1)) AS conso_5_usages_par_m2_ep,"
        f" CAST(surface AS DECIMAL(18,1)) AS surface_habitable_logement,"
        f" type_batiment, periode_construction"
        f" FROM (VALUES {values}) AS t(numero_dpe, code_insee_ban, nom_commune_ban, adresse_ban,"
        f" etiquette_dpe, etiquette_ges, date_etablissement_dpe, conso, surface,"
        f" type_batiment, periode_construction))"
        f" TO '{path}' (FORMAT parquet)"
    )


def make_tree(root) -> None:
    """A v1/ tree carrying only the `search/` partitions and the manifest."""
    d = duckdb.connect()
    parts = []
    for dept, rows in (("09", ROWS_09), ("NG", ROWS_NG), ("DOM", ROWS_DOM)):
        path = f"search/dept={dept}/part-0000.parquet"
        _write(d, rows, root / path)
        parts.append({"dept": dept, "rows": len(rows), "search": {"path": path}})
    root.mkdir(parents=True, exist_ok=True)
    (root / "manifest.json").write_text(
        json.dumps(
            {
                "version": "v1",
                "built_at": "2026-09-11T04:15:59+00:00",
                "high_water": "2026-09-07",
                "partitions": parts,
            }
        )
    )


@pytest.fixture
def built(tmp_path):
    root = tmp_path / "v1"
    make_tree(root)
    return aggregate.aggregate(str(root))


def _dept(built, dept: str) -> dict:
    return built["departements"][dept]


def test_the_class_histogram_is_exactly_what_the_partition_holds(built):
    nine = _dept(built, "09")
    assert nine["certificates"] == 13
    assert nine["etiquette_dpe"] == {"A": 1, "B": 0, "C": 2, "D": 3, "E": 0, "F": 3, "G": 1}
    assert nine["etiquette_ges"] == {"A": 0, "B": 2, "C": 3, "D": 2, "E": 2, "F": 0, "G": 1}


def test_the_passoires_share_is_f_plus_g_over_the_classed_certificates(built):
    """The headline number. Three F and one G of ten graded certificates --
    the three ungraded rows are not in the denominator, because a certificate
    with no class is not a certificate that is not a passoire."""
    nine = _dept(built, "09")
    assert nine["passoires"] == {"count": 4, "classed": 10, "share": 0.4}


def test_the_quantiles_ignore_an_impossible_consumption(built):
    """With the 99 999 row counted, the median would be 220 instead of 200."""
    conso = _dept(built, "09")["conso_ep_kwh_m2"]
    assert conso == {"counted": 10, "p25": 145.0, "median": 200.0, "p75": 255.0}


def test_the_median_surface_ignores_a_surface_of_zero(built):
    assert _dept(built, "09")["surface_m2"] == {"counted": 10, "median": 85.0}


def test_one_commune_under_two_spellings_is_one_commune_with_the_modal_one(built):
    """`FOIX` three times and `Foix` twice, under 09122. Grouped on the name,
    Foix would appear twice at three and two -- behind Pamiers, which is
    smaller than it."""
    communes = _dept(built, "09")["communes"]
    assert communes[0] == {"code_insee": "09122", "nom": "FOIX", "count": 5}
    assert [c["code_insee"] for c in communes] == ["09122", "09225", "09283", "09004"]
    assert [c["nom"] for c in communes].count("Foix") == 0


def test_the_top_communes_list_is_capped(tmp_path):
    root = tmp_path / "v1"
    make_tree(root)
    built = aggregate.aggregate(str(root), top_communes=2)
    assert [c["code_insee"] for c in _dept(built, "09")["communes"]] == ["09122", "09225"]


def test_the_breakdowns_and_the_years_are_counted(built):
    nine = _dept(built, "09")
    assert nine["type_batiment"] == [
        {"label": "maison", "count": 5},
        {"label": "appartement", "count": 3},
        {"label": "immeuble", "count": 2},
    ]
    assert nine["periode_construction"] == [
        {"label": "1948-1974", "count": 4},
        {"label": "avant 1948", "count": 4},
        {"label": "2006-2012", "count": 2},
    ]
    assert nine["par_annee"] == [
        {"year": 2021, "count": 2},
        {"year": 2022, "count": 2},
        {"year": 2023, "count": 2},
        {"year": 2024, "count": 2},
        {"year": 2025, "count": 5},
    ]


def test_the_two_partitions_that_are_not_places_are_not_publishable(built):
    """`NG` is the ungeocoded pseudo-departement (ADR-0024) and `DOM` is four
    departements in one bucket. Neither is somewhere a page can be about."""
    assert _dept(built, "NG")["publishable"] is False
    assert _dept(built, "DOM")["publishable"] is False
    assert _dept(built, "09")["publishable"] is True


def test_the_national_total_counts_every_partition_including_those(built):
    """`publishable` governs which get a page, not which are counted: a
    national total that quietly dropped the ungeocoded would be wrong."""
    assert built["national"]["certificates"] == 17
    assert built["national"]["passoires"]["classed"] == 14


def test_the_stamp_comes_from_the_published_manifest(built):
    """The published tree runs months behind the recent window (ADR-0039), so
    the page has to be able to say as of when."""
    assert built["high_water"] == "2026-09-07"
    assert built["data_built_at"] == "2026-09-11T04:15:59+00:00"
    assert built["source"] == "existant"


def test_no_address_and_no_certificate_id_reach_the_output(built):
    """The whole reason the pages can be public. If a key or an address ever
    appears here, ADR-0012's gate has been walked around by the build."""
    text = json.dumps(built)
    assert "2409E000" not in text
    assert "rue de Test" not in text
    assert "numero_dpe" not in text
    assert "adresse" not in text


def test_the_cli_writes_the_json_where_it_is_told(tmp_path):
    """`--root` is a plain string, never a Path: `Path('https://x/v1')` would
    collapse to `https:/x/v1`."""
    root = tmp_path / "v1"
    make_tree(root)
    out = tmp_path / "seo" / "aggregates.json"
    assert aggregate.main(["--root", str(root), "--out", str(out)]) == 0
    assert json.loads(out.read_text())["departements"]["09"]["certificates"] == 13


# The aggregate itself is data: the weekly job builds it from the published tree
# and puts it on R2, and every build fetches it from there (ADR-0046). What the
# repository carries is a two-departement sample, so a build with no credentials
# -- CI's e2e job, a laptop -- still renders pages instead of none.
REPO_ROOT = Path(__file__).resolve().parent.parent
SAMPLE = REPO_ROOT / "src" / "seo" / "aggregates.sample.json"


def _sample() -> dict:
    return json.loads(SAMPLE.read_text(encoding="utf-8"))


def _tracked(path: str) -> bool:
    listed = subprocess.run(
        ["git", "ls-files", "--error-unmatch", path],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )
    return listed.returncode == 0


def test_the_aggregate_itself_is_never_committed():
    """357 kB of numbers that move every Monday. Committed, it is a dataset in
    git that only one machine can refresh; fetched, the build reads whatever the
    last weekly run published. See ADR-0046."""
    assert not _tracked("src/seo/aggregates.json"), "the aggregate is committed again"
    ignored = (REPO_ROOT / ".gitignore").read_text(encoding="utf-8")
    assert "src/seo/aggregates.json" in ignored, "nothing stops it being committed again"


def test_the_sample_is_a_fixture_and_not_a_dataset():
    """The point of the sample is that it is small enough to read. A sample that
    grew back to the full aggregate would have put the dataset back in git under
    another name."""
    assert _tracked("src/seo/aggregates.sample.json"), "the sample is not committed"
    assert SAMPLE.stat().st_size < 30_000, f"the sample is {SAMPLE.stat().st_size} bytes"
    assert _sample()["sample"] is True, "nothing marks the sample as a sample"


def test_the_sample_carries_the_pages_the_e2e_spec_opens():
    """09 Ariege and 31 Haute-Garonne by name: `test/e2e/seo.spec.ts` goes to
    both, and a build with no credentials is the build that spec runs against."""
    sample = _sample()
    assert set(sample["departements"]) == {"09", "31"}
    assert all(d["publishable"] for d in sample["departements"].values())


def test_the_sample_has_the_shape_the_module_produces(built):
    """Pinned against a real run rather than against a copy of the keys here: a
    field added to the aggregate and not to the sample is a field the offline
    build renders as undefined, and nothing else would catch it."""
    sample = _sample()
    assert set(sample) == set(built) | {"sample"}
    assert set(sample["national"]) == set(built["national"])
    for code, dept in sample["departements"].items():
        assert set(dept) == set(built["departements"]["09"]), code


def test_no_address_and_no_certificate_id_reach_the_sample():
    """The sample is committed, so the gate of
    `test_no_address_and_no_certificate_id_reach_the_output` has to hold for it
    too -- and here it holds over real ADEME rows, not the fixture's."""
    text = SAMPLE.read_text(encoding="utf-8")
    assert "numero_dpe" not in text
    assert "adresse" not in text
