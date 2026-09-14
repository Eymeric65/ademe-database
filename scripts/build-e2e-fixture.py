"""Rebuild test/e2e/fixtures from live ADEME. `python scripts/build-e2e-fixture.py`

The fixture is committed, so this is not run by CI -- it exists so the fixture
can be regenerated and so its provenance is a script rather than a story.

A SAMPLE of two real departements, not a whole one: the smallest metropolitan
departement is 10,647 certificates and its wide file is megabytes, which is too
much to carry in git for a test that needs a few hundred rows. Two departements
rather than one because the search has to choose a partition from the postcode,
and one partition cannot get that wrong.

Metropolitan on purpose: overseas coordinates are published as NULL (ADR-0011),
so an overseas fixture could not exercise the map link at all.

`--from-published DIR` slices an already published `v1` tree instead: every
source, plus the RNB, cadastre and crosswalk rows the kept certificates link
to. That is the only way to get a crosswalk that agrees with the certificates,
and it is the exact bytes shape R2 serves.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ademe import api, cadastre, db, export_parquet, ingest, rnb, schema, spec
from ademe.config import API

# Ariege and Lozere: small, metropolitan, and far enough apart that a postcode
# selects exactly one of them.
DEPTS = ("09", "48")
PER_DEPT = 400

# The certificate every existing spec searches for. It is in the exceptions
# index (its numero says '07') and links to no building, which is why the slice
# also keeps a second, linked one.
TARGET = "2107E0132696Z"

# subdir -> (slug, rows per département). Audits are kept whole, by audit.
TREES = {"": ("existant", PER_DEPT), "neuf": ("neuf", 100), "tertiaire": ("tertiaire", 100),
         "audit": ("audit", 25)}


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _read(path: Path) -> str:
    return f"read_parquet('{path}', hive_partitioning = false)"


def slice_published(src: Path, out: Path) -> dict:
    """Write `out/v1/...` from the published tree at `src` (a `v1` directory).

    Returns the keys the specs hard-code, so they come from the script rather
    than from somebody browsing the fixture.
    """
    import duckdb

    duck = duckdb.connect()
    root = out / export_parquet.VERSION
    targets: dict[str, dict] = {}
    rnb_ids: set[str] = set()
    parcels: set[str] = set()
    kept_existant: dict[str, list[str]] = {}

    def copy(select: str, dest: Path, order: str, row_group: int | None) -> int:
        dest.parent.mkdir(parents=True, exist_ok=True)
        rg = f", ROW_GROUP_SIZE {row_group}" if row_group else ""
        duck.execute(
            f"COPY ({select} ORDER BY {order}) TO '{dest}'"
            f" (FORMAT parquet, {export_parquet.COMPRESSION}{rg})"
        )
        return duck.execute(f"SELECT count(*) FROM {_read(dest)}").fetchone()[0]

    for sub, (slug, per_dept) in TREES.items():
        tree_src, tree_out = src / sub, root / sub
        manifest = json.loads((tree_src / "manifest.json").read_text())
        key = manifest["key"]
        sort = ", ".join(export_parquet.SEARCH[slug][1])
        parts, keys_all = [], []
        for dept in DEPTS:
            search_src = tree_src / "search" / f"dept={dept}" / "part-0000.parquet"
            dpe_src = tree_src / "dpe" / f"dept={dept}" / "part-0000.parquet"
            wide = _read(dpe_src)
            geocoded = "lat IS NOT NULL AND adresse_ban IS NOT NULL"
            linked = f"id_rnb IN (SELECT rnb_id FROM {_read(src / 'rnb' / f'dept={dept}' / 'part-0000.parquet')})"
            if slug == "audit":
                # Whole audits: a step without its siblings is not an audit.
                pick = (
                    f"SELECT n_audit FROM {wide} WHERE {geocoded} GROUP BY n_audit"
                    f" ORDER BY md5(n_audit) LIMIT {per_dept}"
                )
                must = f"SELECT n_audit FROM {wide} WHERE {geocoded} AND {linked} ORDER BY n_audit LIMIT 1"
                keys = [r[0] for r in duck.execute(
                    f"SELECT {key} FROM {wide} WHERE n_audit IN ({pick}) OR n_audit IN ({must})"
                ).fetchall()]
                if dept == DEPTS[0]:
                    row = duck.execute(
                        f"SELECT id_etape, n_audit, code_postal_ban, classe_bilan_dpe, adresse_ban,"
                        f" date_etablissement_audit, id_rnb FROM {wide} WHERE n_audit IN ({must})"
                        f" AND etape_travaux = 'état initial' LIMIT 1"
                    ).fetchone()
                    targets[slug] = dict(zip(
                        ("key", "n_audit", "code_postal", "classe", "adresse", "date", "id_rnb"),
                        map(str, row)))
            else:
                must = [TARGET] if slug == "existant" and dept == "09" else []
                if slug == "existant":
                    # A certificate the crosswalk links by its own id_rnb, to a
                    # parcel the cadastre slice will carry.
                    xw = _read(src / "crosswalk" / f"dept={dept}" / "part-0000.parquet")
                    cad = _read(src / "cadastre" / f"dept={dept}" / "part-0000.parquet")
                    one = duck.execute(
                        f"SELECT x.record_key FROM {xw} x JOIN {wide} w ON w.numero_dpe = x.record_key"
                        f" WHERE x.source = 'existant' AND x.match_method = 'id_rnb'"
                        f" AND x.parcel_id IN (SELECT id FROM {cad})"
                        f" AND w.lat IS NOT NULL AND w.adresse_ban IS NOT NULL"
                        f" GROUP BY x.record_key HAVING count(*) = 1 ORDER BY x.record_key LIMIT 1"
                    ).fetchone()
                    candidate = duck.execute(
                        f"SELECT x.record_key FROM {xw} x WHERE x.source = 'existant'"
                        f" AND x.match_method = 'ban' AND x.ban_candidates BETWEEN 2 AND 3"
                        f" ORDER BY x.record_key LIMIT 1"
                    ).fetchone()
                    must += [one[0], candidate[0]]
                else:
                    one = duck.execute(
                        f"SELECT {key} FROM {wide} WHERE {geocoded} AND {linked} ORDER BY {key} LIMIT 1"
                    ).fetchone()
                    must.append(one[0])
                in_must = ", ".join(f"'{k}'" for k in must)
                keys = [r[0] for r in duck.execute(
                    f"SELECT {key} FROM {wide} WHERE {key} IN ({in_must}) UNION"
                    f" (SELECT {key} FROM {wide} WHERE {geocoded} AND {key} NOT IN ({in_must})"
                    f" ORDER BY md5({key}) LIMIT {per_dept - len(must)})"
                ).fetchall()]
                if dept == DEPTS[0]:
                    cols = (f"{key}, code_postal_ban, etiquette_dpe, adresse_ban, date_etablissement_dpe,"
                            f" id_rnb")
                    for name, k in (("", must[0]), ("_linked", must[1] if slug == "existant" else None),
                                    ("_candidate", must[2] if slug == "existant" else None)):
                        if k is None:
                            continue
                        row = duck.execute(f"SELECT {cols} FROM {wide} WHERE {key} = '{k}'").fetchone()
                        targets[slug + name] = dict(zip(
                            ("key", "code_postal", "classe", "adresse", "date", "id_rnb"), map(str, row)))
            keys_all += keys
            duck.execute(f"CREATE OR REPLACE TABLE keep AS SELECT unnest(?::VARCHAR[]) AS k", [keys])
            where = f"WHERE {key} IN (SELECT k FROM keep)"
            search_out = tree_out / "search" / f"dept={dept}" / "part-0000.parquet"
            dpe_out = tree_out / "dpe" / f"dept={dept}" / "part-0000.parquet"
            copy(f"SELECT * FROM {_read(search_src)} {where}", search_out, sort,
                 export_parquet.SEARCH_ROW_GROUP)
            rows = copy(f"SELECT * FROM {wide} {where}", dpe_out, key, export_parquet.DPE_ROW_GROUP)
            rnb_ids |= {r[0] for r in duck.execute(
                f"SELECT id_rnb FROM {wide} {where} AND id_rnb IS NOT NULL").fetchall()}
            if slug == "existant":
                kept_existant[dept] = keys
            parts.append({
                "dept": dept, "codes": [dept], "rows": rows,
                "search": {"path": f"search/dept={dept}/part-0000.parquet",
                           "bytes": search_out.stat().st_size, "sha256": _sha256(search_out)},
                "dpe": {"path": f"dpe/dept={dept}/part-0000.parquet",
                        "bytes": dpe_out.stat().st_size, "sha256": _sha256(dpe_out)},
            })

        duck.execute("CREATE OR REPLACE TABLE keep AS SELECT unnest(?::VARCHAR[]) AS k", [keys_all])
        index_src, index_out = tree_src / "index", tree_out / "index"
        copy(f"SELECT * FROM {_read(index_src / 'numero-exceptions.parquet')}"
             f" WHERE numero_dpe IN (SELECT k FROM keep)",
             index_out / "numero-exceptions.parquet", "numero_dpe", None)
        copy(f"SELECT * FROM {_read(index_src / 'scale-violation.parquet')}"
             f" WHERE {key} IN (SELECT k FROM keep)",
             index_out / "scale-violation.parquet", f"{key}, column_name", None)
        manifest["sliced_from"] = manifest["built_at"]
        manifest["partitions"] = parts
        (tree_out / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False))
        print(f"  {slug}: {sum(p['rows'] for p in parts)} rows")

    # Reference data: only what the kept certificates reach.
    xw_parts = []
    for dept in DEPTS:
        duck.execute("CREATE OR REPLACE TABLE keep AS SELECT unnest(?::VARCHAR[]) AS k",
                     [kept_existant[dept]])
        dest = root / "crosswalk" / f"dept={dept}" / "part-0000.parquet"
        rows = copy(
            f"SELECT * FROM {_read(src / 'crosswalk' / f'dept={dept}' / 'part-0000.parquet')}"
            f" WHERE source = 'existant' AND record_key IN (SELECT k FROM keep)",
            dest, "record_key, rnb_id, parcel_id", None)
        for rid, pid in duck.execute(f"SELECT rnb_id, parcel_id FROM {_read(dest)}").fetchall():
            if rid:
                rnb_ids.add(rid)
            if pid:
                parcels.add(pid)
        xw_parts.append({"dept": dept, "rows": rows, "sha256": _sha256(dest)})

    rnb_parts = []
    duck.execute("CREATE OR REPLACE TABLE keep AS SELECT unnest(?::VARCHAR[]) AS k", [sorted(rnb_ids)])
    for dept in DEPTS:
        dest = root / "rnb" / f"dept={dept}" / "part-0000.parquet"
        rows = copy(f"SELECT * FROM {_read(src / 'rnb' / f'dept={dept}' / 'part-0000.parquet')}"
                    f" WHERE rnb_id IN (SELECT k FROM keep)", dest, "rnb_id", rnb.ROW_GROUP)
        parcels |= {r[0] for r in duck.execute(
            f"SELECT unnest(plots).id FROM {_read(dest)}").fetchall()}
        rnb_parts.append({"dept": dept, "rows": rows, "sha256": _sha256(dest)})

    cad_parts = []
    duck.execute("CREATE OR REPLACE TABLE keep AS SELECT unnest(?::VARCHAR[]) AS k", [sorted(parcels)])
    for dept in DEPTS:
        dest = root / "cadastre" / f"dept={dept}" / "part-0000.parquet"
        rows = copy(f"SELECT * FROM {_read(src / 'cadastre' / f'dept={dept}' / 'part-0000.parquet')}"
                    f" WHERE id IN (SELECT k FROM keep)", dest, "id", cadastre.ROW_GROUP)
        cad_parts.append({"dept": dept, "rows": rows, "sha256": _sha256(dest)})

    for sub, parts in (("crosswalk", xw_parts), ("rnb", rnb_parts), ("cadastre", cad_parts)):
        manifest = json.loads((src / sub / "manifest.json").read_text())
        manifest["sliced_from"] = manifest["built_at"]
        manifest.pop("coverage", None)
        manifest["partitions"] = parts
        (root / sub / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False))
        print(f"  {sub}: {sum(p['rows'] for p in parts)} rows")

    duck.close()
    return targets


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, default=Path("test/e2e/fixtures"))
    how = ap.add_mutually_exclusive_group(required=True)
    how.add_argument("--scales-from", type=Path,
                     help="a built database to copy column scales and vocabularies from")
    how.add_argument("--from-published", type=Path,
                     help="a published v1 tree to slice every source out of")
    args = ap.parse_args(argv)

    if args.from_published:
        targets = slice_published(args.from_published, args.out)
        print(json.dumps(targets, indent=2, ensure_ascii=False))
        return 0

    source = db.connect(args.scales_from)
    scales = {
        r[0]: r[1]
        for r in source.execute("SELECT column_name, scale FROM column_meta WHERE scale != 1")
    }

    work = args.out / "fixture.sqlite"
    work.parent.mkdir(parents=True, exist_ok=True)
    work.unlink(missing_ok=True)
    schema.build(work, scales=scales)

    conn = db.connect(work, bulk=True)
    for (name,) in source.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'vocab_%'"
    ):
        rows = source.execute(f"SELECT id, code FROM {name}").fetchall()
        if rows:
            conn.executemany(f"INSERT INTO {name} (id, code) VALUES (?,?)", [tuple(r) for r in rows])
    conn.commit()

    loader = ingest.Loader(conn, spec.load(scales))
    client = api.client()
    for dept in DEPTS:
        page = api.page(
            client,
            f"{API}/lines",
            {"size": PER_DEPT, "format": "csv", "sort": "_i",
             "qs": f'code_departement_ban:"{dept}"'},
        )
        with db.transaction(conn):
            loaded = loader.load_page(page.rows)
        conn.execute(
            "INSERT INTO ingest_departement"
            " (code_departement, total_expected, rows_loaded, started_at, completed_at)"
            " VALUES (?,?,?,datetime(),datetime())"
            " ON CONFLICT(code_departement) DO UPDATE SET rows_loaded = excluded.rows_loaded",
            (dept, loaded, loaded),
        )
        conn.commit()
        print(f"  {dept}: {loaded} certificates")
    conn.close()

    export_parquet.export(work, args.out, quiet=False)
    work.unlink()
    print(f"fixture written to {args.out / export_parquet.VERSION}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
