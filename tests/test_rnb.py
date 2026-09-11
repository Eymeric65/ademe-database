"""RNB, published as Parquet: the buildings a certificate's `id_rnb` names.

The RNB (Référentiel National des Bâtiments) is what joins a DPE to the
cadastre: ADEME fills `id_rnb` on about half the certificates, and each RNB
building lists the parcels it stands on and the BAN addresses it carries. The
weekly export is a CSV per département, most of whose bytes are the building
polygon. We keep everything except that polygon and the validator's identity.

What is kept must be exactly what RNB published. The three lines below are real
(RNB_09, 2026-09-05), chosen for the shapes that go wrong: several plots and
addresses with `street_rep` both `""` and `null`; no plots at all (an empty
field, not `[]`); and no external ids (`[]`, not empty) with a cover ratio of
1.0000000000000002, which a float formatted along the way would round.
See ADR-0019.
"""

from __future__ import annotations

import csv
import io
import json
import sys
import zipfile

import duckdb
import httpx
import pytest

from ademe import api, rnb

HEADER = "rnb_id;point;shape;status;ext_ids;addresses;plots;validated_by\n"
RICH = (
    'WHN8D9K38QNG;"SRID=4326;POINT(1.83931465039422 42.73115938000424)";"SRID=4326;MULTIPOLYGON(((1.839204876712718 42.731152360080934,1.839265600781804 42.73122675465613,1.839421713414075 42.73116639992756,1.839393736225111 42.73110135256343,1.839344615952824 42.73111790553044,1.839339845543131 42.7311124584841,1.839323866660139 42.731118579893085,1.839314307918564 42.73110858482896,1.839262730705423 42.731126010357144,1.839265062124238 42.731131430973925,1.839204876712718 42.731152360080934)))";constructed;'
    '"[{""id"": ""bdnb-bc-PEZ4-CYLL-TJZ4"", ""source"": ""bdnb"", ""created_at"": ""2023-12-07T14:13:59.518719+00:00"", ""source_version"": ""2023_01""}, {""id"": ""BATIMENT0000002202818378"", ""source"": ""bdtopo"", ""created_at"": ""2023-12-21T15:48:00.433247+00:00"", ""source_version"": ""bdtopo_2023_09""}]";'
    '"[{""cle_interop_ban"" : ""09140_0025_00013"", ""street_number"" : ""13"", ""street_rep"" : """", ""street"" : ""chemin de la coumeille"", ""city_zipcode"" : ""09110"", ""city_name"" : ""Ignaux""}, {""cle_interop_ban"" : ""09140_2c2gpg_00002_ter"", ""street_number"" : ""2"", ""street_rep"" : ""ter"", ""street"" : ""chemin de Lacoumelle"", ""city_zipcode"" : ""09110"", ""city_name"" : ""Ignaux""}, {""cle_interop_ban"" : ""09140_2c2gpg_00002"", ""street_number"" : ""2"", ""street_rep"" : null, ""street"" : ""chemin de Lacoumelle"", ""city_zipcode"" : ""09110"", ""city_name"" : ""Ignaux""}]";'
    '"[{""id"" : ""091400000C1069"", ""bdg_cover_ratio"" : 0.9135327992473545}, {""id"" : ""091400000C1030"", ""bdg_cover_ratio"" : 0.086467200752188}]";[]\n'
)
NO_PLOTS = (
    'ZQP5VP4WN6BX;"SRID=4326;POINT(1.488013408784226 43.197545719758395)";"SRID=4326;MULTIPOLYGON(((1.48792065497964 43.19748010023919,1.48798045607057 43.197638378344024,1.488105363537081 43.1976113392776,1.48804683845786 43.197451279810714,1.48792065497964 43.19748010023919)))";constructed;'
    '"[{""id"": ""bdnb-bc-3KA3-YRD3-E5EJ"", ""source"": ""bdnb"", ""created_at"": ""2023-12-07T14:13:50.300074+00:00"", ""source_version"": ""2023_01""}]";'
    '"[{""cle_interop_ban"" : ""09109_y883i1_00065"", ""street_number"" : ""65"", ""street_rep"" : """", ""street"" : ""anglats"", ""city_zipcode"" : ""09130"", ""city_name"" : ""Durfort""}]";;[]\n'
)
NO_EXT_IDS = (
    'NTXFHPYC6CRC;"SRID=4326;POINT(1.40723681684196 43.16984785)";"SRID=4326;POLYGON((1.4072516 43.169927,1.4073379 43.1698805,1.4072232 43.1697681,1.407135 43.1698152,1.4072516 43.169927))";constructed;[];'
    '"[{""cle_interop_ban"" : ""09124_a025_00010"", ""street_number"" : ""10"", ""street_rep"" : null, ""street"" : ""Lot la Fontaine de Peybroc"", ""city_zipcode"" : ""09130"", ""city_name"" : ""Le Fossat""}, {""cle_interop_ban"" : ""09124_if5hpk_00010"", ""street_number"" : ""10"", ""street_rep"" : """", ""street"" : ""Impasse de la Fontaine de Peybroc"", ""city_zipcode"" : ""09130"", ""city_name"" : ""Le Fossat""}]";'
    '"[{""id"" : ""09124000ZI0097"", ""bdg_cover_ratio"" : 1.0000000000000002}]";[]\n'
)
LINES = [RICH, NO_PLOTS, NO_EXT_IDS]
NESTED = ("ext_ids", "addresses", "plots")


def _zip(text: str, member: str = "RNB_09.csv") -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(member, text)
    return buf.getvalue()


def _source_rows(text: str) -> dict[str, dict[str, str]]:
    csv.field_size_limit(sys.maxsize)
    return {r["rnb_id"]: r for r in csv.DictReader(io.StringIO(text), delimiter=";")}


def _published(path) -> dict[str, dict]:
    d = duckdb.connect()
    cols = ", ".join(
        f"to_json({c})::VARCHAR AS {c}" if c in NESTED else c for c in rnb.KEPT
    )
    cur = d.execute(f"SELECT {cols} FROM read_parquet('{path}')")
    names = [c[0] for c in cur.description]
    return {r[0]: dict(zip(names, r)) for r in cur.fetchall()}


def _parsed(value: str | None):
    """RNB's JSON has spaces around its colons; what must match is the value."""
    return None if value in (None, "") else json.loads(value)


@pytest.fixture
def converted(tmp_path):
    text = HEADER + "".join(LINES)
    src = tmp_path / "RNB_09.csv"
    src.write_text(text, encoding="utf-8")
    out = tmp_path / "rnb.parquet"
    rows = rnb.convert(src, out)
    return text, out, rows


def test_every_kept_field_of_every_line_survives(converted):
    text, out, rows = converted
    want, got = _source_rows(text), _published(out)
    assert rows == len(want) == len(got) == 3
    compared = 0
    for rid, src in want.items():
        for col in rnb.KEPT:
            compared += 1
            if col in NESTED:
                assert _parsed(got[rid][col]) == _parsed(src[col]), f"{rid}.{col}"
            else:
                assert got[rid][col] == src[col], f"{rid}.{col}"
    assert compared == 18


def test_the_polygon_and_the_validator_are_not_published(converted):
    _text, out, _rows = converted
    d = duckdb.connect()
    names = [r[0] for r in d.execute(f"DESCRIBE SELECT * FROM read_parquet('{out}')").fetchall()]
    assert names == list(rnb.KEPT)


def test_no_plots_stays_absent_and_no_ids_stays_empty(converted):
    """Two different states in the source, and a join treats them differently:
    an empty field is 'RNB does not know', `[]` is 'there are none'."""
    _text, out, _rows = converted
    got = _published(out)
    assert got["ZQP5VP4WN6BX"]["plots"] is None
    assert got["NTXFHPYC6CRC"]["ext_ids"] == "[]"


@pytest.mark.parametrize(
    "text, complaint",
    [
        (HEADER.replace(";validated_by", ";validated_by;height"), "header"),
        (HEADER + NO_PLOTS.replace('""city_name""', '""street_type"" : ""x"", ""city_name""'), "street_type"),
    ],
    ids=["a new column", "a new key inside addresses"],
)
def test_a_new_field_upstream_fails_instead_of_vanishing(tmp_path, text, complaint):
    """`json_transform` drops a key it was not told about, without a word, and
    a SELECT of the known columns drops a new one. Either would publish less
    than RNB did while every other test stayed green."""
    src = tmp_path / "RNB_09.csv"
    src.write_text(text, encoding="utf-8")
    with pytest.raises(ValueError, match=complaint):
        rnb.convert(src, tmp_path / "out.parquet")


class Server:
    """The S3 bucket RNB publishes to, honouring If-None-Match."""

    def __init__(self, body: bytes, etag: str):
        self.body, self.etag, self.requests = body, etag, []

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.headers.get("if-none-match") == self.etag:
            return httpx.Response(304)
        return httpx.Response(
            200,
            content=self.body,
            headers={"etag": self.etag, "last-modified": "Sat, 05 Sep 2026 03:59:22 GMT"},
        )

    def client(self) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self.handle))


def test_a_departement_is_fetched_only_when_it_changed(tmp_path):
    out = tmp_path / "out"
    server = Server(_zip(HEADER + "".join(LINES)), '"e1"')

    first = rnb.build(out, ["09"], client=server.client())
    part = out / "v1" / "rnb" / "dept=09" / "part-0000.parquet"
    assert first["partitions"] == [
        {
            "dept": "09",
            "rows": 3,
            "etag": '"e1"',
            "last_modified": "Sat, 05 Sep 2026 03:59:22 GMT",
            "sha256": first["partitions"][0]["sha256"],
        }
    ]
    written = part.read_bytes()

    # Unchanged upstream: asked conditionally, answered 304, nothing rewritten.
    again = rnb.build(out, ["09"], client=server.client())
    assert server.requests[-1].headers["if-none-match"] == '"e1"'
    assert part.read_bytes() == written
    assert again["partitions"] == first["partitions"]

    # Changed upstream: the whole partition is replaced.
    server.body, server.etag = _zip(HEADER + RICH), '"e2"'
    third = rnb.build(out, ["09"], client=server.client())
    assert third["partitions"][0]["etag"] == '"e2"'
    assert third["partitions"][0]["rows"] == 1
    assert len(_published(part)) == 1


def test_a_failed_departement_leaves_the_published_manifest_alone(tmp_path):
    out = tmp_path / "out"
    good = Server(_zip(HEADER + "".join(LINES)), '"e1"')
    rnb.build(out, ["09"], client=good.client())
    manifest = out / "v1" / "rnb" / "manifest.json"
    before = manifest.read_text()

    def handle(request: httpx.Request) -> httpx.Response:
        if "RNB_2A" in request.url.path:
            return httpx.Response(503)
        return good.handle(request)

    broken = httpx.Client(transport=httpx.MockTransport(handle))
    with pytest.raises(httpx.HTTPStatusError):
        rnb.build(out, ["09", "2A"], client=broken)
    assert manifest.read_text() == before


def test_a_partial_build_keeps_the_departements_it_did_not_touch(tmp_path):
    out = tmp_path / "out"
    rnb.build(out, ["09"], client=Server(_zip(HEADER + "".join(LINES)), '"e1"').client())
    both = rnb.build(
        out, ["2A"], client=Server(_zip(HEADER + RICH, "RNB_2A.csv"), '"a1"').client()
    )
    assert [p["dept"] for p in both["partitions"]] == ["09", "2A"]


def test_the_departements_are_read_from_the_catalogue():
    resources = [
        {"url": "https://rnb-opendata.s3.fr-par.scw.cloud/files/RNB_09.csv.zip"},
        {"url": "https://rnb-opendata.s3.fr-par.scw.cloud/files/RNB_2A.csv.zip"},
        {"url": "https://rnb-opendata.s3.fr-par.scw.cloud/files/RNB_974.csv.zip"},
        # The national file is every département again, 11.7 GB of it.
        {"url": "https://rnb-opendata.s3.fr-par.scw.cloud/files/RNB_nat.csv.zip"},
        {"url": "https://rnb-fr.gitbook.io/documentation/export"},
    ]
    cl = httpx.Client(
        transport=httpx.MockTransport(lambda r: httpx.Response(200, json={"resources": resources}))
    )
    assert rnb.departements(cl) == ["09", "2A", "974"]


def test_the_ademe_key_is_never_sent_to_rnb(monkeypatch):
    """The ADEME key is a credential for data.ademe.fr. RNB is a different
    operator's bucket, so it gets its own client and never that header."""
    monkeypatch.setattr(api, "API_KEY", "sekrit")
    headers = rnb.client().headers
    assert "x-apiKey" not in headers
    # Cloudflare-fronted hosts answer a library user-agent with 403.
    assert "python" not in headers["user-agent"].lower()


@pytest.mark.live
def test_departement_09_round_trips_against_the_live_export(tmp_path):
    """Every kept field of every building in the real RNB_09, against the CSV
    it came from."""
    out = tmp_path / "out"
    with rnb.client() as cl:
        manifest = rnb.build(out, ["09"], client=cl)
        r = cl.get(rnb.URL.format(code="09"))
        r.raise_for_status()
    with zipfile.ZipFile(io.BytesIO(r.content)) as z:
        text = z.read("RNB_09.csv").decode("utf-8")
    want = _source_rows(text)
    got = _published(out / "v1" / "rnb" / "dept=09" / "part-0000.parquet")
    assert manifest["partitions"][0]["rows"] == len(want) == len(got)
    bad = [
        f"{rid}.{col}"
        for rid, src in want.items()
        for col in rnb.KEPT
        if (
            _parsed(got[rid][col]) != _parsed(src[col])
            if col in NESTED
            else got[rid][col] != src[col]
        )
    ]
    assert not bad, f"{len(bad)} fields differ: {bad[:10]}"
