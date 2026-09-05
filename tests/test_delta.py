"""The weekly delta, and the merge that has to be exactly right.

A merge that drops a row is invisible: the file still parses, the search still
works, and one certificate has simply stopped existing. So the assertions here
are about counts and about which version of a changed row wins, not about the
files being readable.
"""

from __future__ import annotations

import json

import duckdb
import pytest

from ademe import db, delta, export_parquet, ingest, schema, spec

SCALES = {
    "conso_5_usages_par_m2_ep": 10,
    "surface_habitable_logement": 10,
    "coordonnee_cartographique_x_ban": 10**6,
    "coordonnee_cartographique_y_ban": 10**6,
}


def _row(numero: str, dept: str, modified: str, **over) -> dict:
    insee = f"{dept}001" if len(dept) == 2 else f"{dept}01"
    return {
        "numero_dpe": numero,
        "code_insee_ban": insee,
        "code_departement_ban": dept,
        "code_postal_ban": f"{dept}000",
        "nom_commune_ban": "Foix",
        "adresse_ban": "1 rue de Test",
        "identifiant_ban": f"ban-{numero}",
        "etiquette_dpe": "D",
        "etiquette_ges": "C",
        "date_etablissement_dpe": "2024-03-11",
        "date_derniere_modification_dpe": modified,
        "surface_habitable_logement": "78.5",
        "conso_5_usages_par_m2_ep": "117.1",
        **over,
    }


def _build(tmp_path, name: str, rows: list[dict]):
    path = tmp_path / f"{name}.sqlite"
    schema.build(path, scales=SCALES)
    conn = db.connect(path, bulk=True)
    ingest.Loader(conn, spec.load(SCALES)).load_page(rows)
    conn.commit()
    return path, conn


@pytest.fixture
def base(tmp_path):
    """Two partitions, exported -- the published state a delta merges into."""
    rows = [
        _row("2409E0000001", "09", "2026-08-01"),
        _row("2409E0000002", "09", "2026-08-02", etiquette_dpe="E"),
        _row("2431E0000001", "31", "2026-08-01"),
    ]
    path, conn = _build(tmp_path, "base", rows)
    out = tmp_path / "published"
    manifest = export_parquet.export(path, out)
    conn.close()
    return out / export_parquet.VERSION, manifest


def test_merge_replaces_the_changed_row_and_keeps_the_rest(base, tmp_path):
    published, manifest = base
    assert manifest["high_water"] == "2026-08-02"

    # One updated certificate and one new one, both in departement 09.
    delta_rows = [
        _row("2409E0000002", "09", "2026-09-01", etiquette_dpe="A"),  # was E
        _row("2409E0000003", "09", "2026-09-02"),  # new
    ]
    dpath, dconn = _build(tmp_path, "delta", delta_rows)
    delta_dir = tmp_path / "delta-out"
    export_parquet.export(dpath, delta_dir)
    dconn.close()

    merged = tmp_path / "merged"
    touched = delta.merge(published, delta_dir / export_parquet.VERSION, merged)
    assert touched == ["09"], "only the departement the delta touched is rewritten"

    d = duckdb.connect()
    rows = d.execute(
        f"SELECT numero_dpe, etiquette_dpe FROM"
        f" read_parquet('{merged / 'dpe' / 'dept=09' / 'part-0000.parquet'}')"
        " ORDER BY numero_dpe"
    ).fetchall()
    assert rows == [
        ("2409E0000001", "D"),
        ("2409E0000002", "A"),  # the delta's version won, not the base's E
        ("2409E0000003", "D"),
    ]


def test_the_untouched_partition_is_carried_over_byte_for_byte(base, tmp_path):
    """Rewriting a partition the delta never mentioned would be pure risk: new
    bytes, a new checksum, and a chance to lose a row for no reason."""
    published, _ = base
    dpath, dconn = _build(tmp_path, "delta", [_row("2409E0000009", "09", "2026-09-01")])
    delta_dir = tmp_path / "delta-out"
    export_parquet.export(dpath, delta_dir)
    dconn.close()

    merged = tmp_path / "merged"
    delta.merge(published, delta_dir / export_parquet.VERSION, merged)

    before = (published / "dpe" / "dept=31" / "part-0000.parquet").read_bytes()
    after = (merged / "dpe" / "dept=31" / "part-0000.parquet").read_bytes()
    assert before == after


def test_the_search_file_stays_sorted_after_a_merge(base, tmp_path):
    """The whole layout rests on row-group statistics, which mean nothing if a
    merge appends the delta instead of re-sorting."""
    published, _ = base
    delta_rows = [
        _row("2409E0000010", "09", "2026-09-01", code_postal_ban="09001"),
        _row("2409E0000011", "09", "2026-09-01", code_postal_ban="09999"),
        _row("2409E0000012", "09", "2026-09-01", code_postal_ban="09500"),
    ]
    dpath, dconn = _build(tmp_path, "delta", delta_rows)
    delta_dir = tmp_path / "delta-out"
    export_parquet.export(dpath, delta_dir)
    dconn.close()

    merged = tmp_path / "merged"
    delta.merge(published, delta_dir / export_parquet.VERSION, merged)

    d = duckdb.connect()
    codes = [
        r[0]
        for r in d.execute(
            f"SELECT code_postal_ban FROM"
            f" read_parquet('{merged / 'search' / 'dept=09' / 'part-0000.parquet'}')"
        ).fetchall()
    ]
    assert codes == sorted(codes)


def test_the_new_manifest_advances_the_high_water_mark(base, tmp_path):
    """The high-water mark is what the next run resumes from. If a merge left
    it behind, every later delta would re-fetch the same window forever; if it
    ran ahead, the rows in between would be skipped and never come back."""
    published, _ = base
    dpath, dconn = _build(tmp_path, "delta", [_row("2409E0000020", "09", "2026-09-03")])
    delta_dir = tmp_path / "delta-out"
    export_parquet.export(dpath, delta_dir)
    dconn.close()

    merged = tmp_path / "merged"
    delta.merge(published, delta_dir / export_parquet.VERSION, merged)
    m = json.loads((merged / "manifest.json").read_text())

    assert m["high_water"] == "2026-09-03"
    counts = {p["dept"]: p["rows"] for p in m["partitions"]}
    assert counts == {"09": 3, "31": 1}
    for p in m["partitions"]:
        assert p["dpe"]["sha256"] and p["search"]["sha256"]


def test_the_high_water_mark_never_moves_backwards(base, tmp_path):
    """A re-run over an older window -- `--since` given by hand, or ADEME
    revising a row to an earlier modification date -- must not rewind the mark.
    If it did, the next run would re-fetch a window it had already published,
    and every run after that would inherit the rewind.
    """
    published, base_manifest = base
    assert base_manifest["high_water"] == "2026-08-02"

    dpath, dconn = _build(tmp_path, "old", [_row("2409E0000030", "09", "2026-07-01")])
    delta_dir = tmp_path / "delta-out"
    export_parquet.export(dpath, delta_dir)
    dconn.close()

    merged = tmp_path / "merged"
    delta.merge(published, delta_dir / export_parquet.VERSION, merged)
    m = json.loads((merged / "manifest.json").read_text())

    assert m["high_water"] == "2026-08-02", "an older delta rewound the mark"
    # The row itself is still published; only the mark is held.
    assert {p["dept"]: p["rows"] for p in m["partitions"]}["09"] == 3


def test_a_sharp_departure_is_flagged_rather_than_published():
    """ADEME republishing a whole departement looks from here like an ordinary
    week with a big number. The point is to stop and be looked at."""
    runs = [{"rows_changed": n} for n in (50_000, 48_000, 61_000, 52_000)]
    flagged, median = delta.sharp_departure(runs, 55_000)
    assert not flagged and median == 51_000

    flagged, _ = delta.sharp_departure(runs, 400_000)
    assert flagged

    # Too little history to have a norm: never flag, never block the first runs.
    assert delta.sharp_departure([{"rows_changed": 1}], 10**9) == (False, None)


@pytest.mark.live
def test_the_incremental_key_really_filters():
    """A range query that silently matched nothing would look exactly like a
    quiet week, and the job would advance the high-water mark past rows it
    never fetched. This proves the syntax discriminates on this Data Fair
    instance rather than merely being accepted."""
    from ademe import api

    client = api.client()
    everything = api.total(client)
    recent = api.total(client, qs='date_derniere_modification_dpe:[2026-08-25 TO *]')
    none_yet = api.total(client, qs='date_derniere_modification_dpe:[2099-01-01 TO *]')

    assert everything > 1_000_000
    assert 0 < recent < everything, "the bound neither matched everything nor nothing"
    assert none_yet == 0, "a bound in the future must match nothing"

    rows = next(
        api.iter_pages(
            client,
            qs='date_derniere_modification_dpe:[2026-08-25 TO *]',
            select=["numero_dpe", "date_derniere_modification_dpe"],
            page_size=20,
        )
    ).rows
    assert rows
    for r in rows:
        assert r["date_derniere_modification_dpe"] >= "2026-08-25"


# --- reconciliation ---------------------------------------------------------


class FakeApi:
    """The api module's surface, with a fixed upstream. Stubbed at that
    boundary rather than at HTTP so the tests state what ADEME holds, which is
    the only thing reconcile actually reasons about."""

    def __init__(self, by_dept: dict[str, list[str]], *, lie_about_total: int | None = None):
        self.by_dept = by_dept
        self.lie = lie_about_total
        self.pulled: list[str] = []

    def total(self, _client, *, departement=None, qs=None):
        if self.lie is not None and departement is not None:
            return self.lie
        if departement is not None:
            return len(self.by_dept.get(departement, []))
        return sum(len(v) for v in self.by_dept.values())

    def iter_pages(self, _client, *, departement=None, qs=None, select=None, **_kw):
        if departement is not None:
            self.pulled.append(departement)
            rows = [{"numero_dpe": n} for n in self.by_dept.get(departement, [])]
        else:
            # A numero_dpe:(a OR b) fetch of specific certificates.
            wanted = {w.strip('"') for w in qs.split("(", 1)[1].rstrip(")").split(" OR ")}
            rows = [{"numero_dpe": n} for v in self.by_dept.values() for n in v if n in wanted]

        class Page:
            def __init__(self, rows):
                self.rows, self.next_url, self.nbytes = rows, None, 0

        yield Page(rows)


def test_reconcile_finds_what_left_the_dataset(base, tmp_path, monkeypatch):
    """The delta cannot see a deletion.

    dpe03existant is a virtual dataset filtered `dpe_desactive = 0`, and the
    field is not in the public schema. A deactivated certificate simply leaves
    the view; `date_derniere_modification_dpe > mark` never returns it, and an
    upsert-only merge keeps it forever. See ADR-0007.
    """
    published, _ = base

    # Upstream no longer has 2409E0000002. This is the state AFTER the delta
    # has run, which is the order the job uses: additions arrive through the
    # delta, so anything still missing here left the dataset.
    fake = FakeApi({"09": ["2409E0000001"], "31": ["2431E0000001"]})
    monkeypatch.setattr(delta.api, "total", fake.total)
    monkeypatch.setattr(delta.api, "iter_pages", fake.iter_pages)

    report = delta.reconcile(None, published)

    assert report["09"].gone == ["2409E0000002"]
    assert report["09"].appeared == []
    # 31 matched on count alone, so its ids were never pulled -- that is the
    # whole point of checking the total first.
    assert "31" not in fake.pulled
    assert "09" in fake.pulled


def test_equal_numbers_of_deletions_and_additions_hide_from_the_count(
    base, tmp_path, monkeypatch
):
    """A known blind spot, recorded rather than papered over.

    Checking the total first is what keeps this job polite -- 248 MB and eight
    minutes to pull every id. The cost is that one deletion plus one addition
    in the same partition net out and the count still matches.

    It is survivable because of the ORDER the job runs in: additions arrive
    through the delta first, so by the time reconcile looks, an addition has
    already raised the published count and a deletion shows as a shortfall.
    This test pins the limitation so nobody discovers it as a surprise.
    """
    published, _ = base
    fake = FakeApi({"09": ["2409E0000001", "2409E0000099"], "31": ["2431E0000001"]})
    monkeypatch.setattr(delta.api, "total", fake.total)
    monkeypatch.setattr(delta.api, "iter_pages", fake.iter_pages)

    report = delta.reconcile(None, published)

    assert fake.pulled == [], "counts matched, so no ids were pulled"
    assert report["09"].clean(), "the swap is invisible to a count check -- see ADR-0007"


def test_reconcile_pulls_no_ids_when_every_count_agrees(base, tmp_path, monkeypatch):
    """248 MB and eight minutes for the full dataset. Pulling ids when the
    counts already agree would spend that every week for nothing."""
    published, _ = base
    fake = FakeApi(
        {"09": ["2409E0000001", "2409E0000002"], "31": ["2431E0000001"]}
    )
    monkeypatch.setattr(delta.api, "total", fake.total)
    monkeypatch.setattr(delta.api, "iter_pages", fake.iter_pages)

    report = delta.reconcile(None, published)
    assert fake.pulled == []
    assert all(not r.gone and not r.appeared for r in report.values())


def test_reconcile_refuses_when_upstream_contradicts_itself(base, tmp_path, monkeypatch):
    """A total that disagrees with the ids behind it means the answer cannot be
    trusted, and acting on it would delete rows on the strength of a number
    that is wrong. Fail, and leave the manifest alone."""
    published, _ = base
    fake = FakeApi({"09": ["2409E0000001", "2409E0000002"], "31": ["2431E0000001"]},
                   lie_about_total=7)
    monkeypatch.setattr(delta.api, "total", fake.total)
    monkeypatch.setattr(delta.api, "iter_pages", fake.iter_pages)

    with pytest.raises(delta.ReconcileError) as e:
        delta.reconcile(None, published)
    assert "09" in str(e.value)


def test_apply_deletions_rewrites_the_partition_without_the_gone_rows(base, tmp_path, monkeypatch):
    published, _ = base
    fake = FakeApi({"09": ["2409E0000001"], "31": ["2431E0000001"]})
    monkeypatch.setattr(delta.api, "total", fake.total)
    monkeypatch.setattr(delta.api, "iter_pages", fake.iter_pages)

    report = delta.reconcile(None, published)
    out = tmp_path / "reconciled"
    delta.apply_deletions(published, report, out)

    d = duckdb.connect()
    left = [
        r[0]
        for r in d.execute(
            f"SELECT numero_dpe FROM read_parquet('{out / 'dpe' / 'dept=09' / 'part-0000.parquet'}')"
            " ORDER BY numero_dpe"
        ).fetchall()
    ]
    assert left == ["2409E0000001"]

    m = json.loads((out / "manifest.json").read_text())
    assert {p["dept"]: p["rows"] for p in m["partitions"]} == {"09": 1, "31": 1}


@pytest.mark.live
def test_the_id_pull_agrees_with_the_total_upstream():
    """reconcile trusts `total` enough to pull ids on a mismatch, and trusts
    the ids enough to delete on a difference. If those two disagreed upstream,
    every week's reconciliation would be acting on noise."""
    from ademe import api

    client = api.client()
    code = "975"
    reported = api.total(client, departement=code)
    ids = [
        r["numero_dpe"]
        for page in api.iter_pages(client, departement=code, select=["numero_dpe"], page_size=10000)
        for r in page.rows
    ]
    assert reported > 0
    assert len(ids) == reported, f"total says {reported}, the id pull returned {len(ids)}"
    assert len(set(ids)) == len(ids), "upstream returned a duplicate numero_dpe"
