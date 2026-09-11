/**
 * Put the e2e fixtures into the LOCAL R2 bucket `wrangler dev` reads.
 *
 * Since ADR-0012 the Parquet is served by the Worker out of an R2 binding, so
 * the harness has to fill that binding rather than stand up a second origin.
 * `wrangler dev` is local-only and so is this: no `--remote` anywhere, which is
 * also why nothing here can touch the real bucket.
 *
 * TRAP: `wrangler r2 object put` writes to the LOCAL simulated bucket by
 * default and prints "Upload complete." either way. That is what makes it safe
 * here and what made it dangerous the day the real bucket needed filling.
 *
 *   node scripts/seed-r2.mjs [fixtureDir] [bucket]
 */

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const root = process.argv[2] ?? 'test/e2e/fixtures'
const bucket = process.argv[3] ?? 'ademe-dpe'
const stampFile = '.wrangler/state/r2-seed-stamp.json'

// WebAssembly.compileStreaming refuses anything but application/wasm, naming
// neither the file nor the header. R2 stores the type with the object, so it
// has to be right at upload time -- here and in the real bucket alike.
const TYPES = {
  '.json': 'application/json',
  '.parquet': 'application/vnd.apache.parquet',
  '.wasm': 'application/wasm',
}

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path))
    else out.push(path)
  }
  return out
}

const files = walk(root).sort()
if (files.length === 0) throw new Error(`no fixtures under ${root}`)

// Uploading 77 MB of engine on every run costs more than reading eight stat
// calls. The stamp is content-shaped, so a rebuilt fixture re-seeds.
const stamp = JSON.stringify(
  files.map((f) => {
    const s = statSync(f)
    return [f, s.size, s.mtimeMs]
  }),
)
try {
  if (readFileSync(stampFile, 'utf8') === stamp) {
    console.log(`${bucket}: ${files.length} fixtures already seeded`)
    process.exit(0)
  }
} catch {
  // No stamp yet, or it is unreadable. Seed.
}

for (const file of files) {
  const key = relative(root, file).split(sep).join('/')
  const type = TYPES[file.slice(file.lastIndexOf('.'))]
  execFileSync(
    'npx',
    [
      'wrangler',
      'r2',
      'object',
      'put',
      `${bucket}/${key}`,
      '--file',
      file,
      ...(type ? ['--content-type', type] : []),
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
  console.log(`${key}  ${(statSync(file).size / 1e6).toFixed(1)} MB -> local ${bucket}`)
}

writeFileSync(stampFile, stamp)
