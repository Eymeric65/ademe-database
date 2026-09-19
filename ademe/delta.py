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
import re
import shutil
import tempfile
from bisect import bisect_left
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import duckdb

from ademe import api, db, export_parquet, ingest, schema, spec
from ademe.config import DEFAULT_DB, EXISTANT, PAGE_SIZE, SOURCES, Source
from ademe.export_parquet import DPE_ROW_GROUP, SEARCH_ROW_GROUP


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


def _fetch(
    client,
    queries,
    db_path: Path,
    manifest: dict,
    *,
    page_size: int = PAGE_SIZE,
    quiet=True,
    source: Source = EXISTANT,
    mark: str | None = None,
    ledger: str = "delta",
) -> int:
    """Load every row matching any of `queries` into a fresh SQLite.

    One Loader, one schema, one ledger row, whether the query is a window over
    the modification date (the weekly delta) or a list of ids (a repair).
    """
    scales = scales_from(manifest)
    schema.build(db_path, scales=scales, source=source)
    conn = db.connect(db_path, bulk=True)
    try:
        loader = ingest.Loader(conn, spec.load(scales, source=source), source=source)
        loaded = 0
        for qs in queries:
            for page in api.iter_pages(client, qs=qs, page_size=page_size, source=source):
                with db.transaction(conn):
                    loaded += loader.load_page(page.rows)
                if not quiet:
                    print(f"\r  fetched {loaded:,}", end="", flush=True)
        conn.execute(
            "INSERT INTO ingest_departement"
            " (code_departement, total_expected, rows_loaded, started_at, completed_at,"
            "  upstream_high_water)"
            f" VALUES ('{ledger}', ?, ?, datetime(), datetime(), ?)"
            " ON CONFLICT(code_departement) DO UPDATE SET rows_loaded = excluded.rows_loaded",
            (loaded, loaded, mark),
        )
        conn.commit()
        if not quiet:
            print()
        return loaded
    finally:
        conn.close()


def fetch_delta(
    client,
    since: str,
    db_path: Path,
    manifest: dict,
    *,
    page_size: int = PAGE_SIZE,
    quiet=True,
    source: Source = EXISTANT,
) -> int:
    """Load every certificate modified on or after `since` into a fresh SQLite."""
    # Inclusive lower bound: the mark is a DATE, so a strict bound would
    # drop everything else modified on the same day as the last run.
    qs = f"{source.mapping.modified}:[{since} TO *]"
    mark = api.high_water(client, source=source)  # before the first page: ADR-0041
    return _fetch(
        client,
        [qs],
        db_path,
        manifest,
        page_size=page_size,
        quiet=quiet,
        source=source,
        mark=mark,
    )


# A repair asks for its rows by id, so the query is a list of them. The chunk
# is what fits a URL with room to spare; `test_an_id_list_query_returns_exactly
# _those_ids` checks the server agrees. See ADR-0043.
ID_CHUNK = 100


def id_queries(key: str, ids, chunk: int = ID_CHUNK):
    """`key:("a" OR "b" …)`, in chunks.

    TRAP: the bound of a RANGE cannot be quoted (ADR-0040), but a term must be:
    a bare id with a hyphen in it parses as an operator.
    """
    ordered = sorted(ids)
    for i in range(0, len(ordered), chunk):
        part = ordered[i : i + chunk]
        yield f"{key}:(" + " OR ".join(f'"{n}"' for n in part) + ")"


def fetch_ids(
    client,
    ids,
    db_path: Path,
    manifest: dict,
    *,
    quiet=True,
    source: Source = EXISTANT,
) -> int:
    """Load the named rows, whole, into a fresh SQLite.

    No mark: a repair fetches rows of any age, and a mark taken from them would
    move the manifest's high water forward over rows nobody asked for. See
    `merge(keep_mark=True)` and ADR-0043.
    """
    return _fetch(
        client,
        id_queries(source.mapping.key, ids),
        db_path,
        manifest,
        quiet=quiet,
        source=source,
        ledger="repair",
    )


# --- merge ------------------------------------------------------------------


def _partitions(root: Path | str, kind: str) -> set[str]:
    manifest = read_manifest(root)
    return {p["dept"] for p in manifest["partitions"]}


def _url(root: Path | str, *parts: str) -> str:
    if is_url(root):
        return f"{root}/" + "/".join(parts)
    return str(Path(root).joinpath(*parts))


def _search(source: Source) -> tuple[str, str]:
    """The source's search columns and sort, as SQL lists. ADR-0018."""
    columns, order = export_parquet.SEARCH[source.slug]
    return ", ".join(f'"{c}"' for c in columns), ", ".join(f'"{c}"' for c in order)


def merge_partition(
    duck,
    base: Path | str,
    delta_dir: Path | None,
    dept: str,
    out: Path,
    source: Source = EXISTANT,
    gone: "set[str] | tuple" = (),
) -> int:
    """Rewrite one partition as (base minus the delta's ids, minus `gone`) plus
    the delta.

    Anti-join on numero_dpe, never a plain UNION: a certificate that was
    modified exists in both, and appending would publish it twice -- which the
    search would show as a duplicate result and the detail view would resolve
    arbitrarily. On the source's own key (ADR-0029): an audit's steps share a
    numero_dpe, and anti-joining on it would delete a changed step's siblings.

    `gone` are the ids reconciliation found upstream no longer has. They are
    removed in the same rewrite as the additions rather than in a pass of their
    own, which would mean a second whole copy of the tree on the runner's disk.
    """
    key = source.mapping.key
    for kind, row_group, columns, order in (
        ("dpe", DPE_ROW_GROUP, "*", key),
        ("search", SEARCH_ROW_GROUP, *_search(source)),
    ):
        base_file = _url(base, kind, f"dept={dept}", "part-0000.parquet")
        delta_file = (
            delta_dir / kind / f"dept={dept}" / "part-0000.parquet" if delta_dir else None
        )
        has_delta = delta_file is not None and delta_file.exists()
        dest = out / kind / f"dept={dept}" / "part-0000.parquet"
        dest.parent.mkdir(parents=True, exist_ok=True)

        where = []
        if has_delta:
            where.append(f"{key} NOT IN (SELECT {key} FROM read_parquet('{delta_file}'))")
        if gone:
            where.append(f"{key} NOT IN ({', '.join(repr(str(n)) for n in sorted(gone))})")

        # TRAP: hive_partitioning = false on every SELECT *. The files live
        # under `dept=NN/`, which DuckDB otherwise reads as a `dept` column,
        # and this rewrite would store it: a 229th column the export never
        # wrote, in every partition a weekly delta touches.
        kept = (
            f"SELECT * FROM read_parquet('{base_file}', hive_partitioning = false)"
            + (f" WHERE {' AND '.join(where)}" if where else "")
        )
        if has_delta:
            kept += (
                " UNION ALL BY NAME"
                f" SELECT * FROM read_parquet('{delta_file}', hive_partitioning = false)"
            )
        duck.execute(
            f"""COPY (
                  SELECT {columns} FROM ({kept})
                  ORDER BY {order}
                ) TO '{dest}'
                (FORMAT parquet, {export_parquet.COMPRESSION}, ROW_GROUP_SIZE {row_group})"""
        )

    return duck.execute(
        f"SELECT COUNT(*) FROM read_parquet('{out / 'dpe' / f'dept={dept}' / 'part-0000.parquet'}')"
    ).fetchone()[0]


def merge(
    base: Path | str,
    delta_dir: Path,
    out: Path,
    source: Source = EXISTANT,
    *,
    deleted: dict[str, list[str]] | None = None,
    keep_mark: bool = False,
) -> list[str]:
    """Merge every partition the delta touched. Returns the ones rewritten.

    Partitions the delta never mentioned are COPIED, not rebuilt. Rewriting
    them would be pure risk: new bytes, a new checksum, and a chance to lose a
    row for no reason at all.

    `deleted` names, per partition, the ids reconciliation found gone upstream;
    `keep_mark` leaves the high-water mark where the base had it, which is what
    a repair wants (ADR-0043).
    """
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    base_manifest = read_manifest(base)
    delta_manifest = read_manifest(delta_dir)
    deleted = {d: set(g) for d, g in (deleted or {}).items() if g}

    touched = sorted({p["dept"] for p in delta_manifest["partitions"]} | set(deleted))
    duck = duckdb.connect()
    duck.execute("INSTALL httpfs; LOAD httpfs")

    rows: dict[str, int] = {}
    for part in base_manifest["partitions"]:
        dept = part["dept"]
        if dept in touched:
            rows[dept] = merge_partition(
                duck, base, delta_dir, dept, out, source, gone=deleted.get(dept, ())
            )
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

    write_manifest(base_manifest, delta_manifest, rows, out, keep_mark=keep_mark)
    duck.close()
    return touched


def _copy(src: str, dest: Path) -> None:
    if is_url(src):
        dest.write_bytes(api._get(_http(), src).content)
    else:
        shutil.copyfile(src, dest)


def write_manifest(
    base_manifest: dict,
    delta_manifest: dict,
    rows: dict[str, int],
    out: Path,
    *,
    keep_mark: bool = False,
):
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
    #
    # TRAP: a repair fetches rows by id, of any age, and the newest of them says
    # nothing about what ADEME held when anything was fetched. Adopting it would
    # move the mark forward over rows no pass ever asked for -- exactly the hole
    # ADR-0041 closed. So a repair pins the base's mark. See ADR-0043.
    high = None if keep_mark else delta_manifest.get("high_water")
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


def _published_ids(duck, root: Path | str, dept: str, key: str = "numero_dpe") -> list[str]:
    path = _url(root, "dpe", f"dept={dept}", "part-0000.parquet")
    return [
        r[0]
        for r in duck.execute(
            f"SELECT {key} FROM read_parquet('{path}')"
        ).fetchall()
    ]


# A range holding this many published rows or fewer is pulled rather than
# split again; a split costs FANOUT counts. See ADR-0040.
LEAF = 2_000
FANOUT = 8


# TRAP: Data Fair's qs parser rejects a quoted range bound (`Expected "."`),
# so a bound goes in bare -- and is only ever cut at a key made of these.
_BARE = re.compile(r"[A-Za-z0-9-]+")


def _range_qs(key: str, lo: str | None, hi: str | None) -> str | None:
    """`key` in [lo, hi); None is an open end. Both open is the whole
    departement, which needs no clause at all."""
    if lo is None and hi is None:
        return None
    start = "*" if lo is None else lo
    return f"{key}:[{start} TO *]" if hi is None else f"{key}:[{start} TO {hi}}}"


def _narrow(
    client,
    source: Source,
    dept: str,
    codes: list[str],
    here: list[str],
    lo: str | None,
    hi: str | None,
    upstream: int,
) -> tuple[set[str], set[str]]:
    """(gone, appeared) within [lo, hi), whose sorted published keys are `here`
    and whose count upstream is `upstream`.

    Counts over ranges of the key are exact and cost one request each, where
    pulling the ids of a whole departement costs a page per 10,000 of them.
    So a range that disagrees is split at its published quantiles and only the
    sub-ranges that still disagree are followed, down to LEAF rows.
    """
    key = source.mapping.key
    if upstream == len(here):
        return set(), set()

    # Strictly inside the range: a cut at `lo` would hand the whole range back
    # to itself, forever.
    cuts = sorted(
        {
            c
            for c in (here[len(here) * i // FANOUT] for i in range(1, FANOUT))
            if _BARE.fullmatch(c) and (lo is None or c > lo)
        }
    )
    if len(here) <= LEAF or not cuts:
        rng = _range_qs(key, lo, hi)
        there: set[str] = set()
        for code in codes:
            for page in api.iter_pages(
                client,
                departement=code,
                qs=rng,
                select=[key],
                page_size=PAGE_SIZE,
                source=source,
            ):
                there.update(r[key] for r in page.rows)

        # TRAP: upstream has to agree with itself before we act on it.
        # Deleting rows on the strength of a total that disagrees with the
        # ids behind it is deleting on the strength of a number known wrong.
        if len(there) != upstream:
            raise ReconcileError(
                f"dept {dept}: total says {upstream} for {rng or 'the departement'}"
                f" but the id pull returned {len(there)}; refusing to reconcile"
                " against a source that contradicts itself"
            )
        mine = set(here)
        return mine - there, there - mine

    bounds = [lo, *cuts, hi]
    gone: set[str] = set()
    appeared: set[str] = set()
    for a, b in zip(bounds, bounds[1:]):
        start = 0 if a is None else bisect_left(here, a)
        end = len(here) if b is None else bisect_left(here, b)
        sub = here[start:end]
        count = sum(
            api.total(client, departement=c, qs=_range_qs(key, a, b), source=source)
            for c in codes
        )
        g, n = _narrow(client, source, dept, codes, sub, a, b, count)
        gone |= g
        appeared |= n
    return gone, appeared


def reconcile(
    client, root: Path | str, *, quiet: bool = True, source: Source = EXISTANT
) -> dict[str, Divergence]:
    """Compare every partition against ADEME, by count first and ids only if needed.

    The delta cannot see a deletion. `dpe03existant` is a Data Fair VIRTUAL
    dataset over a private child, filtered `dpe_desactive = 0`, and that field
    is not in the public schema -- a deactivated certificate simply leaves the
    view, and `date_derniere_modification_dpe > mark` never returns it. An
    upsert-only merge would keep it forever. See ADR-0007.

    The count is checked first because the id pull is not free, and a
    mismatch is narrowed by counts over ranges of the key before any id is
    pulled -- see ADR-0040 and `_narrow`.
    """
    manifest = read_manifest(root)
    duck = duckdb.connect()
    duck.execute("INSTALL httpfs; LOAD httpfs")

    report: dict[str, Divergence] = {}
    for part in manifest["partitions"]:
        dept = part["dept"]
        codes = part.get("codes", [dept])
        upstream = sum(api.total(client, departement=c, source=source) for c in codes)
        div = Divergence(dept=dept, published=part["rows"], upstream=upstream)

        if upstream != part["rows"]:
            here = sorted(_published_ids(duck, root, dept, source.mapping.key))
            gone, appeared = _narrow(client, source, dept, codes, here, None, None, upstream)
            div.gone = sorted(gone)
            div.appeared = sorted(appeared)

        if not quiet:
            state = "ok" if div.clean() else f"-{len(div.gone)} +{len(div.appeared)}"
            print(f"  dept={dept}: published {div.published}, upstream {upstream} [{state}]")
        report[dept] = div

    duck.close()
    return report


def apply_deletions(
    root: Path | str, report: dict[str, Divergence], out: Path, source: Source = EXISTANT
) -> list[str]:
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
        key = source.mapping.key

        for kind, row_group, columns, order in (
            ("dpe", DPE_ROW_GROUP, "*", key),
            ("search", SEARCH_ROW_GROUP, *_search(source)),
        ):
            src = _url(root, kind, f"dept={dept}", "part-0000.parquet")
            dest = out / kind / f"dept={dept}" / "part-0000.parquet"
            dest.parent.mkdir(parents=True, exist_ok=True)
            if not gone:
                _copy(src, dest)
                continue
            ids = ", ".join(f"'{n}'" for n in gone)
            # hive_partitioning = false, for the reason in merge_partition.
            duck.execute(
                f"COPY (SELECT {columns} FROM read_parquet('{src}', hive_partitioning = false)"
                f" WHERE {key} NOT IN ({ids}) ORDER BY {order}) TO '{dest}'"
                f" (FORMAT parquet, {export_parquet.COMPRESSION}, ROW_GROUP_SIZE {row_group})"
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


# --- holes -------------------------------------------------------------------


# A month whose count agrees costs one request. A month that disagrees costs a
# count per day in it, and a day that disagrees costs that day's ids. More days
# than this disagreeing is not a hole, it is an event: stop and be looked at.
MAX_HOLE_DAYS = 60

# Rows one run repairs on its own. Past it, publish nothing and say what to run
# by hand -- the ETL is polite, and a repair is ADEME's time too (CLAUDE.md §11).
MAX_REPAIR = 50_000


def _duck():
    duck = duckdb.connect()
    duck.execute("INSTALL httpfs; LOAD httpfs")
    return duck


def _dpe_files(root: Path | str, manifest: dict) -> list[str]:
    return [
        _url(root, "dpe", f"dept={p['dept']}", "part-0000.parquet")
        for p in manifest["partitions"]
    ]


def _by_date(duck, files: list[str], modified: str, width: int) -> dict[str, int]:
    """Published rows by the first `width` characters of the modified field --
    7 is a month, 10 a day.

    Cast to text rather than to a date: the column is a DATE in one source and
    an ISO string in another, and both bucket the same this way. A row with no
    date at all buckets as ''.
    """
    scan = ", ".join(f"'{f}'" for f in files)
    return {
        bucket: n
        for bucket, n in duck.execute(
            f"SELECT COALESCE(substr(CAST(\"{modified}\" AS VARCHAR), 1, {width}), '') AS bucket,"
            f" COUNT(*) FROM read_parquet([{scan}], hive_partitioning = false) GROUP BY 1"
        ).fetchall()
    }


def _month(month: str) -> tuple[str, str]:
    """[first day, first day of the next month)."""
    year, mon = (int(part) for part in month.split("-"))
    return (
        date(year, mon, 1).isoformat(),
        date(year + (mon == 12), mon % 12 + 1, 1).isoformat(),
    )


def _window_qs(modified: str, lo: str | None, hi: str | None) -> str:
    """A half-open window over the modification date; no window at all is the
    rows that have none."""
    if lo is None:
        return f"NOT _exists_:{modified}"
    return f"{modified}:[{lo} TO {hi}}}"


def date_holes(client, root: Path | str, *, source: Source = EXISTANT, quiet: bool = True) -> set[str]:
    """The ids ADEME holds under a modification date that this tree does not.

    The second axis, and it sees what counting per partition cannot. A row we
    hold at an OLDER version than ADEME's has the same id and the same
    département: the count agrees and the content is stale. Here it shows up
    twice -- a row too many in the month we hold it under, and one too few in
    the month ADEME holds it under.

    It is also the axis the hole of 2026-09 was measured on (ADR-0041): 27 211
    rows published against 33 471 upstream for 09-01..09-03, which no count per
    département could see, because the rows were never fetched at all.

    Months first, one count each. Only a month that disagrees is split into
    days, and only a day that disagrees has its ids pulled.
    """
    manifest = read_manifest(root)
    modified, key = source.mapping.modified, source.mapping.key
    duck = _duck()
    try:
        files = _dpe_files(root, manifest)
        mine = _by_date(duck, files, modified, 7)
        newest = (api.high_water(client, source=source) or "")[:7]
        months = sorted(m for m in mine if m)
        # Every month from the oldest published one to the one ADEME is
        # publishing into now, so a month this tree holds nothing in is counted
        # too -- a whole missing month is exactly the shape of a bad mark.
        walk = months[0] if months else newest
        wanted: list[str] = []
        while walk and newest and walk <= newest:
            wanted.append(walk)
            walk = _month(walk)[1][:7]

        suspect: list[tuple[str | None, str | None]] = []
        for month in wanted:
            lo, hi = _month(month)
            if api.total(client, qs=_window_qs(modified, lo, hi), source=source) != mine.get(month, 0):
                suspect.append((lo, hi))
        if api.total(client, qs=_window_qs(modified, None, None), source=source) != mine.get("", 0):
            suspect.append((None, None))
        if not quiet:
            print(f"  {len(wanted)} month(s) counted, {len(suspect)} disagree")
        if not suspect:
            return set()

        by_day = _by_date(duck, files, modified, 10)
        days: list[tuple[str | None, str | None]] = []
        for lo, hi in suspect:
            if lo is None:
                days.append((None, None))
                continue
            day, end = date.fromisoformat(lo), date.fromisoformat(hi)
            while day < end:
                nxt = day + timedelta(days=1)
                if api.total(
                    client, qs=_window_qs(modified, day.isoformat(), nxt.isoformat()), source=source
                ) != by_day.get(day.isoformat(), 0):
                    days.append((day.isoformat(), nxt.isoformat()))
                day = nxt
        if len(days) > MAX_HOLE_DAYS:
            raise ReconcileError(
                f"{len(days)} days disagree with ADEME, over {len(suspect)} month(s);"
                " that is a republication rather than a hole. Publishing nothing:"
                " look at the run before re-running."
            )

        scan = ", ".join(f"'{f}'" for f in files)
        ids: set[str] = set()
        for lo, hi in days:
            there: set[str] = set()
            for page in api.iter_pages(
                client,
                qs=_window_qs(modified, lo, hi),
                select=[key],
                page_size=PAGE_SIZE,
                source=source,
            ):
                there.update(row[key] for row in page.rows)
            here = {
                r[0]
                for r in duck.execute(
                    f'SELECT "{key}" FROM read_parquet([{scan}], hive_partitioning = false)'
                    f" WHERE COALESCE(substr(CAST(\"{modified}\" AS VARCHAR), 1, 10), '') = ?",
                    [lo or ""],
                ).fetchall()
            }
            # Only what upstream has and we do not: missing here, or here under
            # another date, which is a stale version. The other direction --
            # ours and not theirs on this day -- is either a row that left the
            # dataset, which is the key axis's job, or the same stale row seen
            # from its old date, which this fetch already replaces.
            ids |= there - here
            if not quiet:
                print(f"  {lo or 'no date'}: {len(there)} upstream, {len(here)} here")
        return ids
    finally:
        duck.close()


@dataclass
class Healed:
    """What one repair fetched, deleted and rewrote."""

    fetched: list[str] = field(default_factory=list)
    gone: dict[str, list[str]] = field(default_factory=dict)
    touched: list[str] = field(default_factory=list)

    def clean(self) -> bool:
        return not self.fetched and not self.gone


def _settle(duck, client, root, base_manifest, delta_dir, report, gone, source, quiet):
    """Check the arithmetic of what is about to be written, partition by
    partition: published, less what left, plus what is genuinely new, must come
    to what ADEME counted this run.

    Where it does not, that partition is narrowed again with the incoming ids
    counted as present. This is how the blind spot of ADR-0007 comes out: a
    deletion and an addition that cancelled in the count no longer cancel once
    the addition has been found on the date axis.
    """
    key = source.mapping.key
    extra: set[str] = set()
    for part in read_manifest(delta_dir)["partitions"]:
        dept = part["dept"]
        div = report.get(dept)
        if div is None:
            continue  # a departement with nothing published until this run
        after = set(_published_ids(duck, root, dept, key))
        after |= set(_published_ids(duck, delta_dir, dept, key))
        after -= set(gone.get(dept, ()))
        if len(after) == div.upstream:
            continue
        entry = next(p for p in base_manifest["partitions"] if p["dept"] == dept)
        left, appeared = _narrow(
            client, source, dept, entry.get("codes", [dept]), sorted(after), None, None, div.upstream
        )
        if left:
            gone[dept] = sorted(set(gone.get(dept, [])) | left)
        extra |= appeared
        if not quiet:
            print(f"  dept={dept}: settled at -{len(left)} +{len(appeared)}")
    return extra


def heal(
    client,
    root: Path | str,
    out: Path,
    *,
    source: Source = EXISTANT,
    max_repair: int = MAX_REPAIR,
    quiet: bool = True,
    work: Path | None = None,
) -> Healed:
    """Find the holes on both axes, fetch what is missing and write the tree.

    Reconciliation has always found the ids that exist upstream and not here --
    it just could not do anything with them, because it holds an id and a row
    needs normalising (ADR-0007). It can now: the ids go back through the same
    Loader the base build used, and the additions and the deletions land in ONE
    rewrite, so the runner never holds a third copy of the tree.
    """
    base_manifest = read_manifest(root)
    report = reconcile(client, root, quiet=quiet, source=source)
    ids = {n for div in report.values() for n in div.appeared}
    ids |= date_holes(client, root, source=source, quiet=quiet)
    gone = {dept: list(div.gone) for dept, div in report.items() if div.gone}

    work = Path(work) if work else Path(tempfile.mkdtemp())
    work.mkdir(parents=True, exist_ok=True)
    duck = _duck()
    delta_dir: Path | None = None
    try:
        for attempt in range(2):
            if len(ids) > max_repair:
                raise ReconcileError(
                    f"{len(ids):,} rows to repair, over the {max_repair:,} this job repairs on its"
                    " own. Publishing nothing. Look at the run, then either raise --max-repair or"
                    f" re-run the delta with --since covering them ({min(ids)} … {max(ids)})."
                )
            if not ids:
                break
            fetched = fetch_ids(
                client, ids, work / f"repair-{attempt}.sqlite", base_manifest, quiet=quiet, source=source
            )
            if fetched < len(ids):
                raise ReconcileError(
                    f"asked ADEME for {len(ids)} row(s) by id and it returned {fetched};"
                    " refusing to publish a repair against a source that contradicts itself"
                )
            export_parquet.export(work / f"repair-{attempt}.sqlite", work / f"parquet-{attempt}", source=source)
            delta_dir = work / f"parquet-{attempt}" / export_parquet.VERSION / source.subdir
            more = _settle(duck, client, root, base_manifest, delta_dir, report, gone, source, quiet)
            if not more:
                break
            ids |= more
    finally:
        duck.close()

    if delta_dir is not None:
        touched = merge(root, delta_dir, out, source, deleted=gone, keep_mark=True)
    elif gone:
        touched = apply_deletions(root, report, out, source)
    else:
        touched = []
    return Healed(fetched=sorted(ids), gone=gone, touched=touched)


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
    ap.add_argument(
        "--base-url", required=True, help="the source's published tree (v1/ or v1/<subdir>), dir or URL"
    )
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--since", help="override the manifest's high_water")
    ap.add_argument("--db-path", type=Path, help="keep the delta SQLite instead of a temp file")
    ap.add_argument("--source", default=EXISTANT.slug, choices=sorted(SOURCES))
    args = ap.parse_args(argv)
    source = SOURCES[args.source]

    manifest = read_manifest(args.base_url)
    since = args.since or manifest.get("high_water")
    if not since:
        ap.error("no high_water in the manifest and no --since given")
    print(f"delta since {since}")

    tmp = Path(args.db_path) if args.db_path else Path(tempfile.mkdtemp()) / "delta.sqlite"
    loaded = fetch_delta(api.client(), since, tmp, manifest, quiet=False, source=source)
    print(f"fetched {loaded:,} modified certificates")
    if not loaded:
        print("nothing changed; the manifest is left alone")
        return 0

    delta_out = tmp.parent / "parquet"
    export_parquet.export(tmp, delta_out, source=source)
    # Into <out>/v1/<subdir>/, the shape ademe.export_parquet writes and the same
    # shape the published bucket has -- so the upload step copies v1/ to v1/
    # rather than having to know that this one command is different.
    destination = args.out / export_parquet.VERSION / source.subdir
    touched = merge(
        args.base_url, delta_out / export_parquet.VERSION / source.subdir, destination, source=source
    )
    print(f"rewrote {len(touched)} partition(s) into {destination}: {', '.join(touched)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
