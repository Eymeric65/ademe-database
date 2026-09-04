"""Rebuild the original 226-column record from the normalised tables.

This is the losslessness contract made executable. Everything the schema does
-- dictionary encoding, integer scaling, unflattening the repeating groups,
deduplicating addresses -- is only defensible if the source row comes back
byte-for-byte, and this is the function that has to prove it.

Driven entirely by `column_meta`, so it cannot drift from the schema: if a
column's encoding changes, reconstruction follows automatically.
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal

from ademe.ingest import EPOCH
from ademe.mapping import REPEATS


def _fmt_scaled(value: int, scale: int) -> str:
    """Exact inverse of the ingest scaling. Decimal, never float."""
    d = Decimal(value) / Decimal(scale)
    places = len(str(scale)) - 1
    return f"{d:.{places}f}" if places else str(int(d))


class Reconstructor:
    def __init__(self, conn):
        self.conn = conn
        self.meta = {
            r["column_name"]: dict(r)
            for r in conn.execute("SELECT * FROM column_meta").fetchall()
        }
        self.vocab: dict[str, dict[int, str]] = {}

    def _code(self, domain: str, vid: int | None) -> str:
        if vid is None:
            return ""
        table = self.vocab.get(domain)
        if table is None:
            table = {
                r["id"]: r["code"]
                for r in self.conn.execute(f"SELECT id, code FROM vocab_{domain}")
            }
            self.vocab[domain] = table
        return table.get(vid, "")

    def _decode(self, col: str, raw, violations: dict[str, str]) -> str:
        # A value the declared scale could not hold was stored verbatim; that
        # copy is the truth.
        if col in violations:
            return violations[col]
        if raw is None:
            return ""
        m = self.meta[col]
        enc, scale, domain = m["encoding"], m["scale"], m["domain"]
        if enc in ("vocab_closed", "vocab_open"):
            return self._code(domain, raw)
        if enc == "date":
            return (EPOCH + timedelta(days=int(raw))).isoformat()
        if enc == "scaled":
            return _fmt_scaled(int(raw), scale)
        if enc == "int":
            return str(int(raw))
        return str(raw)

    def row(self, numero_dpe: str) -> dict[str, str] | None:
        cur = self.conn.execute(
            "SELECT * FROM dpe WHERE numero_dpe = ?", (numero_dpe,)
        ).fetchone()
        if cur is None:
            return None
        dpe = dict(cur)
        dpe_id = dpe["dpe_id"]

        violations = {
            r["column_name"]: r["raw_value"]
            for r in self.conn.execute(
                "SELECT column_name, raw_value FROM scale_violation WHERE dpe_id = ?",
                (dpe_id,),
            )
        }

        adresse: dict = {}
        commune: dict = {}
        if dpe["adresse_id"] is not None:
            got = self.conn.execute(
                "SELECT * FROM adresse WHERE adresse_id = ?", (dpe["adresse_id"],)
            ).fetchone()
            adresse = dict(got) if got else {}
            # Queried separately, not joined: `code_insee` exists on both tables
            # and a `SELECT a.*, c.*` collapses the duplicate names, which
            # silently blanked every commune column.
            if adresse.get("code_insee"):
                got = self.conn.execute(
                    "SELECT * FROM commune WHERE code_insee = ?",
                    (adresse["code_insee"],),
                ).fetchone()
                commune = dict(got) if got else {}
        got = self.conn.execute(
            "SELECT * FROM dpe_adresse_brut WHERE dpe_id = ?", (dpe_id,)
        ).fetchone()
        brut = dict(got) if got else {}

        children: dict[str, dict[tuple, dict]] = {}
        for rep in REPEATS:
            rows = self.conn.execute(
                f"SELECT * FROM {rep.table} WHERE dpe_id = ?", (dpe_id,)
            ).fetchall()
            keyed = {}
            for r in rows:
                r = dict(r)
                k = (r["rang"], r.get("rang_generateur"))
                keyed[k] = r
            children[rep.table] = keyed

        out: dict[str, str] = {}
        for col, m in self.meta.items():
            dest, dcol = m["destination"], m["dest_column"]
            if dest == "dpe":
                out[col] = self._decode(col, dpe.get(dcol), violations)
            elif dest == "adresse":
                out[col] = self._decode(col, adresse.get(dcol), violations)
            elif dest == "commune":
                out[col] = self._decode(col, commune.get(dcol), violations)
            elif dest == "dpe_adresse_brut":
                out[col] = self._decode(col, brut.get(dcol), violations)
            else:
                out[col] = ""  # filled below, where the slot is known

        for rep in REPEATS:
            for slot in rep.slots():
                k = (slot["outer"], slot["inner"])
                got = children[rep.table].get(k, {})
                for src, dst in slot["src_to_dst"].items():
                    dcol = self.meta[src]["dest_column"]
                    out[src] = self._decode(src, got.get(dcol), violations)
        return out
