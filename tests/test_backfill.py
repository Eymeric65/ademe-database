"""`adresse_brut`, put back where the stale CSV labels left it empty.

Every certificate loaded before the labels were corrected has `adresse_brut`
empty -- 7.9M in the national build. Re-ingesting 17 hours to recover one text
column would be absurd; this pulls `numero_dpe` and the column alone, one
departement at a time, and writes it into `dpe_adresse_brut`. It runs after the
ingest and before `finalise`. See ADR-0023.
"""

from __future__ import annotations

import json

import pytest

from ademe import backfill, db, ingest, reconstruct, schema, spec


def _row(numero: str, dept: str = "09", **over) -> dict:
    insee = f"{dept}001"
    return {
        "numero_dpe": numero,
        "code_insee_ban": insee,
        "code_departement_ban": dept,
        "code_postal_ban": f"{dept}000",
        "nom_commune_ban": "Foix",
        "adresse_ban": "1 rue de Test",
        "identifiant_ban": f"ban-{numero}",
        "etiquette_dpe": "D",
        **over,
    }


@pytest.fixture
def loaded(tmp_path):
    """Three certificates as the stale labels loaded them: no `adresse_brut`."""
    path = tmp_path / "t.sqlite"
    schema.build(path)
    conn = db.connect(path, bulk=True)
    ingest.Loader(conn, spec.load()).load_page(
        [
            _row("2409E0000001", adresse_complete_brut="2 Allée des Lilas 09300 VILLENEUVE D OLMES"),
            # No raw address at all, so no dpe_adresse_brut row either.
            _row("2409E0000002"),
            _row("2431E0000001", dept="31", adresse_complete_brut="5 rue X 31000 Toulouse"),
        ]
    )
    conn.execute(
        "INSERT INTO ingest_departement"
        " (code_departement, total_expected, rows_loaded, started_at, completed_at) VALUES"
        " ('09', 2, 2, datetime(), datetime()), ('31', 1, 1, datetime(), datetime())"
    )
    conn.commit()
    yield path, conn
    conn.close()


class Upstream:
    """What ADEME serves for `select=numero_dpe,<column>`, per departement."""

    def __init__(self, by_dept: dict[str, list[tuple[str, str]]], *, fail_on: str | None = None):
        self.by_dept, self.fail_on, self.calls = by_dept, fail_on, []

    def iter_pages(self, _client, *, departement=None, select=None, **_kw):
        self.calls.append((departement, tuple(select or ())))
        if departement == self.fail_on:
            raise RuntimeError(f"upstream down during {departement}")

        class Page:
            rows = [{"numero_dpe": n, "adresse_brut": a} for n, a in self.by_dept.get(departement, [])]
            next_url, nbytes = None, 0

        yield Page()


UPSTREAM = {
    "09": [
        ("2409E0000001", "2 Allée des Lilas"),
        ("2409E0000002", "7 rue Y"),
        # Published since the load: not ours to insert.
        ("2409E9999999", "9 rue Z"),
    ],
    "31": [("2431E0000001", "5 rue X")],
}


def test_the_column_comes_back_for_every_certificate(loaded, monkeypatch):
    _path, conn = loaded
    monkeypatch.setattr(backfill.api, "iter_pages", Upstream(UPSTREAM).iter_pages)

    assert backfill.backfill(conn, None) == 3
    rec = reconstruct.Reconstructor(conn)
    assert rec.row("2409E0000001")["adresse_brut"] == "2 Allée des Lilas"
    # The column next to it is left exactly as it was.
    assert rec.row("2409E0000001")["adresse_complete_brut"] == "2 Allée des Lilas 09300 VILLENEUVE D OLMES"
    assert rec.row("2409E0000002")["adresse_brut"] == "7 rue Y"
    assert rec.row("2431E0000001")["adresse_brut"] == "5 rue X"
    assert rec.row("2409E9999999") is None


def test_it_asks_for_the_key_and_the_column_only(loaded, monkeypatch):
    """One stream, 16 B of numero and a street line per row -- not 2 kB of
    record. The whole dataset is minutes, not the base build's hours."""
    _path, conn = loaded
    up = Upstream(UPSTREAM)
    monkeypatch.setattr(backfill.api, "iter_pages", up.iter_pages)
    backfill.backfill(conn, None)
    assert up.calls == [("09", ("numero_dpe", "adresse_brut")), ("31", ("numero_dpe", "adresse_brut"))]


def test_it_refuses_while_the_ingest_is_still_loading(loaded, monkeypatch):
    """Two writers on one SQLite file, one of them a 17-hour load: no."""
    _path, conn = loaded
    conn.execute("UPDATE ingest_departement SET completed_at = NULL WHERE code_departement = '31'")
    conn.commit()
    up = Upstream(UPSTREAM)
    monkeypatch.setattr(backfill.api, "iter_pages", up.iter_pages)
    with pytest.raises(backfill.Incomplete, match="31"):
        backfill.backfill(conn, None)
    assert up.calls == []


def test_a_rerun_picks_up_where_it_stopped(loaded, tmp_path, monkeypatch):
    _path, conn = loaded
    progress = tmp_path / "progress.json"
    monkeypatch.setattr(backfill.api, "iter_pages", Upstream(UPSTREAM, fail_on="31").iter_pages)
    with pytest.raises(RuntimeError):
        backfill.backfill(conn, None, progress=progress)
    assert json.loads(progress.read_text()) == ["09"]

    up = Upstream(UPSTREAM)
    monkeypatch.setattr(backfill.api, "iter_pages", up.iter_pages)
    assert backfill.backfill(conn, None, progress=progress) == 1
    assert [c[0] for c in up.calls] == ["31"]


def test_only_a_text_column_of_the_raw_address_table_can_be_backfilled(loaded):
    _path, conn = loaded
    with pytest.raises(ValueError, match="etiquette_dpe"):
        backfill.backfill(conn, None, column="etiquette_dpe")
