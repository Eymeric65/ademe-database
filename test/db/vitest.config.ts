import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'

// TRAP: wrangler refuses to start when `assets.directory` is missing, and dist/
// is a build output that is gitignored. Without this, `npm run test:db` fails on
// a fresh clone with an error about assets that has nothing to do with the
// database. The pool never serves an asset -- these tests only call /api.
mkdirSync(fileURLToPath(new URL('../../dist/', import.meta.url)), { recursive: true })

// Tests that need a real database live here. There is no mock D1 in this
// repository on purpose (CLAUDE.md section 3): Miniflare's D1 is real SQLite,
// and a fake would only ever assert the fake.
export default defineWorkersConfig({
  test: {
    include: ['test/db/**/*.test.ts'],
    poolOptions: {
      workers: {
        // Each test file gets its own empty database, so migrate() really does
        // run against a fresh one in every file that asks for it.
        isolatedStorage: true,
        wrangler: { configPath: '../../wrangler.jsonc' },
      },
    },
  },
})
