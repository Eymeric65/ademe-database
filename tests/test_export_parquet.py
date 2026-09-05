"""The published files have to be the same data, not nearly the same data.

`tests/test_roundtrip.py` settles that for SQLite. This settles it for the
Parquet, which is what the browser actually reads -- a green database and a
lossy export are compatible states, and the export is where a DECIMAL scale or
a vocabulary join can quietly drop a value.
"""

from __future__ import annotations

from decimal import Decimal, InvalidOperation

import duckdb
import pytest

from ademe import db, export_parquet, geo, ingest, schema, spec

# Real certificates, with ADEME's own `_geopoint` beside the Lambert-93 pair it
# is derived from. Fetched once from the live API and pinned here so the
# projection has ground truth offline.
# Real scales, as `ademe.scales` discovered them against the live dataset.
# schema.build without these makes every numeric column an unscaled INTEGER,
# which is lossy for decimals -- and would make the round-trip assertion below
# pass against a fixture that could not represent 117.1 in the first place.
SCALES = {
    "conso_5_usages_par_m2_ep": 10,
    "emission_ges_5_usages_par_m2": 10,
    "surface_habitable_logement": 10,
    "conso_5_usages_ef_energie_n1": 10,
    "conso_5_usages_ef_energie_n3": 10,
    "coordonnee_cartographique_x_ban": 10**6,
    "coordonnee_cartographique_y_ban": 10**6,
}

# Enough to span more than one 2048-row Parquet row group; see `exported`.
FIXTURE_ROWS = 5000

GEO_FIXTURES = [
    ("2609E0061365T", 604356.72, 6202312.65, 42.91384797010697, 1.8297960439175422),
    ("2609E0004862O", 568748.21, 6239000.45, 43.238121027238755, 1.385047942798267),
    ("2609E0036923R", 601292.07, 6182507.62, 42.7353659586826, 1.7960000110907162),
]


def _equal(col: str, want: str, got: str, numeric: set[str]) -> bool:
    """The same contract tests/test_roundtrip.py uses: text byte-exact,
    numbers by value, because ADEME writes `38` and `117.1` in one column."""
    want, got = want or "", got or ""
    if want == got:
        return True
    if col in numeric and want and got:
        try:
            return Decimal(want) == Decimal(got)
        except InvalidOperation:
            return False
    return False


def _row(numero: str, insee: str, dept: str, **over) -> dict:
    return {
        "numero_dpe": numero,
        "code_insee_ban": insee,
        "code_departement_ban": dept,
        "code_postal_ban": f"{dept}000",
        "nom_commune_ban": "Foix" if dept == "09" else "Saint-Pierre",
        "adresse_ban": "1 rue de Test",
        "identifiant_ban": f"ban-{insee}-1",
        "nom_rue_ban": "rue de Test",
        "numero_voie_ban": "1",
        "etiquette_dpe": "D",
        "etiquette_ges": "C",
        "date_etablissement_dpe": "2024-03-11",
        # The incremental key the weekly delta resumes from (ADR-0005).
        "date_derniere_modification_dpe": "2024-04-02",
        # 117.1 and 38 in one column: the variable-decimals case the whole
        # scaled-integer encoding has to survive.
        "conso_5_usages_par_m2_ep": "117.1",
        "emission_ges_5_usages_par_m2": "38",
        "surface_habitable_logement": "78.5",
        "type_batiment": "maison",
        "periode_construction": "1948-1974",
        "annee_construction": "1960",
        # Full Lambert-93 precision -- six decimals, the case that made
        # "too precise to scale" fall back to TEXT rather than truncate.
        "coordonnee_cartographique_x_ban": "604356.720000",
        "coordonnee_cartographique_y_ban": "6202312.650000",
        # A repeating group occupying slots n1 and n3 but not n2.
        "type_energie_n1": "Electricite",
        "conso_5_usages_ef_energie_n1": "8000",
        "type_energie_n3": "Bois",
        "conso_5_usages_ef_energie_n3": "1200",
        **over,
    }


@pytest.fixture
def exported(tmp_path, monkeypatch):
    """A small database across two partitions, exported.

    5000 certificates rather than six: the search file's sort order is only
    checkable across more than one row group, a single-group assertion would
    pass no matter how the rows were ordered, and DuckDB rounds ROW_GROUP_SIZE
    up to a 2048-row vector boundary -- so a small fixture cannot produce two
    groups at any setting.
    """
    path = tmp_path / "t.sqlite"
    schema.build(path, scales=SCALES)
    conn = db.connect(path, bulk=True)
    cols = spec.load(SCALES)
    loader = ingest.Loader(conn, cols)

    rows = []
    for i in range(FIXTURE_ROWS):
        # Descending postcodes on the way in, so a sorted file cannot be an
        # accident of insertion order.
        rows.append(
            _row(
                f"2409E{i:07d}",
                "09001",
                "09",
                code_postal_ban=f"09{(FIXTURE_ROWS - i) % 1000:03d}",
                surface_habitable_logement=str(50 + i),
            )
        )
    # Two certificates at one address -- the dedup path.
    rows.append(_row("2409E9000001", "09001", "09"))
    rows.append(_row("2409E9000002", "09001", "09"))
    # A second partition, and one that has to merge into DOM.
    rows.append(_row("2497E0000001", "97701", "977"))
    rows.append(_row("2497E0000002", "97701", "977"))

    # A value with one more decimal than its column's declared scale, so it
    # cannot round-trip through the integer and lands in scale_violation.
    column = "conso_5_usages_par_m2_ep"
    scale = conn.execute(
        "SELECT scale FROM column_meta WHERE column_name = ?", (column,)
    ).fetchone()[0]
    assert scale > 1, "the fixture needs a scaled column to violate"
    places = len(str(scale))  # one decimal more than the scale can hold
    violating = "1." + "0" * (places - 1) + "7"
    rows.append(_row("2409E9000003", "09001", "09", **{column: violating}))

    loader.load_page(rows)
    conn.commit()

    # 50k rows to a group would put this whole fixture in one, and a
    # single-group file says nothing about whether the sort worked.
    monkeypatch.setattr(export_parquet, "SEARCH_ROW_GROUP", 2048)

    out = tmp_path / "out"
    manifest = export_parquet.export(path, out)
    yield conn, out / export_parquet.VERSION, manifest, (column, violating)
    conn.close()


def test_every_column_of_every_row_survives_the_export(exported):
    """(a) The losslessness claim, for the files the browser reads."""
    conn, root, _manifest, _ = exported
    from ademe import reconstruct

    numeric = {
        r[0]
        for r in conn.execute(
            "SELECT column_name FROM column_meta WHERE encoding IN ('scaled','int')"
        )
    }
    numeros = [r[0] for r in conn.execute("SELECT numero_dpe FROM dpe")]
    published = export_parquet.read_rows(root, numeros)
    assert len(published) == len(numeros)

    rec = reconstruct.Reconstructor(conn)
    mismatches, compared = [], 0
    for numero in numeros:
        want = rec.row(numero)
        got = published[numero]
        for col, value in want.items():
            compared += 1
            if not _equal(col, value, got.get(col, ""), numeric):
                mismatches.append(f"{numero}.{col}: sqlite={value!r} parquet={got.get(col)!r}")
    assert compared > 5000, f"only {compared} fields compared -- too weak to mean anything"
    assert not mismatches, f"{len(mismatches)} of {compared}:\n  " + "\n  ".join(mismatches[:20])


def test_search_file_has_exactly_the_declared_columns_and_is_sorted(exported):
    """(b) The search index is the file every query touches; a wrong column set
    is a silent full-file read, and a wrong sort order defeats the row-group
    statistics the whole layout is built on."""
    _conn, root, _manifest, _ = exported
    d = duckdb.connect()
    path = root / "search" / "dept=09" / "part-0000.parquet"

    names = [
        r[0]
        for r in d.execute(
            # The root element carries num_children; leaves carry a type.
            f"SELECT name FROM parquet_schema('{path}') WHERE type IS NOT NULL"
        ).fetchall()
    ]
    assert names == list(export_parquet.SEARCH_COLUMNS)

    values = [
        r[0]
        for r in d.execute(
            f"SELECT code_postal_ban FROM read_parquet('{path}')"
        ).fetchall()
    ]
    assert values == sorted(values), "the search file is not sorted by its first sort key"

    groups = d.execute(
        f"SELECT row_group_id, stats_min_value FROM parquet_metadata('{path}')"
        " WHERE path_in_schema = 'code_postal_ban' ORDER BY row_group_id"
    ).fetchall()
    assert len(groups) > 1, "one row group proves nothing about ordering"
    mins = [g[1] for g in groups]
    assert mins == sorted(mins), f"row-group minima are not monotonic: {mins}"


def test_manifest_counts_match_the_database(exported):
    """(c)"""
    conn, _root, manifest, _ = exported
    by_part = {p["dept"]: p["rows"] for p in manifest["partitions"]}
    assert set(by_part) == {"09", "DOM"}, by_part
    assert sum(by_part.values()) == conn.execute("SELECT COUNT(*) FROM dpe").fetchone()[0]
    assert by_part["DOM"] == 2, "975/976/977/978 merge into one partition"
    assert manifest["high_water"], "the delta has nothing to resume from without this"


def test_a_value_too_precise_to_scale_comes_back_verbatim(exported):
    """(d) The side file, and the reason it exists.

    A value the declared scale cannot hold is stored raw rather than rounded.
    If the export dropped that copy, the published row would carry the
    ROUNDED number and nothing would say so.
    """
    conn, root, _manifest, (column, raw) = exported
    assert conn.execute("SELECT COUNT(*) FROM scale_violation").fetchone()[0] > 0

    got = export_parquet.read_rows(root, ["2409E9000003"])["2409E9000003"]
    assert got[column] == raw, f"{column} came back as {got[column]!r}, not the raw {raw!r}"


def test_numero_exceptions_lists_what_the_substring_shortcut_would_miss(exported):
    """PR11's detail view finds a partition from numero_dpe[2:4]. Anything that
    rule gets wrong has to be listed, or that certificate becomes unreachable."""
    _conn, root, _manifest, _ = exported
    d = duckdb.connect()
    rows = d.execute(
        f"SELECT numero_dpe, dept FROM read_parquet('{root}/index/numero-exceptions.parquet')"
    ).fetchall()
    # The DOM certificates are numbered 2497E..., so '97' != 'DOM'.
    assert {r[1] for r in rows} == {"DOM"}
    assert len(rows) == 2


@pytest.mark.parametrize("numero,x,y,lat,lon", GEO_FIXTURES)
def test_lambert93_inverse_matches_ademes_own_geopoint(numero, x, y, lat, lon):
    """The projection is inverted in Python rather than through DuckDB's
    spatial extension (ADR-0006), so it needs ground truth of its own. These
    are real certificates; `_geopoint` is ADEME's WGS84 for the same row.
    """
    glat, glon = geo.to_wgs84(x, y)
    assert abs(glat - lat) < 1e-9, f"{numero} latitude off by {abs(glat - lat):.2e}"
    assert abs(glon - lon) < 1e-9, f"{numero} longitude off by {abs(glon - lon):.2e}"


# --- coordinates outside Lambert-93's domain --------------------------------

# Measured from the live API. ADEME publishes `_geopoint` for these by applying
# the Lambert-93 inverse to coordinates that are NOT in Lambert-93 -- the
# overseas departements use local UTM zones -- so their own values land on the
# wrong continent. The x/y here are real; the "ademe_says" column is what their
# _geopoint returns for that row.
OVERSEAS = [
    ("971", 653431.02, 1774592.38, (6.12, 2.66)),      # Guadeloupe -> Benin
    ("972", 719680.07, 1601062.96, (4.87, 3.14)),      # Martinique -> Gulf of Guinea
    ("973", 351398.0, 516336.1, (-2.59, 0.73)),        # Guyane -> Atlantic
    ("974", 320828.97, 7676122.5, (56.01, -3.00)),     # Reunion -> Scotland
    ("976", 521607.39, 8583361.04, (63.99, -0.46)),    # Mayotte -> Norway
]


@pytest.mark.parametrize("dept,x,y,ademe_says", OVERSEAS)
def test_overseas_coordinates_are_published_as_null_not_as_the_wrong_continent(
    dept, x, y, ademe_says
):
    """A pin on the wrong continent is worse than no pin.

    `geo.to_wgs84` is the Lambert-93 inverse and is correct for metropolitan
    France to ~1e-13 degrees. Applied to a UTM 20N/22N/40S coordinate it
    returns a plausible-looking number that is thousands of kilometres wrong --
    which is exactly what ADEME's own `_geopoint` does for these departements.
    Reproducing their arithmetic would be lossless and useless.
    """
    assert not geo.is_lambert93(dept), f"{dept} is not metropolitan France"

    # The bug being avoided: the transform does run, and does return the same
    # wrong answer ADEME publishes. Nothing here is hypothetical.
    wrong_lat, wrong_lon = geo.to_wgs84(x, y)
    assert abs(wrong_lat - ademe_says[0]) < 0.01
    assert abs(wrong_lon - ademe_says[1]) < 0.01

    assert geo.wgs84_for(dept, x, y) == (None, None)


def test_metropolitan_coordinates_are_still_derived():
    """The other half: the guard must not blank the 99.94% that are correct."""
    for dept in ("09", "75", "2A", "2B"):
        assert geo.is_lambert93(dept)
    lat, lon = geo.wgs84_for("09", 604356.72, 6202312.65)
    # Rounded to the DECIMAL(10,6) the column declares -- about 0.1 m. The
    # projection itself agrees with ADEME to ~1e-13; this bound is the storage
    # precision, not the arithmetic's.
    assert lat is not None and abs(lat - 42.91384797010697) < 1e-6
    assert lon is not None and abs(lon - 1.8297960439175422) < 1e-6
