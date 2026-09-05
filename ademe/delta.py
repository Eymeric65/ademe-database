"""The weekly incremental. `python -m ademe.delta --out DIR`

ADR-0005 decided this shape: the full 17-hour build is done once, by hand, and
CI only ever moves the difference. The incremental key is
`date_derniere_modification_dpe`, which ADEME documents for exactly this.

Three steps, and the third is the one that has to be exactly right:

  1. fetch every row modified after the manifest's high-water mark, normalising
     it through the SAME Loader the base build used, into a temporary SQLite;
  2. export that with the SAME exporter, so the delta files and the published
     files cannot disagree about types;
  3. merge per touched partition: anti-join the base on numero_dpe, union the
     delta, re-sort, rewrite. A merge that drops a row is invisible -- the file
     still parses and one certificate has simply stopped existing.

The manifest is written last, so a failed run cannot take the app down and a
rollback is a manifest edit (ADR-0002).
"""

from __future__ import annotations

import argparse
import json
import shutil
import tempfile
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path

import duckdb

from ademe import api, db, export_parquet, ingest, schema, spec
from ademe.config import DEFAULT_DB, PAGE_SIZE
from ademe.export_parquet import DPE_ROW_GROUP, SEARCH_COLUMNS, SEARCH_ROW_GROUP, SEARCH_SORT


def is_url(root: Path | str) -> bool:
    return str(root).startswith(("http://", "https://"))


_client = None


def _http():
    """The project's own httpx client, not urllib.

    TRAP: Cloudflare answers `Python-urllib/3.x` with 403. The published data
    sits behind Cloudflare, so a plain urlopen of the manifest fails in the
    weekly job with a Forbidden that has nothing to do with permissions --
    `api.client()` sends a real User-Agent, and brings the retry and timeout
    handling with it.
    """
    global _client
    if _client is None:
        _client = api.client()
    return _client


def read_manifest(root: Path | str) -> dict:
    if is_url(root):
        return json.loads(api._get(_http(), f"{root}/manifest.json").content)
    return json.loads((Path(root) / "manifest.json").read_text())


def scales_from(manifest: dict) -> dict[str, int]:
    """The scales the base build used, so the delta encodes identically.

    Only the columns actually stored as scaled integers: a column that was too
    precise to scale is 'text', and handing its scale back would silently
    re-enable the truncation the fallback exists to prevent.
    """
    return {
        column: meta["scale"]
        for column, meta in manifest["column_meta"].items()
        if meta["encoding"] == "scaled" and meta["scale"] != 1
    }


# --- fetch ------------------------------------------------------------------


def fetch_delta(
    client, since: str, db_path: Path, manifest: dict, *, page_size: int = PAGE_SIZE, quiet=True
) -> int:
    """Load every certificate modified on or after `since` into a fresh SQLite."""
    scales = scales_from(manifest)
    schema.build(db_path, scales=scales)
    conn = db.connect(db_path, bulk=True)
    try:
        loader = ingest.Loader(conn, spec.load(scales))
        loaded = 0
        # Inclusive lower bound: the mark is a DATE, so a strict bound would
        # drop everything else modified on the same day as the last run.
        qs = f"date_derniere_modification_dpe:[{since} TO *]"
        for page in api.iter_pages(client, qs=qs, page_size=page_size):
            with db.transaction(conn):
                loaded += loader.load_page(page.rows)
            if not quiet:
                print(f"\r  fetched {loaded:,}", end="", flush=True)
        conn.execute(
            "INSERT INTO ingest_departement"
            " (code_departement, total_expected, rows_loaded, started_at, completed_at)"
            " VALUES ('delta', ?, ?, datetime(), datetime())"
            " ON CONFLICT(code_departement) DO UPDATE SET rows_loaded = excluded.rows_loaded",
            (loaded, loaded),
        )
        conn.commit()
        if not quiet:
            print()
        return loaded
    finally:
        conn.close()


# --- merge ------------------------------------------------------------------


def _partitions(root: Path | str, kind: str) -> set[str]:
    manifest = read_manifest(root)
    return {p["dept"] for p in manifest["partitions"]}


def _url(root: Path | str, *parts: str) -> str:
    if is_url(root):
        return f"{root}/" + "/".join(parts)
    return str(Path(root).joinpath(*parts))


def merge_partition(duck, base: Path | str, delta_dir: Path, dept: str, out: Path) -> int:
    """Rewrite one partition as (base minus the delta's ids) plus the delta.

    Anti-join on numero_dpe, never a plain UNION: a certificate that was
    modified exists in both, and appending would publish it twice -- which the
    search would show as a duplicate result and the detail view would resolve
    arbitrarily.
    """
    for kind, row_group, columns, order in (
        ("dpe", DPE_ROW_GROUP, "*", "numero_dpe"),
        ("search", SEARCH_ROW_GROUP, ", ".join(f'"{c}"' for c in SEARCH_COLUMNS),
         ", ".join(f'"{c}"' for c in SEARCH_SORT)),
    ):
        base_file = _url(base, kind, f"dept={dept}", "part-0000.parquet")
        delta_file = delta_dir / kind / f"dept={dept}" / "part-0000.parquet"
        dest = out / kind / f"dept={dept}" / "part-0000.parquet"
        dest.parent.mkdir(parents=True, exist_ok=True)

        duck.execute(
            f"""COPY (
                  SELECT {columns} FROM (
                    SELECT * FROM read_parquet('{base_file}')
                    WHERE numero_dpe NOT IN (
                      SELECT numero_dpe FROM read_parquet('{delta_file}')
                    )
                    UNION ALL BY NAME
                    SELECT * FROM read_parquet('{delta_file}')
                  )
                  ORDER BY {order}
                ) TO '{dest}'
                (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE {row_group})"""
        )

    return duck.execute(
        f"SELECT COUNT(*) FROM read_parquet('{out / 'dpe' / f'dept={dept}' / 'part-0000.parquet'}')"
    ).fetchone()[0]


def merge(base: Path | str, delta_dir: Path, out: Path) -> list[str]:
    """Merge every partition the delta touched. Returns the ones rewritten.

    Partitions the delta never mentioned are COPIED, not rebuilt. Rewriting
    them would be pure risk: new bytes, a new checksum, and a chance to lose a
    row for no reason at all.
    """
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    base_manifest = read_manifest(base)
    delta_manifest = read_manifest(delta_dir)

    touched = sorted(p["dept"] for p in delta_manifest["partitions"])
    duck = duckdb.connect()
    duck.execute("INSTALL httpfs; LOAD httpfs")

    rows: dict[str, int] = {}
    for part in base_manifest["partitions"]:
        dept = part["dept"]
        if dept in touched:
            rows[dept] = merge_partition(duck, base, delta_dir, dept, out)
        else:
            for kind in ("dpe", "search"):
                src = _url(base, kind, f"dept={dept}", "part-0000.parquet")
                dest = out / kind / f"dept={dept}" / "part-0000.parquet"
                dest.parent.mkdir(parents=True, exist_ok=True)
                _copy(src, dest)
            rows[dept] = part["rows"]

    # A departement that had no certificates at all until this week.
    for dept in touched:
        if dept in rows:
            continue
        for kind in ("dpe", "search"):
            src = delta_dir / kind / f"dept={dept}" / "part-0000.parquet"
            dest = out / kind / f"dept={dept}" / "part-0000.parquet"
            dest.parent.mkdir(parents=True, exist_ok=True)
            _copy(str(src), dest)
        rows[dept] = next(
            p["rows"] for p in delta_manifest["partitions"] if p["dept"] == dept
        )

    for name in ("numero-exceptions.parquet", "scale-violation.parquet"):
        src = _url(base, "index", name)
        dest = out / "index" / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        _copy(src, dest)

    write_manifest(base_manifest, delta_manifest, rows, out)
    duck.close()
    return touched


def _copy(src: str, dest: Path) -> None:
    if is_url(src):
        dest.write_bytes(api._get(_http(), src).content)
    else:
        shutil.copyfile(src, dest)


def write_manifest(base_manifest: dict, delta_manifest: dict, rows: dict[str, int], out: Path):
    partitions = []
    for dept in sorted(rows):
        entry = {"dept": dept, "rows": rows[dept]}
        for source in (delta_manifest, base_manifest):
            match = next((p for p in source["partitions"] if p["dept"] == dept), None)
            if match and "codes" in match:
                entry["codes"] = match["codes"]
                break
        for kind in ("search", "dpe"):
            path = out / kind / f"dept={dept}" / "part-0000.parquet"
            entry[kind] = {
                "path": f"{kind}/dept={dept}/part-0000.parquet",
                "bytes": path.stat().st_size,
                "sha256": export_parquet._sha256(path),
            }
        partitions.append(entry)

    manifest = dict(base_manifest)
    manifest["built_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    # TRAP: never max(old, new) blindly -- take the delta's mark only when it
    # actually moved forward. A delta that fetched nothing must leave the mark
    # where it is, or the next run skips the window in between and those rows
    # never come back.
    high = delta_manifest.get("high_water")
    if high and (not base_manifest.get("high_water") or high > base_manifest["high_water"]):
        manifest["high_water"] = high
    manifest["partitions"] = partitions
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False))
    return manifest


# --- reconciliation ---------------------------------------------------------


class ReconcileError(RuntimeError):
    """Upstream contradicted itself, or the partition still disagrees after a
    repair. Either way the manifest is not swapped."""


@dataclass
class Divergence:
    """What one partition holds against what ADEME holds."""

    dept: str
    published: int
    upstream: int
    gone: list[str] = field(default_factory=list)
    appeared: list[str] = field(default_factory=list)

    def clean(self) -> bool:
        return not self.gone and not self.appeared


def _published_ids(duck, root: Path | str, dept: str) -> list[str]:
    path = _url(root, "dpe", f"dept={dept}", "part-0000.parquet")
    return [
        r[0]
        for r in duck.execute(
            f"SELECT numero_dpe FROM read_parquet('{path}')"
        ).fetchall()
    ]


def reconcile(client, root: Path | str, *, quiet: bool = True) -> dict[str, Divergence]:
    """Compare every partition against ADEME, by count first and ids only if needed.

    The delta cannot see a deletion. `dpe03existant` is a Data Fair VIRTUAL
    dataset over a private child, filtered `dpe_desactive = 0`, and that field
    is not in the public schema -- a deactivated certificate simply leaves the
    view, and `date_derniere_modification_dpe > mark` never returns it. An
    upsert-only merge would keep it forever. See ADR-0007.

    The count is checked first because the id pull is not free: measured at
    16.0 B a row, the whole dataset is ~248 MB and about eight minutes at
    ADEME's documented 500 kB/s. Spending that every week on partitions that
    already agree would be the difference between a polite job and a rude one.
    """
    manifest = read_manifest(root)
    duck = duckdb.connect()
    duck.execute("INSTALL httpfs; LOAD httpfs")

    report: dict[str, Divergence] = {}
    for part in manifest["partitions"]:
        dept = part["dept"]
        codes = part.get("codes", [dept])
        upstream = sum(api.total(client, departement=c) for c in codes)
        div = Divergence(dept=dept, published=part["rows"], upstream=upstream)

        if upstream != part["rows"]:
            here = set(_published_ids(duck, root, dept))
            there: set[str] = set()
            for code in codes:
                for page in api.iter_pages(
                    client, departement=code, select=["numero_dpe"], page_size=PAGE_SIZE
                ):
                    there.update(r["numero_dpe"] for r in page.rows)

            # TRAP: upstream has to agree with itself before we act on it.
            # Deleting rows on the strength of a total that disagrees with the
            # ids behind it is deleting on the strength of a number known wrong.
            if len(there) != upstream:
                raise ReconcileError(
                    f"dept {dept}: total says {upstream} but the id pull returned"
                    f" {len(there)}; refusing to reconcile against a source that"
                    " contradicts itself"
                )
            div.gone = sorted(here - there)
            div.appeared = sorted(there - here)

        if not quiet:
            state = "ok" if div.clean() else f"-{len(div.gone)} +{len(div.appeared)}"
            print(f"  dept={dept}: published {div.published}, upstream {upstream} [{state}]")
        report[dept] = div

    duck.close()
    return report


def apply_deletions(root: Path | str, report: dict[str, Divergence], out: Path) -> list[str]:
    """Rewrite every partition that lost rows, and carry the rest over.

    Only deletions. Certificates that APPEARED upstream come back through the
    ordinary delta path, which already knows how to normalise a full record --
    reconciliation only ever sees an id.
    """
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    manifest = read_manifest(root)
    duck = duckdb.connect()
    duck.execute("INSTALL httpfs; LOAD httpfs")

    rewritten: list[str] = []
    rows: dict[str, int] = {}
    for part in manifest["partitions"]:
        dept = part["dept"]
        div = report.get(dept)
        gone = div.gone if div else []

        for kind, row_group, columns, order in (
            ("dpe", DPE_ROW_GROUP, "*", "numero_dpe"),
            ("search", SEARCH_ROW_GROUP, ", ".join(f'"{c}"' for c in SEARCH_COLUMNS),
             ", ".join(f'"{c}"' for c in SEARCH_SORT)),
        ):
            src = _url(root, kind, f"dept={dept}", "part-0000.parquet")
            dest = out / kind / f"dept={dept}" / "part-0000.parquet"
            dest.parent.mkdir(parents=True, exist_ok=True)
            if not gone:
                _copy(src, dest)
                continue
            ids = ", ".join(f"'{n}'" for n in gone)
            duck.execute(
                f"COPY (SELECT {columns} FROM read_parquet('{src}')"
                f" WHERE numero_dpe NOT IN ({ids}) ORDER BY {order}) TO '{dest}'"
                f" (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE {row_group})"
            )
        if gone:
            rewritten.append(dept)
        rows[dept] = part["rows"] - len(gone)

    for name in ("numero-exceptions.parquet", "scale-violation.parquet"):
        src = _url(root, "index", name)
        dest = out / "index" / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        _copy(src, dest)

    write_manifest(manifest, manifest, rows, out)
    duck.close()
    return rewritten


# --- alerting ---------------------------------------------------------------


def sharp_departure(runs: list[dict], rows_changed: int, *, window: int = 8, factor: int = 3):
    """True when this run moved far more rows than the recent norm.

    ADEME republishing a whole departement, or a schema change upstream, looks
    from here like an ordinary week with a big number. The point is to stop and
    be looked at rather than to publish it.
    """
    recent = [r["rows_changed"] for r in runs[-window:] if "rows_changed" in r]
    if len(recent) < 3:
        return False, None  # not enough history to have a norm
    ordered = sorted(recent)
    n = len(ordered)
    median = (ordered[n // 2] if n % 2 else (ordered[n // 2 - 1] + ordered[n // 2]) / 2)
    return rows_changed > factor * median, median


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--base-url", required=True, help="the published v1/ directory or URL")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--since", help="override the manifest's high_water")
    ap.add_argument("--db-path", type=Path, help="keep the delta SQLite instead of a temp file")
    args = ap.parse_args(argv)

    manifest = read_manifest(args.base_url)
    since = args.since or manifest.get("high_water")
    if not since:
        ap.error("no high_water in the manifest and no --since given")
    print(f"delta since {since}")

    tmp = Path(args.db_path) if args.db_path else Path(tempfile.mkdtemp()) / "delta.sqlite"
    loaded = fetch_delta(api.client(), since, tmp, manifest, quiet=False)
    print(f"fetched {loaded:,} modified certificates")
    if not loaded:
        print("nothing changed; the manifest is left alone")
        return 0

    delta_out = tmp.parent / "parquet"
    export_parquet.export(tmp, delta_out)
    # Into <out>/v1/, the same shape ademe.export_parquet writes and the same
    # shape the published bucket has -- so the upload step copies v1/ to v1/
    # rather than having to know that this one command is different.
    destination = args.out / export_parquet.VERSION
    touched = merge(args.base_url, delta_out / export_parquet.VERSION, destination)
    print(f"rewrote {len(touched)} partition(s) into {destination}: {', '.join(touched)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
