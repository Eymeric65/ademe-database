import { defineConfig, devices } from '@playwright/test'

/**
 * E2E runs against the WORKER, not against Vite.
 *
 * The built assets and the API have to be on one origin, because that is how
 * production serves them and because the session cookie is same-origin. A
 * harness that ran Vite on 5180 and wrangler on 8787 would pass while the real
 * thing was broken -- which is the failure this suite exists to catch.
 *
 * E2E_BASE_URL points the same specs at a deployed preview; when it is set the
 * local server is not started at all.
 */
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:8787'

// The Parquet is served BY the Worker now, out of its R2 binding and behind the
// route gate (ADR-0012), so there is no second origin to stand up. The local
// bucket is filled by scripts/seed-r2.mjs in `pretest:e2e`.

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['html'], ['list']] : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Fails the run if the Worker does not answer 206 to a Range request, which
  // is the one way this whole suite could pass while testing nothing.
  globalSetup: './test/e2e/global-setup.ts',
  ...(process.env.E2E_BASE_URL
    ? {}
    : {
        webServer: [
          {
          // --env preview, not the default env: AUTH_TEST_CREDENTIALS lives
          // there and nowhere else (ADR-0008), and sign-in.spec.ts cannot sign
          // anybody in without it. `wrangler dev` is local-only, so this binds
          // a local Miniflare D1 and never the deployed preview database.
          //
          // BETTER_AUTH_SECRET is passed here rather than through .dev.vars so
          // there is no file for a real secret to be committed into. This value
          // is local-only; production's is set with `wrangler secret put`.
          command:
            'npm run build && npx wrangler dev --env preview --port 8787' +
            ' --var BETTER_AUTH_SECRET:local-development-only-not-a-real-secret',
          // /api/health is the readiness probe on purpose: it answers only
          // once the Worker is up AND the migrations have run, so a spec never
          // races an empty database.
          url: 'http://localhost:8787/api/health',
          reuseExistingServer: !process.env.CI,
          timeout: 180_000,
          },
        ],
      }),
})
