"""Turn a loaded database into a usable one. `python -m ademe.finalise`

Two things the load deliberately postponed happen here, and neither is
optional:

  - **Indexes.** `ddl.indexes_ddl()` is not run by `ademe.schema`, because
    building them up front makes every one of ~15.5M inserts maintain a B-tree
    it does not need yet.
  - **Foreign keys.** `db.connect(bulk=True)` sets `PRAGMA foreign_keys = OFF`.
    That is far cheaper than per-row enforcement across ~57M child rows, but it
    is only *sound* if something checks them wholesale afterwards. This is that
    something.

Then ANALYZE, so the query planner has statistics, and the row count into
`data_source` so the export has something to check itself against.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from ademe import db, ddl
from ademe.config import DEFAULT_DB, EXISTANT, Source


class Quarantined(RuntimeError):
    """The load put certificates in `bad_row` and nobody has looked at them.

    Quarantine keeps a seventeen-hour run alive through one malformed row. It
    must not also be the thing that lets a systematically broken load look
    finished: a schema change upstream would send every certificate here, and
    the build would publish empty and green. So the count has to be
    acknowledged before anything is published. See ADR-0015."""


class Incomplete(RuntimeError):
    """A departement is still loading. Finalising now would ANALYZE a database
    that is about to change shape, and check foreign keys whose parents may
    simply not have arrived yet."""


class IntegrityError(RuntimeError):
    """`PRAGMA foreign_key_check` found orphaned rows."""


def unfinished(conn) -> list[str]:
    return [
        r[0]
        for r in conn.execute(
            "SELECT code_departement FROM ingest_departement"
            " WHERE completed_at IS NULL ORDER BY code_departement"
        )
    ]


def check_foreign_keys(conn) -> None:
    """Raise naming the table and the first offending rows.

    `PRAGMA foreign_key_check` yields (table, rowid, parent, fkid). The table
    and the rowids are what make the failure actionable -- "some foreign key
    is broken" across 226 columns and eight tables is not a bug report.
    """
    rows = conn.execute("PRAGMA foreign_key_check").fetchall()
    if not rows:
        return
    by_table: dict[str, list] = {}
    for r in rows:
        by_table.setdefault(r[0], []).append(r)
    summary = ", ".join(f"{t} ({len(v)})" for t, v in sorted(by_table.items()))
    first = "\n  ".join(
        f"table={r[0]} rowid={r[1]} references={r[2]}" for r in rows[:10]
    )
    raise IntegrityError(
        f"{len(rows)} orphaned row(s) across {summary}\n  {first}"
    )


def check_quarantine(conn, allow: int) -> int:
    n = conn.execute("SELECT COUNT(*) FROM bad_row").fetchone()[0]
    if n <= allow:
        return n
    sample = conn.execute(
        "SELECT numero_dpe, code_departement, error FROM bad_row"
        " ORDER BY seen_at LIMIT 5"
    ).fetchall()
    first = "\n  ".join(f"{r[0]} (dept {r[1]}): {r[2]}" for r in sample)
    raise Quarantined(
        f"{n} certificate(s) in bad_row, {allow} allowed.\n  {first}\n"
        "Read them, decide whether the loss is acceptable, then re-run with"
        f" --allow-bad-rows {n}."
    )


def finalise(
    conn,
    *,
    partial: bool = False,
    quiet: bool = True,
    allow_bad_rows: int = 0,
    source: Source = EXISTANT,
) -> int:
    """Index, verify, analyse. Returns the `dpe` row count."""
    if not partial and (pending := unfinished(conn)):
        raise Incomplete(
            f"still loading: {', '.join(pending)}."
            " Finish the ingest, or pass --partial to finalise anyway."
        )

    # Before the expensive work: a build nobody has looked at should not get an
    # hour of B-tree building spent on it.
    bad = check_quarantine(conn, allow_bad_rows)
    if bad and not quiet:
        print(f"  {bad} quarantined certificate(s), acknowledged")

    # Foreign keys BEFORE the indexes: a broken database should fail in seconds
    # rather than after an hour of B-tree building.
    check_foreign_keys(conn)

    for stmt in ddl.indexes_ddl(source):
        if not quiet:
            print(f"  {stmt}")
        conn.execute(stmt)
    conn.commit()

    conn.execute("ANALYZE")
    rows = conn.execute("SELECT COUNT(*) FROM dpe").fetchone()[0]
    conn.execute(
        "UPDATE data_source SET upstream_rows = ? WHERE source_id = ?",
        (rows, source.dataset),
    )
    conn.commit()
    return rows


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db-path", type=Path, default=DEFAULT_DB)
    ap.add_argument(
        "--partial",
        action="store_true",
        help="finalise even though a departement is still loading",
    )
    ap.add_argument(
        "--allow-bad-rows",
        type=int,
        default=0,
        help="proceed with this many quarantined certificates in bad_row",
    )
    args = ap.parse_args(argv)

    conn = db.connect(args.db_path)
    try:
        rows = finalise(
            conn,
            partial=args.partial,
            quiet=False,
            allow_bad_rows=args.allow_bad_rows,
        )
    finally:
        conn.close()
    print(f"finalised {args.db_path}: {rows:,} certificates")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
