"""Where each of the 226 source columns goes.

The source is a flattened export: 92 of its columns are repeating groups
(`installation_n1/n2`, each with `generateur_n1/n2`; the same shape for hot
water; `energie_n1/n2/n3` for the per-energy breakdown). Flattening them costs
a serial-type byte per column per row whether the occurrence exists or not --
226 columns x 15.5M rows is 3.5 GB of pure record header before any value is
stored. Unflattening them into child tables is what this module describes.

`check_coverage()` asserts every source column is claimed exactly once. It is
the guard that makes "lossless" checkable rather than aspirational.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Repeat:
    """A repeating group: one child table, one row per occupied slot."""

    table: str
    # Source column name -> child column name. `{i}` is the outer slot,
    # `{g}` the inner (generator) slot.
    columns: dict[str, str]
    outer: tuple[int, ...] = (1,)
    inner: tuple[int, ...] | None = None

    def slots(self) -> list[dict]:
        out = []
        for i in self.outer:
            for g in self.inner or (None,):
                src = {
                    s.format(i=i, g=g): dst for s, dst in self.columns.items()
                }
                out.append({"outer": i, "inner": g, "src_to_dst": src})
        return out

    def source_columns(self) -> set[str]:
        return {c for s in self.slots() for c in s["src_to_dst"]}


# --- repeating groups -------------------------------------------------------
# Slot 1 is present on ~all rows and slot 2 on ~21%, so both live in the child
# table rather than slot 1 being inlined: keeping the shape uniform is worth
# more than the ~0.2 GB inlining would save, and it keeps the reconstruction
# view a plain join instead of a UNION.

INSTALLATION_CHAUFFAGE = Repeat(
    table="dpe_installation_chauffage",
    outer=(1, 2),
    columns={
        "type_installation_chauffage_n{i}": "type_installation",
        "type_emetteur_installation_chauffage_n{i}": "type_emetteur",
        "configuration_installation_chauffage_n{i}": "configuration",
        "description_installation_chauffage_n{i}": "description",
        "conso_chauffage_installation_chauffage_n{i}": "conso_chauffage",
        "surface_chauffee_installation_chauffage_n{i}": "surface_chauffee",
        "facteur_couverture_solaire_installation_chauffage_n{i}": "facteur_couverture_solaire",
        "facteur_couverture_solaire_saisi_installation_chauffage_n{i}": "facteur_couverture_solaire_saisi",
    },
)

GENERATEUR_CHAUFFAGE = Repeat(
    table="dpe_generateur_chauffage",
    outer=(1, 2),
    inner=(1, 2),
    columns={
        "type_generateur_n{g}_installation_n{i}": "type_generateur",
        "type_energie_generateur_n{g}_installation_n{i}": "type_energie",
        "usage_generateur_n{g}_installation_n{i}": "usage",
        "description_generateur_chauffage_n{g}_installation_n{i}": "description",
        "conso_chauffage_generateur_n{g}_installation_n{i}": "conso_chauffage",
    },
)

INSTALLATION_ECS = Repeat(
    table="dpe_installation_ecs",
    outer=(1,),
    columns={
        "type_installation_ecs_n{i}": "type_installation",
        "configuration_installation_ecs_n{i}": "configuration",
        "description_installation_ecs_n{i}": "description",
        "conso_ef_installation_ecs_n{i}": "conso_ef",
        "nombre_logements_desservis_par_installation_ecs_n{i}": "nombre_logements_desservis",
        "surface_habitable_desservie_par_installation_ecs_n{i}": "surface_habitable_desservie",
        "type_installation_solaire_n{i}": "type_installation_solaire",
        "production_ecs_solaire_installation_n{i}": "production_ecs_solaire",
        "facteur_couverture_solaire_n{i}": "facteur_couverture_solaire",
        "facteur_couverture_solaire_saisi_n{i}": "facteur_couverture_solaire_saisi",
    },
)

GENERATEUR_ECS = Repeat(
    table="dpe_generateur_ecs",
    outer=(1,),
    inner=(1, 2),
    columns={
        "type_generateur_n{g}_ecs_n{i}": "type_generateur",
        "type_energie_generateur_n{g}_ecs_n{i}": "type_energie",
        "usage_generateur_n{g}_ecs_n{i}": "usage",
        "description_generateur_n{g}_ecs_n{i}": "description",
        "volume_stockage_generateur_n{g}_ecs_n{i}": "volume_stockage",
        "cop_generateur_n{g}_ecs_n{i}": "cop",
        "conso_ef_generateur_n{g}_ecs_n{i}": "conso_ef",
        "date_installation_generateur_n{g}_ecs_n{i}": "date_installation",
    },
)

BILAN_ENERGIE = Repeat(
    table="dpe_bilan_energie",
    outer=(1, 2, 3),
    columns={
        "type_energie_n{i}": "type_energie",
        "conso_5_usages_ef_energie_n{i}": "conso_5_usages_ef",
        "conso_chauffage_ef_energie_n{i}": "conso_chauffage_ef",
        "conso_ecs_ef_energie_n{i}": "conso_ecs_ef",
        "cout_total_5_usages_energie_n{i}": "cout_total_5_usages",
        "cout_chauffage_energie_n{i}": "cout_chauffage",
        "cout_ecs_energie_n{i}": "cout_ecs",
        "emission_ges_5_usages_energie_n{i}": "emission_ges_5_usages",
        "emission_ges_chauffage_energie_n{i}": "emission_ges_chauffage",
        "emission_ges_ecs_energie_n{i}": "emission_ges_ecs",
    },
)

REPEATS: tuple[Repeat, ...] = (
    INSTALLATION_CHAUFFAGE,
    GENERATEUR_CHAUFFAGE,
    INSTALLATION_ECS,
    GENERATEUR_ECS,
    BILAN_ENERGIE,
)

# --- deduplicated reference tables ------------------------------------------
# 3.07 DPEs share an address, so anything address-determined is stored once
# instead of three times. The coordinates belong here for the same reason: they
# are a property of the address, not of the certificate.

COMMUNE_COLUMNS = {
    "code_insee_ban": "code_insee",
    "nom_commune_ban": "nom",
    "code_departement_ban": "code_departement",
    "code_region_ban": "code_region",
}

ADRESSE_COLUMNS = {
    "identifiant_ban": "identifiant_ban",
    "adresse_ban": "adresse",
    "numero_voie_ban": "numero_voie",
    "nom_rue_ban": "nom_rue",
    "code_postal_ban": "code_postal",
}
# `adresse` holds only what is stable for a BAN identifier: the identity and the
# street/postcode text. Everything about the GEOCODING stays on `dpe`.
#
# `score_ban`, `statut_geocodage`, `coordonnee_cartographique_x/y_ban` and the
# derived lat/lon describe how THIS certificate was geocoded, not the address.
# Measured: 11 of 1435 BAN identifiers in a 2000-row sample (0.8%) carry more
# than one distinct coord_x -- e.g. 09185_0035 appears as both 592611.33 and
# 592628.17. Deduplicating them let whichever certificate created the address
# row overwrite every later one. The round-trip test caught it as a source
# score of 0.87 rebuilt as 0.59.

# The raw pre-geocoding strings the BAN fields supersede. Near-unique per row,
# ~111 B, and almost never queried -- kept in a side table so they do not widen
# the row everything else reads.
ADRESSE_BRUT_COLUMNS = {
    "adresse_brut": "adresse_brut",
    "adresse_complete_brut": "adresse_complete_brut",
    "nom_commune_brut": "nom_commune_brut",
    "code_postal_brut": "code_postal_brut",
    "nom_residence": "nom_residence",
    "complement_adresse_batiment": "complement_adresse_batiment",
    "complement_adresse_logement": "complement_adresse_logement",
}

# Data Fair internals. `_geopoint` is "lat,lon" in WGS84 and is the only one
# worth keeping: the source coordinates are Lambert-93 (EPSG:2154, verified
# against the projection's valid domain) and reprojecting them would need
# pyproj, which is a dependency this repo does not want.
INTERNAL_COLUMNS = {"_id", "_i", "_rand", "_geopoint"}


@dataclass
class Coverage:
    dpe: list[str] = field(default_factory=list)
    adresse: list[str] = field(default_factory=list)
    commune: list[str] = field(default_factory=list)
    adresse_brut: list[str] = field(default_factory=list)
    repeats: dict[str, list[str]] = field(default_factory=dict)
    internal: list[str] = field(default_factory=list)

    def total(self) -> int:
        return (
            len(self.dpe)
            + len(self.adresse)
            + len(self.commune)
            + len(self.adresse_brut)
            + sum(len(v) for v in self.repeats.values())
            + len(self.internal)
        )


def classify(source_columns: list[str]) -> Coverage:
    """Assign every source column to exactly one destination."""
    cov = Coverage()
    claimed: dict[str, str] = {}

    def claim(col: str, where: str) -> None:
        if col in claimed:
            raise ValueError(f"{col!r} claimed by both {claimed[col]} and {where}")
        claimed[col] = where

    for rep in REPEATS:
        cols = sorted(rep.source_columns())
        cov.repeats[rep.table] = cols
        for c in cols:
            claim(c, rep.table)

    for src in COMMUNE_COLUMNS:
        cov.commune.append(src)
        claim(src, "commune")
    for src in ADRESSE_COLUMNS:
        cov.adresse.append(src)
        claim(src, "adresse")
    for src in ADRESSE_BRUT_COLUMNS:
        cov.adresse_brut.append(src)
        claim(src, "dpe_adresse_brut")

    for col in source_columns:
        if col in INTERNAL_COLUMNS:
            cov.internal.append(col)
            claim(col, "internal")
        elif col not in claimed:
            cov.dpe.append(col)
            claim(col, "dpe")

    unknown = set(claimed) - set(source_columns)
    if unknown:
        raise ValueError(
            f"mapping names {len(unknown)} column(s) absent from the source "
            f"schema -- the export shape changed: {sorted(unknown)[:8]}"
        )
    return cov


def check_coverage(source_columns: list[str]) -> Coverage:
    cov = classify(source_columns)
    if cov.total() != len(source_columns):
        raise ValueError(f"covered {cov.total()} of {len(source_columns)} columns")
    return cov
