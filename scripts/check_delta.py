"""Refuse to publish a run that moved far more rows than the recent norm.

ADEME republishing a whole departement, or changing something upstream, looks
from here like an ordinary week with a big number. `v1/runs.jsonl` is the
history; this compares against it and fails the job rather than swapping the
manifest. Run BEFORE the upload step, so a flagged run has published nothing.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from pathlib import Path

from ademe import delta


def load_runs(base_url: str) -> list[dict]:
    url = f"{base_url}/runs.jsonl"
    try:
        if url.startswith(("http://", "https://")):
            with urllib.request.urlopen(url) as fh:
                text = fh.read().decode()
        else:
            text = Path(url).read_text()
    except Exception:
        return []  # no history yet is not an error; it is the first run
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--base-url", required=True)
    args = ap.parse_args(argv)

    new = json.loads((args.out / "v1" / "manifest.json").read_text())
    old = delta.read_manifest(args.base_url)
    before = sum(p["rows"] for p in old["partitions"])
    after = sum(p["rows"] for p in new["partitions"])
    changed = abs(after - before)

    runs = load_runs(args.base_url)
    flagged, median = delta.sharp_departure(runs, changed)
    print(f"rows {before:,} -> {after:,} ({changed:,} changed); median of recent runs {median}")
    if flagged:
        print(
            f"::error::{changed:,} rows changed against a median of {median:,}."
            " Refusing to swap the manifest; look at the run before re-running.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
