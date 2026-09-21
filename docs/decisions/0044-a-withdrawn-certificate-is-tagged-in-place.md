---
status: accepted
date: 2026-09-20
area: data plane
supersedes:
superseded-by:
---

# ADR-0044 — A withdrawn certificate is tagged in place, never deleted

**Status:** accepted · **Decided:** 2026-09-20 · **Area:** data plane

## Context and Problem Statement

ADEME's public datasets are Data Fair **virtual** views filtered `dpe_desactive = 0` (audits:
`in_desactive = 0`). The flag is not in the public schema, so a withdrawn certificate never gets a
status — it simply stops being returned. ADR-0007 finds those rows by reconciling counts per
département and, on a mismatch, pulling ids and deleting the difference; ADR-0043 moved that
deletion into the repair's single rewrite.

The deletion is terminal. The row is rewritten out of both the `dpe` and the `search` file, the
files are copied over the published ones, and the record exists nowhere — the only trace is a line
in a GitHub Actions log. Nobody publishes a history of withdrawn DPEs; ADEME's own view just makes
them vanish. It is also a visible dead end: a saved building whose certificate was withdrawn renders
`Introuvable` with nothing to say why.

## Decision Drivers

* The rows are already in hand at the moment they are deleted. Keeping them costs almost nothing.
* `manifest.rows` per partition is compared against ADEME's own `total` every week. Whatever is
  done must leave that comparison meaning exactly what it means today.
* A weekly job that rewrites more than it must is risk for nothing (`merge`'s own docstring).
* The published tree is immutable and versioned (CLAUDE.md §11): a change of layout has to survive
  the whole pipeline — `recent join` → delta → reconcile/repair → `recent split` → upload.
* The paid window (ADR-0038, ADR-0039) must not move because of this.

## Considered Options

* Delete, as today
* Copy the row to a separate archive tree under `index/withdrawn/dept=<PART>/` before deleting it
* Tag the row in place with a `withdrawn_on` date and never delete it

## Decision Outcome

Chosen option: **"tag the row in place"**.

Both published files gain one column:

| column | type | meaning |
|---|---|---|
| `withdrawn_on` | `DATE` | NULL while the certificate is live; otherwise the day a weekly run found it gone from ADEME |

It is the date the run **looked**, not the date of the withdrawal: ADEME publishes nothing about
the withdrawal itself, so the most that can honestly be said is that the certificate was there the
run before and is not there now.

The tag goes in the `search` file as well as the wide one, so a result can say a certificate was
withdrawn without opening a 226-column row.

**A tag is not a move.** The row stays in its partition, and — this is what makes the option cheap —
on whichever side of the paid cutoff its own date already put it. `recent.split` classifies it
exactly as before, the `recent/` tree keeps holding what it held, and no certificate changes hands
between the free and the paid tree because it was withdrawn.

**A certificate that comes back clears its own tag.** The delta anti-joins the base against the
delta's ids and takes the delta's row whole; that row carries no tag. Nothing has to remember.

### `rows` still means live rows

This is the whole risk of the record. A tagged row is still in the file, so every count taken *off a
file* and compared against ADEME had to learn to ignore it:

| site | |
|---|---|
| `delta.merge_partition`'s return | the count written into the manifest |
| `delta._published_ids` | what reconciliation believes this tree holds |
| `delta._by_date` | the per-month and per-day counts of the date axis (ADR-0043) |
| `recent.split`, `recent.join` | the row counts each checks itself against |

Miss one and the failure is not loud. A tagged row counted as published stands in for a certificate
that really is missing, so the repair stops fetching it; and on a key range where the counts do not
cancel, the same row is reported `gone` a second time, re-tagged with a later date, and the
partition's `rows` walks down by one every week. `delta._published_ids` carries an inline `TRAP:`
for that reason (CLAUDE.md §8).

### The published tree migrates itself

The live tree has no `withdrawn_on`, and a weekly run copies the partitions it did not touch byte
for byte — so during a run, a base file may predate the column while the delta beside it does not.
`delta._wide` wraps a read and adds a typed NULL when the column is absent, which is what every
read of a published file goes through.

No migration is scheduled and none is needed: `recent.split` already rewrites every partition of
every source every week, whether or not the delta touched it, so one weekly run per source carries
the column across the whole tree. `_wide` is deletable once every source has had one.

### Consequences

* Good, because the history exists at all — the one thing this project can offer that the source
  does not — and it costs one mostly-NULL, highly compressible column.
* Good, because nothing moved: no new file, no new directory, no new prefix. `rclone copy` of
  `search/`, `dpe/` and `index/` is unchanged, and `/data/v1/*` is a prefix wildcard, so neither
  the weekly workflow nor the Worker needed a line.
* Good, because a withdrawn certificate can be shown as withdrawn instead of as `Introuvable`.
* Bad, because a partition never shrinks. A withdrawn row keeps paying for its bytes in the wide
  file, which is the file the detail view range-reads (ADR-0035). Row groups are ordered by key, so
  tagged rows are spread through them rather than skippable — at ADEME's observed rate of
  withdrawal this is noise, and a retention policy is deliberately not decided here.
* Bad, because "rows in the file" and "rows in the manifest" are no longer the same number. The
  table above is the whole list of places that care, and the tests below pin each of them.
* Neutral, because the tag is an observation, not a claim about ADEME's reasons. A certificate can
  leave, come back, and leave again; the column holds the latest observation, not a log of them.

### Confirmation

`tests/test_delta.py`, `tests/test_source_keys.py`, `tests/test_export_parquet.py`,
`tests/test_delta_per_source.py`:

* `test_a_withdrawn_certificate_is_kept_and_tagged` — the row survives reconciliation in both files,
  with the date pinned, and the manifest still counts one.
* `test_the_repair_path_tags_instead_of_deleting` — through `heal`, which is the path the weekly
  job takes; a tag written only in `apply_deletions` would almost never be written.
* `test_a_withdrawn_row_is_not_reported_gone_again_next_week` — the `_published_ids` trap. Removing
  the filter makes the repair miss a certificate that really is absent.
* `test_a_certificate_that_comes_back_loses_its_tag`.
* `test_a_partition_published_before_the_column_gains_it_when_rewritten` — `_wide`.
* `test_a_withdrawn_row_splits_with_the_side_its_date_puts_it_on` — the split and the join, and
  that the paid window did not move.
* `test_a_withdrawn_step_is_tagged_by_the_sources_own_key` — an audit's steps share one
  `numero_dpe`, so a tag written against that column would mark the whole audit.
* `test_search_file_has_exactly_the_declared_columns_and_is_sorted` and
  `test_a_merge_keeps_the_sources_own_search_index` pin the search index's exact column list.

## Pros and Cons of the Options

### Copy the row to an archive tree under `index/withdrawn/`

* Good, because the wide file never grows and the hot read stays exactly as it is.
* Good, because the archive is append-only and reads as an event log, with a row per withdrawal
  rather than one latest observation.
* Bad, because the history then has to survive four hand-offs — `merge`'s touched and untouched
  branches, `apply_deletions`, `recent.split` and `recent.join` — and a single miss does not lose a
  week, it loses every week. Three of those are places where a partition is rebuilt from scratch.
* Bad, because it needs a conditional manifest entry, and a reader that guesses wrong gets a 404.
* Bad, because `index/` is a flat side-car of two whole-tree files (ADR-0006); a per-département
  directory under it is a second shape in the same place.

### Delete, as today

* Good, because there is nothing to get wrong.
* Bad, because the record is destroyed, and the only account of it is a CI log with a 90-day life.

## More Information

* Related: [ADR-0007](0007-the-delta-cannot-see-deletions-so-reconcile-by-count.md) — **amended, not
  superseded.** Reconciliation still finds what left the dataset in exactly the same way and still
  only ever acts on `gone`; what it does with the ids is now a tag rather than a delete. ADR-0006
  set the precedent for amending without superseding.
* Related: [ADR-0043](0043-holes-are-found-on-two-axes-and-healed-by-id.md) — the repair's single
  rewrite is where the tag is written in practice.
* Related: [ADR-0039](0039-the-last-two-months-are-published-in-a-tree-of-their-own-beside-a-counts-only-index.md)
  — the split classifies a tagged row exactly as it did before.
* Related: [ADR-0006](0006-search-index-and-detail-parquet-per-departement.md) — the layout is
  unchanged; both files gain one column and `index/` is untouched.
