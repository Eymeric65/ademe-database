"""The paid window. `python -m ademe.recent split|join --from ROOT --out ROOT`

Certificates established in the last two months are for paid members
(ADR-0038). They are published in a tree of their own, under `recent/`, which
the Worker serves to paid callers only. Beside each base partition, a
counts-only file carries those rows' filter columns and nothing that names one,
so a free search can say how many it is not showing. See ADR-0039.

A ROOT mirrors the bucket: a source's base tree is ROOT/v1/<subdir>, its
recent tree ROOT/recent/v1/<subdir>. `split` turns one whole tree into the
two; `join` puts them back, so the weekly delta, the reconciliation and the
checks keep running on the whole tree they always have.
"""

from __future__ import annotations

import argparse
import calendar
import json
import shutil
from datetime import date, datetime, timezone
from pathlib import Path

import duckdb

from ademe import delta
from ademe.config import EXISTANT, SOURCES, Source
from ademe.export_parquet import (
    COMPRESSION,
    DPE_ROW_GROUP,
    RECENT,
    RECENT_MONTHS,
    SEARCH,
    SEARCH_ROW_GROUP,
    VERSION,
    WITHDRAWN,
    _sha256,
)

PREFIX = "recent"

# The column whose rows are one record to a reader: every step of an audit is
# on the same side, or the detail view would show half an audit.
TOGETHER = {"audit": "n_audit"}

INDEXES = ("numero-exceptions.parquet", "scale-violation.parquet")


def cutoff_for(day: date, months: int = RECENT_MONTHS) -> date:
    """`months` calendar months before `day`, clamped to the end of the month."""
    y, m = divmod(day.year * 12 + day.month - 1 - months, 12)
    return date(y, m + 1, min(day.day, calendar.monthrange(y, m + 1)[1]))


def trees(root: Path, source: Source = EXISTANT) -> tuple[Path, Path]:
    """(base, recent) under a ROOT shaped like the bucket."""
    root = Path(root)
    return root / VERSION / source.subdir, root / PREFIX / VERSION / source.subdir


def _tree_name(source: Source) -> str:
    return "/".join(p for p in (PREFIX, VERSION, source.subdir) if p)


def _copy(duck, sql: str, dest: Path, row_group: int | None = None) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    rg = f", ROW_GROUP_SIZE {row_group}" if row_group else ""
    duck.execute(f"COPY ({sql}) TO '{dest}' (FORMAT parquet, {COMPRESSION}{rg})")


def _entry(tree: Path, rel: str) -> dict:
    path = tree / rel
    return {"path": rel, "bytes": path.stat().st_size, "sha256": _sha256(path)}


def _read(path: Path) -> str:
    # hive_partitioning = false, for the reason in delta.merge_partition.
    return f"read_parquet('{path}', hive_partitioning = false)"


def _index_order(name: str, key: str) -> str:
    return "numero_dpe" if name == "numero-exceptions.parquet" else f'"{key}", column_name'


def _index_key(name: str, key: str) -> str:
    return "numero_dpe" if name == "numero-exceptions.parquet" else f'"{key}"'


def split(src: Path, out: Path, cutoff: date, source: Source = EXISTANT) -> dict:
    """Split ROOT `src`'s whole tree into base, recent and counts under `out`.

    Every file is written for every partition, empty or not: `rclone copy`
    never deletes, so a file left unwritten keeps serving last week's rows.
    The base manifest is written last. Returns it.
    """
    src_tree, _ = trees(src, source)
    base_tree, recent_tree = trees(out, source)
    manifest = delta.read_manifest(src_tree)
    if "recent" in manifest:
        raise ValueError(
            f"{src_tree} is already split at {manifest['recent']['cutoff']}; join it first"
        )
    if base_tree.resolve() == src_tree.resolve():
        raise ValueError(f"split {src_tree} into a different ROOT, not over itself")

    date_col, counts_cols = RECENT[source.slug]
    search_cols, _ = SEARCH[source.slug]
    columns, order = delta._search(source)
    key = source.mapping.key
    if key not in search_cols:
        raise ValueError(f"{source.slug}'s search index has no {key}: it cannot be split by key")
    group = TOGETHER.get(source.slug)
    by = f'coalesce("{group}", "{key}")' if group else f'"{key}"'
    counts = ", ".join(f'"{c}"' for c in counts_cols)

    duck = duckdb.connect()
    duck.execute("CREATE TEMP TABLE recent_keys (k VARCHAR)")
    partitions, recent_partitions = [], []
    for part in manifest["partitions"]:
        dept = part["dept"]
        dpe = src_tree / part["dpe"]["path"]
        search = src_tree / part["search"]["path"]
        # A NULL date is never recent: nothing says it is.
        duck.execute(
            f'CREATE OR REPLACE TEMP TABLE side AS SELECT "{key}" AS k,'
            f' coalesce(max("{date_col}") OVER (PARTITION BY {by}) >= DATE \'{cutoff}\', false)'
            f" AS recent, {WITHDRAWN} IS NULL AS live FROM {delta._wide(duck, _read(dpe))}"
        )
        # Live rows on both sides: a withdrawn certificate stays in the file and
        # on the side its date already put it, but it is not one of the rows the
        # manifest counts. See ADR-0044.
        n, n_recent = duck.execute(
            "SELECT count(*) FILTER (live), count(*) FILTER (recent AND live) FROM side"
        ).fetchone()
        if n != part["rows"]:
            raise ValueError(f"dept={dept}: {n} rows in {dpe}, the manifest says {part['rows']}")
        duck.execute("INSERT INTO recent_keys SELECT k FROM side WHERE recent")

        rel = {kind: f"{kind}/dept={dept}/part-0000.parquet" for kind in ("dpe", "search")}
        for tree, side in ((base_tree, "NOT recent"), (recent_tree, "recent")):
            picked = f'"{key}" IN (SELECT k FROM side WHERE {side})'
            _copy(duck, f'SELECT * FROM {delta._wide(duck, _read(dpe))} WHERE {picked}'
                        f' ORDER BY "{key}"',
                  tree / rel["dpe"], DPE_ROW_GROUP)
            _copy(duck, f"SELECT {columns} FROM {delta._wide(duck, _read(search))}"
                        f" WHERE {picked} ORDER BY {order}",
                  tree / rel["search"], SEARCH_ROW_GROUP)
        rel_counts = f"recent-counts/dept={dept}/part-0000.parquet"
        _copy(
            duck,
            f"SELECT {counts} FROM {_read(search)}"
            f' WHERE "{key}" IN (SELECT k FROM side WHERE recent)'
            f' ORDER BY "code_postal_ban", "{date_col}"',
            base_tree / rel_counts,
            SEARCH_ROW_GROUP,
        )

        recent_entry = {
            "rows": n_recent,
            "search": _entry(recent_tree, rel["search"]),
            "dpe": _entry(recent_tree, rel["dpe"]),
        }
        # `rows` stays the whole partition's: reconcile and check_delta compare
        # it to ADEME's own count.
        partitions.append({
            **part,
            "search": _entry(base_tree, rel["search"]),
            "dpe": _entry(base_tree, rel["dpe"]),
            "recent": recent_entry,
            "counts": _entry(base_tree, rel_counts),
        })
        recent_partitions.append({"dept": dept, **recent_entry})

    for name in INDEXES:
        path = src_tree / "index" / name
        if not path.exists():
            continue
        col = _index_key(name, key)
        # coalesce: a NULL numero_dpe in the exceptions is in neither IN nor
        # NOT IN, and would otherwise drop out of both sides.
        is_recent = f"coalesce({col} IN (SELECT k FROM recent_keys), false)"
        for tree, where in ((base_tree, f"NOT {is_recent}"), (recent_tree, is_recent)):
            _copy(duck, f"SELECT * FROM {_read(path)} WHERE {where} ORDER BY {_index_order(name, key)}",
                  tree / "index" / name)
    duck.close()

    window = {
        "cutoff": cutoff.isoformat(),
        "date_column": date_col,
        "counts_columns": list(counts_cols),
        "tree": _tree_name(source),
    }
    recent_manifest = {
        "version": manifest["version"],
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "key": key,
        **{k: v for k, v in window.items() if k != "tree"},
        "partitions": recent_partitions,
    }
    (recent_tree / "manifest.json").write_text(
        json.dumps(recent_manifest, indent=2, ensure_ascii=False)
    )
    split_manifest = {**manifest, "recent": window, "partitions": partitions}
    (base_tree / "manifest.json").write_text(
        json.dumps(split_manifest, indent=2, ensure_ascii=False)
    )
    return split_manifest


def join(src: Path, out: Path, source: Source = EXISTANT) -> dict:
    """Put ROOT `src`'s base and recent trees back into one whole tree under `out`.

    A tree that was never split is copied as it is. Raises when a joined
    partition does not hold the rows the manifest says it does -- a recent file
    that failed to download would otherwise join to a smaller whole, and the
    delta would publish that. Returns the whole tree's manifest.
    """
    base_tree, recent_tree = trees(src, source)
    dest, _ = trees(out, source)
    manifest = delta.read_manifest(base_tree)
    if base_tree.resolve() == dest.resolve():
        raise ValueError(f"join {base_tree} into a different ROOT, not over itself")

    if "recent" not in manifest:
        for part in manifest["partitions"]:
            for kind in ("dpe", "search"):
                (dest / part[kind]["path"]).parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(base_tree / part[kind]["path"], dest / part[kind]["path"])
        for name in INDEXES:
            if (base_tree / "index" / name).exists():
                (dest / "index").mkdir(parents=True, exist_ok=True)
                shutil.copyfile(base_tree / "index" / name, dest / "index" / name)
        shutil.copyfile(base_tree / "manifest.json", dest / "manifest.json")
        return manifest

    columns, order = delta._search(source)
    key = manifest.get("key", source.mapping.key)
    duck = duckdb.connect()
    partitions = []
    for part in manifest["partitions"]:
        dept = part["dept"]
        for kind, cols, sort, row_group in (
            ("dpe", "*", f'"{key}"', DPE_ROW_GROUP),
            ("search", columns, order, SEARCH_ROW_GROUP),
        ):
            both = (
                f"SELECT * FROM {delta._wide(duck, _read(base_tree / part[kind]['path']))}"
                " UNION ALL BY NAME SELECT * FROM"
                f" {delta._wide(duck, _read(recent_tree / part['recent'][kind]['path']))}"
            )
            _copy(duck, f"SELECT {cols} FROM ({both}) ORDER BY {sort}",
                  dest / part[kind]["path"], row_group)
        # Live rows, the number the manifest carries and reconcile checks.
        n = duck.execute(
            f"SELECT count(*) FROM {_read(dest / part['dpe']['path'])}"
            f" WHERE {WITHDRAWN} IS NULL"
        ).fetchone()[0]
        if n != part["rows"]:
            raise ValueError(
                f"dept={dept}: base and recent join to {n} rows, the manifest says {part['rows']}"
            )
        entry = {k: v for k, v in part.items() if k not in ("recent", "counts")}
        entry["search"] = _entry(dest, part["search"]["path"])
        entry["dpe"] = _entry(dest, part["dpe"]["path"])
        partitions.append(entry)

    for name in INDEXES:
        sides = [t / "index" / name for t in (base_tree, recent_tree) if (t / "index" / name).exists()]
        if not sides:
            continue
        both = " UNION ALL BY NAME ".join(f"SELECT * FROM {_read(p)}" for p in sides)
        _copy(duck, f"SELECT * FROM ({both}) ORDER BY {_index_order(name, key)}", dest / "index" / name)
    duck.close()

    whole = {k: v for k, v in manifest.items() if k != "recent"}
    whole["partitions"] = partitions
    (dest / "manifest.json").write_text(json.dumps(whole, indent=2, ensure_ascii=False))
    return whole


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("command", choices=("split", "join"))
    ap.add_argument("--from", dest="src", type=Path, required=True, help="a ROOT holding v1/")
    ap.add_argument("--out", type=Path, required=True, help="a ROOT to write v1/ and recent/v1/ into")
    ap.add_argument("--source", default=EXISTANT.slug, choices=sorted(SOURCES))
    ap.add_argument("--cutoff", type=date.fromisoformat, help="default: two months before today, UTC")
    args = ap.parse_args(argv)
    source = SOURCES[args.source]

    if args.command == "join":
        m = join(args.src, args.out, source)
        print(f"joined {len(m['partitions'])} partition(s) into {trees(args.out, source)[0]}")
        return 0
    cutoff = args.cutoff or cutoff_for(datetime.now(timezone.utc).date())
    m = split(args.src, args.out, cutoff, source)
    n = sum(p["recent"]["rows"] for p in m["partitions"])
    print(f"split {len(m['partitions'])} partition(s) at {cutoff}: {n:,} recent rows")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
