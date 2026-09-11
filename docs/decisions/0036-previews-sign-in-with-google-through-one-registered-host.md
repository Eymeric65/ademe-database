---
status: accepted
date: 2026-09-11
area: identity
supersedes:
superseded-by:
---

# ADR-0036 — Previews sign in with Google through the one registered preview host

**Status:** accepted · **Decided:** 2026-09-11 · **Area:** identity

## Context and Problem Statement

Google accepts a redirect URI only if it matches one registered on the OAuth
client exactly; there are no wildcards. ADR-0008 leaves `BETTER_AUTH_URL` empty
on previews, so each one asks Google to come back to its own host. Every branch
gets a new one (`<alias>-ademe-app-preview.eymeric-chauchat.workers.dev`), so
every branch preview answered `Erreur 400 : redirect_uri_mismatch` until its
callback was added in the Google console by hand.

## Decision Drivers

* Google sign-in must be testable on any branch preview with no per-branch
  console change.
* Production's sign-in must not change.
* Preview sessions stay in the preview database (ADR-0008).

## Considered Options

* Register each preview's callback by hand (the status quo).
* An email and password form on previews only, with Google left untested
  there.
* Better Auth's `oAuthProxy` plugin, with the stable preview host as the proxy.
* The same plugin, with production as the proxy.

## Decision Outcome

Chosen option: **"`oAuthProxy` through the stable preview host"**, because it
needs one registered URI, once, and keeps every preview session in the preview
database.

The plugin is loaded only when `OAUTH_PROXY_URL` is set, and only `env.preview`
sets it, to `https://ademe-app-preview.eymeric-chauchat.workers.dev`. Every
preview alias runs that same Worker environment, with the same secret and the
same D1, which is what lets them trust each other:

1. On a branch host, `sign-in/social` asks Google to return to the stable
   host's `/api/auth/callback/google`. It points the final hop at the branch's
   own `/api/auth/oauth-proxy-callback`.
2. The stable host exchanges the code, encrypts the profile with the shared
   secret, and redirects to that hop.
3. The branch host checks the payload's age (60 s) and its OAuth state, then
   creates the session in the preview D1 and sets its own cookie.

On the stable host itself the proxy steps aside, since its origin is the proxy
URL.

Production as the proxy was rejected: production is not deployed yet, and it
holds the real D1 and a different secret, so a preview sign-in would have to
cross into real user data.

### Consequences

* Good, because one callback URI, registered once, serves every branch.
* Good, because production is untouched: it has no `OAUTH_PROXY_URL`, so it
  loads no plugin.
* Bad, because a branch's Google sign-in depends on the stable host running a
  version with this plugin. It has to be deployed there (`wrangler deploy
  --env preview`) before any branch can use it, and again whenever the plugin's
  configuration changes.
* Bad, because the encrypted profile, including Google's tokens, travels in a
  URL for one redirect. It is encrypted, bound to the OAuth state and expires
  in 60 s, but it can land in the browser history of that hop.
* Neutral, because email and password still works on previews for tests and
  CI (ADR-0008).

### Confirmation

* `test/db/auth.test.ts`, "Google on a preview, through the stable preview
  host":
  * a branch host asks Google for the stable host's callback;
  * the stable host and production each keep their own callback;
  * a forged hand-back sets no session.
* Not automatically verified: a real Google round-trip. The test is to sign in
  with Google on a branch preview once the callback is registered and the
  stable host is deployed.

## More Information

* Related: [ADR-0008](0008-better-auth-per-request-google-only-in-production.md)
