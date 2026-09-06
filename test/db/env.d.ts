/// <reference types="@cloudflare/vitest-pool-workers" />

// `cloudflare:test` is a virtual module provided by the pool at runtime; tsc
// needs the reference above to see it, and this to know what env holds.
declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}
