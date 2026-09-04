"""Create the database. `python -m ademe.schema`

Idempotent: every statement is CREATE ... IF NOT EXISTS, so re-running against
an existing database is a no-op rather than an error.
"""

from __future__ import annotations

import argparse
import hashlib
from datetime import datetime, timezone
from pathlib import Path

from ademe import db, ddl, spec
from ademe.config import API, DATASET, DEFAULT_DB, LICENCE, SCHEMA_JSON


def build(path: Path, *, scales: dict[str, int] | None = None) -> None:
    cols = spec.load(scales)
    conn = db.connect(path)
    try:
        with db.transaction(conn):
            for stmt in ddl.all_ddl(cols):
                conn.execute(stmt)

            conn.executemany(
                "INSERT INTO column_meta"
                " (column_name, source_type, encoding, scale, domain,"
                "  destination, dest_column) VALUES (?,?,?,?,?,?,?)"
                " ON CONFLICT(column_name) DO UPDATE SET"
                "  encoding=excluded.encoding, scale=excluded.scale,"
                "  domain=excluded.domain, destination=excluded.destination,"
                "  dest_column=excluded.dest_column",
                ddl.column_meta_rows(cols),
            )

            sha = hashlib.sha256(SCHEMA_JSON.read_bytes()).hexdigest()
            conn.execute(
                "INSERT INTO data_source"
                " (source_id, dataset, url, licence, schema_sha256, retrieved_at)"
                " VALUES (?,?,?,?,?,?)"
                " ON CONFLICT(source_id) DO UPDATE SET"
                "  schema_sha256=excluded.schema_sha256,"
                "  retrieved_at=excluded.retrieved_at",
                (
                    DATASET,
                    DATASET,
                    API,
                    LICENCE,
                    sha,
                    datetime.now(timezone.utc).isoformat(timespec="seconds"),
                ),
            )
    finally:
        conn.close()


def report(path: Path) -> None:
    conn = db.connect(path)
    try:
        tables = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        ).fetchall()
        vocab = [t["name"] for t in tables if t["name"].startswith("vocab_")]
        other = [t["name"] for t in tables if not t["name"].startswith("vocab_")]
        enc = conn.execute(
            "SELECT encoding, COUNT(*) n FROM column_meta GROUP BY encoding"
            " ORDER BY n DESC"
        ).fetchall()
        print(f"database   {path}")
        print(f"page_size  {db.page_size(conn)}")
        print(f"tables     {len(tables)}  ({len(vocab)} vocabulary, {len(other)} other)")
        print(f"           {', '.join(other)}")
        print(
            "columns    "
            + ", ".join(f"{r['encoding']}={r['n']}" for r in enc)
            + f"  (total {sum(r['n'] for r in enc)})"
        )
        free = db.free_bytes(path) / 1e9
        print(f"free disk  {free:.1f} GB")
    finally:
        conn.close()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db-path", type=Path, default=DEFAULT_DB)
    args = ap.parse_args(argv)
    build(args.db_path)
    report(args.db_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
