---
status: accepted
date: 2026-09-24
area: deployment
supersedes: 0047 (in part: where production keeps the price id)
superseded-by:
---

# ADR-0050 — The live Stripe price id is a Worker secret, so turning billing on needs no promotion

**Status:** accepted · **Decided:** 2026-09-24 · **Area:** deployment

## Context and Problem Statement

ADR-0047 kept `STRIPE_PRICE_ID` as a var in `wrangler.jsonc`, set to `""` in
production until the live Stripe setup exists. The only way to change a var in
production is to change `main`. Turning billing on would therefore take a
`feat/stripe-live` PR to `dev` and then a second `dev → main` promotion, just to
change one string. Setting the var in the Cloudflare dashboard instead does not
last: the next `wrangler deploy` resets it to `""` and billing quietly goes back
to 503.

## Decision Drivers

* Going live should be something Eymeric does in Cloudflare, without a
  promotion.
* A value set outside the repo must survive deploys.
* Previews must keep their test-mode price and keep refusing live keys.

## Considered Options

* Keep the var and do the second promotion (ADR-0047 as written).
* Make production's price id a secret, like the key and the webhook secret.
* Look the price up at Stripe by a `lookup_key` on each checkout.

## Decision Outcome

Chosen option: **"a secret"**, because it is the only option that makes the
live switch three `wrangler secret put` commands and needs no code change:
the Worker already reads `env.STRIPE_PRICE_ID`, and secrets and vars show up
the same way on `env`. Unlike a var, a secret is not reset by `wrangler deploy`.

The top-level `vars` in `wrangler.jsonc` no longer declares `STRIPE_PRICE_ID`.
Wrangler refuses to create a secret with the same name as a declared var.
`env.preview` keeps its test-mode price as a var, since vars are not inherited
across environments.

Going live, after the live Stripe setup:

```
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put STRIPE_WEBHOOK_SECRET
wrangler secret put STRIPE_PRICE_ID
```

### Consequences

* Good, because billing is turned on and off in Cloudflare, without a PR.
* Good, because until the secret is set, the billing routes answer 503 exactly
  as they did with the empty var.
* Bad, because the live price id is no longer visible or reviewed in the repo.
  It is not sensitive; it is simply somewhere else now.
* Neutral, because a `lookup_key` would add a Stripe call to every checkout to
  save one secret. Not worth it.

### Confirmation

`test/unit/stripe-price-config.test.ts` reads `wrangler.jsonc` through
wrangler's own `unstable_readConfig`. It fails if production declares a
`STRIPE_PRICE_ID` var, and it fails if the preview loses its `price_…` var.

## More Information

* Related: [ADR-0047](0047-the-paid-plan-is-bought-through-stripe-checkout-and-the-webhook-re-fetches.md)
