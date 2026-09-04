import { defineConfig } from 'drizzle-kit'

// Deliberately connection-less: this file only generates SQL. Applying it is
// `wrangler d1 migrations apply`'s job, and in the Worker it is db/migrate.ts.
export default defineConfig({
  dialect: 'sqlite',
  driver: 'd1-http',
  schema: './db/schema.ts',
  out: './db/migrations',
  strict: true,
  verbose: true,
})
