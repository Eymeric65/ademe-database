/** The Worker's bindings and vars. Kept beside the router that consumes them. */
interface Env {
  DB: D1Database
  ASSETS: Fetcher

  BETTER_AUTH_SECRET: string
  BETTER_AUTH_URL: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string

  /**
   * '1' enables email+password sign-in. Set in dev and preview, NEVER in
   * production -- see the trap in server/db.ts and ADR-0008.
   */
  AUTH_TEST_CREDENTIALS?: string
}
