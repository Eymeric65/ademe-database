"""The weekly rewrites use the export's compression, not DuckDB's default.

ADR-0016 set zstd level 9 for the published Parquet -- 6.4% smaller -- through
`export_parquet.COMPRESSION`. The export reads it; the delta's two rewrites
(`merge_partition`, `apply_deletions`) wrote `COMPRESSION zstd` literally, so
every partition a weekly run touched went back to the default level.

The level is not recorded in the file, so size is the only place it shows. Both
sides here go through the same rewrite of the same rows; only the constant
differs.
"""

from __future__ import annotations

from ademe import delta, export_parquet
from tests.test_delta import FakeApi, _build, _row

ROWS = 3000


def _published(tmp_path):
    rows = [_row(f"2409E{i:07d}", "09", "2026-08-01") for i in range(ROWS)]
    path, conn = _build(tmp_path, "base", rows)
    export_parquet.export(path, tmp_path / "published")
    conn.close()
    return tmp_path / "published" / export_parquet.VERSION


def test_a_merged_partition_is_written_at_the_exports_level(tmp_path, monkeypatch):
    published = _published(tmp_path)
    dpath, dconn = _build(tmp_path, "delta", [_row("2409E0000001", "09", "2026-09-01", etiquette_dpe="A")])
    export_parquet.export(dpath, tmp_path / "delta-out")
    dconn.close()

    sizes = {}
    for level in (1, 19):
        monkeypatch.setattr(export_parquet, "COMPRESSION", f"COMPRESSION zstd, COMPRESSION_LEVEL {level}")
        out = tmp_path / f"merged-{level}"
        delta.merge(published, tmp_path / "delta-out" / export_parquet.VERSION, out)
        sizes[level] = (out / "dpe" / "dept=09" / "part-0000.parquet").stat().st_size
    assert sizes[19] < sizes[1], f"{sizes}: the merge ignores export_parquet.COMPRESSION"


def test_a_partition_rewritten_for_deletions_is_written_at_the_exports_level(tmp_path, monkeypatch):
    published = _published(tmp_path)
    # Upstream lost one certificate, so the partition is rewritten.
    fake = FakeApi({"09": [f"2409E{i:07d}" for i in range(1, ROWS)]})
    monkeypatch.setattr(delta.api, "total", fake.total)
    monkeypatch.setattr(delta.api, "iter_pages", fake.iter_pages)
    report = delta.reconcile(None, published)

    sizes = {}
    for level in (1, 19):
        monkeypatch.setattr(export_parquet, "COMPRESSION", f"COMPRESSION zstd, COMPRESSION_LEVEL {level}")
        out = tmp_path / f"reconciled-{level}"
        delta.apply_deletions(published, report, out)
        sizes[level] = (out / "dpe" / "dept=09" / "part-0000.parquet").stat().st_size
    assert sizes[19] < sizes[1], f"{sizes}: apply_deletions ignores export_parquet.COMPRESSION"
