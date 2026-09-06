/** The Worker's bindings and vars. Kept beside the router that consumes them. */
interface Env {
  DB: D1Database
  ASSETS: Fetcher

  /**
   * The published certificates. Read-only: the Worker serves bytes out of this
   * bucket and never writes to it -- the ETL uploads with an S3 token. The
   * bucket has no public custom domain, which is what makes the gate on
   * /data/v1/* the only way in. See ADR-0012.
   */
  DATA: R2Bucket

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
