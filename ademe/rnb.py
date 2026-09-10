"""RNB, the national building register, as Parquet. `python -m ademe.rnb --out DIR`

The bridge from a certificate to the cadastre: ADEME's `id_rnb` names a building,
and the building lists the parcels it stands on (`plots`) and the BAN addresses
it carries (`addresses`). RNB publishes a weekly CSV per département; this keeps
every field of it except the polygon and the validator. See ADR-0019.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import duckdb
import httpx

from ademe.api import TIMEOUT
from ademe.export_parquet import COMPRESSION, VERSION, _sha256

URL = "https://rnb-opendata.s3.fr-par.scw.cloud/files/RNB_{code}.csv.zip"
CATALOGUE = "https://www.data.gouv.fr/api/1/datasets/referentiel-national-des-batiments/"
LICENCE = "Licence Ouverte 2.0 (Etalab)"

HEADER = ("rnb_id", "point", "shape", "status", "ext_ids", "addresses", "plots", "validated_by")
KEPT = ("rnb_id", "status", "point", "ext_ids", "addresses", "plots")
DROPPED = ("shape", "validated_by")

# The JSON columns, typed. json_transform silently drops a key missing from
# these, so `_refuse_new_keys` runs first and fails the build instead.
NESTED = {
    "ext_ids": {
        "id": "VARCHAR",
        "source": "VARCHAR",
        "created_at": "VARCHAR",
        "source_version": "VARCHAR",
    },
    "addresses": {
        "cle_interop_ban": "VARCHAR",
        "street_number": "VARCHAR",
        "street_rep": "VARCHAR",
        "street": "VARCHAR",
        "city_zipcode": "VARCHAR",
        "city_name": "VARCHAR",
    },
    "plots": {"id": "VARCHAR", "bdg_cover_ratio": "DOUBLE"},
}

# A lookup by rnb_id reads one row group of one partition.
ROW_GROUP = 10_000

# Per-département files only: RNB_nat.csv.zip is all of them again, 11.7 GB.
_FILE = re.compile(r"/RNB_(\d{2,3}|2[AB])\.csv\.zip$")


def client() -> httpx.Client:
    # Not api.client(): that one carries the ADEME key, a credential for
    # data.ademe.fr that has no business reaching another operator's bucket.
    return httpx.Client(
        timeout=TIMEOUT,
        follow_redirects=True,
        headers={"user-agent": "ademe-database/0.1 (local research build)"},
    )


_client = client  # `build` takes a `client=` argument, which shadows the name


def departements(client: httpx.Client) -> list[str]:
    """The codes RNB publishes a file for, from the data.gouv.fr catalogue."""
    r = client.get(CATALOGUE)
    r.raise_for_status()
    return sorted(
        {m.group(1) for res in r.json()["resources"] if (m := _FILE.search(res.get("url") or ""))}
    )


def _refuse_new_keys(duck: duckdb.DuckDBPyConnection) -> None:
    for col, fields in NESTED.items():
        keys = {
            r[0]
            for r in duck.execute(
                f"SELECT DISTINCT unnest(json_keys(e)) FROM"
                f" (SELECT unnest(json_extract({col}, '$[*]')) AS e FROM src WHERE {col} IS NOT NULL)"
            ).fetchall()
        }
        if extra := keys - set(fields):
            raise ValueError(f"RNB added {sorted(extra)} to {col}; publish or drop them explicitly")


def convert(csv_path: Path, out_path: Path) -> int:
    """One RNB CSV to one Parquet partition. Returns the row count."""
    with csv_path.open(encoding="utf-8") as fh:
        header = tuple(fh.readline().rstrip("\r\n").split(";"))
    if header != HEADER:
        raise ValueError(f"RNB header changed: {header}, expected {HEADER}")

    duck = duckdb.connect()
    # The polygons never enter the table: they are ~90% of the file.
    duck.execute(f"SET temp_directory = '{csv_path.parent}'")
    duck.execute(
        f"CREATE TEMP TABLE src AS SELECT {', '.join(KEPT)} FROM read_csv('{csv_path}',"
        " delim=';', header=true, quote='\"', escape='\"', all_varchar=true)"
    )
    _refuse_new_keys(duck)
    cols = ", ".join(
        f"json_transform_strict({c}, '{json.dumps([NESTED[c]])}') AS {c}" if c in NESTED else c
        for c in KEPT
    )
    duck.execute(
        f"COPY (SELECT {cols} FROM src ORDER BY rnb_id) TO '{out_path}'"
        f" (FORMAT parquet, {COMPRESSION}, ROW_GROUP_SIZE {ROW_GROUP})"
    )
    return duck.execute("SELECT count(*) FROM src").fetchone()[0]


def _download(
    client: httpx.Client, url: str, dest: Path, etag: str | None
) -> tuple[str | None, str | None] | None:
    """(etag, last_modified), or None when the server says nothing changed."""
    headers = {"if-none-match": etag} if etag else {}
    with client.stream("GET", url, headers=headers) as r:
        if r.status_code == 304:
            return None
        r.raise_for_status()
        with dest.open("wb") as fh:
            for chunk in r.iter_bytes(1 << 20):
                fh.write(chunk)
        return r.headers.get("etag"), r.headers.get("last-modified")


def _extract(zipped: Path, code: str, work: Path) -> Path:
    member = f"RNB_{code}.csv"
    with zipfile.ZipFile(zipped) as z:
        if (names := z.namelist()) != [member]:
            raise ValueError(f"{zipped.name}: expected only {member}, found {names}")
        z.extract(member, work)
    return work / member


def build(out: Path, codes: list[str] | None = None, *, client: httpx.Client | None = None) -> dict:
    """Refresh `out/v1/rnb/` and write its manifest, last.

    A département whose ETag has not moved answers 304 and keeps its partition.
    One that fails raises before the manifest is written, so the manifest never
    names a half-built set. Départements not asked for keep their entries.
    """
    root = out / VERSION / "rnb"
    root.mkdir(parents=True, exist_ok=True)
    manifest_path = root / "manifest.json"
    previous = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    parts = {p["dept"]: p for p in previous.get("partitions", [])}

    own = client is None
    http = _client() if own else client
    # Beside the output, not in /tmp: /tmp is RAM on Fedora, and a large
    # département's CSV is a gigabyte of polygons.
    work = root / ".work"
    work.mkdir(exist_ok=True)
    try:
        for code in codes if codes is not None else departements(http):
            dest = root / f"dept={code}" / "part-0000.parquet"
            known = parts.get(code)
            zipped = work / f"RNB_{code}.csv.zip"
            got = _download(
                http, URL.format(code=code), zipped, known["etag"] if known and dest.exists() else None
            )
            if got is None:
                continue
            tmp = work / f"{code}.parquet"
            rows = convert(_extract(zipped, code, work), tmp)
            dest.parent.mkdir(exist_ok=True)
            os.replace(tmp, dest)
            parts[code] = {
                "dept": code,
                "rows": rows,
                "etag": got[0],
                "last_modified": got[1],
                "sha256": _sha256(dest),
            }
            for f in work.iterdir():
                f.unlink()
    finally:
        shutil.rmtree(work, ignore_errors=True)
        if own:
            http.close()

    manifest = {
        "version": VERSION,
        "source": "rnb",
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "licence": LICENCE,
        "origin": URL,
        "columns": list(KEPT),
        "dropped": list(DROPPED),
        "partitions": [parts[k] for k in sorted(parts)],
    }
    tmp = root / "manifest.json.tmp"
    tmp.write_text(json.dumps(manifest, indent=2, ensure_ascii=False))
    os.replace(tmp, manifest_path)
    return manifest


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", type=Path, required=True, help="writes OUT/v1/rnb/")
    ap.add_argument(
        "--dept", action="append", help="one code, repeatable; default every file in the catalogue"
    )
    args = ap.parse_args(argv)
    m = build(args.out, args.dept)
    rows = sum(p["rows"] for p in m["partitions"])
    print(f"{len(m['partitions'])} partitions, {rows:,} buildings -> {args.out / VERSION / 'rnb'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
