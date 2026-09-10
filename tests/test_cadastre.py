"""Cadastre parcels, published as attributes: what an RNB `plots[].id` names.

Etalab republishes the DGFiP cadastre quarterly as one gzipped GeoJSON
FeatureCollection per département, written one feature per line. We keep every
property and drop the polygon. The three features below are real (département
09, edition 2026-06-01): an ordinary parcel, one whose `contenance` key is
absent (410 of them in 09), and one with `arpente: true` and a non-zero
`prefixe`. See ADR-0020.
"""

from __future__ import annotations

import gzip
import io
import json

import duckdb
import httpx
import pytest

from ademe import api, cadastre

HEADER = '{"type":"FeatureCollection","features":['
ORDINARY = '{"type":"Feature","id":"090870000A0025","geometry":{"type":"Polygon","coordinates":[[[1.7943467,42.7684175],[1.7941759,42.7683944],[1.7941492,42.7683908],[1.7938374,42.7682112],[1.7943822,42.7682488],[1.7943467,42.7684175]]]},"properties":{"id":"090870000A0025","commune":"09087","prefixe":"000","section":"A","numero":"25","contenance":535,"arpente":false,"created":"2016-02-11","updated":"2026-02-19"}}'
NO_CONTENANCE = '{"type":"Feature","id":"091450000A0023","geometry":{"type":"Polygon","coordinates":[[[1.7385797,43.0857464],[1.7385672,43.0857122],[1.7386022,43.0857053],[1.7386147,43.0857395],[1.7385797,43.0857464]]]},"properties":{"id":"091450000A0023","commune":"09145","prefixe":"000","section":"A","numero":"23","arpente":false,"created":"2014-07-28","updated":"2015-03-06"}}'
ARPENTE = '{"type":"Feature","id":"092960280A0896","geometry":{"type":"Polygon","coordinates":[[[1.6697384,42.7974077],[1.6697251,42.7973918],[1.6697899,42.797361],[1.6698148,42.7973893],[1.6697467,42.7974192],[1.6697384,42.7974077]]]},"properties":{"id":"092960280A0896","commune":"09296","prefixe":"028","section":"A","numero":"896","contenance":24,"arpente":true,"created":"2015-09-28","updated":"2018-10-19"}}'
FEATURES = [ORDINARY, NO_CONTENANCE, ARPENTE]

EDITION = "2026-06-01"
DATED = (
    f"https://cadastre.s3.rbx.io.cloud.ovh.net/etalab-cadastre/{EDITION}"
    "/geojson/departements/{code}/cadastre-{code}-parcelles.json.gz"
)


def _collection(features: list[str]) -> str:
    """The layout Etalab writes: a header line, one feature per line, `,`
    between them and `]}` closing the last."""
    return HEADER + "\n" + ",\n".join(features) + "]}\n"


def _gz(text: str) -> bytes:
    return gzip.compress(text.encode("utf-8"))


def _source(text: str) -> dict[str, dict]:
    dec = json.JSONDecoder()
    out = {}
    for line in text.splitlines()[1:]:
        f, _ = dec.raw_decode(line)
        out[f["properties"]["id"]] = f["properties"]
    return out


def _published(path) -> dict[str, dict]:
    d = duckdb.connect()
    cur = d.execute(
        "SELECT id, commune, prefixe, section, numero, contenance, arpente,"
        " strftime(created, '%Y-%m-%d') AS created, strftime(updated, '%Y-%m-%d') AS updated"
        f" FROM read_parquet('{path}')"
    )
    names = [c[0] for c in cur.description]
    return {r[0]: dict(zip(names, r)) for r in cur.fetchall()}


@pytest.fixture
def converted(tmp_path):
    text = _collection(FEATURES)
    src = tmp_path / "cadastre-09-parcelles.json.gz"
    src.write_bytes(_gz(text))
    out = tmp_path / "cadastre.parquet"
    return text, out, cadastre.convert(src, out)


def test_every_property_of_every_parcel_survives(converted):
    text, out, rows = converted
    want, got = _source(text), _published(out)
    assert rows == len(want) == len(got) == 3
    for pid, props in want.items():
        # An absent key comes back as NULL; Etalab never writes an explicit null.
        assert {k: v for k, v in got[pid].items() if v is not None} == props, pid
    assert got["091450000A0023"]["contenance"] is None
    assert got["092960280A0896"]["arpente"] is True


def test_the_polygon_is_not_published(converted):
    _text, out, _rows = converted
    d = duckdb.connect()
    names = [r[0] for r in d.execute(f"DESCRIBE SELECT * FROM read_parquet('{out}')").fetchall()]
    assert names == list(cadastre.KEPT)


@pytest.mark.parametrize(
    "text, complaint",
    [
        ('{"type":"Topology"}\n' + ",\n".join(FEATURES) + "]}\n", "header"),
        (HEADER + "\n" + ORDINARY + "," + NO_CONTENANCE + ",\n" + ARPENTE + "]}\n", "line 2"),
        (_collection([ORDINARY.replace('"arpente"', '"surface":12,"arpente"')]), "surface"),
        (_collection([ORDINARY.replace('"id":"090870000A0025","geometry"', '"id":"X","geometry"')]), "id"),
        (HEADER + "\n" + ORDINARY + ",\n" + NO_CONTENANCE + ",\n", "closing"),
    ],
    ids=[
        "not a FeatureCollection",
        "two features on one line",
        "a new property",
        "feature id disagrees with properties.id",
        "a file that stops mid-collection",
    ],
)
def test_a_file_that_is_not_laid_out_as_expected_fails(tmp_path, text, complaint):
    """The line reader is only correct for the layout Etalab writes today, and
    each of these would otherwise publish a wrong or partial département
    without an error. The last is a download cut short on a line boundary."""
    src = tmp_path / "cadastre-09-parcelles.json.gz"
    src.write_bytes(_gz(text))
    with pytest.raises(ValueError, match=complaint):
        cadastre.convert(src, tmp_path / "out.parquet")


class Server:
    """cadastre.data.gouv.fr's `latest` redirect, and the bucket behind it."""

    def __init__(self, body: bytes, etag: str):
        self.body, self.etag, self.requests = body, etag, []

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if "/latest/" in request.url.path:
            code = request.url.path.split("/")[-2]
            return httpx.Response(302, headers={"location": DATED.format(code=code)})
        if request.headers.get("if-none-match") == self.etag:
            return httpx.Response(304)
        return httpx.Response(
            200,
            content=self.body,
            headers={"etag": self.etag, "last-modified": "Thu, 02 Jul 2026 09:07:22 GMT"},
        )

    def client(self) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self.handle), follow_redirects=True)


def test_a_departement_is_fetched_only_when_it_changed(tmp_path):
    out = tmp_path / "out"
    server = Server(_gz(_collection(FEATURES)), '"e1"')

    first = cadastre.build(out, ["09"], client=server.client())
    part = out / "v1" / "cadastre" / "dept=09" / "part-0000.parquet"
    assert first["partitions"] == [
        {
            "dept": "09",
            "edition": EDITION,
            "rows": 3,
            "etag": '"e1"',
            "last_modified": "Thu, 02 Jul 2026 09:07:22 GMT",
            "sha256": first["partitions"][0]["sha256"],
        }
    ]
    written = part.read_bytes()

    again = cadastre.build(out, ["09"], client=server.client())
    assert server.requests[-1].headers["if-none-match"] == '"e1"'
    assert part.read_bytes() == written
    assert again["partitions"] == first["partitions"]

    server.body, server.etag = _gz(_collection([ARPENTE])), '"e2"'
    third = cadastre.build(out, ["09"], client=server.client())
    assert third["partitions"][0]["etag"] == '"e2"'
    assert third["partitions"][0]["rows"] == 1
    assert list(_published(part)) == ["092960280A0896"]


def test_a_failed_departement_leaves_the_published_manifest_alone(tmp_path):
    out = tmp_path / "out"
    good = Server(_gz(_collection(FEATURES)), '"e1"')
    cadastre.build(out, ["09"], client=good.client())
    manifest = out / "v1" / "cadastre" / "manifest.json"
    before = manifest.read_text()

    def handle(request: httpx.Request) -> httpx.Response:
        if "cadastre-2A-" in request.url.path and "/latest/" not in request.url.path:
            return httpx.Response(503)
        return good.handle(request)

    broken = httpx.Client(transport=httpx.MockTransport(handle), follow_redirects=True)
    with pytest.raises(httpx.HTTPStatusError):
        cadastre.build(out, ["09", "2A"], client=broken)
    assert manifest.read_text() == before


def test_a_partial_build_keeps_the_departements_it_did_not_touch(tmp_path):
    out = tmp_path / "out"
    cadastre.build(out, ["09"], client=Server(_gz(_collection(FEATURES)), '"e1"').client())
    both = cadastre.build(out, ["2A"], client=Server(_gz(_collection([ARPENTE])), '"a1"').client())
    assert [p["dept"] for p in both["partitions"]] == ["09", "2A"]


def test_the_departements_are_read_from_the_edition_index():
    """The real index is an HTML directory listing with absolute hrefs."""
    listing = (
        '<a href="../">../</a>'
        + "".join(
            f'<a href="/data/etalab-cadastre/{EDITION}/geojson/departements/{c}/">{c}/</a>'
            for c in ("09", "2A", "971", "976")
        )
    )
    cl = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200, text=listing)))
    assert cadastre.departements(cl) == ["09", "2A", "971", "976"]


def test_the_ademe_key_is_never_sent_to_the_cadastre(monkeypatch):
    monkeypatch.setattr(api, "API_KEY", "sekrit")
    headers = cadastre.client().headers
    assert "x-apiKey" not in headers
    assert "python" not in headers["user-agent"].lower()


@pytest.mark.live
def test_departement_75_round_trips_against_the_live_edition(tmp_path):
    """Every property of every parcel in Paris, against the file it came from.
    75 rather than 09 because it is 7 MB rather than 150."""
    out = tmp_path / "out"
    with cadastre.client() as cl:
        manifest = cadastre.build(out, ["75"], client=cl)
        r = cl.get(cadastre.URL.format(code="75"))
        r.raise_for_status()
    text = gzip.open(io.BytesIO(r.content), "rt", encoding="utf-8").read()
    want = _source(text)
    got = _published(out / "v1" / "cadastre" / "dept=75" / "part-0000.parquet")
    assert manifest["partitions"][0]["rows"] == len(want) == len(got)
    bad = [
        pid
        for pid, props in want.items()
        if {k: v for k, v in got[pid].items() if v is not None} != props
    ]
    assert not bad, f"{len(bad)} parcels differ: {bad[:10]}"
