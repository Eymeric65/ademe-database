---
status: accepted
date: 2026-09-22
area: identity
supersedes:
superseded-by:
---

# ADR-0047 — The paid plan is bought through Stripe Checkout, and the webhook re-fetches rather than trusts

**Status:** accepted · **Decided:** 2026-09-22 · **Area:** identity

## Context and Problem Statement

ADR-0038 made the paid plan a `user.plan` column that only an operator's
`UPDATE` can set, and left payment out of scope. The plan now costs €5 a
month and renews by itself. A payment provider has to be able to tell the
Worker "this account paid", over a public webhook, without that route becoming
a way to make any account paid.

Revolut Merchant was tried first and dropped before it reached `dev`: its
Business account is not available to the operator. Stripe is used instead.

## Decision Drivers

* A caller cannot make themselves paid, and neither can a forged or replayed
  webhook, even a well-signed one.
* Duplicate, late and out-of-order deliveries must be harmless: Stripe does not
  guarantee order.
* No new runtime dependency: the Worker has `fetch` and WebCrypto.
* Cancelling keeps what was paid for, and a failed renewal stops by itself,
  with no cron.
* As little billing UI of our own as possible: no card form, no cancel flow.
* D1 has no RLS (ADR-0003): every read stays scoped in `server/db.ts`.

## Considered Options

* A hosted Checkout Session opened by our own route for the signed-in caller;
  the webhook re-fetches; cancel and card changes in Stripe's hosted portal.
* A Payment Link (no route of ours) that carries the account id in
  `client_reference_id`, with the webhook inserting the row.
* Either of those, but with the webhook writing the state carried in the event
  body.

## Decision Outcome

Chosen option: **"a hosted Checkout Session opened by the owner, webhook as a
poke"**, because it is the only option in which an owner's own request creates
every row, so no signed event can attach a subscription to an account, and
nothing in an event body is ever written.

**Table `subscription`** (migration `0004_subscription`, no change to `user`).
One row per checkout the owner opened:

| column | type | meaning |
|---|---|---|
| `id` | text PK | the Checkout Session id, `cs_…` |
| `user_id` | text NOT NULL → `user.id` ON DELETE CASCADE | the owner, set by checkout only |
| `subscription_id` | text NULL, UNIQUE | `sub_…`, once the checkout is paid |
| `customer_id` | text NULL | Stripe customer, reused on resubscription |
| `status` | text NOT NULL, CHECK in Stripe's eight statuses + `pending` | as Stripe last said |
| `paid_until` | integer NULL | unix seconds, end of the current period |
| `cancel_at_period_end` | integer (boolean) NOT NULL | the member cancelled; it ends at `paid_until` |
| `created_at`, `updated_at` | integer | `updated_at` set by the writer |

**Entitlement.** `planOf` answers paid for `user.plan = 'paid'` (ADR-0038's
comp, unchanged) or for a row with `status` in (`active`, `trialing`) and
`paid_until + 1 day > now`. It is still one query. Both conditions are needed:
- The status, because a `past_due` or `canceled` subscription has not been
  paid for, even though Stripe has already moved its period forward.
- The date, so that if the webhooks stop arriving an `active` row still runs
  out.

The day of grace covers renewal. Stripe rolls the period over, charges up to
an hour later, and the webhook arrives after that. Cancelling in the portal
leaves the subscription `active` with `cancel_at_period_end` set, so it reads
until the end of the month.

**Routes.**

| route | scope | does |
|---|---|---|
| `POST /api/billing/checkout` | `self` | 409 if already paid, or if a subscription is still live at Stripe (`trialing`, `active`, `past_due`, `unpaid`, `paused`); open a Checkout Session for the caller (reusing their Stripe customer); insert the `pending` row; return the session's `url` |
| `POST /api/billing/webhook` | `public` | verify the signature, read only the type and an id, re-fetch from Stripe, `UPDATE … WHERE id = ?` or `WHERE subscription_id = ?`; 204 |
| `GET /api/me` | `self` | adds `renewsOn` / `endsOn` |

Cancelling, changing the card and invoices happen in Stripe's hosted Customer
Portal, which the UI links to. No route of ours cancels anything.

**The webhook can only update rows an owner created.** Checkout alone inserts
rows, under the caller's subject. The webhook has no caller. `applyCheckout`,
`applySubscription` and `isKnownBilling` are the exports of `server/db.ts` that
take no `Caller`. That is safe because they only update a row by a Stripe id
and never insert: an id that no checkout created changes nothing and costs no
Stripe call.
- `checkout.session.completed` names the session. The re-fetched session names
  its subscription only once it is `complete`.
- `customer.subscription.*` events name the subscription.
- Every other event is acknowledged and ignored.

**Signature.** `Stripe-Signature: t=…,v1=…`: HMAC-SHA256 of `{t}.{raw body}`
with the endpoint's `whsec_…` secret, hex. Any one of several `v1` values may
match (rotation). The comparison is constant-time, and `t` must be within five
minutes either way. `v0` is never accepted. A bad signature is a 400.

**Checkout settings** are the ones chosen in Stripe's Checkout Studio:
- mode `subscription`
- billing address `auto`
- phone collection off
- automatic tax off
- no promotion codes
- payment method always collected

They are spelled out even where they are Stripe's defaults, so that a change of
default at Stripe is not a change of checkout here. Studio's
`integration_identifier` and `origin_context` are not sent. They label the
integration for Stripe and play no part in the checkout.

**Configuration.** Secrets: `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`.
The secret key should be a restricted key: Checkout Sessions write,
Subscriptions read. The var `STRIPE_PRICE_ID` holds the price. If any of them
is missing, both billing routes answer 503. The preview sets
`STRIPE_TEST_MODE_ONLY=1`, and there a key that is not `sk_test_`/`rk_test_`
also answers 503, so a preview can never take real money into the preview
database.

### Consequences

* Good, because nothing in a webhook body is written. Stripe's own answer to an
  authenticated GET is the only source of state, so replays and reordering are
  harmless.
* Good, because no card data and no cancel logic live here.
* Good, because a missed webhook fails closed at the end of the period, not
  never.
* Bad, because a subscription that is live at Stripe but unpaid (`past_due`)
  reads as free, while its retries run. That is intended: the money did not
  come.
* Bad, because deleting an account cascades its rows but cancels nothing at
  Stripe. A delete-account route must cancel first; a trap comment in
  `db/schema.ts` says so.
* Bad, because a user who opens a checkout and never pays leaves a `pending`
  row. It is harmless: `pending` never entitles and never blocks a new checkout.
* Neutral, because the account's Stripe API version does not matter here. The
  period end is read from both the subscription and its items, where versions
  since 2025-03-31 put it.

### Confirmation

* `test/db/billing.test.ts`, on Miniflare D1 with Stripe answered by fetchMock
  and net connect disabled. It covers:
  - checkout parameters and the pending row
  - customer reuse
  - the 409s
  - completion
  - replay
  - a body that lies
  - bad and stale signatures
  - unknown ids reaching no Stripe call
  - 5xx on a Stripe outage
  - cancel at period end
  - deletion
  - `past_due`
  - a silent lapse
  - the day of grace
  - 503 unconfigured, and 503 on a live key in a test-only deployment
* `test/db/cross-tenant.test.ts` › *two users and one subscription*: A's payment
  never makes B paid or shows in B's `/api/me`. Removing the `user_id` predicate
  from `planOf`'s join fails it.
* `test/unit/stripe-signature.test.ts`, against signatures made with node's own
  HMAC.
* `test/unit/authorization.test.ts`: the webhook is on the public list and
  checkout is on the self list.

## Pros and Cons of the Options

### A Payment Link

* Good, because it has no checkout route at all.
* Bad, because the row would be born in the webhook, from an account id that
  anybody can put in the link's URL: someone could pay for another account.
* Bad, because nothing could refuse a second subscription to an account that
  already pays.
