---
status: proposed
date: YYYY-MM-DD
area: 
supersedes: 
superseded-by: 
---

# ADR-NNNN — {short title, naming the problem AND the solution}

**Status:** proposed · **Decided:** YYYY-MM-DD · **Area:** {data plane | app plane | identity | security |
encoding | performance | deployment | frontend | testing |
tooling}

## Context and Problem Statement

{Two to four sentences, or a short story. What forced a decision? Name the
components involved. If a defect prompted it, say what the symptom was.}

## Decision Drivers

* {a quality attribute, constraint or force — one line each}
* {…}

## Considered Options

* {option 1}
* {option 2}
* {option 3}

## Decision Outcome

Chosen option: **"{option 1}"**, because {the justification, in one or two
sentences — ideally naming the driver it resolves that the others do not}.

{Any detail the decision itself needs: a table, the shape of the thing chosen.}

### Consequences

* Good, because {…}
* Bad, because {…}
* Neutral, because {…}

### Confirmation

{How compliance is checked. Name the test file, the CI job, the assertion, or
the measurement. "Not automatically verified" is an acceptable — and useful —
answer.}

## Pros and Cons of the Options

<!-- Only when the rejected options are genuinely close. Delete otherwise. -->

### {option 2}

* Good, because {…}
* Bad, because {…}

## More Information

* Commits: `abcdef1`
* Related: `[ADR-NNNN](NNNN-slug.md)`

<!--
Rules for this directory, from https://adr.github.io/ :

  * ONE decision per record. If the title needs an "and", consider two records.
  * A record is IMMUTABLE once accepted. Superseding facts get a NEW record
    that links back; the old one changes only its status line and gains a
    `superseded-by`. A silently edited record destroys the log's whole value,
    which is showing how the system came to be its current shape.
  * Number sequentially and monotonically. Never reuse a number.
  * Worth a record: a new external dependency, a change in deployment topology,
    a data-model or identity change, or any choice that would be expensive to
    reverse. Not worth one: adding a utility function.
-->
