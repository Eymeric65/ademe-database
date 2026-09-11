"""Every build command takes --source.

The build is six commands -- schema, vocab, scales, ingest, finalise, export --
and each worked on existing housing's database and dataset with no way to say
otherwise. `ingest_departement` asked ADEME for existing housing's totals and
pages whatever loader it was handed. So a second source could be exported and
merged (#31, #32) but never built. See ADR-0017.
"""

from __future__ import annotations

import json

import httpx
import pytest

from ademe import config, export_parquet, finalise, ingest, mapping, scales, schema, spec, vocab
from ademe.config import SCHEMA_JSON, Source
from tests.test_export_parquet import SCALES, _row
from tests.test_mapping_per_source import NEUF_ABSENT


@pytest.fixture
def neuf(tmp_path, monkeypatch) -> Source:
    fields = [f for f in json.loads(SCHEMA_JSON.read_text()) if f["key"] not in NEUF_ABSENT]
    path = tmp_path / "neuf-like-schema.json"
    path.write_text(json.dumps(fields))
    src = Source(
        slug="neuf-like",
        dataset="neuf-like",
        schema_json=path,
        db_path=tmp_path / "neuf-like.sqlite",
        subdir="neuf-like",
        mapping=mapping.EXISTANT.without(NEUF_ABSENT),
    )
    # Into each module's own reference, not only config's: test_api_key reloads
    # config, which rebinds config.SOURCES to a new dict the CLIs never see.
    for module in (config, schema, vocab, scales, ingest, finalise, export_parquet):
        monkeypatch.setitem(module.SOURCES, "neuf-like", src)
    return src


def test_schema_builds_the_sources_own_database(neuf, monkeypatch):
    seen = {}
    monkeypatch.setattr(schema, "build", lambda path, **kw: seen.update(path=path, **kw))
    monkeypatch.setattr(schema, "report", lambda path: None)
    assert schema.main(["--source", "neuf-like"]) == 0
    assert seen == {"path": neuf.db_path, "source": neuf}


def test_vocab_fills_the_sources_own_database(neuf, monkeypatch):
    seen = {}
    monkeypatch.setattr(vocab, "build", lambda path, **kw: seen.update(path=path, **kw) or {})
    assert vocab.main(["--source", "neuf-like"]) == 0
    assert seen == {"path": neuf.db_path, "source": neuf}


def test_scales_samples_the_sources_own_dataset(neuf, monkeypatch):
    seen = {}

    def discover(client, numeric, **kw):
        seen.update(source=kw.get("source"), numeric=set(numeric))
        return {}, {}, 0

    monkeypatch.setattr(scales, "discover", discover)
    monkeypatch.setattr(
        scales, "store", lambda path, s, source: seen.update(path=path, stored_for=source)
    )
    monkeypatch.setattr(scales.api, "client", lambda: None)
    assert scales.main(["--source", "neuf-like"]) == 0
    assert seen["source"] is neuf and seen["path"] == neuf.db_path
    # The schema is rebuilt under the scales, so it must be the source's own (ADR-0032).
    assert seen["stored_for"] is neuf
    # The source's own numeric columns, not existing housing's.
    assert not seen["numeric"] & NEUF_ABSENT


def test_finalise_finalises_the_sources_own_database(neuf, monkeypatch):
    seen = {}

    class Conn:
        def close(self):
            pass

    monkeypatch.setattr(finalise.db, "connect", lambda path, **kw: seen.update(path=path) or Conn())
    monkeypatch.setattr(finalise, "finalise", lambda conn, **kw: seen.update(**kw) or 0)
    assert finalise.main(["--source", "neuf-like"]) == 0
    assert seen["path"] == neuf.db_path and seen["source"] is neuf


def test_export_exports_the_sources_own_database(neuf, monkeypatch, tmp_path):
    seen = {}

    def export(db_path, out, depts=None, **kw):
        seen.update(db_path=db_path, **kw)
        return {"partitions": []}

    monkeypatch.setattr(export_parquet, "export", export)
    assert export_parquet.main(["--source", "neuf-like", "--out", str(tmp_path / "out")]) == 0
    assert seen["db_path"] == neuf.db_path and seen["source"] is neuf


class FakeApi:
    def __init__(self):
        self.sources = []

    def total(self, _client, *, departement=None, qs=None, source=None):
        self.sources.append(source)
        return 1

    def iter_pages(self, _client, *, departement=None, start_url=None, source=None, **_kw):
        self.sources.append(source)

        class Page:
            rows, next_url, nbytes = [_row("2409N0000001", "09001", "09")], None, 0

        yield Page()


def test_a_departement_is_fetched_from_the_loaders_own_dataset(neuf, monkeypatch):
    schema.build(neuf.db_path, scales=SCALES, source=neuf)
    conn = ingest.db.connect(neuf.db_path, bulk=True)
    loader = ingest.Loader(conn, spec.load(SCALES, source=neuf), source=neuf)
    fake = FakeApi()
    monkeypatch.setattr(ingest.api, "total", fake.total)
    monkeypatch.setattr(ingest.api, "iter_pages", fake.iter_pages)

    assert ingest.ingest_departement(conn, loader, None, "09", quiet=True) == 1
    assert fake.sources == [neuf, neuf]


def test_the_departements_are_listed_from_the_sources_own_dataset(neuf):
    seen = []

    def handle(request):
        seen.append(request.url.path)
        return httpx.Response(200, json=["09"])

    cl = httpx.Client(transport=httpx.MockTransport(handle))
    assert ingest.departements(cl, neuf) == ["09", "NG"]
    assert seen == ["/data-fair/api/v1/datasets/neuf-like/values/code_departement_ban"]


def test_ingest_loads_into_the_sources_own_database(neuf, monkeypatch):
    schema.build(neuf.db_path, scales=SCALES, source=neuf)
    calls = []
    monkeypatch.setattr(ingest.api, "client", lambda: None)
    monkeypatch.setattr(ingest, "departements", lambda client, source=None: calls.append(source) or ["09"])
    monkeypatch.setattr(
        ingest,
        "ingest_departement",
        lambda conn, loader, client, code, **kw: calls.append((loader.source, code)) or 0,
    )
    assert ingest.main(["--source", "neuf-like", "--all"]) == 0
    assert calls == [neuf, (neuf, "09")]
