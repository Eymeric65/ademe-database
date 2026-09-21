"""Per-departement statistics for the public pages.
`python -m ademe.aggregate --root DIR/v1` (or a URL)

The site's ~101 public pages carry aggregates and only aggregates: counts,
histograms, medians, and the largest communes by name. No address, no
`numero_dpe`, no individual certificate -- which is what leaves ADR-0012's login
gate exactly where it is while the pages themselves need no session.

Read from the published `search/` tree alone, with DuckDB over the files a
reader would read (ADR-0033), never from SQLite: the numbers are then the ones
the published data actually supports.

Run by the weekly job, in the run that has just published that tree, and the
result put on R2 beside the manifest for every build to fetch -- rather than
committed, which would leave a dataset in the repository that only the machine
holding the tree could refresh. `src/seo/aggregates.sample.json` is the
two-departement fixture a build with no credentials falls back to. See ADR-0046.

The output is stamped with the manifest's `built_at` and `high_water` so the
pages can say as of when: the published tree runs structurally a couple of
months behind, because the recent window is paid (ADR-0039).
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from ademe import delta
from ademe.config import REPO, UNGEOCODED
from ademe.export_parquet import DOM, VERSION

# The energy classes. Other values exist in the column -- `N`, and the odd
# blank -- and they are not grades, so they are counted nowhere.
CLASSES = ("A", "B", "C", "D", "E", "F", "G")

# The passoires thermiques, the headline number of every one of these pages.
PASSOIRES = ("F", "G")

# Neither is a place a page can be about: `NG` is the pseudo-departement the
# ungeocoded certificates land in (ADR-0024) and `DOM` is four departements
# merged into one partition (`export_parquet.DOM`).
NOT_A_PLACE = (UNGEOCODED, "DOM")

# kWh/m2/an. Class G starts around 420; an order of magnitude past that is a
# keying error, and a handful of them drag every quantile with them.
CONSO_MIN = 1.0
CONSO_MAX = 2000.0

# Enough for a page's "largest communes" table, and what keeps the committed
# file to a few hundred kB rather than a few megabytes.
TOP_COMMUNES = 20

OUT = REPO / "src" / "seo" / "aggregates.json"


def _scan(files: list[str]) -> str:
    """The files as one DuckDB relation.

    TRAP: hive_partitioning = false. The files live under `dept=NN/`, which
    DuckDB otherwise reads as an extra `dept` column -- and a partition read on
    its own would then disagree about its own schema with the national scan.
    """
    return "read_parquet([" + ", ".join(f"'{f}'" for f in files) + "], hive_partitioning = false)"


def _search_files(root: Path | str, manifest: dict) -> dict[str, str]:
    """Every `search/` partition, from the manifest -- never a `*` glob, which
    would pick up a half-written file or an old one the manifest dropped."""
    return {
        p["dept"]: delta._url(root, p["search"]["path"])
        for p in manifest["partitions"]
    }


def _histogram(duck, scan: str, column: str) -> dict[str, int]:
    counts = dict(
        duck.execute(
            f"SELECT {column}, count(*) FROM {scan}"
            f" WHERE {column} IN ({', '.join(repr(c) for c in CLASSES)})"
            " GROUP BY 1"
        ).fetchall()
    )
    return {c: int(counts.get(c, 0)) for c in CLASSES}


def _breakdown(duck, scan: str, column: str) -> list[dict]:
    """Counts by label, largest first. A row that states no label is left out:
    a missing period of construction is not a period of construction."""
    return [
        {"label": label, "count": int(n)}
        for label, n in duck.execute(
            f"SELECT {column}, count(*) AS n FROM {scan} WHERE {column} IS NOT NULL"
            " GROUP BY 1 ORDER BY n DESC, 1"
        ).fetchall()
    ]


def stats(duck, files: list[str], *, top_communes: int = TOP_COMMUNES) -> dict:
    """Everything one page renders, for one partition or for the whole country."""
    scan = _scan(files)
    certificates = int(duck.execute(f"SELECT count(*) FROM {scan}").fetchone()[0])
    dpe = _histogram(duck, scan, "etiquette_dpe")
    ges = _histogram(duck, scan, "etiquette_ges")
    classed = sum(dpe.values())
    passoires = sum(dpe[c] for c in PASSOIRES)

    n_conso, quantiles = duck.execute(
        "SELECT count(*), quantile_cont(CAST(conso_5_usages_par_m2_ep AS DOUBLE), [0.25, 0.5, 0.75])"
        f" FROM {scan} WHERE conso_5_usages_par_m2_ep BETWEEN {CONSO_MIN} AND {CONSO_MAX}"
    ).fetchone()
    n_surface, surface = duck.execute(
        "SELECT count(*), quantile_cont(CAST(surface_habitable_logement AS DOUBLE), 0.5)"
        f" FROM {scan} WHERE surface_habitable_logement > 0"
    ).fetchone()

    # Grouped on the INSEE code and labelled with the most frequent spelling:
    # ADEME does not normalise `nom_commune_ban`, so the same commune arrives
    # as both `PAMIERS` and `Pamiers` (ADR-0010) and grouping on the name would
    # publish it twice at half its size.
    communes = [
        {"code_insee": code, "nom": nom, "count": int(n)}
        for code, nom, n in duck.execute(
            "SELECT code_insee_ban, mode(nom_commune_ban) AS nom, count(*) AS n"
            f" FROM {scan} WHERE code_insee_ban IS NOT NULL AND code_insee_ban <> ''"
            f" GROUP BY 1 ORDER BY n DESC, 1 LIMIT {int(top_communes)}"
        ).fetchall()
    ]

    return {
        "certificates": certificates,
        "etiquette_dpe": dpe,
        "etiquette_ges": ges,
        "passoires": {
            "count": passoires,
            "classed": classed,
            "share": round(passoires / classed, 4) if classed else None,
        },
        "conso_ep_kwh_m2": {
            "counted": int(n_conso),
            "p25": _round(quantiles[0] if quantiles else None),
            "median": _round(quantiles[1] if quantiles else None),
            "p75": _round(quantiles[2] if quantiles else None),
        },
        "surface_m2": {"counted": int(n_surface), "median": _round(surface)},
        "periode_construction": _breakdown(duck, scan, "periode_construction"),
        "type_batiment": _breakdown(duck, scan, "type_batiment"),
        "par_annee": [
            {"year": int(year), "count": int(n)}
            for year, n in duck.execute(
                f"SELECT year(date_etablissement_dpe) AS y, count(*) FROM {scan}"
                " WHERE date_etablissement_dpe IS NOT NULL GROUP BY 1 ORDER BY 1"
            ).fetchall()
        ],
        "communes": communes,
    }


def _round(value) -> float | None:
    return None if value is None else round(float(value), 1)


def aggregate(root: Path | str, *, top_communes: int = TOP_COMMUNES) -> dict:
    """Aggregate every `search/` partition of the existing-housing tree.

    Every partition is counted, including the two that get no page: a national
    total that quietly dropped the ungeocoded would be wrong.
    """
    manifest = delta.read_manifest(root)
    files = _search_files(root, manifest)
    duck = delta._duck()
    try:
        departements = {
            dept: {
                "dept": dept,
                "publishable": dept not in NOT_A_PLACE,
                **stats(duck, [path], top_communes=top_communes),
            }
            for dept, path in files.items()
        }
        national = stats(duck, list(files.values()), top_communes=top_communes)
    finally:
        duck.close()
    return {
        "version": VERSION,
        "source": "existant",
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "data_built_at": manifest.get("built_at"),
        "high_water": manifest.get("high_water"),
        "classes": list(CLASSES),
        "national": national,
        "departements": departements,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    # NOT type=Path. Path("https://x/v1") collapses the double slash to
    # "https:/x/v1"; the published root is normally a URL and read_manifest
    # branches on the scheme.
    ap.add_argument("--root", required=True, help="the published v1/ tree, directory or URL")
    ap.add_argument("--out", type=Path, default=OUT, help=f"where to write the JSON (default {OUT})")
    ap.add_argument(
        "--top-communes", type=int, default=TOP_COMMUNES, help="communes listed per partition"
    )
    args = ap.parse_args(argv)

    result = aggregate(args.root, top_communes=args.top_communes)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=1, ensure_ascii=False, sort_keys=False) + "\n")

    national = result["national"]
    pages = sum(1 for d in result["departements"].values() if d["publishable"])
    print(
        f"{len(result['departements'])} partitions, {pages} publishable:"
        f" {national['certificates']:,} certificates,"
        f" {national['passoires']['share']:.1%} F or G,"
        f" median {national['conso_ep_kwh_m2']['median']:g} kWh/m2/an"
        f" -- as of {result['high_water']} -> {args.out}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
