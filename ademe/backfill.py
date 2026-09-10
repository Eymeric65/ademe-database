"""Put one raw-address column back where the stale CSV labels left it empty.
`python -m ademe.backfill [--column adresse_brut]`

Before ADR-0023 corrected the vendored labels, the rename sent the CSV header
`adresse_brut` onto `adresse_complete_brut`, and every certificate loaded has
`adresse_brut` empty -- 7.9M in the national build. This pulls `numero_dpe` and
the column alone, one departement at a time over one stream, and writes it into
`dpe_adresse_brut`: minutes, where re-ingesting would be seventeen hours.

Run after the ingest and BEFORE `finalise` and the export. A departement that
finishes is recorded beside the database, so a rerun picks up where it stopped.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from ademe import api, db
from ademe.config import DEFAULT_DB, PAGE_SIZE
from ademe.finalise import Incomplete, unfinished


def _check_column(conn, column: str) -> None:
    """Only a text column of `dpe_adresse_brut`: stored verbatim, so the value
    ADEME serves is the value to store, with no vocabulary or scale between."""
    r = conn.execute(
        "SELECT destination, encoding FROM column_meta WHERE column_name = ?", (column,)
    ).fetchone()
    if r is None or (r["destination"], r["encoding"]) != ("dpe_adresse_brut", "text"):
        raise ValueError(f"{column!r} is not a text column of dpe_adresse_brut")


def backfill(
    conn, client, column: str = "adresse_brut", *, progress: Path | None = None, quiet: bool = True
) -> int:
    """Write `column` for every loaded certificate. Returns the rows written."""
    _check_column(conn, column)
    if pending := unfinished(conn):
        raise Incomplete(
            f"still loading: {', '.join(pending)}. Backfill after the ingest, before finalise."
        )
    done = set(json.loads(progress.read_text())) if progress and progress.exists() else set()
    codes = [
        r[0]
        for r in conn.execute("SELECT code_departement FROM ingest_departement ORDER BY code_departement")
    ]
    # A certificate with no raw address at all has no dpe_adresse_brut row yet,
    # hence the upsert. One ADEME published after the load has no dpe row, so
    # the SELECT finds nothing and it is left to the weekly delta.
    sql = (
        f'INSERT INTO dpe_adresse_brut (dpe_id, "{column}")'
        " SELECT dpe_id, ? FROM dpe WHERE numero_dpe = ?"
        f' ON CONFLICT(dpe_id) DO UPDATE SET "{column}" = excluded."{column}"'
    )
    written = 0
    for code in codes:
        if code in done:
            continue
        n = 0
        with db.transaction(conn):
            for page in api.iter_pages(
                client, departement=code, select=["numero_dpe", column], page_size=PAGE_SIZE
            ):
                n += conn.executemany(
                    sql, [(r.get(column) or None, r["numero_dpe"]) for r in page.rows]
                ).rowcount
        written += n
        done.add(code)
        if progress:
            progress.write_text(json.dumps(sorted(done)))
        if not quiet:
            print(f"  {code}: {n:,} certificates")
    return written


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--db-path", type=Path, default=DEFAULT_DB)
    ap.add_argument("--column", default="adresse_brut")
    args = ap.parse_args(argv)

    # Beside the database it describes, so it cannot be mistaken for another's.
    progress = args.db_path.with_name(f"{args.db_path.name}.backfill-{args.column}.json")
    conn = db.connect(args.db_path)
    try:
        n = backfill(conn, api.client(), args.column, progress=progress, quiet=False)
    finally:
        conn.close()
    print(f"{n:,} certificates given their {args.column}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
