---
status: accepted
date: 2026-09-20
area: data plane
supersedes: 
superseded-by: 
---

# ADR-0045 — A repair run's budget is a dial, not a constant

**Status:** accepted · **Decided:** 2026-09-20 · **Area:** data plane

## Context and Problem Statement

ADR-0043 gave the weekly job a repair that finds holes on two axes and fetches
them back. It also gave it two guards. One of them, `MAX_REPAIR`, is a
dispatch input; the other, `MAX_HOLE_DAYS = 60`, is a module constant with no
way to reach it from outside the source file.

The constant trips on the tree it was meant to protect. Run 35474909563
(`existant`, 2026-09-19) stopped on **209 days across 10 months** after the
source had missed only two weekly runs, and published nothing. That particular
trip was a bug — deletions were being counted as holes, fixed in `1d36e30` —
but the shape it revealed is not: a tree that is far behind, or that has never
been reconciled at all, looks exactly like a republication. `neuf` and `audit`
are in that state today. Both have been published since 2026-09-11 and neither
has ever been through the two-axis repair, so the first run that tries to heal
them is the run most likely to be stopped by the guard, and the only way past
it is to edit `ademe/delta.py` and push.

The same run cannot be made longer either. `timeout-minutes: 120` is what
cancelled run 34829784527 mid-way through reconciling audits (ADR-0040), and
`audit` now walks 69 months on the date axis on top of narrowing 3.2M keys.

## Decision Drivers

* A recovery is a deliberate act by a human, and it should not need a commit.
* The guard still has to stop the *scheduled* Monday run, which nobody is watching.
* CLAUDE.md §11: the ETL is polite. Whatever is raised, spending stays bounded.
* A guard that trips publishes nothing, so the whole run's work is lost — the
  cost of being stopped scales with how long the source takes.

## Considered Options

* Make the cap a parameter, defaulted to the constant, with a dispatch input.
* Raise `MAX_HOLE_DAYS` to a number big enough for the worst tree.
* Drop the cap and rely on `MAX_REPAIR` alone.

## Decision Outcome

Chosen option: **"make the cap a parameter"**, because it is the only one that
keeps the unattended Monday run stopping at 60 days while letting a person say
*I know, chase them anyway* without a commit.

`date_holes` and `heal` take `max_hole_days`, `scripts/reconcile.py` takes
`--max-hole-days`, and the workflow takes a `max_hole_days` input defaulting to
`'60'` — beside `max_repair`, in the same shape, reaching the repair through the
same step.

The default does not move. The constant is what a run nobody is watching gets.

`timeout-minutes` goes 120 → 240 in the same change, for the same reason: it is
the other ceiling that ends a repair with nothing published, and since ADR-0042
gave each source its own runner, a raised ceiling costs the other three sources
nothing but the wall-clock of a job that was going to fail anyway.

### Why the day cap is not the real budget

`MAX_HOLE_DAYS` counts **days whose ids get listed**, not rows fetched. A day
costs one paged id listing; the rows themselves are still capped by
`MAX_REPAIR`, which is checked after both axes have reported and before a single
record is pulled. Raising the day cap widens what a run may *look at*. It does
not widen what it may *fetch*. That is why it is safe to hand to a human and why
`MAX_REPAIR` is the one that should stay conservative.

### Consequences

* Good, because a tree far enough behind to look like a republication can now be
  healed by a dispatch, which is the only way it can be healed at all — the
  local base build is 17 hours and cannot be uploaded from here.
* Good, because the failure message now names the flag that unblocks it.
* Bad, because a person can now tell a run to chase a genuine republication.
  `MAX_REPAIR` still stops it before it rewrites anything, at the cost of a
  wasted run.
* Neutral, because a scheduled run behaves exactly as it did before.

### Confirmation

* `tests/test_delta.py::test_a_recovery_run_may_raise_the_hole_day_cap` — the dial
  has to beat the constant, not merely exist: with `MAX_HOLE_DAYS` monkeypatched
  to 0 the default run raises and the `max_hole_days=400` run repairs. Before the
  change: `TypeError: heal() got an unexpected keyword argument 'max_hole_days'`.
* `tests/test_delta.py::test_the_hole_day_cap_reaches_the_repair_through_the_script`
  asserts it through `scripts/reconcile.py`, which is what the job runs. Before:
  `error: unrecognized arguments: --max-hole-days 400`.
* `tests/test_workflows.py::test_a_recovery_run_can_be_told_how_many_hole_days_to_chase`
  pins the input and the flag on the reconcile step. Before: `AssertionError: no
  max_hole_days input`.
* The timeout is not pinned to a number by a test; `test_each_source_is_its_own_job_one_at_a_time`
  only requires that a per-source timeout exists.

## More Information

* Refines [ADR-0043](0043-holes-are-found-on-two-axes-and-healed-by-id.md): the
  guards it introduced, made operable.
* Builds on [ADR-0042](0042-each-source-is-its-own-weekly-job-one-at-a-time.md):
  a per-source runner is what makes a longer ceiling cheap.
* Evidence: runs 35474909563 (stopped at 209 days) and 34829784527 (cancelled at
  120 minutes in audits).
