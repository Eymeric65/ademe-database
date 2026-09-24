---
status: accepted
date: 2026-09-24
area: identity
supersedes: 0047 (in part: how the UI reaches the portal)
superseded-by:
---

# ADR-0048 — The Stripe portal is opened by a session route for the caller, and cancelling passes one « avant de partir » panel

**Status:** accepted · **Decided:** 2026-09-24 · **Area:** identity

## Context and Problem Statement

ADR-0047 left cancelling and card changes to Stripe's hosted Customer Portal,
"which the UI links to": a no-code login link in `STRIPE_PORTAL_URL`, with the
account's email prefilled. That link was never set, so a member had no way to
cancel. It also had two flaws of its own. It always returns to one fixed host,
so a member on a preview would come back to production. And it signs in by an
emailed code, which adds a step to every visit. Separately, Eymeric wants
leaving members to read, once, who the subscription pays for: a student who
builds and runs the site alone.

## Decision Drivers

* A member must be able to cancel, and French law caps how hard that can be:
  « résiliation en trois clics » (Code de la consommation L215-1-1, décret
  2023-417), and DSA art. 25 forbids interfaces that obstruct a choice.
* The portal must come back to the host it was opened from, so previews work.
* No new dependency, and no billing UI of our own beyond what is unavoidable
  (ADR-0047).
* D1 has no RLS (ADR-0003): which customer the portal opens on must come from
  the caller's own row, never from the request.

## Considered Options

* A `self` route that opens a portal *session* for the caller's own Stripe
  customer, with one panel of ours before a cancel.
* The no-code login link from ADR-0047, set per environment.
* A cancel route of our own (`DELETE /subscriptions/:id` or
  `cancel_at_period_end=true`) with our own confirmation page.

## Decision Outcome

Chosen option: **"a session route for the caller, one panel before a
cancel"**, because it is the only option that returns to the caller's own
host without an email code, while Stripe's hosted cancel page stays the
confirmation. Nothing of ours cancels anything.

**Route.** `POST /api/billing/portal`, scope `self`, body `{ cancel?: boolean }`.

| case | answer |
|---|---|
| Stripe not configured (`stripeKey()` null) | 503 |
| the caller has no Stripe customer (`subscriptionOf` returns no `customer_id`) | 404 |
| `cancel: true` and the subscription is not live (`trialing`, `active`, `past_due`, `unpaid`, `paused`) | 404 |
| Stripe fails | 502, through the existing `upstream()` |
| otherwise | `{ url }` of a `billing_portal` session |

The customer and the subscription are read from `subscriptionOf(env, caller)`,
the same caller-scoped lookup that checkout and `/api/me` already use. No new
query shape was added. `return_url` is `<request origin>/#/abonnement`. With
`cancel`, the session is deep-linked with
`flow_data[type]=subscription_cancel` on the caller's subscription, and after
completion it redirects to `<origin>/?abonnement=resilie`. The page then shows
« Résiliation enregistrée » and polls `/api/me` until `endsOn` arrives with
the webhook, the same way `?abonnement=merci` waits for "paid".

`STRIPE_PORTAL_URL` and `/api/me`'s `manageUrl` are removed.

**The panel.** « Résilier mon abonnement » sits on the Abonnement page beside
« Gérer ma carte et mes factures ». The second button opens the portal
directly. The first opens **one** « Avant de partir » dialog: a few sentences
on who runs the site, a link to eymeric.me, and two buttons with the same
styling, « Continuer la résiliation » first and « Garder mon abonnement ». It
has no countdown, no discount and no guilt wording. It adds exactly one click,
and Stripe's cancel page is the confirmation: Résilier → Continuer → confirm
at Stripe. That is three clicks. A second panel, a retention coupon, or
Stripe's cancellation-reasons survey would each add one more, so all of them
are off. The last two are switched off in the Stripe dashboard.

### Consequences

* Good, because a preview's portal returns to the preview, and no member ever
  waits for an email code.
* Good, because the customer comes only from the caller's row, so a request
  body cannot open another account's portal. The cross-tenant test holds this.
* Bad, because the restricted key needs one more permission (Customer portal:
  Write). Without it the route answers 502.
* Bad, because the portal must be configured in the Stripe dashboard, once per
  mode (test and live): cancel at period end, reasons and coupons off,
  ToS/privacy links. Nothing in the repository can check that.
* Neutral, because the cancel still lands through the existing
  `customer.subscription.updated` webhook. Nothing in ADR-0047's data path
  changes.

### Confirmation

* `test/unit/stripe-portal.test.ts`: the form (`return_url` is the request
  origin; a cancel adds the `flow_data`).
* `test/db/billing.test.ts` › "the portal": 200, 404 without a customer, 404
  for a cancel on a finished subscription, 502, 503.
* `test/db/cross-tenant.test.ts`: B never gets a session on A's customer.
* `test/unit/authorization.test.ts`: the route is in `SELF_SCOPED`.
* `test/e2e/billing.spec.ts`: the buttons, the one panel (Garder sends no
  request, Escape closes, Continuer posts `{cancel:true}`), and the
  `?abonnement=resilie` return.
* The legal constraints on the panel are not verified automatically beyond
  "one panel, two buttons of the same class".

## Pros and Cons of the Options

### The no-code login link (ADR-0047)

* Good, because no route and no key permission are needed.
* Bad, because it has one fixed return host and an email code on every visit,
  and it cannot deep-link to the cancel page.

### A cancel route of our own

* Good, because the whole flow stays on our site.
* Bad, because it is billing UI of our own, which ADR-0047 set out to avoid,
  and it adds a mutation on Stripe that our code would own.

## More Information

* Related: [ADR-0047](0047-the-paid-plan-is-bought-through-stripe-checkout-and-the-webhook-re-fetches.md)
  (partly superseded: only the portal link),
  [ADR-0003](0003-d1-has-no-rls-and-what-replaces-it.md)
