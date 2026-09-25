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

  /**
   * The one preview host registered with Google. Branch previews send their
   * Google sign-in through it. Preview only, NEVER production -- see ADR-0036.
   */
  OAUTH_PROXY_URL?: string

  /**
   * Stripe, for the paid plan. The key and the webhook secret are secrets
   * (`wrangler secret put`, test-mode values under --env preview); the price is
   * a secret in production and a var on previews. Any of them missing and the
   * billing routes answer 503: no key, no checkout. See ADR-0047 and ADR-0050.
   */
  STRIPE_SECRET_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
  STRIPE_PRICE_ID?: string

  /** '1' refuses any key that is not a test-mode key. Preview only -- see server/stripe.ts. */
  STRIPE_TEST_MODE_ONLY?: string
}
