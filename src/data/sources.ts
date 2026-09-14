/**
 * The four ADEME trees the browser can search, and the pure functions that
 * turn a search into files and SQL.
 *
 * Nothing here touches DuckDB, `window` or Vite, so test/unit runs it in node.
 * Each tree has existant's shape at `v1/<subdir>/` (ADR-0018) but its own
 * column names, which is all a `Source` records.
 */

import type { QuerySpec } from '../search/spec'

/** Also `SAVED_SOURCES` in db/schema.ts; a unit test keeps them equal. */
export const SOURCES = ['existant', 'neuf', 'tertiaire', 'audit'] as const
export type SourceId = (typeof SOURCES)[number]

export function isSource(value: unknown): value is SourceId {
  return typeof value === 'string' && (SOURCES as readonly string[]).includes(value)
}

type FileRef = { path: string; bytes: number; sha256: string }

export type Partition = {
  dept: string
  codes?: string[]
  rows: number
  search?: FileRef
  dpe?: FileRef
}

/** A numeric filter: the column, and the SQL that reads it as a number. */
export type Measure = { col: string; expr: string; label: string }

/** A select in the form, bound to one QuerySpec field and one column. */
export type Choice = {
  field: 'typeBatiment' | 'secteurActivite' | 'categorieErp' | 'categorieScenario' | 'etapeTravaux'
  col: string
  label: string
  options: readonly string[]
}

export type Source = {
  id: SourceId
  label: string
  subdir: string
  key: string
  /** The département as ADEME spells it; RNB's partitions are named by it. */
  deptCol: string
  dateCol: string
  classCol: string
  gesCol: string
  surface: Measure
  conso: Measure
  ges: Measure
  /** What a result line says the record is: a type, a sector, a scenario. */
  kindCol: string
  choices: readonly Choice[]
  periodes: readonly string[]
  /** `numero_dpe[2:4]` names the partition for most rows (ADR-0006). */
  numeroLocates: boolean
}

const PERIODES = [
  'avant 1948', '1948-1974', '1975-1977', '1978-1982', '1983-1988',
  '1989-2000', '2001-2005', '2006-2012', '2013-2021', 'après 2021',
] as const

const TYPE: Choice = {
  field: 'typeBatiment',
  col: 'type_batiment',
  label: 'Type de bien',
  options: ['maison', 'appartement', 'immeuble'],
}

const DPE_MEASURES = {
  surface: { col: 'surface_habitable_logement', expr: 'surface_habitable_logement', label: 'Surface (m²)' },
  conso: { col: 'conso_5_usages_par_m2_ep', expr: 'conso_5_usages_par_m2_ep', label: 'Consommation (kWhEP/m²/an)' },
  ges: { col: 'emission_ges_5_usages_par_m2', expr: 'emission_ges_5_usages_par_m2', label: 'Émissions (kgCO₂/m²/an)' },
}

// Audit measures are published as text: their values are more precise than
// any one scale (ADR-0032). TRY_CAST, so one odd value is a NULL, not an error.
const text = (col: string) => `TRY_CAST(${col} AS DOUBLE)`

export const SOURCE: Record<SourceId, Source> = {
  existant: {
    id: 'existant',
    label: 'Logement existant',
    subdir: '',
    key: 'numero_dpe',
    deptCol: 'code_departement_ban',
    dateCol: 'date_etablissement_dpe',
    classCol: 'etiquette_dpe',
    gesCol: 'etiquette_ges',
    ...DPE_MEASURES,
    kindCol: 'type_batiment',
    choices: [TYPE],
    periodes: PERIODES,
    numeroLocates: true,
  },
  neuf: {
    id: 'neuf',
    label: 'Logement neuf',
    subdir: 'neuf',
    key: 'numero_dpe',
    deptCol: 'code_departement_ban',
    dateCol: 'date_etablissement_dpe',
    classCol: 'etiquette_dpe',
    gesCol: 'etiquette_ges',
    ...DPE_MEASURES,
    kindCol: 'type_batiment',
    choices: [TYPE],
    periodes: PERIODES,
    numeroLocates: true,
  },
  tertiaire: {
    id: 'tertiaire',
    label: 'Tertiaire',
    subdir: 'tertiaire',
    key: 'numero_dpe',
    deptCol: 'code_departement_ban',
    dateCol: 'date_etablissement_dpe',
    classCol: 'etiquette_dpe',
    gesCol: 'etiquette_ges',
    surface: { col: 'surface_utile', expr: 'surface_utile', label: 'Surface utile (m²)' },
    conso: { col: 'conso_kwhep_m2_an', expr: 'conso_kwhep_m2_an', label: 'Consommation (kWhEP/m²/an)' },
    ges: { col: 'emission_ges_kg_co2_m2_an', expr: 'emission_ges_kg_co2_m2_an', label: 'Émissions (kgCO₂/m²/an)' },
    kindCol: 'secteur_activite',
    choices: [
      {
        field: 'secteurActivite',
        col: 'secteur_activite',
        label: 'Secteur d’activité',
        options: [
          'autres tertiaires non ERP', "locaux d'entreprise (bureaux)",
          'CTS : Chapiteaux, Tentes et Structures toile',
          'EF : Établissements flottants (eaux intérieures)',
          'GA : Gares Accessibles au public (chemins de fer, téléphériques, remonte-pentes...)',
          'GHA : Habitation', 'GHO : Hôtel', 'GHR : Enseignement', "GHS : Dépôt d'archives",
          'GHTC : tour de contrôle', 'GHU : Usage sanitaire', 'GHW : Bureaux', 'GHZ : Usage mixte',
          'J : Structures d’accueil pour personnes âgées ou personnes handicapées',
          "L : Salles d'auditions, de conférences, de réunions, de spectacles ou à usage multiple",
          'M : Magasins de vente, centres commerciaux', 'N : Restaurants et débits de boisson',
          'O : Hôtels et pensions de famille', "OA : Hôtels-restaurants d'Altitude",
          'P : Salles de danse et salles de jeux', 'PA : Établissements de Plein Air',
          'PS : Parcs de Stationnement couverts',
          'R : Établissements d’éveil, d’enseignement, de formation, centres de vacances, centres de loisirs sans hébergement',
          'REF : REFuges de montagne', 'S : Bibliothèques, centres de documentation',
          'SG : Structures Gonflables', "T : Salles d'exposition à vocation commerciale",
          'U : Établissements de soins', 'V : Établissements de divers cultes',
          'W : Administrations, banques, bureaux', 'X : Établissements sportifs couverts', 'Y : Musées',
        ],
      },
      {
        field: 'categorieErp',
        col: 'categorie_erp',
        label: 'Catégorie ERP',
        options: ['1ère Catégorie', '2ème Catégorie', '3ème Catégorie', '4ème Catégorie', '5ème Catégorie'],
      },
    ],
    periodes: PERIODES,
    numeroLocates: true,
  },
  audit: {
    id: 'audit',
    label: 'Audit énergétique',
    subdir: 'audit',
    key: 'id_etape',
    deptCol: 'n_departement_ban',
    dateCol: 'date_etablissement_audit',
    classCol: 'classe_bilan_dpe',
    gesCol: 'etiquette_ges',
    surface: { col: 'surface_habitable_logement', expr: text('surface_habitable_logement'), label: 'Surface (m²)' },
    conso: { col: 'ep_conso_5_usages_m2', expr: text('ep_conso_5_usages_m2'), label: 'Consommation (kWhEP/m²/an)' },
    ges: { col: 'emission_ges_5_usages_m2', expr: text('emission_ges_5_usages_m2'), label: 'Émissions (kgCO₂/m²/an)' },
    kindCol: 'categorie_scenario',
    choices: [
      {
        field: 'etapeTravaux',
        col: 'etape_travaux',
        label: 'Étape',
        options: [
          'état initial', 'étape première', 'étape intermédiaire 1', 'étape intermédiaire 2',
          'étape intermédiaire 3', 'étape finale',
        ],
      },
      {
        field: 'categorieScenario',
        col: 'categorie_scenario',
        label: 'Scénario',
        options: [
          'état initial', 'scénario multi étapes "principal"', 'scénario en une étape "principal"',
          'scénario complémentaire 1', 'scénario complémentaire 2', 'scénario complémentaire 3',
          'scénario audit copro "principal"', 'scénario complémentaire 4 - audit copro', 'Non référencé',
        ],
      },
    ],
    // An audit carries annee_construction, not the period.
    periodes: [],
    // The key is a UUID: the partition has to travel with the link.
    numeroLocates: false,
  },
}

// --- where to look ----------------------------------------------------------

/**
 * The partitions a postcode can live in, from the manifest's own `codes`.
 *
 * The codes differ per source -- existant merges 975, 976 and 978 into DOM,
 * tertiaire 976 to 978, audit only 976 -- so they are read, never assumed.
 * Returns nothing rather than everything when no partition matches: a search
 * that silently read all 103 files is the timeout this replaced.
 */
export function partitionsForPostcode(partitions: Partition[], codePostal: string): string[] {
  const digits = codePostal.replace(/\s/g, '')
  if (!/^\d{2}/.test(digits)) return []
  let codes: string[]
  if (digits.startsWith('20')) codes = ['2A', '2B']
  else if (/^9[78]/.test(digits)) {
    if (digits.length < 3) return []
    const code = digits.slice(0, 3)
    // Saint-Barthélemy (977) and Saint-Martin (978) post under 971xx.
    codes = code === '971' ? ['971', '977', '978'] : [code]
  } else codes = [digits.slice(0, 2)]

  const out: string[] = []
  for (const code of codes) {
    for (const p of partitions) {
      if ((p.codes ?? [p.dept]).includes(code) && !out.includes(p.dept)) out.push(p.dept)
    }
  }
  return out
}

/** The partition a numero names, for sources where it names one. */
export function partitionOfNumero(numero: string): string {
  return numero.slice(2, 4)
}

/** The cadastre partition a parcel id belongs to: its INSEE prefix. */
export function parcelDept(parcelId: string): string {
  return parcelId.startsWith('97') ? parcelId.slice(0, 3) : parcelId.slice(0, 2)
}

const NAMES: Record<string, string> = {
  '01': 'Ain', '02': 'Aisne', '03': 'Allier', '04': 'Alpes-de-Haute-Provence', '05': 'Hautes-Alpes',
  '06': 'Alpes-Maritimes', '07': 'Ardèche', '08': 'Ardennes', '09': 'Ariège', '10': 'Aube',
  '11': 'Aude', '12': 'Aveyron', '13': 'Bouches-du-Rhône', '14': 'Calvados', '15': 'Cantal',
  '16': 'Charente', '17': 'Charente-Maritime', '18': 'Cher', '19': 'Corrèze', '2A': 'Corse-du-Sud',
  '2B': 'Haute-Corse', '21': 'Côte-d’Or', '22': 'Côtes-d’Armor', '23': 'Creuse', '24': 'Dordogne',
  '25': 'Doubs', '26': 'Drôme', '27': 'Eure', '28': 'Eure-et-Loir', '29': 'Finistère', '30': 'Gard',
  '31': 'Haute-Garonne', '32': 'Gers', '33': 'Gironde', '34': 'Hérault', '35': 'Ille-et-Vilaine',
  '36': 'Indre', '37': 'Indre-et-Loire', '38': 'Isère', '39': 'Jura', '40': 'Landes',
  '41': 'Loir-et-Cher', '42': 'Loire', '43': 'Haute-Loire', '44': 'Loire-Atlantique', '45': 'Loiret',
  '46': 'Lot', '47': 'Lot-et-Garonne', '48': 'Lozère', '49': 'Maine-et-Loire', '50': 'Manche',
  '51': 'Marne', '52': 'Haute-Marne', '53': 'Mayenne', '54': 'Meurthe-et-Moselle', '55': 'Meuse',
  '56': 'Morbihan', '57': 'Moselle', '58': 'Nièvre', '59': 'Nord', '60': 'Oise', '61': 'Orne',
  '62': 'Pas-de-Calais', '63': 'Puy-de-Dôme', '64': 'Pyrénées-Atlantiques', '65': 'Hautes-Pyrénées',
  '66': 'Pyrénées-Orientales', '67': 'Bas-Rhin', '68': 'Haut-Rhin', '69': 'Rhône', '70': 'Haute-Saône',
  '71': 'Saône-et-Loire', '72': 'Sarthe', '73': 'Savoie', '74': 'Haute-Savoie', '75': 'Paris',
  '76': 'Seine-Maritime', '77': 'Seine-et-Marne', '78': 'Yvelines', '79': 'Deux-Sèvres', '80': 'Somme',
  '81': 'Tarn', '82': 'Tarn-et-Garonne', '83': 'Var', '84': 'Vaucluse', '85': 'Vendée', '86': 'Vienne',
  '87': 'Haute-Vienne', '88': 'Vosges', '89': 'Yonne', '90': 'Territoire de Belfort', '91': 'Essonne',
  '92': 'Hauts-de-Seine', '93': 'Seine-Saint-Denis', '94': 'Val-de-Marne', '95': 'Val-d’Oise',
  '971': 'Guadeloupe', '972': 'Martinique', '973': 'Guyane', '974': 'La Réunion',
  '975': 'Saint-Pierre-et-Miquelon', '976': 'Mayotte', '977': 'Saint-Barthélemy', '978': 'Saint-Martin',
  '988': 'Nouvelle-Calédonie',
}

/** The Département select: every searchable partition, NG excluded. */
export function deptOptions(partitions: Partition[]): { value: string; label: string }[] {
  return partitions
    .filter((p) => p.dept !== 'NG')
    .map((p) => ({
      value: p.dept,
      label:
        p.dept === 'DOM'
          ? `Autres outre-mer (${(p.codes ?? []).map((c) => NAMES[c] ?? c).join(', ')})`
          : `${p.dept} ${NAMES[p.dept] ?? ''}`.trim(),
    }))
}

// --- what to ask ------------------------------------------------------------

export const LIMIT = 50

const DAY = /^\d{4}-\d{2}-\d{2}$/

/** The inclusive day range a spec asks for; a saved month becomes its days. */
export function dateBounds(spec: QuerySpec): { from?: string; to?: string } {
  let from = spec.dateDu && DAY.test(spec.dateDu) ? spec.dateDu : undefined
  let to = spec.dateAu && DAY.test(spec.dateAu) ? spec.dateAu : undefined
  const month = spec.moisEtablissement
  if (!from && !to && month && /^\d{4}-\d{2}$/.test(month)) {
    const [y, m] = month.split('-').map(Number) as [number, number]
    from = `${month}-01`
    to = `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`
  }
  if (from && to && from > to) [from, to] = [to, from]
  return { ...(from ? { from } : {}), ...(to ? { to } : {}) }
}

/** A number typed the French way or the English way; nothing for anything else. */
export function parseDecimal(input: string): number | undefined {
  const cleaned = input.trim().replace(/\s/g, '').replace(',', '.')
  if (cleaned === '' || !/^-?\d+(\.\d+)?$/.test(cleaned)) return undefined
  return Number(cleaned)
}

/**
 * The search, as SQL with every value bound.
 *
 * The date range compares the DATE column directly: `strftime(col) = ?` hid
 * the column from the row-group statistics, so every search read every group.
 */
export function searchQuery(
  src: Source,
  spec: QuerySpec,
  files: string[],
): { sql: string; params: unknown[] } {
  if (!files.length) throw new Error('no partition to search')
  const where: string[] = []
  const params: unknown[] = []
  const add = (sql: string, ...values: unknown[]) => {
    where.push(sql)
    params.push(...values)
  }

  if (spec.codePostal?.trim()) add('code_postal_ban = ?', spec.codePostal.replace(/\s/g, ''))
  if (spec.commune?.trim()) {
    add('strip_accents(nom_commune_ban) ILIKE strip_accents(?)', `%${spec.commune.trim()}%`)
  }
  if (spec.etiquetteDpe) add(`${src.classCol} = ?`, spec.etiquetteDpe)
  if (spec.etiquetteGes) add(`${src.gesCol} = ?`, spec.etiquetteGes)

  const { from, to } = dateBounds(spec)
  if (from && to) add(`${src.dateCol} BETWEEN CAST(? AS DATE) AND CAST(? AS DATE)`, from, to)
  else if (from) add(`${src.dateCol} >= CAST(? AS DATE)`, from)
  else if (to) add(`${src.dateCol} <= CAST(? AS DATE)`, to)

  if (spec.surface != null) {
    const tol = spec.surfaceTolerance ?? 5
    add(`${src.surface.expr} BETWEEN ? AND ?`, spec.surface - tol, spec.surface + tol)
  }
  if (spec.consoEp != null) {
    add(`${src.conso.expr} BETWEEN ? AND ?`, spec.consoEp * 0.95, spec.consoEp * 1.05)
  }
  if (spec.emissionGes != null) {
    add(`${src.ges.expr} BETWEEN ? AND ?`, spec.emissionGes * 0.95, spec.emissionGes * 1.05)
  }
  for (const choice of src.choices) {
    const value = spec[choice.field]
    if (value) add(`${choice.col} = ?`, value)
  }
  if (spec.periodeConstruction && src.periodes.length) {
    add('periode_construction = ?', spec.periodeConstruction)
  }

  // Closeness on surface first: an advert rounds, so the nearest area is the
  // likeliest match rather than merely one of the matches.
  let order = `ORDER BY ${src.dateCol} DESC NULLS LAST, ${src.key}`
  if (spec.surface != null) {
    order = `ORDER BY abs(${src.surface.expr} - ?) NULLS LAST, ${src.key}`
    params.push(spec.surface)
  }

  const list = files.map((f) => `'${f.replace(/'/g, "''")}'`).join(', ')
  const sql =
    `SELECT *, count(*) OVER () AS total` +
    ` FROM read_parquet([${list}], hive_partitioning = false, filename = true)` +
    ` WHERE ${where.length ? where.join(' AND ') : 'TRUE'} ${order} LIMIT ${LIMIT}`
  return { sql, params }
}

// --- what came back ---------------------------------------------------------

export type Hit = {
  source: SourceId
  key: string
  /** The partition the row was read from, so its detail reads one known file. */
  dept: string | null
  address: string | null
  commune: string | null
  codePostal: string | null
  classe: string | null
  ges: string | null
  date: string | null
  surface: number | null
  kind: string | null
  etape: string | null
  lat: number | null
  lon: number | null
  total: number
}

function num(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = typeof value === 'string' ? Number(value) : Number(value as number)
  return Number.isFinite(n) ? n : null
}

function str(value: unknown): string | null {
  return value == null || value === '' ? null : String(value)
}

/** Arrow hands a DATE back as epoch milliseconds; the UI wants 'YYYY-MM-DD'. */
export function isoDate(value: unknown): string | null {
  if (value == null || value === '') return null
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'string') return DAY.test(value.slice(0, 10)) ? value.slice(0, 10) : null
  const n = Number(value)
  return Number.isFinite(n) ? new Date(n).toISOString().slice(0, 10) : null
}

/** 'DD/MM/YYYY', from UTC parts so no time zone moves the day. */
export function formatDate(value: unknown): string {
  const iso = isoDate(value)
  if (!iso) return ''
  const [y, m, d] = iso.split('-')
  return `${d}/${m}/${y}`
}

export function toHit(src: Source, row: Record<string, unknown>): Hit {
  const file = typeof row.filename === 'string' ? row.filename : ''
  return {
    source: src.id,
    key: String(row[src.key]),
    dept: /\/dept=([^/?]+)\//.exec(file)?.[1] ?? null,
    address: str(row.adresse_ban),
    commune: str(row.nom_commune_ban),
    codePostal: str(row.code_postal_ban),
    classe: str(row[src.classCol]),
    ges: str(row[src.gesCol]),
    date: isoDate(row[src.dateCol]),
    surface: num(row[src.surface.col]),
    kind: str(row[src.kindCol]),
    etape: src.id === 'audit' ? str(row.etape_travaux) : null,
    lat: num(row.lat),
    lon: num(row.lon),
    total: num(row.total) ?? 0,
  }
}

/** An RNB `point`, 'SRID=4326;POINT(lon lat)'. */
export function parsePoint(value: unknown): { lat: number; lon: number } | null {
  if (typeof value !== 'string') return null
  const m = /POINT\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)/.exec(value)
  return m ? { lon: Number(m[1]), lat: Number(m[2]) } : null
}
