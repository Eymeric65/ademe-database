"""Generate the schema from the column spec and the structural mapping.

The DDL is generated rather than hand-written because it is 226 columns wide
and every column's encoding is a derived fact. Hand-maintaining it would let
the schema and the loader disagree, which is exactly the class of bug that
makes "lossless" untrue quietly.
"""

from __future__ import annotations

from ademe import spec
from ademe.mapping import (
    ADRESSE_BRUT_COLUMNS,
    ADRESSE_COLUMNS,
    COMMUNE_COLUMNS,
    INTERNAL_COLUMNS,
    REPEATS,
    check_coverage,
)


def _col_sql(c: spec.Column, name: str | None = None) -> tuple[str, str]:
    """(column_name, sql fragment) for one source column."""
    if c.encoding in (spec.VOCAB_CLOSED, spec.VOCAB_OPEN):
        n = (name or c.key) + "_id"
        return n, f'"{n}" INTEGER REFERENCES vocab_{c.domain}(id)'
    n = name or c.key
    return n, f'"{n}" {c.sql_type}'


def dest_name(c: spec.Column, base: str | None = None) -> str:
    """The column name a source column lands in. Vocabulary columns become
    `<name>_id`; everything else keeps its name. The loader and the DDL must
    agree on this, so both go through here."""
    return _col_sql(c, base)[0]


def bookkeeping_ddl() -> list[str]:
    return [
        # The losslessness contract, machine-readable: how to get every source
        # column back. `finalise` writes it and the round-trip test reads it.
        """CREATE TABLE IF NOT EXISTS column_meta (
    column_name  TEXT PRIMARY KEY,
    source_type  TEXT NOT NULL,
    encoding     TEXT NOT NULL,
    scale        INTEGER NOT NULL DEFAULT 1,
    domain       TEXT,
    destination  TEXT NOT NULL,
    dest_column  TEXT NOT NULL
) WITHOUT ROWID""",
        """CREATE TABLE IF NOT EXISTS data_source (
    source_id    TEXT PRIMARY KEY,
    dataset      TEXT NOT NULL,
    url          TEXT NOT NULL,
    licence      TEXT NOT NULL,
    upstream_rows INTEGER,
    schema_sha256 TEXT,
    retrieved_at TEXT NOT NULL
) WITHOUT ROWID""",
        # Resumability spine. One row per departement; `next_cursor` is the
        # Data Fair `after=` token, so a killed run restarts mid-departement
        # rather than re-downloading it.
        """CREATE TABLE IF NOT EXISTS ingest_departement (
    code_departement TEXT PRIMARY KEY,
    total_expected   INTEGER,
    rows_loaded      INTEGER NOT NULL DEFAULT 0,
    next_cursor      TEXT,
    started_at       TEXT,
    completed_at     TEXT
) WITHOUT ROWID""",
        # A value that does not round-trip at its declared scale is stored raw
        # here rather than silently rounded. Expected to stay empty; if it does
        # not, the round-trip test still passes because reconstruction prefers
        # this table, and the scale for that column needs revisiting.
        """CREATE TABLE IF NOT EXISTS scale_violation (
    dpe_id      INTEGER NOT NULL,
    column_name TEXT NOT NULL,
    raw_value   TEXT NOT NULL,
    PRIMARY KEY (dpe_id, column_name)
) WITHOUT ROWID""",
    ]


def vocab_ddl(cols: dict[str, spec.Column]) -> list[str]:
    out = []
    for domain in sorted(spec.vocab_domains(cols)):
        out.append(
            f"""CREATE TABLE IF NOT EXISTS vocab_{domain} (
    id   INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE
)"""
        )
    return out


def reference_ddl(cols: dict[str, spec.Column]) -> list[str]:
    commune_cols = [
        _col_sql(cols[src], dst)[1]
        for src, dst in COMMUNE_COLUMNS.items()
        if dst != "code_insee"
    ]
    adresse_cols = [_col_sql(cols[src], dst)[1] for src, dst in ADRESSE_COLUMNS.items()]
    return [
        # TRAP: the primary key is a surrogate, and the dedup key is the WHOLE
        # tuple -- not code_insee. ADEME does not normalise `nom_commune_ban`,
        # so certificates for one commune carry both `PAMIERS` and `Pamiers`.
        # Keying on the INSEE code let whichever certificate arrived first
        # impose its spelling on every later one, which is lossy. Same shape,
        # and same reason, as `adresse`. See ADR-0010.
        f"""CREATE TABLE IF NOT EXISTS commune (
    commune_id INTEGER PRIMARY KEY,
    code_insee TEXT NOT NULL,
    {",\n    ".join(commune_cols)}
)""",
        # ~5.06M rows against 15.5M certificates: 3.07 DPEs share an address.
        # lat/lon live here too -- they are a property of the address, so
        # storing them per certificate would triple them for nothing.
        f"""CREATE TABLE IF NOT EXISTS adresse (
    adresse_id INTEGER PRIMARY KEY,
    {",\n    ".join(adresse_cols)},
    commune_id INTEGER REFERENCES commune(commune_id)
)""",
    ]


def dpe_ddl(cols: dict[str, spec.Column], cov) -> list[str]:
    body = []
    for key in cov.dpe:
        if key == "numero_dpe":
            continue
        body.append(_col_sql(cols[key])[1])
    return [
        f"""CREATE TABLE IF NOT EXISTS dpe (
    dpe_id     INTEGER PRIMARY KEY,
    numero_dpe TEXT NOT NULL,
    adresse_id INTEGER REFERENCES adresse(adresse_id),
    lat        INTEGER,
    lon        INTEGER,
    {",\n    ".join(body)}
)""",
        f"""CREATE TABLE IF NOT EXISTS dpe_adresse_brut (
    dpe_id INTEGER PRIMARY KEY REFERENCES dpe(dpe_id),
    {",\n    ".join(_col_sql(cols[s], d)[1] for s, d in ADRESSE_BRUT_COLUMNS.items())}
) WITHOUT ROWID""",
    ]


def repeat_ddl(cols: dict[str, spec.Column]) -> list[str]:
    """Child tables, WITHOUT ROWID.

    The primary key IS the table, so there is no separate rowid and no index on
    dpe_id to build: for ~57M child rows that is the difference between ~29 B
    and ~11 B of plumbing per row.
    """
    out = []
    for rep in REPEATS:
        slot = rep.slots()[0]
        keys = ["dpe_id", "rang"] + (["rang_generateur"] if rep.inner else [])
        body = []
        for src, dst in slot["src_to_dst"].items():
            body.append(_col_sql(cols[src], dst)[1])
        out.append(
            f"""CREATE TABLE IF NOT EXISTS {rep.table} (
    dpe_id INTEGER NOT NULL REFERENCES dpe(dpe_id),
    rang   INTEGER NOT NULL,
    {"rang_generateur INTEGER NOT NULL," if rep.inner else ""}
    {",\n    ".join(body)},
    PRIMARY KEY ({", ".join(keys)})
) WITHOUT ROWID"""
        )
    return out


def all_ddl(cols: dict[str, spec.Column] | None = None) -> list[str]:
    cols = cols if cols is not None else spec.load()
    cov = check_coverage([k for k in cols])
    return (
        bookkeeping_ddl()
        + vocab_ddl({k: v for k, v in cols.items() if k not in INTERNAL_COLUMNS})
        + reference_ddl(cols)
        + dpe_ddl(cols, cov)
        + repeat_ddl(cols)
    )


def commune_key_columns(cols: dict[str, spec.Column] | None = None) -> list[str]:
    """The columns a commune is deduplicated on: all of them."""
    cols = cols if cols is not None else spec.load()
    out = ["code_insee"]
    for src, dst in COMMUNE_COLUMNS.items():
        if dst == "code_insee":
            continue
        out.append(dest_name(cols[src], dst))
    return out


def indexes_ddl() -> list[str]:
    """Built by `finalise`, after the load: creating them up front would make
    every insert maintain a B-tree it does not need yet."""
    return [
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_dpe_numero ON dpe(numero_dpe)",
        "CREATE INDEX IF NOT EXISTS ix_dpe_adresse ON dpe(adresse_id)",
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_adresse_ban ON adresse(identifiant_ban)",
        "CREATE INDEX IF NOT EXISTS ix_adresse_commune ON adresse(commune_id)",
        # UNIQUE so `finalise` fails loudly if the loader ever wrote a true
        # duplicate; the load itself dedups through the Loader's cache.
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_commune_tuple ON commune("
        + ", ".join(commune_key_columns())
        + ")",
        "CREATE INDEX IF NOT EXISTS ix_commune_dept ON commune(code_departement)",
    ]


def column_meta_rows(cols: dict[str, spec.Column]) -> list[tuple]:
    cov = check_coverage(list(cols))
    dest = {}
    for k in cov.dpe:
        dest[k] = ("dpe", k)
    for src, dst in COMMUNE_COLUMNS.items():
        dest[src] = ("commune", dst)
    for src, dst in ADRESSE_COLUMNS.items():
        dest[src] = ("adresse", dst)
    for src, dst in ADRESSE_BRUT_COLUMNS.items():
        dest[src] = ("dpe_adresse_brut", dst)
    for rep in REPEATS:
        for s in rep.slots():
            for src, dst in s["src_to_dst"].items():
                dest[src] = (rep.table, dst)
    rows = []
    for key, c in cols.items():
        if key in INTERNAL_COLUMNS:
            continue
        table, dst = dest[key]
        encoding, domain = c.encoding, c.domain
        if (table, dst) == ("commune", "code_insee"):
            # The commune primary key is the code itself, stored as raw text
            # rather than a vocabulary FK -- so reconstruction must not try to
            # decode it through a vocabulary, which blanked every value.
            name, encoding, domain = "code_insee", "text", None
        else:
            name, _ = _col_sql(c, dst)
        rows.append((key, c.type, encoding, c.scale, domain, table, name))
    return rows
