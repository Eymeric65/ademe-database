/**
 * A static server for test/e2e/fixtures, with Range support.
 *
 * Written rather than pulled in, for one reason: DuckDB-WASM reads Parquet by
 * issuing HTTP range requests. A server that ignores `Range` and answers 200
 * with the whole file makes DuckDB fail deep inside the WASM with an error
 * that says nothing about ranges -- so the harness has to guarantee 206, and
 * guaranteeing it is easier than auditing somebody else's default.
 */

import { createReadStream, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'

const root = process.argv[2] ?? 'test/e2e/fixtures'
const port = Number(process.argv[3] ?? 8788)

const TYPES = {
  '.json': 'application/json',
  '.parquet': 'application/vnd.apache.parquet',
  // TRAP: WebAssembly.compileStreaming refuses anything but application/wasm,
  // with "Incorrect response MIME type" and no mention of the file. R2 needs
  // the same content-type set on upload.
  '.wasm': 'application/wasm',
}

createServer((req, res) => {
  // Same-origin is not the case here: the app is on 8787 and this is on 8788,
  // exactly as production has the app and the data on different hosts.
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-headers', 'Range')
  res.setHeader('access-control-expose-headers', 'Content-Range, Content-Length, ETag')
  res.setHeader('accept-ranges', 'bytes')
  if (req.method === 'OPTIONS') return res.writeHead(204).end()

  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname))
  if (path.includes('..')) return res.writeHead(400).end()
  const file = join(root, path)

  let size
  try {
    size = statSync(file).size
  } catch {
    return res.writeHead(404).end('not found')
  }

  const type = TYPES[extname(file)] ?? 'application/octet-stream'
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
  if (range) {
    const start = range[1] === '' ? size - Number(range[2]) : Number(range[1])
    const end = range[2] === '' || range[1] === '' ? size - 1 : Number(range[2])
    if (start >= size || start < 0) {
      return res.writeHead(416, { 'content-range': `bytes */${size}` }).end()
    }
    const last = Math.min(end, size - 1)
    res.writeHead(206, {
      'content-type': type,
      'content-range': `bytes ${start}-${last}/${size}`,
      'content-length': last - start + 1,
    })
    if (req.method === 'HEAD') return res.end()
    return createReadStream(file, { start, end: last }).pipe(res)
  }

  res.writeHead(200, { 'content-type': type, 'content-length': size })
  if (req.method === 'HEAD') return res.end()
  createReadStream(file).pipe(res)
}).listen(port, () => console.log(`fixtures on http://localhost:${port} (root ${root})`))
