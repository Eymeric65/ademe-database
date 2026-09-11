"""The crosswalk: certificate -> RNB building -> cadastre parcel.
`python -m ademe.crosswalk --root DIR/v1`

Built from the published trees alone -- the certificates' `id_rnb` and, when
that is empty, their BAN address; RNB's `plots` and `addresses`; the cadastre's
parcel ids -- never from SQLite, so it joins exactly the way a reader of the
files will, and anyone holding them can rebuild it. See ADR-0021 and ADR-0022.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path

import duckdb

from ademe.export_parquet import COMPRESSION, VERSION, _sha256

# `spatial` is reserved. ADR-0021, ADR-0022.
METHODS = ("id_rnb", "ban", "unresolved")

# Below this share of the certificates that name a building, the RNB tree is
# empty, stale or missing départements -- and the crosswalk would publish that
# as "RNB does not know these buildings".
MIN_RESOLVED = 0.95

COLUMNS = (
    "source",
    "record_key",
    "rnb_id",
    "match_method",
    "parcel_id",
    "bdg_cover_ratio",
    "ban_candidates",
)

COVERAGE = (
    "certificates",
    "with_id_rnb",
    "resolved",
    "with_parcel",
    "parcel_in_cadastre",
    "ban_matched",
    "ban_single",
)


def _input(path: Path) -> dict:
    m = json.loads(path.read_text())
    return {"built_at": m.get("built_at"), "sha256": _sha256(path)}


def _files(root: Path, sub: str) -> str:
    m = json.loads((root / sub / "manifest.json").read_text())
    paths = [str(root / sub / f"dept={p['dept']}" / "part-0000.parquet") for p in m["partitions"]]
    return "[" + ", ".join(f"'{p}'" for p in paths) + "]"


def build(root: Path, *, min_resolved: float = MIN_RESOLVED) -> dict:
    """Rebuild `root/crosswalk/` whole and write its manifest, last.

    Refuses -- before anything published is touched -- when fewer than
    `min_resolved` of the certificates naming a building find it in RNB.
    """
    inputs = {
        name: _input(root / sub / "manifest.json")
        for name, sub in (("existant", ""), ("rnb", "rnb"), ("cadastre", "cadastre"))
    }
    certs = json.loads((root / "manifest.json").read_text())["partitions"]
    rnb = _files(root, "rnb")
    out = root / "crosswalk"
    work = out / ".work"
    work.mkdir(parents=True, exist_ok=True)
    try:
        duck = duckdb.connect()
        duck.execute(f"SET temp_directory = '{work}'")
        duck.execute(
            "CREATE TEMP TABLE cert AS "
            + " UNION ALL ".join(
                f"SELECT '{p['dept']}' AS dept, numero_dpe, id_rnb, identifiant_ban"
                f" FROM read_parquet('{root / p['dpe']['path']}')"
                for p in certs
            )
        )
        # Only where ADEME named no building: an address is a guess, and a
        # guess beside ADEME's own `id_rnb` would only dilute it. Each
        # (building, key) once, so a building listing a key twice, or filed
        # under two départements, is still one candidate.
        duck.execute(
            "CREATE TEMP TABLE ban AS"
            " SELECT c.dept, c.numero_dpe, a.rnb_id,"
            "        (count(*) OVER (PARTITION BY c.dept, c.numero_dpe))::INTEGER AS candidates"
            " FROM cert c JOIN"
            " (SELECT DISTINCT rnb_id, x.cle_interop_ban AS ban_key FROM"
            f"   (SELECT rnb_id, unnest(addresses) AS x FROM read_parquet({rnb}) WHERE len(addresses) > 0)) a"
            " ON a.ban_key = c.identifiant_ban"
            " WHERE c.id_rnb IS NULL"
        )
        # An rnb_id filed under two départements would otherwise double its
        # certificates' rows.
        duck.execute(
            "CREATE TEMP TABLE bld AS"
            f" SELECT DISTINCT ON (rnb_id) rnb_id, plots FROM read_parquet({rnb})"
            " WHERE rnb_id IN (SELECT id_rnb FROM cert) OR rnb_id IN (SELECT rnb_id FROM ban)"
        )
        duck.execute(
            "CREATE TEMP TABLE linked AS"
            " SELECT c.dept, c.numero_dpe, c.id_rnb, b.rnb_id IS NOT NULL AS found, b.plots"
            " FROM cert c LEFT JOIN bld b ON b.rnb_id = c.id_rnb"
            " WHERE c.id_rnb IS NOT NULL"
        )
        duck.execute(
            "CREATE TEMP TABLE xw AS"
            " SELECT dept, 'existant' AS source, numero_dpe AS record_key, id_rnb AS rnb_id,"
            "        'id_rnb' AS match_method, p.id AS parcel_id, p.bdg_cover_ratio,"
            "        NULL::INTEGER AS ban_candidates"
            " FROM (SELECT dept, numero_dpe, id_rnb, unnest(plots) AS p"
            "       FROM linked WHERE found AND len(plots) > 0)"
            " UNION ALL"
            " SELECT dept, 'existant', numero_dpe, id_rnb,"
            "        CASE WHEN found THEN 'id_rnb' ELSE 'unresolved' END, NULL, NULL, NULL"
            " FROM linked WHERE NOT found OR plots IS NULL OR len(plots) = 0"
            " UNION ALL"
            " SELECT dept, 'existant', numero_dpe, rnb_id, 'ban', p.id, p.bdg_cover_ratio, candidates"
            " FROM (SELECT b.dept, b.numero_dpe, rnb_id, b.candidates, unnest(r.plots) AS p"
            "       FROM ban b JOIN bld r USING (rnb_id) WHERE len(r.plots) > 0)"
            " UNION ALL"
            " SELECT b.dept, 'existant', b.numero_dpe, rnb_id, 'ban', NULL, NULL, b.candidates"
            " FROM ban b LEFT JOIN bld r USING (rnb_id) WHERE r.plots IS NULL OR len(r.plots) = 0"
        )
        duck.execute(
            "CREATE TEMP TABLE known AS SELECT DISTINCT id"
            f" FROM read_parquet({_files(root, 'cadastre')})"
            " WHERE id IN (SELECT parcel_id FROM xw)"
        )
        # with_parcel and parcel_in_cadastre count ADEME's own links only; the
        # address candidates are counted apart, so guesses cannot inflate them.
        coverage = {
            r[0]: dict(zip(COVERAGE, r[1:]))
            for r in duck.execute(
                "SELECT c.dept, c.certificates, c.with_id_rnb,"
                "       coalesce(x.resolved, 0), coalesce(x.with_parcel, 0), coalesce(x.in_cadastre, 0),"
                "       coalesce(x.ban_matched, 0), coalesce(x.ban_single, 0)"
                " FROM (SELECT dept, count(*) AS certificates, count(id_rnb) AS with_id_rnb"
                "       FROM cert GROUP BY dept) c"
                " LEFT JOIN (SELECT dept,"
                "       count(DISTINCT record_key) FILTER (WHERE match_method = 'id_rnb') AS resolved,"
                "       count(DISTINCT record_key)"
                "         FILTER (WHERE match_method = 'id_rnb' AND parcel_id IS NOT NULL) AS with_parcel,"
                "       count(DISTINCT record_key)"
                "         FILTER (WHERE match_method = 'id_rnb' AND parcel_id IN (SELECT id FROM known))"
                "         AS in_cadastre,"
                "       count(DISTINCT record_key) FILTER (WHERE match_method = 'ban') AS ban_matched,"
                "       count(DISTINCT record_key)"
                "         FILTER (WHERE match_method = 'ban' AND ban_candidates = 1) AS ban_single"
                "       FROM xw GROUP BY dept) x USING (dept)"
                " ORDER BY c.dept"
            ).fetchall()
        }
        total = {k: sum(c[k] for c in coverage.values()) for k in COVERAGE}
        if total["with_id_rnb"] and total["resolved"] < min_resolved * total["with_id_rnb"]:
            raise ValueError(
                f"only {total['resolved']:,} of {total['with_id_rnb']:,} certificates naming a building"
                f" resolve in RNB (floor {min_resolved:.0%}) -- is the RNB tree complete?"
            )

        parts = []
        for dept, cov in coverage.items():
            tmp = work / f"{dept}.parquet"
            duck.execute(
                f"COPY (SELECT {', '.join(COLUMNS)} FROM xw WHERE dept = '{dept}'"
                f" ORDER BY record_key, rnb_id, parcel_id) TO '{tmp}' (FORMAT parquet, {COMPRESSION})"
            )
            rows = duck.execute(f"SELECT count(*) FROM xw WHERE dept = '{dept}'").fetchone()[0]
            parts.append((dept, tmp, rows, cov))
        for dept, tmp, rows, cov in parts:
            dest = out / f"dept={dept}" / "part-0000.parquet"
            dest.parent.mkdir(exist_ok=True)
            os.replace(tmp, dest)
    finally:
        shutil.rmtree(work, ignore_errors=True)

    manifest = {
        "version": VERSION,
        "source": "crosswalk",
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "methods": list(METHODS),
        "columns": list(COLUMNS),
        "inputs": inputs,
        "coverage": total,
        "partitions": [
            {
                "dept": dept,
                "rows": rows,
                "sha256": _sha256(out / f"dept={dept}" / "part-0000.parquet"),
                "coverage": cov,
            }
            for dept, _tmp, rows, cov in parts
        ],
    }
    tmp = out / "manifest.json.tmp"
    tmp.write_text(json.dumps(manifest, indent=2, ensure_ascii=False))
    os.replace(tmp, out / "manifest.json")
    return manifest


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--root", type=Path, required=True, help="the local v1/ tree; writes ROOT/crosswalk/")
    args = ap.parse_args(argv)
    m = build(args.root)
    c = m["coverage"]
    print(
        f"{c['certificates']:,} certificates: {c['with_id_rnb']:,} name a building,"
        f" {c['resolved']:,} resolve in RNB, {c['with_parcel']:,} reach a parcel,"
        f" {c['parcel_in_cadastre']:,} a parcel in the cadastre edition;"
        f" {c['ban_matched']:,} more linked by address, {c['ban_single']:,} of them to one building"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
