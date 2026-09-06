/**
 * Prove the Worker honours Range BEFORE any spec runs.
 *
 * DuckDB-WASM reads Parquet through range requests. A server that answers 200
 * with the whole file makes it fail deep inside the WASM with a message that
 * says nothing about ranges, and the failure looks like "the query is wrong".
 * This turns that into one clear failure at startup -- and it is what stops the
 * whole search suite from being vacuous against a proxy that never worked.
 *
 * The probe is the ENGINE, not a certificate: since ADR-0012 the certificates
 * need a session and this runs before any browser context exists. /data/vendor
 * travels the identical R2 code path, so a proxy that flattened ranges would
 * still be caught here.
 */
export default async function globalSetup() {
  const base = process.env.E2E_BASE_URL ?? 'http://localhost:8787'
  const url = `${base}/data/vendor/duckdb/duckdb-eh.wasm`

  const res = await fetch(url, { headers: { Range: 'bytes=0-99' } })
  if (res.status !== 206) {
    throw new Error(
      `${url} answered ${res.status}, not 206. The Worker is not honouring Range,` +
        ' and DuckDB-WASM cannot read Parquet without it.',
    )
  }
  const body = await res.arrayBuffer()
  if (body.byteLength !== 100) {
    throw new Error(`Range returned ${body.byteLength} bytes, not 100`)
  }
}
