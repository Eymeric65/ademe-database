"""SQLite connection handling.

Everyone goes through `connect()`; nothing imports sqlite3 directly. SQL uses
qmark `?` placeholders, which is both SQLite-native and the house convention in
the sibling repos, so statements stay portable to the eventual Postgres build.
"""

from __future__ import annotations

import shutil
import sqlite3
from contextlib import contextmanager
from pathlib import Path

from ademe.config import SQLITE_PAGE_SIZE


def free_bytes(path: Path) -> int:
    p = path if path.exists() else path.parent
    while not p.exists():
        p = p.parent
    return shutil.disk_usage(p).free


def connect(path: Path, *, bulk: bool = False) -> sqlite3.Connection:
    """Open (creating if needed) the database.

    `bulk=True` is for the load: foreign keys off (re-checked wholesale by
    `finalise`, which is far cheaper than per-row enforcement across ~57M child
    rows) and a large page cache.

    Journalling stays in WAL even during the load. `journal_mode=OFF` is faster
    but a crash then corrupts the file rather than losing a transaction, and
    this is a 17-hour unattended run -- losing the whole database at hour 14 is
    not a trade worth the speed. The disk that made OFF tempting is no longer
    scarce.
    """
    first_time = not path.exists()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=60)
    conn.row_factory = sqlite3.Row

    if first_time:
        # Silently ignored once any table exists, so it has to happen here.
        conn.execute(f"PRAGMA page_size = {SQLITE_PAGE_SIZE}")
        # FULL adds a pointer-map page every ~page_size/5 pages and fragments
        # the file; this database is built once and never shrinks.
        conn.execute("PRAGMA auto_vacuum = NONE")
        conn.execute("PRAGMA journal_mode = WAL")

    conn.execute("PRAGMA foreign_keys = " + ("OFF" if bulk else "ON"))
    conn.execute("PRAGMA synchronous = NORMAL")
    # Index building spills an external sort to temp files; on disk that lands
    # next to the database and can outgrow it transiently.
    conn.execute("PRAGMA temp_store = MEMORY")
    if bulk:
        conn.execute("PRAGMA cache_size = -262144")  # 256 MB
    return conn


@contextmanager
def transaction(conn: sqlite3.Connection):
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def table_exists(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?",
        (name,),
    ).fetchone()
    return row is not None


def page_size(conn: sqlite3.Connection) -> int:
    return conn.execute("PRAGMA page_size").fetchone()[0]


def table_sizes(conn: sqlite3.Connection) -> list[tuple[str, int, int]]:
    """(name, bytes, rows) per table, from dbstat. Requires the dbstat vtab."""
    try:
        rows = conn.execute(
            "SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name "
            "ORDER BY bytes DESC"
        ).fetchall()
    except sqlite3.OperationalError:
        return []
    out = []
    for r in rows:
        try:
            n = conn.execute(f'SELECT COUNT(*) FROM "{r["name"]}"').fetchone()[0]
        except sqlite3.OperationalError:
            n = -1  # an index, not a table
        out.append((r["name"], r["bytes"], n))
    return out
