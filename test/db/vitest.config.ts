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
        miniflare: {
          bindings: {
            // Dev and preview set this; production never does. The OFF case is
            // tested in auth.test.ts by building authFor() with it absent.
            AUTH_TEST_CREDENTIALS: '1',
            BETTER_AUTH_SECRET: 'test-secret-not-used-anywhere-real',
            BETTER_AUTH_URL: 'http://x',
            // Stripe is answered by fetchMock in test/db/billing.test.ts,
            // with net connect disabled, so a missing intercept fails loudly
            // rather than reaching the real API.
            STRIPE_SECRET_KEY: 'sk_test_not_a_real_key',
            STRIPE_WEBHOOK_SECRET: 'whsec_test_not_a_real_secret',
            STRIPE_PRICE_ID: 'price_test',
            STRIPE_PORTAL_URL: 'https://billing.stripe.invalid/p/login/test',
          },
        },
      },
    },
  },
})
