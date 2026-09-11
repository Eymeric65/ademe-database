/**
 * Copy DuckDB-WASM's binaries where the browser can fetch them.
 *
 * They cannot ship in the app bundle: Workers Assets refuses anything over
 * 25 MB and these are 36 MB and 41 MB. They live on the data origin instead
 * (ADR-0009), so this stages them for the e2e fixture server and for upload
 * to R2.
 *
 *   node scripts/stage-duckdb.mjs test/e2e/fixtures/vendor/duckdb
 */

import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

// Resolved by path rather than by require.resolve: the package's `exports` map
// does not expose ./package.json or ./dist, and these files are data, not
// modules -- there is nothing to import.
const dist = fileURLToPath(new URL('../node_modules/@duckdb/duckdb-wasm/dist/', import.meta.url))
if (!existsSync(dist)) throw new Error(`@duckdb/duckdb-wasm not installed at ${dist}`)
const out = process.argv[2] ?? 'test/e2e/fixtures/vendor/duckdb'

mkdirSync(out, { recursive: true })
for (const file of ['duckdb-eh.wasm', 'duckdb-mvp.wasm']) {
  const from = join(dist, file)
  copyFileSync(from, join(out, file))
  console.log(`${file}  ${(statSync(from).size / 1e6).toFixed(1)} MB -> ${out}`)
}
