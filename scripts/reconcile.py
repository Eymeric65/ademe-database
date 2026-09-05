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


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    # NOT type=Path. Path("https://x/v1") collapses the double slash to
    # "https:/x/v1" and read_manifest then looks for a local file of that name.
    # The published root is normally a URL, so this argument is a string and
    # read_manifest branches on the scheme.
    ap.add_argument("--root", required=True, help="the published v1/ directory or URL")
    ap.add_argument("--out", type=Path, help="where to write the corrected files")
    args = ap.parse_args(argv)

    report = delta.reconcile(api.client(), args.root, quiet=False)
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

    rewritten = delta.apply_deletions(args.root, report, args.out / export_parquet.VERSION)
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
