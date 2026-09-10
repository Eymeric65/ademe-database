"""Load the certificates. `python -m ademe.ingest --dept 09` / `--all`

Streams CSV straight into the normalised tables. Nothing raw is written to
disk: the full export is ~31 GB of CSV and landing it first would cost more
space than the finished database.

Resumable at page granularity. The ledger stores the server's own `next`
cursor, so a killed run restarts mid-departement instead of re-downloading it.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import date
from decimal import Decimal, InvalidOperation
from pathlib import Path

from ademe import api, db, ddl, spec
from ademe.config import EXISTANT, PAGE_SIZE, SOURCES, UNGEOCODED, Source
from ademe.mapping import check_coverage

EPOCH = date(1970, 1, 1)
MIN_FREE_BYTES = 1_500_000_000
INT64_MIN, INT64_MAX = -(2**63), 2**63 - 1


def to_days(raw: str) -> int | None:
    try:
        return (date.fromisoformat(raw[:10]) - EPOCH).days
    except ValueError:
        return None


def to_scaled(raw: str, scale: int) -> tuple[int | None, str | None]:
    """(stored value, raw literal if it would not round-trip).

    Decimal throughout: float would defeat the point, which is byte-exact
    regeneration.
    """
    try:
        d = Decimal(raw)
    except (InvalidOperation, ValueError):
        return None, raw
    scaled = d * scale
    if scaled != scaled.to_integral_value():
        return None, raw  # more precision than the declared scale holds
    # TRAP: SQLite integers are 64 bits and nothing wider -- a larger one is an
    # OverflowError at execute() time, not a truncation. ADEME publishes
    # `hauteur_sous_plafond = 5.55555555555556e+181`, and that one certificate
    # killed a 15-hour national ingest. Too large for the encoding is the same
    # failure as too precise for it, so it takes the same exit.
    if not (INT64_MIN <= scaled <= INT64_MAX):
        return None, raw
    return int(scaled), None


class Accumulator:
    """One page's pending child rows, so they can be inserted in one go."""

    def __init__(self, repeats):
        self.violations: list = []
        self.brut: list = []
        self.children: dict[str, list] = {r.table: [] for r in repeats}


class Loader:
    def __init__(self, conn, cols: dict[str, spec.Column], source: Source = EXISTANT):
        self.conn = conn
        self.cols = cols
        self.source = source
        self.m = source.mapping
        self.cov = check_coverage(list(cols), self.m)
        self.vocab: dict[str, dict[str, int]] = {}
        self.commune: dict[tuple, int] = {}
        self.adresse: dict[tuple, int] = {}
        self._ensure_load_prerequisites()
        self._load_vocab()
        self._load_communes()

    def _ensure_load_prerequisites(self) -> None:
        """The two pieces of schema the load itself depends on.

        Both are created here rather than left to `ademe.schema`, because a
        database part-way through a 15.5M-row import was built by an older
        version of this code and nobody is going to re-run the schema step
        before resuming it. `IF NOT EXISTS` makes that free.

        `bad_row` is the quarantine (ADR-0015). `ux_dpe_numero` is the one
        index the load cannot defer to `finalise`.

        TRAP: a stored resume cursor has a shelf life. `ingest_departement`
        keeps the server's own `after` token, but ADEME keeps publishing --
        departement 30 grew from 157 179 to 157 573 rows over the three days a
        crashed run sat idle. The token is a position in a sort order, so once
        rows are inserted ahead of it the resume re-serves certificates that
        are already loaded, and there is nothing in the response that says so.

        Verified: ADEME serves no duplicates within one pass (157 573 rows for
        dept 30, 157 573 distinct numeros). The duplication is entirely an
        artefact of resuming across a change.

        Without this index the second copy inserts silently and `finalise`
        fails hours later, when it builds the same index over 15M rows. With
        it, `load_page` skips what it already has. See ADR-0014.
        """
        self.conn.execute(ddl.BAD_ROW_DDL)
        self.conn.execute(
            f"CREATE UNIQUE INDEX IF NOT EXISTS ux_dpe_numero ON dpe({self.m.key})"
        )
        self.conn.commit()

    # -- reference data ----------------------------------------------------
    def _load_vocab(self) -> None:
        for domain in spec.vocab_domains(self.cols):
            rows = self.conn.execute(f"SELECT id, code FROM vocab_{domain}").fetchall()
            self.vocab[domain] = {r["code"]: r["id"] for r in rows}

    def _load_communes(self) -> None:
        """Rebuild the dedup cache from what is already loaded.

        Keyed on the whole tuple, so a resumed run recognises a commune it
        already wrote instead of writing it again.
        """
        cols = ddl.commune_key_columns(self.cols, self.source)
        quoted = ", ".join(f'"{c}"' for c in cols)
        self.commune = {
            tuple(r[1:]): r[0]
            for r in self.conn.execute(f"SELECT commune_id, {quoted} FROM commune")
        }

    def vocab_id(self, domain: str, code: str) -> int | None:
        """Closed vocabularies are pre-built; open ones grow here on first
        sight, which is why the dictionary is persisted rather than rebuilt."""
        if not code:
            return None
        table = self.vocab.setdefault(domain, {})
        got = table.get(code)
        if got is None:
            cur = self.conn.execute(
                f"INSERT INTO vocab_{domain} (code) VALUES (?)"
                " ON CONFLICT(code) DO UPDATE SET code = excluded.code"
                " RETURNING id",
                (code,),
            )
            got = cur.fetchone()[0]
            table[code] = got
        return got

    def commune_id(self, row: dict) -> int | None:
        """Deduplicate on the WHOLE commune tuple, not on the INSEE code.

        ADEME does not normalise `nom_commune_ban`: one commune arrives as both
        `PAMIERS` and `Pamiers`, and 13 of departement 09's 326 INSEE codes
        carry two spellings. Keying on the code alone let the first certificate
        impose its spelling on every later one, which the Parquet round-trip
        caught as source='PAMIERS' rebuilt='Pamiers'. Identical rows -- the
        overwhelming majority -- still collapse. See ADR-0010, and
        `adresse_id` below, which has the same shape for the same reason.
        """
        insee = row.get("code_insee_ban") or ""
        if not insee:
            return None
        names, vals = [], []
        for src, dst in self.m.commune.items():
            if dst == "code_insee":
                continue
            names.append(ddl.dest_name(self.cols[src], dst))
            vals.append(self.convert(src, row.get(src, ""))[0])

        key = (insee, *vals)
        if (got := self.commune.get(key)) is not None:
            return got
        cur = self.conn.execute(
            f"INSERT INTO commune (code_insee, {', '.join(names)})"
            f" VALUES ({', '.join('?' * (len(names) + 1))})"
            " RETURNING commune_id",
            key,
        )
        cid = cur.fetchone()[0]
        self.commune[key] = cid
        return cid

    def adresse_id(self, row: dict) -> int | None:
        """3.07 certificates share an address.

        Deduplication keys on the WHOLE address tuple, not on
        `identifiant_ban`. The source is not internally consistent: certificates
        sharing a BAN identifier can disagree on the street text -- one row
        carries `Parc d’Espagne`, another the mojibake `Parc dâ€™Espagne`,
        a third an empty `nom_rue_ban`. Keying on the identifier alone let
        whichever certificate arrived first impose its spelling on the others,
        which the round-trip test caught. Keying on the tuple keeps every
        variant, and identical rows -- the overwhelming majority -- still
        collapse.

        The cache is per-departement: addresses do not recur across
        departements, so a national dict would be 5M entries of pure waste.
        """
        vals = []
        for src, dst in self.m.adresse.items():
            c = self.cols[src]
            raw = row.get(src) or ""
            if not raw:
                vals.append(None)
            elif c.encoding in (spec.VOCAB_CLOSED, spec.VOCAB_OPEN):
                vals.append(self.vocab_id(c.domain, raw))
            elif c.encoding == spec.SCALED:
                vals.append(to_scaled(raw, c.scale)[0])
            elif c.encoding == spec.PLAIN_INT:
                vals.append(to_scaled(raw, 1)[0])
            else:
                vals.append(raw)

        cid = self.commune_id(row)
        key = (*vals, cid)
        if (got := self.adresse.get(key)) is not None:
            return got

        names = [
            f'"{ddl.dest_name(self.cols[s], d)}"'
            for s, d in self.m.adresse.items()
        ]
        cur = self.conn.execute(
            f"INSERT INTO adresse ({', '.join(names)}, commune_id)"
            f" VALUES ({', '.join('?' * len(names))},?) RETURNING adresse_id",
            (*vals, cid),
        )
        aid = cur.fetchone()[0]
        self.adresse[key] = aid
        return aid

    # -- per-row conversion -------------------------------------------------
    def convert(self, key: str, raw: str):
        c = self.cols[key]
        if raw == "" or raw is None:
            return None, None
        if c.encoding == spec.DATE:
            return to_days(raw), None
        if c.encoding in (spec.VOCAB_CLOSED, spec.VOCAB_OPEN):
            return self.vocab_id(c.domain, raw), None
        if c.encoding == spec.SCALED:
            return to_scaled(raw, c.scale)
        if c.encoding == spec.PLAIN_INT:
            v, bad = to_scaled(raw, 1)
            return v, bad
        return raw, None

    # -- quarantine ---------------------------------------------------------
    def _cache_mark(self) -> tuple:
        """Sizes of the dedup caches, for undoing a rolled-back row.

        TRAP: the caches are the reason a savepoint is not enough on its own.
        `adresse_id` and `commune_id` write a row and remember its id; roll the
        write back and the id is gone, but the cache still hands it out. Every
        later certificate at that address would then carry a dangling
        `adresse_id` -- accepted silently, because the load runs with
        `PRAGMA foreign_keys = OFF`, and surfacing 12 hours later as a
        `foreign_key_check` failure in `finalise`. Dicts keep insertion order,
        so the entries added during one row are exactly the last few.
        """
        return (
            len(self.commune),
            len(self.adresse),
            {d: len(v) for d, v in self.vocab.items()},
        )

    def _cache_reset(self, mark: tuple) -> None:
        n_commune, n_adresse, n_vocab = mark
        for cache, n in ((self.commune, n_commune), (self.adresse, n_adresse)):
            for key in list(cache)[n:]:
                del cache[key]
        for domain, n in n_vocab.items():
            for key in list(self.vocab[domain])[n:]:
                del self.vocab[domain][key]

    def _quarantine(self, row: dict, exc: BaseException) -> None:
        self.conn.execute(
            "INSERT INTO bad_row (numero_dpe, code_departement, error, raw)"
            " VALUES (?,?,?,?)",
            (
                row.get(self.m.key),
                row.get(self.m.departement),
                f"{type(exc).__name__}: {exc}",
                json.dumps(row, ensure_ascii=False, sort_keys=True),
            ),
        )

    def load_page(self, rows: list[dict]) -> int:
        """Load a page, and do not let one certificate end a seventeen-hour run.

        Two paths. The fast one is what runs 15.5M times: convert every row,
        then insert the children with `executemany`, because a per-row round
        trip across seven child tables is the difference between 500 rows/s and
        a crawl.

        The slow one runs only for a page that raised. It rolls the whole page
        back -- so the fast path's partial work cannot survive -- and replays it
        one certificate at a time inside a savepoint each. Whatever fails goes
        to `bad_row` with its raw CSV and the exception, and the other 9 999
        rows load. A page has to actually break before anything pays for this.
        """
        self.conn.execute("SAVEPOINT page")
        try:
            self._load_rows(rows)
        except Exception:
            self.conn.execute("ROLLBACK TO page")
            self._cache_reset(self._page_mark)
            self._load_rows_carefully(rows)
        self.conn.execute("RELEASE page")
        return len(rows)

    def _load_rows(self, rows: list[dict]) -> None:
        self._page_mark = self._cache_mark()
        acc = Accumulator(self.m.repeats)
        for row in rows:
            self._convert_row(row, acc)
        self._flush(acc)

    def _load_rows_carefully(self, rows: list[dict]) -> None:
        """One certificate per savepoint. Slow, and only ever used on a page
        that already failed."""
        for row in rows:
            mark = self._cache_mark()
            self.conn.execute("SAVEPOINT row")
            try:
                acc = Accumulator(self.m.repeats)
                self._convert_row(row, acc)
                self._flush(acc)
            except Exception as exc:
                self.conn.execute("ROLLBACK TO row")
                self._cache_reset(mark)
                self._quarantine(row, exc)
            self.conn.execute("RELEASE row")

    def _insert_sql(self) -> tuple[str, list[str]]:
        key = self.m.key
        dpe_cols = [k for k in self.cov.dpe if k != key]
        names = ", ".join(f'"{ddl.dest_name(self.cols[k])}"' for k in dpe_cols)
        placeholders = ", ".join("?" * (len(dpe_cols) + 4))
        return (
            f"INSERT INTO dpe ({key}, adresse_id, lat, lon, {names})"
            f" VALUES ({placeholders})"
            f" ON CONFLICT({key}) DO NOTHING RETURNING dpe_id",
            dpe_cols,
        )

    def _convert_row(self, row: dict, acc: "Accumulator") -> None:
        insert, dpe_cols = self._insert_sql()
        aid = self.adresse_id(row)
        vals, bad = [], []
        for k in dpe_cols:
            v, raw = self.convert(k, row.get(k, ""))
            vals.append(v)
            if raw is not None:
                bad.append((k, raw))
        lat = lon = None
        if geo := row.get("_geopoint"):
            try:
                a, b = geo.split(",")
                lat, lon = int(Decimal(a) * 10**6), int(Decimal(b) * 10**6)
            except (ValueError, InvalidOperation):
                pass
        got = self.conn.execute(
            insert, (row.get(self.m.key), aid, lat, lon, *vals)
        ).fetchone()
        if got is None:
            # Already loaded -- a resumed cursor served it twice. Its children
            # are already there too, so the whole row is skipped. Still
            # counted: `rows_loaded` tracks the certificates the server has
            # handed over, which is what the cursor advances past, not the ones
            # that turned out to be new.
            return
        dpe_id = got[0]
        acc.violations.extend((dpe_id, k, r) for k, r in bad)

        brut = [self.convert(s, row.get(s, ""))[0] for s in self.m.adresse_brut]
        if any(v is not None for v in brut):
            acc.brut.append((dpe_id, *brut))

        for rep in self.m.repeats:
            for slot in rep.slots():
                vals = []
                for src in slot["src_to_dst"]:
                    v, raw = self.convert(src, row.get(src, ""))
                    vals.append(v)
                    if raw is not None:
                        acc.violations.append((dpe_id, src, raw))
                if all(v is None for v in vals):
                    continue  # the occurrence does not exist
                key = [dpe_id, slot["outer"]]
                if rep.inner:
                    key.append(slot["inner"])
                acc.children[rep.table].append((*key, *vals))

    def _flush(self, acc: "Accumulator") -> None:
        if acc.brut:
            cols = ", ".join(
                f'"{ddl.dest_name(self.cols[s], d)}"'
                for s, d in self.m.adresse_brut.items()
            )
            self.conn.executemany(
                f"INSERT INTO dpe_adresse_brut (dpe_id, {cols})"
                f" VALUES ({', '.join('?' * (len(self.m.adresse_brut) + 1))})",
                acc.brut,
            )
        for rep in self.m.repeats:
            batch = acc.children[rep.table]
            if not batch:
                continue
            slot0 = rep.slots()[0]["src_to_dst"]
            dst = [ddl.dest_name(self.cols[s], d) for s, d in slot0.items()]
            keys = ["dpe_id", "rang"] + (["rang_generateur"] if rep.inner else [])
            cols = ", ".join(keys + [f'"{d}"' for d in dst])
            self.conn.executemany(
                f"INSERT INTO {rep.table} ({cols})"
                f" VALUES ({', '.join('?' * (len(keys) + len(dst)))})",
                batch,
            )
        if acc.violations:
            self.conn.executemany(
                "INSERT INTO scale_violation (dpe_id, column_name, raw_value)"
                " VALUES (?,?,?) ON CONFLICT DO NOTHING",
                acc.violations,
            )


def departements(client, source: Source = EXISTANT) -> list[str]:
    r = api._get(client, f"{source.api}/values/{source.mapping.departement}", {"size": 200})
    # ADEME's list is of the departements that exist; NG is the certificates
    # that have none (ADR-0024).
    return sorted(v for v in r.json() if v) + [UNGEOCODED]


def ingest_departement(conn, loader: Loader, client, code: str, *, quiet=False) -> int:
    led = conn.execute(
        "SELECT rows_loaded, next_cursor, completed_at FROM ingest_departement"
        " WHERE code_departement = ?",
        (code,),
    ).fetchone()
    if led and led["completed_at"]:
        if not quiet:
            print(f"  {code}: already complete ({led['rows_loaded']:,} rows)")
        return 0

    expected = api.total(client, departement=code, source=loader.source)
    start_url = led["next_cursor"] if led else None
    loaded = led["rows_loaded"] if led else 0
    if not led:
        conn.execute(
            "INSERT INTO ingest_departement"
            " (code_departement, total_expected, started_at) VALUES (?,?,datetime())",
            (code, expected),
        )
        conn.commit()

    loader.adresse.clear()  # addresses do not recur across departements
    t0 = time.time()
    for p in api.iter_pages(client, departement=code, start_url=start_url, source=loader.source):
        with db.transaction(conn):
            loaded += loader.load_page(p.rows)
            conn.execute(
                "UPDATE ingest_departement SET rows_loaded = ?, next_cursor = ?"
                " WHERE code_departement = ?",
                (loaded, p.next_url, code),
            )
        if not quiet:
            rate = loaded / max(time.time() - t0, 1e-9)
            pct = 100 * loaded / expected if expected else 0
            print(
                f"\r  {code}: {loaded:>8,}/{expected:,} ({pct:5.1f}%) "
                f"{rate:6.0f} rows/s",
                end="",
                flush=True,
            )
    conn.execute(
        "UPDATE ingest_departement SET completed_at = datetime(), next_cursor = NULL"
        " WHERE code_departement = ?",
        (code,),
    )
    conn.commit()
    if not quiet:
        print(f"\r  {code}: {loaded:>8,} rows in {time.time() - t0:.0f}s" + " " * 20)
    return loaded


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--source", default=EXISTANT.slug, choices=sorted(SOURCES))
    ap.add_argument("--db-path", type=Path, help="default: the source's own database")
    ap.add_argument("--dept", action="append", help="repeatable; omit with --all")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--min-free", type=int, default=MIN_FREE_BYTES)
    ap.add_argument("--page-size", type=int, default=PAGE_SIZE)
    args = ap.parse_args(argv)

    if not args.dept and not args.all:
        ap.error("give --dept CODE (repeatable) or --all")
    source = SOURCES[args.source]
    db_path = args.db_path or source.db_path

    client = api.client()
    conn = db.connect(db_path, bulk=True)
    cols = {}
    meta = conn.execute(
        "SELECT column_name, scale FROM column_meta WHERE scale != 1"
    ).fetchall()
    if not meta:
        print(
            "no scales recorded -- run `python -m ademe.scales` first, or every "
            "decimal column will be stored truncated",
            file=sys.stderr,
        )
        return 2
    scales = {r["column_name"]: r["scale"] for r in meta}
    cols = {
        k: v for k, v in spec.load(scales, source=source).items() if k not in source.mapping.internal
    }

    todo = args.dept or departements(client, source)
    loader = Loader(conn, cols, source)
    total = 0
    try:
        for code in todo:
            free = db.free_bytes(db_path)
            if free < args.min_free:
                print(
                    f"\nstopping before {code}: {free / 1e9:.1f} GB free, "
                    f"below the {args.min_free / 1e9:.1f} GB floor. "
                    f"Ledger intact -- rerun to resume.",
                    file=sys.stderr,
                )
                return 1
            total += ingest_departement(conn, loader, client, code)
    finally:
        conn.close()
    print(f"\nloaded {total:,} rows")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
