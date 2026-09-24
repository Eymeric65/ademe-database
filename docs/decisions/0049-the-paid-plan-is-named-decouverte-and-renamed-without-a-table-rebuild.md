---
status: accepted
date: 2026-09-24
area: app plane
supersedes:
superseded-by:
---

# ADR-0049 — The paid plan is named « Découverte », and `user.plan` is renamed in place, never by a table rebuild

**Status:** accepted · **Decided:** 2026-09-24 · **Area:** app plane

## Context and Problem Statement

The one paid plan was stored as `user.plan = 'paid'` (ADR-0038) and shown as
« l'abonnement » or « membres payants ». Eymeric wants the Abonnement page to
lay plans side by side, the same for everybody, and to hold more than one paid
plan later. A value called `paid` cannot be one of several paid plans, so the
plan gets a name: **Découverte** (5 €/mois: the last two months in the search),
stored as `decouverte`, beside `free` (« Gratuit »).

Changing the CHECK on `user.plan` is where this goes wrong. For any CHECK
change, drizzle-kit emits a table rebuild: `PRAGMA foreign_keys=OFF`, create
`__new_user`, copy, `DROP TABLE user`, rename. D1 enforces foreign keys and
ignores that PRAGMA, and `session`, `account`, `saved_building`,
`saved_search` and `subscription` all cascade on user delete. The generated
migration would sign everybody out and delete every saved building, saved
search and subscription row. `test/db/migrate.test.ts` shows it: against the
generated rebuild, the session count is 0 after the migration.

## Decision Drivers

* No owned row may be lost: D1 has no way to switch cascades off.
* `db/schema.ts` stays the one source of truth, and `npm run db:check` stays
  clean.
* A migration that fails halfway must be safe to run again (CLAUDE.md §10).
* A later paid plan should open the paid tree without a second pass over
  every gate.

## Considered Options

* Rename in place: add a checked column, copy, drop the old one, rename.
* Accept drizzle-kit's rebuild.
* Keep `paid` in the database and call it Découverte only in the UI.

## Decision Outcome

Chosen option: **"rename in place"**, because it is the only one that changes
the CHECK without deleting the `user` rows that everything else cascades from.

`0005_user_plan_decouverte.sql` is a custom migration. drizzle-kit wrote its
snapshot, which matches `db/schema.ts`, but the SQL was written by hand:

```sql
ALTER TABLE `user` ADD `plan_next` text DEFAULT 'free' NOT NULL CHECK (`plan_next` in ('free', 'decouverte'));
UPDATE `user` SET `plan_next` = 'decouverte' WHERE `plan` = 'paid';
ALTER TABLE `user` DROP COLUMN `plan`;
ALTER TABLE `user` RENAME COLUMN `plan_next` TO `plan`;
```

This works only because 0003 added `plan` with a *column* CHECK. SQLite drops
a column along with its own CHECK, but refuses to drop one named in a
table-level CHECK. The snapshot records the check as table-level; the
database has it as a column constraint. Both enforce the same rule, and
`db:check` compares snapshots only.

The four statements are one migration, and `db/migrate.ts` now runs each
migration's statements and its ledger row in a single `db.batch`, which D1
applies as one transaction. Run one statement at a time, a failure on
`DROP COLUMN` left `plan_next` in place, and every retry then failed with
"duplicate column". Earlier migrations were single statements, or
multi-statement ones that nothing had made fail.

Around the rename:

* **Gates.** `server/index.ts` tests `plan !== 'free'` (checkout's 409) and
  `plan === 'free'` (the `paid` route scope's 403). The scope keeps the name
  `paid`, meaning "any paid plan", so `test/unit/authorization.test.ts` does
  not change. `planOf` still lists `decouverte` explicitly: an unknown value
  reads as free, so the gate still fails closed.
* **`planSource`.** `GET /api/me` adds `planSource: 'lifetime' | 'stripe' |
  null`. It is `lifetime` when `user.plan` is set by hand, `stripe` when only
  a subscription in force gives the plan, and null on free. A hand-set plan
  wins over a subscription. The page used to work out "comped" from missing
  dates. Now it reads the source and shows a « Plan à vie » tag with no
  button.
* **One list of plans.** `src/billing/plans.ts` holds `PLANS`. The page draws
  one card per entry, and the status line names the plan from it. A new plan
  is one entry there, plus its value in the CHECK. Adding the value to the
  CHECK is itself a migration like this one.
* **Future work.** A Stripe subscription does not yet say which plan it buys.
  `planOf` maps any subscription in force to `decouverte`, the only plan on
  sale. A second paid plan needs a plan id on `subscription` (or the Stripe
  price id read back by the webhook) before the mapping can tell the two
  apart.

### Consequences

* Good, because no session, account, saved row or subscription is touched.
  The test seeds one of each under a `paid` user and checks they are all
  still there.
* Good, because every migration is now all-or-nothing, not only this one.
* Bad, because the live `user` table no longer matches drizzle-kit's picture
  of it byte for byte: a column CHECK where the snapshot has a table CHECK.
  The next CHECK change on `user` hits the same trap and needs the same
  hand-written migration.
* Neutral, because the premium badge and star keep their names; they mark
  "any paid plan", not Découverte.

### Confirmation

* `test/db/migrate.test.ts`: « renames paid to decouverte without dropping a
  single owned row » fails against the drizzle-generated rebuild (session
  count 0) and passes with this migration. « retries a migration that failed
  halfway as if it had never started » fails with statement-by-statement
  application and passes with the batch. « refuses a plan outside the list,
  paid included » checks the new CHECK.
* `test/db/billing.test.ts`: `planSource` for free, Stripe, hand-set, and a
  hand-set plan beside a live subscription.
* `test/e2e/billing.spec.ts`: both cards are shown in every state, the
  member's own plan is marked, and « Plan à vie » appears with no button.

## Pros and Cons of the Options

### Accept drizzle-kit's rebuild

* Good, because it is what the tooling produces, and the database would
  match the snapshot exactly.
* Bad, because on D1 it cascade-deletes every owned row. D1 ignores
  `PRAGMA foreign_keys=OFF`, and `defer_foreign_keys` only delays when
  constraints are checked. It does not stop `ON DELETE CASCADE` from firing
  when `DROP TABLE` deletes the rows.

### Keep `paid` in the database

* Good, because no migration is needed.
* Bad, because the stored value would stop meaning one plan as soon as a
  second one exists, and the code would say `paid` while the screen says
  Découverte.

## More Information

* Related: [ADR-0038](0038-a-paid-plan-is-a-column-on-the-account-and-the-gate-reads-it.md),
  [ADR-0047](0047-the-paid-plan-is-bought-through-stripe-checkout-and-the-webhook-re-fetches.md),
  [ADR-0048](0048-the-portal-is-opened-by-a-session-route-behind-one-panel.md)
