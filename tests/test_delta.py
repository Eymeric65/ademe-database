"""The weekly delta, and the merge that has to be exactly right.

A merge that drops a row is invisible: the file still parses, the search still
works, and one certificate has simply stopped existing. So the assertions here
are about counts and about which version of a changed row wins, not about the
files being readable.
"""

from __future__ import annotations

import json
import re
from datetime import date

import duckdb
import pytest

from ademe import db, delta, export_parquet, ingest, recent, schema, spec

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


def _physical_columns(path) -> list[str]:
    """The columns stored in the file. `hive_partitioning = false` because
    DuckDB otherwise reads the `dept=09` directory as one more column."""
    return [
        r[0]
        for r in duckdb.connect()
        .execute(f"DESCRIBE SELECT * FROM read_parquet('{path}', hive_partitioning = false)")
        .fetchall()
    ]


def test_a_merged_partition_has_exactly_the_columns_the_export_wrote(base, tmp_path):
    """The merge reads the published file with SELECT *, and a file under
    `dept=09/` reads with a `dept` column it does not contain. Written back,
    that column becomes real: every partition a weekly delta touches would
    gain a 229th column the export never wrote, and the detail view would show
    it."""
    published, _ = base
    dpath, dconn = _build(tmp_path, "delta", [_row("2409E0000009", "09", "2026-09-01")])
    delta_dir = tmp_path / "delta-out"
    export_parquet.export(dpath, delta_dir)
    dconn.close()

    merged = tmp_path / "merged"
    delta.merge(published, delta_dir / export_parquet.VERSION, merged)

    for kind in ("dpe", "search"):
        assert _physical_columns(merged / kind / "dept=09" / "part-0000.parquet") == _physical_columns(
            published / kind / "dept=09" / "part-0000.parquet"
        ), kind


def test_a_partition_rewritten_for_deletions_keeps_the_export_columns(base, tmp_path, monkeypatch):
    """The same SELECT *, in the reconciliation's rewrite."""
    published, _ = base
    fake = FakeApi({"09": ["2409E0000001"], "31": ["2431E0000001"]})
    monkeypatch.setattr(delta.api, "total", fake.total)
    monkeypatch.setattr(delta.api, "iter_pages", fake.iter_pages)

    out = tmp_path / "reconciled"
    delta.apply_deletions(published, delta.reconcile(None, published), out)
    assert _physical_columns(out / "dpe" / "dept=09" / "part-0000.parquet") == _physical_columns(
        published / "dpe" / "dept=09" / "part-0000.parquet"
    )


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
        self.rows_pulled = 0

    @staticmethod
    def _in_range(qs: str | None, n: str) -> bool:
        """`numero_dpe:[lo TO hi}`, either end possibly `*`: what reconcile
        narrows a mismatch with. No qs is the whole département."""
        if qs is None:
            return True
        lo, hi, close = re.search(r"\[(\S+) TO (\S+?)([\]}])", qs).groups()
        if lo != "*" and n < lo:
            return False
        if hi != "*" and (n > hi or (close == "}" and n == hi)):
            return False
        return True

    def total(self, _client, *, departement=None, qs=None, source=None):
        if self.lie is not None and departement is not None:
            return self.lie
        if departement is not None:
            return sum(self._in_range(qs, n) for n in self.by_dept.get(departement, []))
        return sum(len(v) for v in self.by_dept.values())

    def iter_pages(self, _client, *, departement=None, qs=None, select=None, **_kw):
        if departement is not None:
            self.pulled.append(departement)
            rows = [
                {"numero_dpe": n}
                for n in self.by_dept.get(departement, [])
                if self._in_range(qs, n)
            ]
            self.rows_pulled += len(rows)
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


def test_a_mismatch_pulls_the_ids_of_the_ranges_that_disagree_not_the_partition(
    tmp_path, monkeypatch
):
    """Audit ids come back at ~800 a second, so pulling a whole département
    because one row left it cost the 2026-09-14 run its two hours. Counts over
    ranges of the key are exact and cheap; only the ranges that still disagree
    are pulled. See ADR-0040."""
    ids = [f"2409E{i:07d}" for i in range(1, 65)]
    path, conn = _build(tmp_path, "base", [_row(n, "09", "2026-08-01") for n in ids])
    export_parquet.export(path, tmp_path / "published")
    conn.close()
    published = tmp_path / "published" / export_parquet.VERSION

    # Two left upstream from the middle; one arrived past the published end,
    # which only an open-ended last range can count.
    upstream = [n for n in ids if n not in ("2409E0000030", "2409E0000031")] + ["2409E9999999"]
    fake = FakeApi({"09": upstream})
    monkeypatch.setattr(delta.api, "total", fake.total)
    monkeypatch.setattr(delta.api, "iter_pages", fake.iter_pages)
    monkeypatch.setattr(delta, "LEAF", 4, raising=False)

    report = delta.reconcile(None, published)

    assert report["09"].gone == ["2409E0000030", "2409E0000031"]
    assert report["09"].appeared == ["2409E9999999"]
    assert fake.rows_pulled <= 8, f"pulled {fake.rows_pulled} ids of a 64-row partition"


def test_a_key_that_cannot_be_a_bare_range_bound_is_never_cut_at(tmp_path, monkeypatch):
    """Data Fair rejects a quoted range bound, so a key with a space or a colon
    cannot be one. Such a range is pulled whole instead of split."""
    ids = [f"2409E {i:07d}" for i in range(1, 17)]
    path, conn = _build(tmp_path, "base", [_row(n, "09", "2026-08-01") for n in ids])
    export_parquet.export(path, tmp_path / "published")
    conn.close()
    published = tmp_path / "published" / export_parquet.VERSION

    fake = FakeApi({"09": ids[1:]})
    monkeypatch.setattr(delta.api, "total", fake.total)
    monkeypatch.setattr(delta.api, "iter_pages", fake.iter_pages)
    monkeypatch.setattr(delta, "LEAF", 4)

    report = delta.reconcile(None, published)
    assert report["09"].gone == [ids[0]]
    assert fake.rows_pulled == 15


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


@pytest.mark.live
@pytest.mark.parametrize("slug, code", [("existant", "2A"), ("audit", "2A")])
def test_a_key_range_count_agrees_with_the_ids_behind_it(slug, code):
    """reconcile narrows a mismatch by counting ranges of the key, and deletes
    on what those ranges pull. Both only mean something if a range's count is
    exactly its ids, and if the ranges tile the departement. ADR-0040."""
    from ademe import api
    from ademe.config import SOURCES, UNGEOCODED

    client, source = api.client(), SOURCES[slug]
    key = source.mapping.key
    ids = sorted(
        r[key]
        for page in api.iter_pages(client, departement=code, select=[key], source=source)
        for r in page.rows
    )
    assert len(ids) > 100, "too small a departement to cut"
    cuts = [ids[len(ids) * i // 4] for i in (1, 2, 3)]
    bounds = [None, *cuts, None]
    for lo, hi in zip(bounds, bounds[1:]):
        rng = delta._range_qs(key, lo, hi)
        want = sum(1 for n in ids if (lo is None or n >= lo) and (hi is None or n < hi))
        assert api.total(client, departement=code, qs=rng, source=source) == want, rng

    # The ungeocoded bucket's clause is a negation; AND-ed with a range it must
    # still tile.
    whole = api.total(client, departement=UNGEOCODED, source=source)
    halves = [
        api.total(client, departement=UNGEOCODED, qs=delta._range_qs(key, a, b), source=source)
        for a, b in ((None, cuts[1]), (cuts[1], None))
    ]
    assert sum(halves) == whole


# --- the paid window: split and join (ADR-0039) ------------------------------

CUTOFF = date(2026, 7, 19)


def _keys(path, column: str = "numero_dpe") -> set:
    return {
        r[0]
        for r in duckdb.connect()
        .execute(f"SELECT {column} FROM read_parquet('{path}', hive_partitioning = false)")
        .fetchall()
    }


def _rows(path) -> list[tuple]:
    """Every row of a file, in a stable order: a search file's sort has ties."""
    return sorted(
        duckdb.connect()
        .execute(f"SELECT * FROM read_parquet('{path}', hive_partitioning = false)")
        .fetchall(),
        key=repr,
    )


def _file(tree, kind, dept):
    return tree / kind / f"dept={dept}" / "part-0000.parquet"


@pytest.fixture
def whole(tmp_path):
    """One unsplit tree whose dates straddle CUTOFF, at ROOT/v1."""
    rows = [
        _row("2409E0000001", "09", "2026-08-01", date_etablissement_dpe="2026-05-01"),
        _row("2409E0000002", "09", "2026-08-01", date_etablissement_dpe="2026-07-19"),  # on the cutoff
        _row("2409E0000003", "09", "2026-08-01", date_etablissement_dpe="2026-07-18"),  # the day before
        _row("2409E0000004", "09", "2026-08-01", date_etablissement_dpe=""),  # no date
        _row("2409E0000005", "09", "2026-08-02", date_etablissement_dpe="2026-09-01"),
        # Numeros that disagree with their partition: one each side of the cutoff.
        _row("2475E0000001", "09", "2026-08-01", date_etablissement_dpe="2026-08-10"),
        _row("2476E0000001", "09", "2026-08-01", date_etablissement_dpe="2026-01-10"),
        # A partition that is recent through and through.
        _row("2431E0000001", "31", "2026-08-01", date_etablissement_dpe="2026-08-01"),
    ]
    path, conn = _build(tmp_path, "whole", rows)
    root = tmp_path / "whole"
    export_parquet.export(path, root)
    conn.close()
    # A value the scale could not hold, on either side of the cutoff.
    index = root / export_parquet.VERSION / "index"
    duckdb.connect().execute(
        "COPY (SELECT * FROM (VALUES"
        " ('2409E0000001', 'surface_habitable_logement', '78.55'),"
        " ('2409E0000005', 'surface_habitable_logement', '78.55')"
        ") t(numero_dpe, column_name, raw_value))"
        f" TO '{index / 'scale-violation.parquet'}' (FORMAT parquet)"
    )
    return root


RECENT_09 = {"2409E0000002", "2409E0000005", "2475E0000001"}
BASE_09 = {"2409E0000001", "2409E0000003", "2409E0000004", "2476E0000001"}


def test_every_row_lands_on_exactly_one_side(whole, tmp_path):
    """On the cutoff day is recent; the day before is not; a row with no date
    is never recent, since nothing says it is."""
    out = tmp_path / "publish"
    recent.split(whole, out, CUTOFF)
    base, paid = out / "v1", out / "recent" / "v1"

    for kind in ("dpe", "search"):
        assert _keys(_file(base, kind, "09")) == BASE_09, kind
        assert _keys(_file(paid, kind, "09")) == RECENT_09, kind
        assert _keys(_file(base, kind, "31")) == set(), kind
        assert _keys(_file(paid, kind, "31")) == {"2431E0000001"}, kind


def test_the_base_tree_holds_nothing_on_or_after_the_cutoff(whole, tmp_path):
    out = tmp_path / "publish"
    recent.split(whole, out, CUTOFF)
    for kind in ("dpe", "search"):
        latest = duckdb.connect().execute(
            "SELECT max(date_etablissement_dpe) FROM"
            f" read_parquet('{out}/v1/{kind}/*/*.parquet', hive_partitioning = false)"
        ).fetchone()[0]
        assert latest < CUTOFF, kind


def test_the_counts_file_carries_the_filters_and_nothing_that_names_a_row(whole, tmp_path):
    out = tmp_path / "publish"
    recent.split(whole, out, CUTOFF)
    date_col, columns = export_parquet.RECENT["existant"]
    for dept, n in (("09", len(RECENT_09)), ("31", 1)):
        counts = out / "v1" / "recent-counts" / f"dept={dept}" / "part-0000.parquet"
        assert _physical_columns(counts) == list(columns)
        assert not {"numero_dpe", "adresse_ban", "lat", "lon"} & set(columns)
        assert len(_rows(counts)) == n
        assert duckdb.connect().execute(
            f"SELECT min({date_col}) FROM read_parquet('{counts}')"
        ).fetchone()[0] >= CUTOFF


def test_the_indexes_follow_their_key(whole, tmp_path):
    out = tmp_path / "publish"
    recent.split(whole, out, CUTOFF)
    base, paid = out / "v1" / "index", out / "recent" / "v1" / "index"
    assert _keys(base / "numero-exceptions.parquet") == {"2476E0000001"}
    assert _keys(paid / "numero-exceptions.parquet") == {"2475E0000001"}
    assert _keys(base / "scale-violation.parquet") == {"2409E0000001"}
    assert _keys(paid / "scale-violation.parquet") == {"2409E0000005"}


def test_the_manifest_records_both_sides_and_their_checksums(whole, tmp_path):
    out = tmp_path / "publish"
    before = json.loads((whole / "v1" / "manifest.json").read_text())
    m = recent.split(whole, out, CUTOFF)
    assert json.loads((out / "v1" / "manifest.json").read_text()) == m
    assert m["recent"] == {
        "cutoff": "2026-07-19",
        "date_column": "date_etablissement_dpe",
        "counts_columns": list(export_parquet.RECENT["existant"][1]),
        "tree": "recent/v1",
    }
    assert m["high_water"] == before["high_water"]
    # `rows` stays the whole: reconcile and check_delta compare it to ADEME.
    assert {p["dept"]: p["rows"] for p in m["partitions"]} == {"09": 7, "31": 1}
    assert {p["dept"]: p["recent"]["rows"] for p in m["partitions"]} == {"09": 3, "31": 1}
    for p in m["partitions"]:
        for tree, entry in (
            (out / "v1", p["search"]),
            (out / "v1", p["dpe"]),
            (out / "v1", p["counts"]),
            (out / "recent" / "v1", p["recent"]["search"]),
            (out / "recent" / "v1", p["recent"]["dpe"]),
        ):
            path = tree / entry["path"]
            assert entry["sha256"] == export_parquet._sha256(path), entry["path"]
            assert entry["bytes"] == path.stat().st_size, entry["path"]


def test_every_file_is_written_even_when_it_is_empty(whole, tmp_path):
    """`rclone copy` never deletes: a partition whose last recent row aged out
    would otherwise keep last week's recent file, and serve it."""
    out = tmp_path / "publish"
    recent.split(whole, out, date(2027, 1, 1))
    for dept in ("09", "31"):
        for kind in ("dpe", "search"):
            assert _rows(_file(out / "recent" / "v1", kind, dept)) == []
        assert _rows(out / "v1" / "recent-counts" / f"dept={dept}" / "part-0000.parquet") == []
    assert (out / "recent" / "v1" / "manifest.json").exists()


def test_a_split_tree_is_refused(whole, tmp_path):
    out = tmp_path / "publish"
    recent.split(whole, out, CUTOFF)
    with pytest.raises(ValueError, match="already split"):
        recent.split(out, tmp_path / "again", CUTOFF)
    assert not (tmp_path / "again").exists()


def test_join_undoes_split(whole, tmp_path):
    out = tmp_path / "publish"
    recent.split(whole, out, CUTOFF)
    joined = tmp_path / "joined"
    recent.join(out, joined)

    for dept in ("09", "31"):
        for kind in ("dpe", "search"):
            assert _rows(_file(joined / "v1", kind, dept)) == _rows(_file(whole / "v1", kind, dept))
    for name in ("numero-exceptions.parquet", "scale-violation.parquet"):
        assert _rows(joined / "v1" / "index" / name) == _rows(whole / "v1" / "index" / name)
    assert not (joined / "v1" / "recent-counts").exists()

    def shape(m):
        return {
            **{k: v for k, v in m.items() if k != "partitions"},
            "partitions": [
                {k: v for k, v in p.items() if k not in ("search", "dpe")} for p in m["partitions"]
            ],
        }

    before = json.loads((whole / "v1" / "manifest.json").read_text())
    after = json.loads((joined / "v1" / "manifest.json").read_text())
    assert shape(after) == shape(before)
    for p in after["partitions"]:
        for kind in ("search", "dpe"):
            assert p[kind]["sha256"] == export_parquet._sha256(joined / "v1" / p[kind]["path"])


def test_join_copies_a_tree_that_was_never_split(whole, tmp_path):
    """The first weekly run after rollout reads the unsplit production trees."""
    joined = tmp_path / "joined"
    recent.join(whole, joined)
    for rel in (
        "manifest.json",
        "dpe/dept=09/part-0000.parquet",
        "search/dept=31/part-0000.parquet",
        "index/scale-violation.parquet",
        "index/numero-exceptions.parquet",
    ):
        assert (joined / "v1" / rel).read_bytes() == (whole / "v1" / rel).read_bytes(), rel


def test_join_refuses_a_tree_missing_rows(whole, tmp_path):
    """A recent file that did not download joins to a smaller tree, which the
    delta would then publish as the whole."""
    out = tmp_path / "publish"
    recent.split(whole, out, CUTOFF)
    m = json.loads((out / "v1" / "manifest.json").read_text())
    m["partitions"][0]["rows"] += 1
    (out / "v1" / "manifest.json").write_text(json.dumps(m))
    with pytest.raises(ValueError, match="dept=09"):
        recent.join(out, tmp_path / "joined")


def test_a_later_cutoff_moves_rows_back_into_the_base(whole, tmp_path):
    first = tmp_path / "first"
    recent.split(whole, first, CUTOFF)
    joined = tmp_path / "joined"
    recent.join(first, joined)
    second = tmp_path / "second"
    recent.main(["split", "--from", str(joined), "--out", str(second), "--cutoff", "2026-08-15"])

    assert _keys(_file(second / "recent" / "v1", "dpe", "09")) == {"2409E0000005"}
    assert _keys(_file(second / "v1", "dpe", "09")) == BASE_09 | {"2409E0000002", "2475E0000001"}
    assert _keys(_file(second / "v1", "dpe", "31")) == {"2431E0000001"}


def test_a_changed_recent_row_stays_recent_through_the_weekly_pass(whole, tmp_path):
    """join -> merge -> split, as the weekly job will run it."""
    out = tmp_path / "publish"
    recent.split(whole, out, CUTOFF)
    joined = tmp_path / "joined"
    recent.join(out, joined)

    dpath, dconn = _build(
        tmp_path,
        "delta",
        [_row("2409E0000005", "09", "2026-09-03", date_etablissement_dpe="2026-09-01", etiquette_dpe="A")],
    )
    export_parquet.export(dpath, tmp_path / "delta-out")
    dconn.close()
    merged = tmp_path / "merged"
    delta.merge(joined / "v1", tmp_path / "delta-out" / "v1", merged / "v1")

    again = tmp_path / "again"
    m = recent.split(merged, again, CUTOFF)
    assert m["high_water"] == "2026-09-03"
    got = duckdb.connect().execute(
        "SELECT numero_dpe, etiquette_dpe FROM"
        f" read_parquet('{_file(again / 'recent' / 'v1', 'dpe', '09')}') ORDER BY numero_dpe"
    ).fetchall()
    assert got == [("2409E0000002", "D"), ("2409E0000005", "A"), ("2475E0000001", "D")]
    assert "2409E0000005" not in _keys(_file(again / "v1", "dpe", "09"))


@pytest.mark.parametrize(
    "day, cutoff",
    [
        (date(2026, 9, 19), date(2026, 7, 19)),
        (date(2026, 1, 15), date(2025, 11, 15)),  # across a year
        (date(2026, 4, 30), date(2026, 2, 28)),  # no 30 February
        (date(2024, 4, 30), date(2024, 2, 29)),  # a leap year
        (date(2026, 5, 31), date(2026, 3, 31)),
        (date(2026, 3, 1), date(2026, 1, 1)),
    ],
)
def test_the_cutoff_counts_back_calendar_months(day, cutoff):
    assert recent.cutoff_for(day) == cutoff
