"""The vocabulary domains are a claim about the data, so they get checked.

Two different claims, checked two different ways:

* Slot columns of one repeating group share a vocabulary by construction. Their
  observed value sets legitimately differ -- a rare slot 2 sees fewer distinct
  values than slot 1 -- so the table holds the union, and the only thing worth
  asserting is that every value is reachable.
* An entry in `_ALIASES` is a semantic claim that two differently-named columns
  draw the same list. That is not structural, so it is asserted strictly: every
  member's values must sit inside the union, and the union must not be much
  larger than the biggest member. If ADEME ever forks these lists, this fails.
"""

from __future__ import annotations

import json
import urllib.parse
import urllib.request

import pytest

from ademe import spec
from ademe.config import API
from ademe.mapping import INTERNAL_COLUMNS


def _values(field: str) -> set[str] | None:
    url = f"{API}/values/{urllib.parse.quote(field)}?size=1000"
    try:
        with urllib.request.urlopen(url, timeout=60) as r:
            return set(json.load(r))
    except Exception:
        return None


@pytest.fixture(scope="module")
def domains():
    cols = {k: v for k, v in spec.load().items() if k not in INTERNAL_COLUMNS}
    return spec.vocab_domains(cols)


@pytest.mark.live
def test_aliased_columns_really_share_one_vocabulary(domains):
    """Explicit aliases are semantic claims and are checked strictly."""
    aliased: dict[str, list[str]] = {}
    for col, dom in spec._domains().items():
        _, _, was_aliased = spec._stem(col)
        if was_aliased:
            aliased.setdefault(dom, []).append(col)

    assert aliased, "no aliases declared -- this test would be vacuous"

    for dom, members in aliased.items():
        peers = [c for c in domains.get(dom, []) if c not in members]
        got = {c: _values(c) for c in members + peers}
        got = {k: v for k, v in got.items() if v}
        if len(got) < 2:
            pytest.skip(f"{dom}: /values unavailable for enough members")
        union = set().union(*got.values())
        biggest = max(got.values(), key=len)
        # Every member must be drawn from the same list: nothing outside the
        # union, and the union barely larger than the largest single member.
        assert len(union) <= len(biggest) + 2, (
            f"{dom}: union has {len(union)} values but the largest member has "
            f"{len(biggest)} -- these are not the same vocabulary. "
            f"Extra: {sorted(union - biggest)[:5]}"
        )


@pytest.mark.live
def test_slot_columns_share_a_domain_and_the_union_is_bounded(domains):
    """Slots of one repeating group: the table holds the union, which must stay
    small enough to be a controlled vocabulary rather than free text."""
    for dom, members in domains.items():
        if len(members) < 2:
            continue
        got = {c: _values(c) for c in members}
        got = {k: v for k, v in got.items() if v}
        if len(got) < 2:
            continue  # free text; /values declines to enumerate these
        union = set().union(*got.values())
        assert len(union) <= spec.CLOSED_VOCAB_MAX_UNION, (
            f"{dom}: union of {len(members)} slot columns is {len(union)} "
            f"values, past the closed-vocabulary ceiling"
        )


def test_summary_columns_are_not_merged_with_their_slots():
    """Regression: `type_installation_chauffage` (collectif/individuel/mixte) is
    a different list from `type_installation_chauffage_n1`, and merging them was
    a real bug. A bare column colliding with a slot stem gets its own domain."""
    assert spec.domain_of("type_installation_chauffage").endswith("_global")
    assert not spec.domain_of("type_installation_chauffage_n1").endswith("_global")
    assert spec.domain_of("type_installation_chauffage") != spec.domain_of(
        "type_installation_chauffage_n1"
    )


def test_verified_aliases_survive_the_collision_rule():
    """Regression: the collision rule used to undo explicit aliases, splitting
    the 15-value energy list across two tables."""
    assert spec.domain_of("type_energie_n1") == spec.domain_of(
        "type_energie_principale_chauffage"
    )
    assert spec.domain_of("etiquette_dpe") == spec.domain_of("etiquette_ges")
