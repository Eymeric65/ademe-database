/**
 * DuckDB-WASM, reading Parquet straight off the data domain. See ADR-0009.
 *
 * The engine is initialised on the FIRST SEARCH, never on first paint: the
 * bundle is several megabytes and somebody who lands on the page and leaves
 * should not pay for it.
 */

import * as duckdb from '@duckdb/duckdb-wasm'
import eh_worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url'
import mvp_worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url'
import type { QuerySpec } from '../search/spec'

const BASE = (import.meta.env.VITE_DATA_BASE_URL as string | undefined) ?? '/data/v1'

/**
 * The WASM binaries come from the DATA origin, not from the app's own assets.
 *
 * Not a preference: Cloudflare Workers Assets refuses any file over 25 MB and
 * these are 36 MB (eh) and 41 MB (mvp). `wrangler dev` fails the build outright
 * with "Asset too large".
 *
 * The data domain rather than a public CDN because the search screen ALREADY
 * cannot work without the data domain -- it is where the Parquet lives. Putting
 * the engine there adds no new point of failure, while jsDelivr would add a
 * second, independent one. See ADR-0009.
 *
 * The worker JS stays in the app bundle: `new Worker()` cannot load a
 * cross-origin script, whereas fetching the module cross-origin is fine.
 */
const VENDOR = `${new URL(BASE, window.location.href).origin}/vendor/duckdb`

export type ColumnMeta = { encoding: string; scale: number; destination: string }

export type Manifest = {
  version: string
  high_water: string | null
  column_meta: Record<string, ColumnMeta>
  partitions: { dept: string; rows: number; codes?: string[] }[]
}

export type Hit = {
  numero_dpe: string
  code_postal_ban: string | null
  nom_commune_ban: string | null
  adresse_ban: string | null
  etiquette_dpe: string | null
  etiquette_ges: string | null
  date_etablissement_dpe: string | null
  surface_habitable_logement: number | null
  conso_5_usages_par_m2_ep: number | null
  emission_ges_5_usages_par_m2: number | null
  type_batiment: string | null
  periode_construction: string | null
  lat: number | null
  lon: number | null
}

let dbPromise: Promise<duckdb.AsyncDuckDB> | null = null
let manifestPromise: Promise<Manifest> | null = null

async function open(): Promise<duckdb.AsyncDuckDB> {
  // TRAP: the `coi` bundle is deliberately not offered. It needs
  // cross-origin-isolation headers (COOP/COEP), which would have to be set on
  // the Worker for every response and would break any third-party embed. `eh`
  // covers every browser we care about and `mvp` is the floor.
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: `${VENDOR}/duckdb-mvp.wasm`, mainWorker: mvp_worker },
    eh: { mainModule: `${VENDOR}/duckdb-eh.wasm`, mainWorker: eh_worker },
  })
  const worker = new Worker(bundle.mainWorker as string, { type: 'module' })
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker)
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker)
  return db
}

function db(): Promise<duckdb.AsyncDuckDB> {
  dbPromise ??= open()
  return dbPromise
}

export function manifest(): Promise<Manifest> {
  // HTTP has no globbing, so the file list has to come from somewhere. The
  // manifest is that somewhere, and it is swapped last by every build, so it
  // never names a file that is not there.
  manifestPromise ??= fetch(`${BASE}/manifest.json`).then((r) => {
    if (!r.ok) throw new Error(`manifest: ${r.status}`)
    return r.json() as Promise<Manifest>
  })
  return manifestPromise
}

/**
 * The partition a postcode lives in.
 *
 * `97xxx` is overseas and those départements are merged into one partition
 * (ADR-0006), so the first two digits are not enough on their own.
 */
export function partitionFor(codePostal: string): string {
  const cleaned = codePostal.replace(/\s/g, '')
  if (cleaned.startsWith('97') || cleaned.startsWith('98')) return 'DOM'
  if (cleaned.startsWith('20')) return '2A' // Corsica; 2B is checked against the manifest
  return cleaned.slice(0, 2)
}

/** Which partition files a spec needs. Unknown postcode -> every partition. */
export async function filesFor(spec: QuerySpec): Promise<string[]> {
  const m = await manifest()
  const known = new Set(m.partitions.map((p) => p.dept))
  if (spec.codePostal) {
    const guess = partitionFor(spec.codePostal)
    const candidates = guess === '2A' ? ['2A', '2B'] : [guess]
    const present = candidates.filter((c) => known.has(c))
    if (present.length) return present.map(url)
  }
  return m.partitions.map((p) => url(p.dept))
}

function url(dept: string): string {
  return `${BASE}/search/dept=${dept}/part-0000.parquet`
}

type Bound = { sql: string; value: unknown }

function predicates(spec: QuerySpec): Bound[] {
  const out: Bound[] = []
  if (spec.codePostal?.trim()) {
    out.push({ sql: 'code_postal_ban = ?', value: spec.codePostal.trim() })
  } else if (spec.commune?.trim()) {
    out.push({ sql: 'nom_commune_ban ILIKE ?', value: `%${spec.commune.trim()}%` })
  }
  if (spec.etiquetteDpe) out.push({ sql: 'etiquette_dpe = ?', value: spec.etiquetteDpe })
  if (spec.etiquetteGes) out.push({ sql: 'etiquette_ges = ?', value: spec.etiquetteGes })
  if (spec.moisEtablissement) {
    // The advert gives a month; matching a day would find nothing.
    out.push({
      sql: "strftime(date_etablissement_dpe, '%Y-%m') = ?",
      value: spec.moisEtablissement,
    })
  }
  if (spec.surface != null) {
    const tol = spec.surfaceTolerance ?? 5
    out.push({ sql: 'surface_habitable_logement BETWEEN ? AND ?', value: [spec.surface - tol, spec.surface + tol] })
  }
  if (spec.consoEp != null) {
    out.push({ sql: 'conso_5_usages_par_m2_ep BETWEEN ? AND ?', value: [spec.consoEp * 0.95, spec.consoEp * 1.05] })
  }
  if (spec.emissionGes != null) {
    out.push({ sql: 'emission_ges_5_usages_par_m2 BETWEEN ? AND ?', value: [spec.emissionGes * 0.95, spec.emissionGes * 1.05] })
  }
  if (spec.typeBatiment) out.push({ sql: 'type_batiment = ?', value: spec.typeBatiment })
  if (spec.periodeConstruction) {
    out.push({ sql: 'periode_construction = ?', value: spec.periodeConstruction })
  }
  return out
}

export const LIMIT = 50

/**
 * `SELECT * REPLACE (...)` casting every DECIMAL column to DOUBLE.
 *
 * TRAP: Arrow hands a DECIMAL back as its UNSCALED INTEGER. Read raw, a
 * latitude of 42.971021 arrives as 42971021 and a 176.4 m² flat as 1764 -- both
 * plausible enough to render without anything looking broken. It was caught in
 * the search results only because a test checked the map link's actual
 * coordinates, and then AGAIN in the detail view, which has ~104 more of them.
 *
 * Derived from the manifest rather than listed here, so a column that changes
 * encoding cannot be forgotten. DOUBLE is right HERE and nowhere else:
 * ADR-0004's scaled integers are about storing and reconstructing the source,
 * which the ETL has already done by the time these bytes exist. This is display.
 */
async function decimalReplace(present?: (name: string) => boolean): Promise<string> {
  const meta = (await manifest()).column_meta ?? {}
  const names = Object.entries(meta)
    .filter(([, m]) => m.encoding === 'scaled' && m.scale > 1)
    .map(([name]) => name)
  // lat/lon are derived at export and are not in column_meta.
  const all = [...names, 'lat', 'lon'].filter((n) => !present || present(n))
  return all.map((c) => `CAST("${c}" AS DOUBLE) AS "${c}"`).join(', ')
}

/** The 17 columns the search index carries. */
const SEARCH_DECIMALS = [
  'surface_habitable_logement',
  'conso_5_usages_par_m2_ep',
  'emission_ges_5_usages_par_m2',
  'lat',
  'lon',
]

export async function search(spec: QuerySpec): Promise<Hit[]> {
  const files = await filesFor(spec)
  if (!files.length) return []

  const bounds = predicates(spec)
  const where = bounds.length ? bounds.map((b) => b.sql).join(' AND ') : 'TRUE'
  const params = bounds.flatMap((b) => (Array.isArray(b.value) ? b.value : [b.value]))

  // Closeness on surface first: an advert rounds, so the nearest area is the
  // likeliest match rather than merely one of the matches.
  const order =
    spec.surface != null
      ? `ORDER BY abs(surface_habitable_logement - ${Number(spec.surface)})`
      : 'ORDER BY code_postal_ban, etiquette_dpe'

  const list = files.map((f) => `'${f}'`).join(', ')
  const replace = await decimalReplace((n) => SEARCH_DECIMALS.includes(n))
  const sql =
    `SELECT * REPLACE (${replace}) FROM read_parquet([${list}])` +
    ` WHERE ${where} ${order} LIMIT ${LIMIT}`

  const conn = await (await db()).connect()
  try {
    const stmt = await conn.prepare(sql)
    const table = await stmt.query(...params)
    return table.toArray().map((row) => normalise(row.toJSON() as Record<string, unknown>))
  } finally {
    await conn.close()
  }
}

/** Arrow hands back Decimals and Dates; the UI wants numbers and ISO strings. */
function normalise(row: Record<string, unknown>): Hit {
  const num = (v: unknown) => (v == null ? null : Number(v))
  const date = (v: unknown) =>
    v == null ? null : new Date(Number(v)).toISOString().slice(0, 10)
  return {
    numero_dpe: String(row.numero_dpe),
    code_postal_ban: (row.code_postal_ban as string) ?? null,
    nom_commune_ban: (row.nom_commune_ban as string) ?? null,
    adresse_ban: (row.adresse_ban as string) ?? null,
    etiquette_dpe: (row.etiquette_dpe as string) ?? null,
    etiquette_ges: (row.etiquette_ges as string) ?? null,
    date_etablissement_dpe: date(row.date_etablissement_dpe),
    surface_habitable_logement: num(row.surface_habitable_logement),
    conso_5_usages_par_m2_ep: num(row.conso_5_usages_par_m2_ep),
    emission_ges_5_usages_par_m2: num(row.emission_ges_5_usages_par_m2),
    type_batiment: (row.type_batiment as string) ?? null,
    periode_construction: (row.periode_construction as string) ?? null,
    lat: num(row.lat),
    lon: num(row.lon),
  }
}


// --- detail -----------------------------------------------------------------

let exceptionsPromise: Promise<Map<string, string>> | null = null

/**
 * Certificates whose numero does not encode their own partition.
 *
 * `numero_dpe[2:4]` is the departement for the overwhelming majority, which is
 * what makes a detail read one file rather than ninety-six. The exceptions file
 * exists because "overwhelming majority" is not "all", and a certificate the
 * shortcut gets wrong would otherwise be unreachable. See ADR-0006.
 */
async function exceptions(): Promise<Map<string, string>> {
  exceptionsPromise ??= (async () => {
    const conn = await (await db()).connect()
    try {
      const rows = await conn.query(
        `SELECT numero_dpe, dept FROM read_parquet('${BASE}/index/numero-exceptions.parquet')`,
      )
      return new Map(
        rows.toArray().map((r) => {
          const o = r.toJSON() as { numero_dpe: string; dept: string }
          return [String(o.numero_dpe), String(o.dept)]
        }),
      )
    } finally {
      await conn.close()
    }
  })()
  return exceptionsPromise
}

/** The partition a certificate's own number implies. */
export function partitionOfNumero(numero: string): string {
  const code = numero.slice(2, 4)
  return code.startsWith('97') || code.startsWith('98') ? 'DOM' : code
}

/** Every one of the 226 columns, for one certificate. */
export async function detail(numero: string): Promise<Record<string, unknown> | null> {
  const m = await manifest()
  const known = new Set(m.partitions.map((p) => p.dept))

  const guess = partitionOfNumero(numero)
  const override = (await exceptions()).get(numero)
  const dept = override ?? guess
  if (!known.has(dept)) return null

  const file = `${BASE}/dpe/dept=${dept}/part-0000.parquet`
  const conn = await (await db()).connect()
  try {
    // One row group of one partition, because the wide file is sorted by
    // numero_dpe (ADR-0006).
    const replace = await decimalReplace()
    const stmt = await conn.prepare(
      `SELECT * REPLACE (${replace}) FROM read_parquet('${file}') WHERE numero_dpe = ? LIMIT 1`,
    )
    const table = await stmt.query(numero)
    const rows = table.toArray()
    if (!rows.length) return null
    return rows[0].toJSON() as Record<string, unknown>
  } finally {
    await conn.close()
  }
}
