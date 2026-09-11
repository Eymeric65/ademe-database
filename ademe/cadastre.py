"""Cadastre parcels, attributes only, as Parquet. `python -m ademe.cadastre --out DIR`

What an RNB `plots[].id` names: a parcel's commune, section, number and area.
Etalab republishes the DGFiP cadastre quarterly as one gzipped GeoJSON
FeatureCollection per département; this keeps every property and drops the
polygon. See ADR-0020.
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import re
import shutil
from collections.abc import Iterator
from datetime import datetime, timezone
from pathlib import Path

import duckdb
import httpx

from ademe.api import TIMEOUT
from ademe.export_parquet import COMPRESSION, VERSION, _sha256

BASE = "https://cadastre.data.gouv.fr/data/etalab-cadastre/latest/geojson/departements/"
URL = BASE + "{code}/cadastre-{code}-parcelles.json.gz"
LICENCE = "Licence Ouverte 2.0 (Etalab)"

HEADER = '{"type":"FeatureCollection","features":['
COLUMNS = {
    "id": "VARCHAR",
    "commune": "VARCHAR",
    "prefixe": "VARCHAR",
    "section": "VARCHAR",
    "numero": "VARCHAR",
    "contenance": "BIGINT",
    "arpente": "BOOLEAN",
    "created": "DATE",
    "updated": "DATE",
}
KEPT = tuple(COLUMNS)

# A lookup by parcel id reads one row group of one partition.
ROW_GROUP = 10_000

_DEPT = re.compile(r'href="[^"]*/departements/(\d{2,3}|2[AB])/"')
_EDITION = re.compile(r"/etalab-cadastre/(\d{4}-\d{2}-\d{2})/")


def client() -> httpx.Client:
    # Not api.client(): that one carries the ADEME key, which is for
    # data.ademe.fr alone.
    return httpx.Client(
        timeout=TIMEOUT,
        follow_redirects=True,
        headers={"user-agent": "ademe-database/0.1 (local research build)"},
    )


_client = client  # `build` takes a `client=` argument, which shadows the name


def departements(client: httpx.Client) -> list[str]:
    """The codes the current edition has a file for, from its index page."""
    r = client.get(BASE)
    r.raise_for_status()
    return sorted(set(_DEPT.findall(r.text)))


def _properties(gz_path: Path) -> Iterator[dict]:
    """Each feature's properties, checking the layout the line reader relies on.

    Etalab writes a header line, then one feature per line followed by `,`, the
    last closed by `]}`. Anything else -- two features on a line, a file cut
    short on a line boundary -- would otherwise publish a wrong or partial
    département without an error.
    """
    dec = json.JSONDecoder()
    with gzip.open(gz_path, "rt", encoding="utf-8") as fh:
        first = fh.readline().rstrip("\n")
        if first != HEADER:
            raise ValueError(f"not the FeatureCollection header Etalab writes: {first[:60]!r}")
        closed = False
        for n, line in enumerate(fh, start=2):
            if closed:
                raise ValueError(f"line {n}: content after the closing ]}}")
            s = line.rstrip("\n")
            feature, end = dec.raw_decode(s)
            rest = s[end:]
            if rest == "]}":
                closed = True
            elif rest != ",":
                raise ValueError(f"line {n}: expected one feature then ',' or ']}}', found {rest[:40]!r}")
            p = feature["properties"]
            if feature.get("id") != p.get("id"):
                raise ValueError(f"line {n}: feature id {feature.get('id')!r} is not properties.id {p.get('id')!r}")
            if extra := p.keys() - COLUMNS.keys():
                raise ValueError(f"line {n}: new properties {sorted(extra)}; publish or drop them explicitly")
            # An absent key is published as NULL and read back as absent, which
            # is lossless only while Etalab never writes an explicit null.
            if None in p.values():
                raise ValueError(f"line {n}: explicit null in {p['id']}")
            yield p
    if not closed:
        raise ValueError("no closing ]} -- the file stops mid-collection")


def convert(gz_path: Path, out_path: Path) -> int:
    """One département's GeoJSON to one Parquet partition. Returns the row count."""
    ndjson = out_path.with_suffix(".ndjson")
    rows = 0
    with ndjson.open("w", encoding="utf-8") as fh:
        for p in _properties(gz_path):
            fh.write(json.dumps(p, ensure_ascii=False))
            fh.write("\n")
            rows += 1
    duck = duckdb.connect()
    duck.execute(f"SET temp_directory = '{out_path.parent}'")
    cols = ", ".join(f"{k}: '{v}'" for k, v in COLUMNS.items())
    duck.execute(
        f"COPY (SELECT * FROM read_json('{ndjson}', format='newline_delimited', columns={{{cols}}})"
        f" ORDER BY id) TO '{out_path}' (FORMAT parquet, {COMPRESSION}, ROW_GROUP_SIZE {ROW_GROUP})"
    )
    ndjson.unlink()
    return rows


def _download(
    client: httpx.Client, url: str, dest: Path, etag: str | None
) -> tuple[str | None, str | None, str | None] | None:
    """(etag, last_modified, edition), or None when the server says nothing changed."""
    headers = {"if-none-match": etag} if etag else {}
    with client.stream("GET", url, headers=headers) as r:
        if r.status_code == 304:
            return None
        r.raise_for_status()
        with dest.open("wb") as fh:
            for chunk in r.iter_bytes(1 << 20):
                fh.write(chunk)
        edition = _EDITION.search(str(r.url))
        return r.headers.get("etag"), r.headers.get("last-modified"), edition and edition.group(1)


def build(out: Path, codes: list[str] | None = None, *, client: httpx.Client | None = None) -> dict:
    """Refresh `out/v1/cadastre/` and write its manifest, last.

    A département whose ETag has not moved answers 304 and keeps its partition.
    One that fails raises before the manifest is written. Départements not asked
    for keep their entries.
    """
    root = out / VERSION / "cadastre"
    root.mkdir(parents=True, exist_ok=True)
    manifest_path = root / "manifest.json"
    previous = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    parts = {p["dept"]: p for p in previous.get("partitions", [])}

    own = client is None
    http = _client() if own else client
    # Beside the output, not in /tmp: /tmp is RAM on Fedora.
    work = root / ".work"
    work.mkdir(exist_ok=True)
    try:
        for code in codes if codes is not None else departements(http):
            dest = root / f"dept={code}" / "part-0000.parquet"
            known = parts.get(code)
            zipped = work / f"cadastre-{code}-parcelles.json.gz"
            got = _download(
                http, URL.format(code=code), zipped, known["etag"] if known and dest.exists() else None
            )
            if got is None:
                continue
            tmp = work / f"{code}.parquet"
            rows = convert(zipped, tmp)
            dest.parent.mkdir(exist_ok=True)
            os.replace(tmp, dest)
            parts[code] = {
                "dept": code,
                "edition": got[2],
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
        "source": "cadastre",
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "licence": LICENCE,
        "origin": URL,
        "columns": list(KEPT),
        "partitions": [parts[k] for k in sorted(parts)],
    }
    tmp = root / "manifest.json.tmp"
    tmp.write_text(json.dumps(manifest, indent=2, ensure_ascii=False))
    os.replace(tmp, manifest_path)
    return manifest


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", type=Path, required=True, help="writes OUT/v1/cadastre/")
    ap.add_argument(
        "--dept", action="append", help="one code, repeatable; default every file in the edition"
    )
    args = ap.parse_args(argv)
    m = build(args.out, args.dept)
    rows = sum(p["rows"] for p in m["partitions"])
    print(f"{len(m['partitions'])} partitions, {rows:,} parcels -> {args.out / VERSION / 'cadastre'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
