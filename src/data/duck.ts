/**
 * DuckDB-WASM, reading Parquet through the Worker's gated /data route.
 * See ADR-0012, which supersedes ADR-0009.
 *
 * The engine is initialised on the FIRST SEARCH, never on first paint: the
 * bundle is several megabytes and somebody who lands on the page and leaves
 * should not pay for it.
 *
 * What to read and what to ask is decided in ./sources, which is pure and
 * unit-tested; this module only fetches and runs it.
 */

import * as duckdb from '@duckdb/duckdb-wasm'
import eh_worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url'
import mvp_worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url'
import type { DetailRef } from '../routes'
import type { QuerySpec } from '../search/spec'
import {
  parcelDept,
  partitionOfNumero,
  partitionsForPostcode,
  parsePoint,
  searchQuery,
  SOURCE,
  toHit,
  type Hit,
  type Partition,
  type Source,
} from './sources'

/**
 * Absolute, always.
 *
 * TRAP: DuckDB resolves a path that is not a URL against its own virtual
 * filesystem, so `/data/v1/search/...` -- correct for fetch, same-origin since
 * ADR-0012 -- comes back as `IO Error: No files found that match the pattern`,
 * naming a path that plainly exists. It has to be `https://host/data/v1`.
 */
const BASE = new URL(
  (import.meta.env.VITE_DATA_BASE_URL as string | undefined) ?? '/data/v1',
  window.location.href,
).href.replace(/\/+$/, '')

/**
 * The WASM binaries come from the bucket, not from the app's own assets.
 *
 * Not a preference: Cloudflare Workers Assets refuses any file over 25 MB and
 * these are 36 MB (eh) and 41 MB (mvp). `wrangler dev` fails the build outright
 * with "Asset too large".
 *
 * TRAP: derived by dropping the version segment off BASE, not from BASE's
 * ORIGIN. Since ADR-0012 the data is same-origin with the app, so the origin
 * form resolved to /vendor/duckdb -- an assets path, which is the 25 MB refusal
 * above, reached again by a different route.
 *
 * The engine sits beside the data rather than on a public CDN because the
 * search screen already cannot work without the bucket; jsDelivr would add a
 * second, independent point of failure. Unlike the data it is NOT gated: it has
 * to load before the app can render the screen that asks somebody to sign in.
 *
 * The worker JS stays in the app bundle: `new Worker()` cannot load a
 * cross-origin script, whereas fetching the module cross-origin is fine.
 */
const VENDOR = `${BASE.replace(/\/v1\/?$/, '')}/vendor/duckdb`

/** A published tree: existant at `v1/` itself, everything else beside it. */
function tree(subdir: string): string {
  return subdir ? `${BASE}/${subdir}` : BASE
}

export type { Hit } from './sources'
export { LIMIT } from './sources'

export type ColumnMeta = { encoding: string; scale: number; destination: string }

export type Manifest = {
  version: string
  high_water?: string | null
  column_meta?: Record<string, ColumnMeta>
  search_columns?: string[]
  key?: string
  partitions: Partition[]
}

let dbPromise: Promise<duckdb.AsyncDuckDB> | null = null
const manifests = new Map<string, Promise<Manifest>>()

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
  await db.open({
    // TRAP: left at its defaults the engine never sends a Range header -- it
    // GETs each file whole, which measured 146 MB to show one Paris
    // certificate. All three are needed: forced full reads skip the ranged
    // HEAD entirely, and the Worker answers that HEAD with 206. See ADR-0035.
    filesystem: { reliableHeadRequests: true, allowFullHTTPReads: false, forceFullHTTPReads: false },
    // TRAP: Arrow hands a DECIMAL back as its UNSCALED INTEGER. Read raw, a
    // latitude of 42.971021 arrives as 42971021 and a 176.4 m² flat as 1764 --
    // both plausible enough to render without anything looking broken.
    // DOUBLE is right HERE and nowhere else: ADR-0004's scaled integers are
    // about storing the source, which the ETL has done. This is display.
    query: { castDecimalToDouble: true },
  })
  return db
}

function db(): Promise<duckdb.AsyncDuckDB> {
  dbPromise ??= open()
  return dbPromise
}

/**
 * One tree's manifest, fetched once. HTTP has no globbing, so the file list
 * has to come from somewhere; the manifest is swapped last by every build, so
 * it never names a file that is not there.
 */
export function manifest(subdir = ''): Promise<Manifest> {
  let pending = manifests.get(subdir)
  if (!pending) {
    pending = fetch(`${tree(subdir)}/manifest.json`).then((r) => {
      if (!r.ok) throw new Error(`manifest: ${r.status}`)
      return r.json() as Promise<Manifest>
    })
    // A failure is not cached: the next search asks again.
    pending.catch(() => manifests.delete(subdir))
    manifests.set(subdir, pending)
  }
  return pending
}

async function query(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  const conn = await (await db()).connect()
  try {
    const stmt = await conn.prepare(sql)
    try {
      const table = await stmt.query(...params)
      return table.toArray().map((row) => row.toJSON() as Record<string, unknown>)
    } finally {
      await stmt.close()
    }
  } finally {
    await conn.close()
  }
}

function quote(url: string): string {
  return `'${url.replace(/'/g, "''")}'`
}

// --- search -----------------------------------------------------------------

/** The partitions a spec reads: its postcode's, else the département picked. */
export async function partitionsFor(spec: QuerySpec): Promise<string[]> {
  const src = SOURCE[spec.source ?? 'existant']
  const m = await manifest(src.subdir)
  if (spec.codePostal?.trim()) return partitionsForPostcode(m.partitions, spec.codePostal)
  return spec.departement && m.partitions.some((p) => p.dept === spec.departement)
    ? [spec.departement]
    : []
}

/**
 * A search file at or under this size is fetched whole, in one request;
 * above it, DuckDB reads it by ranges. Each range read is a sequential round
 * trip of ~150 ms, so a Paris search (15 MB) is 35 of them and 2 MB, while a
 * typical département's 3 MB is one. See ADR-0035.
 */
const WHOLE_SEARCH = 4 * 1024 * 1024
const MAX_BUFFERS = 6
const buffers = new Map<string, Promise<string>>()

/** What DuckDB should read for one partition's search file: a buffer or a URL. */
async function searchFile(subdir: string, p: Partition): Promise<string> {
  const path = p.search?.path ?? `search/dept=${p.dept}/part-0000.parquet`
  const url = `${tree(subdir)}/${path}`
  if (!p.search || p.search.bytes > WHOLE_SEARCH) return url

  let pending = buffers.get(url)
  if (!pending) {
    pending = (async () => {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`${path}: ${res.status}`)
      // The name keeps `/dept=XX/`, which is how a hit knows its partition.
      const name = `${subdir || 'existant'}/${path}`
      await (await db()).registerFileBuffer(name, new Uint8Array(await res.arrayBuffer()))
      return name
    })()
    pending.catch(() => buffers.delete(url))
    buffers.set(url, pending)
    // A session that wanders through départements should not hold them all.
    while (buffers.size > MAX_BUFFERS) {
      const [oldest, name] = buffers.entries().next().value as [string, Promise<string>]
      buffers.delete(oldest)
      void name.then(async (n) => (await db()).dropFile(n)).catch(() => undefined)
    }
  }
  return pending
}

export async function search(spec: QuerySpec): Promise<Hit[]> {
  const src = SOURCE[spec.source ?? 'existant']
  const m = await manifest(src.subdir)
  const depts = await partitionsFor(spec)
  const files = await Promise.all(
    m.partitions.filter((p) => depts.includes(p.dept)).map((p) => searchFile(src.subdir, p)),
  )
  if (!files.length) return []
  const { sql, params } = searchQuery(src, spec, files)
  return (await query(sql, params)).map((row) => toHit(src, row))
}

// --- detail -----------------------------------------------------------------

export type Record_ = {
  row: Record<string, unknown>
  /** The partition it was read from, which is what saving it records. */
  dept: string
  meta: Record<string, ColumnMeta>
}

/**
 * The partition a numero lives in, from the exceptions index.
 *
 * A point query on a file sorted by numero, never the whole index: nationally
 * it is 670 302 rows, and loading it into a Map cost every first detail 2.3 MB
 * and seconds of JavaScript. See ADR-0035.
 */
async function exception(src: Source, numero: string): Promise<string | null> {
  const rows = await query(
    `SELECT dept FROM read_parquet(${quote(`${tree(src.subdir)}/index/numero-exceptions.parquet`)},` +
      ` hive_partitioning = false) WHERE numero_dpe = ? LIMIT 1`,
    [numero],
  )
  return rows.length ? String(rows[0]?.dept) : null
}

/** Every column of one record, read from the one partition that holds it. */
export async function detail(ref: DetailRef): Promise<Record_ | null> {
  const src = SOURCE[ref.source]
  const m = await manifest(src.subdir)
  const known = new Set(m.partitions.map((p) => p.dept))

  // A link from a result carries its partition; a saved row from before
  // ADR-0034, or a pasted numero, has to be located.
  let dept = ref.dept && known.has(ref.dept) ? ref.dept : null
  if (!dept && src.numeroLocates) {
    const guess = partitionOfNumero(ref.key)
    dept = (await exception(src, ref.key)) ?? (known.has(guess) ? guess : null)
  }
  if (!dept) return null

  // TRAP: hive_partitioning = false, or DuckDB reads `dept=09` in the path as
  // a column and the detail view lists a `dept` no file has.
  const rows = await query(
    `SELECT * FROM read_parquet(${quote(`${tree(src.subdir)}/dpe/dept=${dept}/part-0000.parquet`)},` +
      ` hive_partitioning = false) WHERE "${src.key}" = ? LIMIT 1`,
    [ref.key],
  )
  const row = rows[0]
  return row ? { row, dept, meta: m.column_meta ?? {} } : null
}

// --- building and parcel ----------------------------------------------------

export type Parcel = {
  id: string
  commune: string | null
  section: string | null
  numero: string | null
  contenance: number | null
}

export type Building = {
  rnbId: string
  status: string | null
  point: { lat: number; lon: number } | null
  addresses: string[]
  /** 'id_rnb' when the certificate names it, 'ban' when found by its address. */
  method: string
  /** How many buildings share the address; 1 is an unambiguous link. */
  candidates: number | null
  parcels: Parcel[]
}

/**
 * Arrow lists and structs, as plain arrays and objects.
 *
 * TRAP: toJSON, not toArray. A struct row has a toArray too, and it returns
 * the VALUES -- `{ id, bdg_cover_ratio }` came back as `[id, ratio]`, every
 * parcel id was undefined, and the building panel failed only where RNB's
 * plots were read.
 */
function plain(value: unknown): unknown {
  if (value == null || typeof value !== 'object') return value
  const v = value as { toJSON?: () => unknown }
  const json = typeof v.toJSON === 'function' ? v.toJSON() : value
  if (Array.isArray(json)) return json.map(plain)
  return Object.fromEntries(Object.entries(json as object).map(([k, x]) => [k, plain(x)]))
}

async function has(subdir: string, dept: string): Promise<boolean> {
  try {
    return (await manifest(subdir)).partitions.some((p) => p.dept === dept)
  } catch {
    return false
  }
}

const MAX_BUILDINGS = 8

/**
 * The building a record sits in and the parcels under it (ADR-0021, 0022).
 *
 * Existing housing goes through the crosswalk, which also links a certificate
 * with no `id_rnb` by its address. The other sources are not in the crosswalk
 * yet, so their own `id_rnb` is followed, and RNB's plots give the parcels.
 */
export async function buildings(src: Source, key: string, rec: Record_): Promise<Building[]> {
  type Link = { rnb_id: string; match_method: string; parcel_id: string | null; ban_candidates: number | null }
  let links: Link[] = []
  if (src.id === 'existant' && (await has('crosswalk', rec.dept))) {
    links = (await query(
      `SELECT rnb_id, match_method, parcel_id, ban_candidates FROM read_parquet(` +
        `${quote(`${BASE}/crosswalk/dept=${rec.dept}/part-0000.parquet`)}, hive_partitioning = false)` +
        ` WHERE source = 'existant' AND record_key = ? AND rnb_id IS NOT NULL` +
        ` ORDER BY match_method DESC, rnb_id, parcel_id`,
      [key],
    )) as Link[]
  } else if (rec.row.id_rnb) {
    links = [{ rnb_id: String(rec.row.id_rnb), match_method: 'id_rnb', parcel_id: null, ban_candidates: null }]
  }
  const ids = [...new Set(links.map((l) => l.rnb_id))].slice(0, MAX_BUILDINGS)
  if (!ids.length) return []

  // RNB is partitioned by the building's own département, which for a
  // certificate is its own -- and RNB does not merge the DOM codes.
  const firstParcel = links.find((l) => l.parcel_id)?.parcel_id
  const rnbDept = String(rec.row[src.deptCol] ?? (firstParcel ? parcelDept(firstParcel) : rec.dept))
  if (!(await has('rnb', rnbDept))) return []
  const rows = await query(
    `SELECT rnb_id, status, point, addresses, plots FROM read_parquet(` +
      `${quote(`${BASE}/rnb/dept=${rnbDept}/part-0000.parquet`)}, hive_partitioning = false)` +
      ` WHERE rnb_id IN (${ids.map(() => '?').join(', ')})`,
    ids,
  )

  const found = new Map(rows.map((r) => [String(r.rnb_id), r]))
  const byBuilding = new Map<string, string[]>()
  for (const id of ids) {
    const own = links.filter((l) => l.rnb_id === id && l.parcel_id).map((l) => l.parcel_id as string)
    const plots = (plain(found.get(id)?.plots) as { id: string }[] | null) ?? []
    byBuilding.set(id, own.length ? own : plots.map((p) => p.id))
  }

  const parcels = new Map<string, Parcel>()
  const wanted = [...new Set([...byBuilding.values()].flat())]
  for (const dept of new Set(wanted.map(parcelDept))) {
    if (!(await has('cadastre', dept))) continue
    const ofDept = wanted.filter((id) => parcelDept(id) === dept)
    const got = await query(
      `SELECT id, commune, section, numero, contenance FROM read_parquet(` +
        `${quote(`${BASE}/cadastre/dept=${dept}/part-0000.parquet`)}, hive_partitioning = false)` +
        ` WHERE id IN (${ofDept.map(() => '?').join(', ')})`,
      ofDept,
    )
    for (const p of got) {
      parcels.set(String(p.id), {
        id: String(p.id),
        commune: p.commune == null ? null : String(p.commune),
        section: p.section == null ? null : String(p.section),
        numero: p.numero == null ? null : String(p.numero),
        contenance: p.contenance == null ? null : Number(p.contenance),
      })
    }
  }

  return ids.map((id) => {
    const r = found.get(id)
    const link = links.find((l) => l.rnb_id === id)
    const addresses = ((plain(r?.addresses) as Record<string, string | null>[] | null) ?? []).map((a) =>
      [a.street_number, a.street_rep, a.street, a.city_zipcode, a.city_name].filter(Boolean).join(' '),
    )
    return {
      rnbId: id,
      status: r?.status == null ? null : String(r.status),
      point: parsePoint(r?.point),
      addresses,
      method: link?.match_method ?? 'id_rnb',
      candidates: link?.ban_candidates == null ? null : Number(link.ban_candidates),
      parcels: (byBuilding.get(id) ?? []).map((pid) => parcels.get(pid) ?? {
        id: pid, commune: null, section: null, numero: null, contenance: null,
      }),
    }
  })
}
