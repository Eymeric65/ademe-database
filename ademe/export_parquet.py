"""SQLite -> partitioned Parquet. `python -m ademe.export_parquet --out DIR`

Writes, per departement, a narrow search index and the full 226-column detail
file, plus two side files and a manifest. The layout and the reasoning behind
it are ADR-0006.

The SELECT is GENERATED from `column_meta` and `mapping.REPEATS`, exactly as
`ademe/reconstruct.py` is. That is the whole point: a hand-written 226-column
projection would drift from the schema the first time an encoding changed, and
"lossless" would quietly stop being true for one column. Anything the schema
knows, this knows.

DuckDB ATTACHes the SQLite file rather than the rows passing through Python:
15.5M x 226 values is not a Python loop. The same engine reads the files back
in the tests and merges the weekly delta in ademe/delta.py, so the type mapping
is identical at both ends.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import duckdb

from ademe import db, geo
from ademe.config import DEFAULT_DB
from ademe.mapping import REPEATS

VERSION = "v1"

# One row group is one detail read: a few MB, so a point lookup pulls one row
# group of one partition rather than a whole file.
DPE_ROW_GROUP = 10_000
# The search file is scanned, not point-queried, so bigger groups pay.
SEARCH_ROW_GROUP = 50_000

# The narrow index the search screen reads. Everything a listing can tell you,
# and nothing else -- see ADR-0006.
SEARCH_COLUMNS = (
    "numero_dpe",
    "code_departement_ban",
    "code_postal_ban",
    "code_insee_ban",
    "nom_commune_ban",
    "adresse_ban",
    "etiquette_dpe",
    "etiquette_ges",
    "date_etablissement_dpe",
    "surface_habitable_logement",
    "conso_5_usages_par_m2_ep",
    "emission_ges_5_usages_par_m2",
    "type_batiment",
    "periode_construction",
    "annee_construction",
    "lat",
    "lon",
)

SEARCH_SORT = ("code_postal_ban", "etiquette_dpe", "surface_habitable_logement")

# The overseas departements are three-digit codes with a few thousand rows
# each. One partition each would mean four files a search has to consider for
# no benefit; merged, they are one small file.
DOM = ("975", "976", "977", "978")


def partition_of(code: str) -> str:
    """The partition a departement code lands in."""
    return "DOM" if code in DOM else code


# --- the generated projection ----------------------------------------------


def _alias_for(rep_table: str, outer: int, inner: int | None) -> str:
    return f"s_{rep_table}_{outer}" + (f"_{inner}" if inner is not None else "")


class Plan:
    """Where every source column comes from, and how to decode it.

    Built from `column_meta` -- the same table `reconstruct.Reconstructor`
    reads -- plus REPEATS for the slot layout, which column_meta records only
    per repeating group rather than per slot.
    """

    def __init__(self, conn):
        self.meta = {
            r["column_name"]: dict(r)
            for r in conn.execute("SELECT * FROM column_meta").fetchall()
        }
        # source column -> the table alias holding it
        self.alias: dict[str, str] = {}
        base = {
            "dpe": "d",
            "adresse": "a",
            "commune": "cm",
            "dpe_adresse_brut": "br",
        }
        for col, m in self.meta.items():
            if m["destination"] in base:
                self.alias[col] = base[m["destination"]]
        for rep in REPEATS:
            for slot in rep.slots():
                a = _alias_for(rep.table, slot["outer"], slot["inner"])
                for src in slot["src_to_dst"]:
                    self.alias[src] = a

        missing = [c for c in self.meta if c not in self.alias]
        if missing:
            raise RuntimeError(f"no source table for {missing[:5]}")

        # A vocabulary join per (alias, column): two slots of the same group
        # decode through the same vocab table but different rows, so they
        # cannot share one join.
        self.vocab_join: dict[str, tuple[str, str, str]] = {}
        for col, m in self.meta.items():
            if m["domain"]:
                v = f"v{len(self.vocab_join)}"
                self.vocab_join[col] = (v, m["domain"], f"{self.alias[col]}.\"{m['dest_column']}\"")

    def expr(self, col: str) -> str:
        """The SQL that reproduces one source column's value."""
        m = self.meta[col]
        enc, scale = m["encoding"], m["scale"]
        qualified = f'{self.alias[col]}."{m["dest_column"]}"'

        if m["domain"]:
            return f'{self.vocab_join[col][0]}.code'
        if enc == "date":
            # The day count arrives from SQLite as BIGINT; DATE + BIGINT has
            # no overload, only DATE + INTEGER.
            return f"CAST(DATE '1970-01-01' + CAST({qualified} AS INTEGER) AS DATE)"
        if enc == "scaled":
            places = len(str(scale)) - 1
            # TRAP: cast to DECIMAL(38,0) BEFORE dividing. Casting the stored
            # integer straight to DECIMAL(18,s) overflows -- 6478894912345 as a
            # DECIMAL(18,6) needs nineteen digits -- and dividing as DOUBLE
            # would defeat the entire point of scaled integers (ADR-0004).
            return (
                f"CAST(CAST({qualified} AS DECIMAL(38,0))"
                f" / CAST({scale} AS DECIMAL(38,0)) AS DECIMAL(18,{places}))"
            )
        if enc == "int":
            return f"CAST({qualified} AS BIGINT)"
        return f"CAST({qualified} AS VARCHAR)"


def wide_select(conn, *, where: str = "TRUE") -> str:
    """The full 226-column projection plus lat/lon, as one SELECT."""
    plan = Plan(conn)
    cols = [f'd.numero_dpe AS "numero_dpe"']
    for col in plan.meta:
        if col == "numero_dpe":
            continue
        cols.append(f'{plan.expr(col)} AS "{col}"')
    # lat/lon are derived at export from the Lambert-93 pair (see ademe/geo.py
    # and ADR-0006); the loader's _geopoint path never fires, because the CSV
    # export does not carry Data Fair internals unless they are selected.
    cols.append('CAST(g.lat AS DECIMAL(10,6)) AS "lat"')
    cols.append('CAST(g.lon AS DECIMAL(10,6)) AS "lon"')

    joins = [
        "LEFT JOIN sq.adresse a ON a.adresse_id = d.adresse_id",
        "LEFT JOIN sq.commune cm ON cm.commune_id = a.commune_id",
        "LEFT JOIN sq.dpe_adresse_brut br ON br.dpe_id = d.dpe_id",
        "LEFT JOIN geopoint g ON g.dpe_id = d.dpe_id",
    ]
    for rep in REPEATS:
        for slot in rep.slots():
            a = _alias_for(rep.table, slot["outer"], slot["inner"])
            on = [f"{a}.dpe_id = d.dpe_id", f"{a}.rang = {slot['outer']}"]
            if slot["inner"] is not None:
                on.append(f"{a}.rang_generateur = {slot['inner']}")
            joins.append(f"LEFT JOIN sq.{rep.table} {a} ON " + " AND ".join(on))
    for _col, (v, domain, key) in plan.vocab_join.items():
        joins.append(f"LEFT JOIN sq.vocab_{domain} {v} ON {v}.id = {key}")

    return (
        "SELECT\n  "
        + ",\n  ".join(cols)
        + "\nFROM sq.dpe d\n"
        + "\n".join(joins)
        + f"\nWHERE {where}"
    )


# --- export -----------------------------------------------------------------


def _dept_source(conn) -> tuple[str, str, str]:
    """(table, column, vocab domain) for `code_departement_ban`.

    Read from column_meta rather than hard-coded: the vocabulary table is named
    after the DOMAIN (`vocab_code_departement`), not after the source column,
    and guessing that got it wrong.
    """
    r = conn.execute(
        "SELECT destination, dest_column, domain FROM column_meta"
        " WHERE column_name = 'code_departement_ban'"
    ).fetchone()
    return r["destination"], r["dest_column"], r["domain"]


def _dept_join(conn, alias_c: str = "c", alias_v: str = "v") -> str:
    """The join reaching the decoded departement code, whatever table it is on."""
    table, column, domain = _dept_source(conn)
    return f"JOIN vocab_{domain} {alias_v} ON {alias_v}.id = {alias_c}.{column}"


def _departements(conn) -> list[str]:
    _, column, domain = _dept_source(conn)
    return [
        r[0]
        for r in conn.execute(
            f"SELECT DISTINCT v.code FROM commune c"
            f" JOIN vocab_{domain} v ON v.id = c.{column}"
            " WHERE v.code IS NOT NULL AND v.code != '' ORDER BY v.code"
        )
    ]


def _geopoint_rows(conn, codes: list[str]) -> list[tuple[int, float | None, float | None]]:
    """(dpe_id, lat, lon) for one partition, projected in Python.

    Small enough to materialise: one row per certificate, three numbers.
    """
    marks = ",".join("?" * len(codes))
    rows = conn.execute(
        "SELECT d.dpe_id, d.coordonnee_cartographique_x_ban, d.coordonnee_cartographique_y_ban"
        " FROM dpe d"
        " JOIN adresse a ON a.adresse_id = d.adresse_id"
        " JOIN commune c ON c.commune_id = a.commune_id"
        f" {_dept_join(conn)}"
        f" WHERE v.code IN ({marks})",
        codes,
    ).fetchall()
    scale = 10**6
    # One departement per call, so the projection question is answered once.
    lambert = any(geo.is_lambert93(c) for c in codes)
    out = []
    for dpe_id, x, y in rows:
        if x is None or y is None or not lambert:
            out.append((dpe_id, None, None))
            continue
        lat, lon = geo.wgs84_for(codes[0], x / scale, y / scale)
        out.append((dpe_id, lat, lon))
    return out


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def export(
    db_path: Path, out_dir: Path, depts: list[str] | None = None, *, quiet: bool = True
) -> dict:
    """Write every partition and the manifest. Returns the manifest."""
    conn = db.connect(db_path)
    root = Path(out_dir) / VERSION
    root.mkdir(parents=True, exist_ok=True)

    codes = depts or _departements(conn)
    by_partition: dict[str, list[str]] = {}
    for code in codes:
        by_partition.setdefault(partition_of(code), []).append(code)

    duck = duckdb.connect()
    duck.execute("INSTALL sqlite; LOAD sqlite")
    duck.execute(f"ATTACH '{db_path}' AS sq (TYPE sqlite, READ_ONLY)")

    partitions = []
    exceptions: list[tuple[str, str]] = []

    for part, part_codes in sorted(by_partition.items()):
        quoted = ", ".join(f"'{c}'" for c in part_codes)
        _, dept_col, dept_domain = _dept_source(conn)
        where = (
            "d.dpe_id IN (SELECT d2.dpe_id FROM sq.dpe d2"
            " JOIN sq.adresse a2 ON a2.adresse_id = d2.adresse_id"
            " JOIN sq.commune c2 ON c2.commune_id = a2.commune_id"
            f" JOIN sq.vocab_{dept_domain} v2 ON v2.id = c2.{dept_col}"
            f" WHERE v2.code IN ({quoted}))"
        )

        duck.execute("CREATE OR REPLACE TEMP TABLE geopoint (dpe_id BIGINT, lat DOUBLE, lon DOUBLE)")
        rows = _geopoint_rows(conn, part_codes)
        if rows:
            duck.executemany("INSERT INTO geopoint VALUES (?, ?, ?)", rows)

        duck.execute(
            f"CREATE OR REPLACE TEMP TABLE wide AS {wide_select(conn, where=where)}"
        )
        n = duck.execute("SELECT COUNT(*) FROM wide").fetchone()[0]
        if not quiet:
            print(f"  dept={part}: {n:,} certificates")

        dpe_path = root / "dpe" / f"dept={part}" / "part-0000.parquet"
        search_path = root / "search" / f"dept={part}" / "part-0000.parquet"
        dpe_path.parent.mkdir(parents=True, exist_ok=True)
        search_path.parent.mkdir(parents=True, exist_ok=True)

        duck.execute(
            f"COPY (SELECT * FROM wide ORDER BY numero_dpe) TO '{dpe_path}'"
            f" (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE {DPE_ROW_GROUP})"
        )
        cols = ", ".join(f'"{c}"' for c in SEARCH_COLUMNS)
        order = ", ".join(f'"{c}"' for c in SEARCH_SORT)
        duck.execute(
            f"COPY (SELECT {cols} FROM wide ORDER BY {order}) TO '{search_path}'"
            f" (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE {SEARCH_ROW_GROUP})"
        )

        # A numero whose embedded departement disagrees with its partition
        # cannot be found by the detail view's substring shortcut (PR11).
        for (numero,) in duck.execute(
            "SELECT numero_dpe FROM wide WHERE substr(numero_dpe, 3, 2) != ?"
            " OR numero_dpe IS NULL",
            [part],
        ).fetchall():
            exceptions.append((numero, part))

        partitions.append(
            {
                "dept": part,
                "codes": part_codes,
                "rows": n,
                "search": {
                    "path": str(search_path.relative_to(root)),
                    "bytes": search_path.stat().st_size,
                    "sha256": _sha256(search_path),
                },
                "dpe": {
                    "path": str(dpe_path.relative_to(root)),
                    "bytes": dpe_path.stat().st_size,
                    "sha256": _sha256(dpe_path),
                },
            }
        )

    index = root / "index"
    index.mkdir(parents=True, exist_ok=True)
    duck.execute("CREATE OR REPLACE TEMP TABLE exc (numero_dpe VARCHAR, dept VARCHAR)")
    if exceptions:
        duck.executemany("INSERT INTO exc VALUES (?, ?)", exceptions)
    duck.execute(
        f"COPY (SELECT * FROM exc ORDER BY numero_dpe) TO"
        f" '{index / 'numero-exceptions.parquet'}' (FORMAT parquet, COMPRESSION zstd)"
    )

    # Values the declared scale could not hold are stored verbatim in SQLite;
    # that copy is the truth, so it ships beside the data and read_rows prefers
    # it. Expected empty -- but departement 09 alone has eleven.
    viol = conn.execute(
        "SELECT d.numero_dpe, s.column_name, s.raw_value FROM scale_violation s"
        " JOIN dpe d ON d.dpe_id = s.dpe_id ORDER BY d.numero_dpe, s.column_name"
    ).fetchall()
    duck.execute(
        "CREATE OR REPLACE TEMP TABLE viol"
        " (numero_dpe VARCHAR, column_name VARCHAR, raw_value VARCHAR)"
    )
    if viol:
        duck.executemany("INSERT INTO viol VALUES (?, ?, ?)", [tuple(r) for r in viol])
    duck.execute(
        f"COPY (SELECT * FROM viol) TO '{index / 'scale-violation.parquet'}'"
        " (FORMAT parquet, COMPRESSION zstd)"
    )

    manifest = write_manifest(conn, root, partitions)
    duck.close()
    conn.close()
    return manifest


def write_manifest(conn, root: Path, partitions: list[dict]) -> dict:
    src = conn.execute("SELECT * FROM data_source").fetchone()
    high = conn.execute(
        "SELECT MAX(date_derniere_modification_dpe) FROM dpe"
    ).fetchone()[0]
    manifest = {
        "version": VERSION,
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "schema_sha256": src["schema_sha256"] if src else None,
        # The incremental key: the delta asks ADEME for everything modified
        # after this. Stored as ISO, not as the day count SQLite holds.
        "high_water": (date(1970, 1, 1) + timedelta(days=int(high))).isoformat()
        if high is not None
        else None,
        "column_meta": {
            r["column_name"]: {"encoding": r["encoding"], "scale": r["scale"]}
            for r in conn.execute(
                "SELECT column_name, encoding, scale FROM column_meta ORDER BY column_name"
            )
        },
        "search_columns": list(SEARCH_COLUMNS),
        "partitions": partitions,
    }
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False))
    return manifest


# --- reading back -----------------------------------------------------------


def _fmt(value, encoding: str, scale: int) -> str:
    """Render one Parquet value the way the source wrote it.

    The inverse of `Plan.expr`, and deliberately the same canonicalisation
    `reconstruct._fmt_scaled` applies: the declared number of decimal places,
    always, because ADEME writes `38` and `117.1` in the same column and
    reproducing that per-value would mean storing a decimal count per value.
    """
    if value is None:
        return ""
    if encoding == "date":
        return value.isoformat()
    if encoding == "scaled":
        places = len(str(scale)) - 1
        return f"{Decimal(value):.{places}f}" if places else str(int(value))
    if encoding == "int":
        return str(int(value))
    return str(value)


def read_rows(out_dir: Path, numeros: list[str]) -> dict[str, dict[str, str]]:
    """The published rows, as source-shaped strings. Used by the round-trip."""
    root = Path(out_dir)
    manifest = json.loads((root / "manifest.json").read_text())
    meta = manifest["column_meta"]

    duck = duckdb.connect()
    files = str(root / "dpe" / "*" / "*.parquet")
    marks = ",".join("?" * len(numeros))
    cur = duck.execute(
        f"SELECT * FROM read_parquet('{files}') WHERE numero_dpe IN ({marks})", numeros
    )
    names = [d[0] for d in cur.description]
    out: dict[str, dict[str, str]] = {}
    for row in cur.fetchall():
        rec = dict(zip(names, row))
        numero = rec["numero_dpe"]
        out[numero] = {
            c: _fmt(v, meta[c]["encoding"], meta[c]["scale"]) if c in meta else
               ("" if v is None else str(v))
            for c, v in rec.items()
        }

    # The side file wins: a value the declared scale could not hold was stored
    # verbatim precisely because the scaled copy is lossy for it.
    vpath = root / "index" / "scale-violation.parquet"
    if vpath.exists() and out:
        for numero, col, raw in duck.execute(
            f"SELECT numero_dpe, column_name, raw_value FROM read_parquet('{vpath}')"
            f" WHERE numero_dpe IN ({marks})",
            numeros,
        ).fetchall():
            if numero in out:
                out[numero][col] = raw
    duck.close()
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db-path", type=Path, default=DEFAULT_DB)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--dept", action="append", help="repeatable; omit for all")
    args = ap.parse_args(argv)

    m = export(args.db_path, args.out, args.dept, quiet=False)
    total = sum(p["rows"] for p in m["partitions"])
    print(
        f"wrote {len(m['partitions'])} partition(s), {total:,} certificates"
        f" to {args.out / VERSION}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
