---
status: accepted
date: 2026-09-10
area: data plane
supersedes:
superseded-by:
---

# ADR-0014 — The resume cursor has a shelf life, so the load is idempotent on `numero_dpe`

**Status:** accepted · **Decided:** 2026-09-10 · **Area:** data plane

## Context and Problem Statement

The national ingest is resumable at page granularity: `ingest_departement` stores the server's own
`Link: rel=next` token so a killed run restarts mid-département instead of re-downloading it. That
worked for three days. On 2026-09-10, a run resumed from a cursor stored on 2026-09-07 and died
after 80 000 clean rows:

```
  30:  150,000/157,573 ( 95.2%)    875 rows/s
sqlite3.IntegrityError: UNIQUE constraint failed: dpe.numero_dpe
```

The cursor is an `after` token — a *position* in a sort order, not an identity. ADEME kept
publishing while the run was dead: département 30 went from **157 179 rows to 157 573**. Rows
inserted ahead of the stored position shift everything behind it, and the resume re-serves
certificates that are already loaded. Nothing in the response says so.

This is not ADEME serving duplicates. Pulling the whole département with `select=numero_dpe` —
about 15 B a row, so 2.4 MB for the lot — returns **157 573 rows and 157 573 distinct numéros**. The
duplication is entirely an artefact of resuming across a change.

## Decision Drivers

* A 15-hour unattended job will be interrupted, and every interruption ages its cursor.
* The failure has two faces depending on when it is met, and the *quiet* one is worse. The database
  that crashed had `ux_dpe_numero` left over from an earlier `finalise`, so the duplicate raised
  immediately. On a database where the index is still deferred, the second copy inserts **silently**
  and `finalise` fails hours later, building that index over 15M rows.
* Deleting and re-fetching a partially loaded département is possible but wasteful, and requires
  identifying its rows — which the schema does not make cheap before the indexes exist.
* ADR-0005's restraint still binds: one polite stream, no re-downloading what is already held
  without a reason.

## Considered Options

* Detect a stale cursor (`total_expected` changed) and reload the département from scratch
* Make the load idempotent on `numero_dpe`, so an overlapping page is a no-op
* Store a `first_dpe_id` per département and delete the partial load by rowid range

## Decision Outcome

Chosen option: **"idempotent on `numero_dpe`"**.

`Loader.__init__` creates `ux_dpe_numero` before the load, and the certificate insert becomes
`ON CONFLICT(numero_dpe) DO NOTHING RETURNING dpe_id`. When nothing comes back the certificate is
already held, so its seven child tables are skipped with it and the row is counted as seen — because
`rows_loaded` exists to advance the cursor's bookkeeping, and counting only *new* rows would make a
resumed département look permanently incomplete and re-fetch it forever.

The first option detects the problem but does not make the recovery cheap; the third makes recovery
cheap but leaves the silent-duplicate window open on any path that is not a clean restart.
Idempotence closes the window itself, which is the only one of the three that also holds when the
weekly delta re-serves a certificate it has already merged.

### The index this moves, and why that is not a reversal

`ddl.indexes_ddl()` exists because creating indexes up front makes every insert maintain a B-tree it
does not need yet, and `finalise` builds them afterwards in one bulk sort. That reasoning is
unchanged for the other five. `ux_dpe_numero` is now the single exception: it is the index the load
*itself* depends on, and it is built at load time or the load cannot tell a duplicate from a new
row. `finalise` still declares it — `CREATE UNIQUE INDEX IF NOT EXISTS` is idempotent — so a
database built by any other path still ends up with it.

### Consequences

* Good, because a resumed département is now safe to restart from the beginning: the rows already
  held cost one index probe each instead of a crash, and a stale cursor stops being a data hazard.
* Good, because the duplicate can no longer arrive silently and surface at `finalise`, hours later.
* Bad, because every insert now maintains one more B-tree for the whole 15.5M-row load. The index
  was going to be built anyway; this pays for it incrementally rather than in one sort, which is the
  slower way round.
* Neutral, because `finalise` is correspondingly cheaper: it finds the index already there.

### Confirmation

`tests/test_resume_overlap.py`, four assertions against the shape of the real failure — an
overlapping page does not duplicate the certificate, does not duplicate its children, does not
corrupt the copy already held, and still counts every row the server handed over. Reverting the
change fails the first with `assert 4 == 3`: the duplicate inserted, silently, exactly as it would
on a clean build.

`tests/test_finalise.py::test_builds_indexes_and_records_the_row_count` now asserts both halves of
the split — that `ix_dpe_adresse` is still absent before `finalise`, so the deferral is intact, and
that `ux_dpe_numero` is already there, so the exception is deliberate rather than drift.

## More Information

* Related: [ADR-0005](0005-base-built-locally-ci-does-deltas.md),
  [ADR-0010](0010-commune-deduplicates-on-the-whole-tuple.md)
