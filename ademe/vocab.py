"""Populate the closed vocabularies. `python -m ademe.vocab`

`/values/{field}` enumerates a field's distinct values without scanning rows,
so 71 of the 88 dictionary-encoded columns cost nothing to build. It returns
nothing for free text -- that is exactly how the closed vocabularies are told
apart from the open ones, which `ingest` accumulates as rows go by.

Where several columns share a domain the table holds the *union* of their
values. Slots of one repeating group legitimately see different subsets: slot 2
is rarer than slot 1, so it observes fewer distinct generator types. The union
is the vocabulary; a per-slot subset is an accident of sampling.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from ademe import api, db, spec
from ademe.config import EXISTANT, SOURCES, Source


def load_domain(client, columns: list[str], source: Source = EXISTANT) -> set[str]:
    out: set[str] = set()
    for col in columns:
        out.update(api.values(client, col, source=source))
    return out


def build(path: Path, *, verbose: bool = True, source: Source = EXISTANT) -> dict[str, int]:
    cols = {k: v for k, v in spec.load(source=source).items() if k not in source.mapping.internal}
    domains = spec.vocab_domains(cols)
    client = api.client()
    conn = db.connect(path)
    counts: dict[str, int] = {}
    try:
        for domain in sorted(domains):
            members = domains[domain]
            vals = load_domain(client, members, source)
            if vals:
                with db.transaction(conn):
                    conn.executemany(
                        f"INSERT INTO vocab_{domain} (code) VALUES (?)"
                        " ON CONFLICT(code) DO NOTHING",
                        [(v,) for v in sorted(vals)],
                    )
            n = conn.execute(f"SELECT COUNT(*) FROM vocab_{domain}").fetchone()[0]
            counts[domain] = n
            if verbose:
                kind = "closed" if vals else "open (filled during ingest)"
                print(f"  {domain:48s} {n:6d}  {kind}")
    finally:
        conn.close()
    return counts


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--source", default=EXISTANT.slug, choices=sorted(SOURCES))
    ap.add_argument("--db-path", type=Path, help="default: the source's own database")
    args = ap.parse_args(argv)
    source = SOURCES[args.source]
    counts = build(args.db_path or source.db_path, source=source)
    filled = sum(1 for n in counts.values() if n)
    print(
        f"\n{len(counts)} vocabularies: {filled} pre-built from /values, "
        f"{len(counts) - filled} left for ingest. "
        f"{sum(counts.values()):,} values total."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
