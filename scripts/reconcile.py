"""Reconcile the published partitions against ADEME. `python scripts/reconcile.py`

Runs after the merge and BEFORE the upload, so a run that cannot reconcile has
published nothing. See ADR-0007.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import argparse
import sys
from pathlib import Path

from ademe import api, delta, export_parquet
from ademe.config import EXISTANT, SOURCES


def _heal(args, source) -> int:
    """Reconcile and repair: the deletions and the refetched rows in one tree.

    A hole is not news any more. Reconciliation finds the ids upstream has and
    this tree does not, counting by the key (ADR-0040); counting by the
    modification date finds the rows held here at a stale version, and the rows
    a mark that was too late hid (ADR-0041). Both are fetched whole and merged.
    See ADR-0043.
    """
    try:
        healed = delta.heal(
            api.client(),
            args.root,
            args.out / export_parquet.VERSION / source.subdir,
            source=source,
            max_repair=args.max_repair,
            max_hole_days=args.max_hole_days,
            quiet=False,
        )
    except delta.ReconcileError as exc:
        print(f"::error::{exc}", file=sys.stderr)
        return 1

    if healed.clean():
        print("every partition agrees with ADEME, on both axes")
        return 0
    gone = sum(len(g) for g in healed.gone.values())
    print(
        f"repaired {len(healed.fetched)} row(s), deleted {gone},"
        f" rewrote {len(healed.touched)} partition(s): {', '.join(healed.touched)}"
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    # NOT type=Path. Path("https://x/v1") collapses the double slash to
    # "https:/x/v1" and read_manifest then looks for a local file of that name.
    # The published root is normally a URL, so this argument is a string and
    # read_manifest branches on the scheme.
    ap.add_argument(
        "--root", required=True, help="the source's published tree (v1/ or v1/<subdir>), dir or URL"
    )
    ap.add_argument("--out", type=Path, help="where to write the corrected files")
    ap.add_argument("--source", default=EXISTANT.slug, choices=sorted(SOURCES))
    ap.add_argument(
        "--repair",
        action="store_true",
        help="also fetch what is missing here, on both axes (ADR-0043)",
    )
    ap.add_argument(
        "--max-repair",
        type=int,
        default=delta.MAX_REPAIR,
        help="rows this run repairs on its own before it stops for a human",
    )
    ap.add_argument(
        "--max-hole-days",
        type=int,
        default=delta.MAX_HOLE_DAYS,
        help="days holding more rows upstream before this run calls it a republication",
    )
    args = ap.parse_args(argv)
    source = SOURCES[args.source]

    if args.repair:
        if not args.out:
            ap.error("--repair needs --out")
        return _heal(args, source)

    report = delta.reconcile(api.client(), args.root, quiet=False, source=source)
    divergent = {d: r for d, r in report.items() if not r.clean()}
    if not divergent:
        print("every partition agrees with ADEME")
        return 0

    gone = sum(len(r.gone) for r in divergent.values())
    appeared = sum(len(r.appeared) for r in divergent.values())
    print(f"{len(divergent)} partition(s) diverge: {gone} gone upstream, {appeared} new")

    if not args.out:
        print("::error::divergence found and no --out given", file=sys.stderr)
        return 1

    rewritten = delta.apply_deletions(
        args.root, report, args.out / export_parquet.VERSION / source.subdir, source=source
    )
    print(f"rewrote {len(rewritten)} partition(s): {', '.join(rewritten)}")

    if appeared:
        # Only ids are known here; a whole record is the delta's job.
        print(
            f"::warning::{appeared} certificate(s) exist upstream and not here."
            " Re-run the delta with an earlier --since to pull them."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
