"""Data Fair client for the ADEME DPE dataset.

Rows come back as CSV, not JSON: measured 2 012 B/row against ~13x that for
JSON, and over 15.5M rows that is the difference between a 31 GB download and a
far worse one.

Paging follows the server's own `Link: <...>; rel=next` header, which the CSV
response carries even though the CSV body obviously cannot. The `after` token
is a compound sort key (`<_i>,<seq>`), so it is followed verbatim -- an earlier
attempt to rebuild it from the last `_i` was rejected by the server.
"""

from __future__ import annotations

import csv
import io
import re
import time
from collections.abc import Iterator
from dataclasses import dataclass

import httpx

from ademe import spec
from ademe.config import API, API_KEY, PAGE_SIZE

_NEXT = re.compile(r'<([^>]+)>\s*;\s*rel="?next"?', re.I)

RETRIES = 5
BACKOFF = 3.0
TIMEOUT = httpx.Timeout(connect=30.0, read=300.0, write=30.0, pool=30.0)


class ApiError(RuntimeError):
    pass


@dataclass
class Page:
    rows: list[dict[str, str]]
    next_url: str | None
    nbytes: int


def _get(client: httpx.Client, url: str, params: dict | None = None) -> httpx.Response:
    last: Exception | None = None
    for attempt in range(1, RETRIES + 1):
        try:
            r = client.get(url, params=params)
            # 429/5xx are worth waiting out; 4xx otherwise is our bug.
            if r.status_code in (429, 500, 502, 503, 504):
                raise ApiError(f"HTTP {r.status_code}")
            r.raise_for_status()
            return r
        except (httpx.TransportError, httpx.HTTPStatusError, ApiError) as exc:
            last = exc
            if attempt == RETRIES:
                break
            # Linear, not exponential: the server is slow rather than hostile,
            # and this runs unattended for hours -- a doubling backoff would
            # stall the whole load on one blip.
            time.sleep(BACKOFF * attempt)
    raise ApiError(f"{url}: giving up after {RETRIES} attempts ({last})")


def _departement_qs(code: str) -> str:
    return f'code_departement_ban:"{code}"'


def total(
    client: httpx.Client, *, departement: str | None = None, qs: str | None = None
) -> int:
    params: dict = {"size": 0}
    if departement:
        params["qs"] = _departement_qs(departement)
    elif qs:
        params["qs"] = qs
    return _get(client, f"{API}/lines", params).json()["total"]


def values(client: httpx.Client, field: str, size: int = 1000) -> list[str]:
    """Distinct values for a field, without scanning rows.

    Returns [] for free-text fields: the endpoint declines to enumerate
    anything that is not keyword-indexed, which is precisely how the closed
    vocabularies are told apart from the open dictionaries.
    """
    try:
        r = _get(client, f"{API}/values/{field}", {"size": size})
        got = r.json()
        return got if isinstance(got, list) else []
    except ApiError:
        return []


def page(client: httpx.Client, url: str, params: dict | None = None) -> Page:
    r = _get(client, url, params)
    body = r.content
    text = body.decode("utf-8-sig")
    raw = list(csv.DictReader(io.StringIO(text))) if text.strip() else []
    # Headers are labels; callers want schema keys.
    rows = [spec.rename_row(r) for r in raw]
    m = _NEXT.search(r.headers.get("link", ""))
    return Page(rows=rows, next_url=m.group(1) if m else None, nbytes=len(body))


def iter_pages(
    client: httpx.Client,
    *,
    departement: str | None = None,
    qs: str | None = None,
    select: list[str] | None = None,
    start_url: str | None = None,
    page_size: int = PAGE_SIZE,
) -> Iterator[Page]:
    """Yield pages of rows. Resume by passing a previously stored `next_url`.

    `departement=` is sugar for the equivalent `qs`; the weekly delta needs an
    arbitrary filter (a range over the modification date) rather than one more
    named argument per query shape.

    `select=` narrows the columns. Reconciliation pulls `numero_dpe` alone --
    about 15 B a row against ~2 kB for the whole record, which is the
    difference between eight minutes and a day.
    """
    if start_url:
        url, params = start_url, None
    else:
        url = f"{API}/lines"
        params = {"size": page_size, "format": "csv", "sort": "_i"}
        if departement:
            params["qs"] = _departement_qs(departement)
        elif qs:
            params["qs"] = qs
        if select:
            params["select"] = ",".join(select)

    while True:
        p = page(client, url, params)
        if not p.rows:
            return
        yield p
        if not p.next_url:
            return
        url, params = p.next_url, None


def client() -> httpx.Client:
    headers = {"user-agent": "ademe-database/0.1 (local research build)"}
    if API_KEY:
        # `x-apiKey` is what the server's own OpenAPI declares; see ADR-0013,
        # and `test_api_key.py::test_the_server_still_documents_this_header`.
        headers["x-apiKey"] = API_KEY
    return httpx.Client(timeout=TIMEOUT, follow_redirects=True, headers=headers)


# Documented on https://data.ademe.fr/pages/faq, in kB/s of dynamic response.
ANON_KBPS = 500
AUTH_KBPS = 1000


def measure(page_size: int = PAGE_SIZE) -> float:
    """kB/s on one page, at the size the ingest actually uses."""
    cl = client()
    url = f"{API}/lines"
    params = {"size": page_size, "format": "csv", "sort": "_i"}
    t0 = time.monotonic()
    p = page(cl, url, params)
    return p.nbytes / 1000 / max(time.monotonic() - t0, 1e-9)


def main(argv: list[str] | None = None) -> int:
    """`python -m ademe.api` -- is the key doing anything?

    TRAP: this server does not reject an `x-apiKey` it has never seen. It
    answers 200 and quietly applies the anonymous limits, so a typo is
    invisible until the run that was meant to take nine hours takes eighteen.
    Nothing in the response says which budget you are on. Measuring is the
    only honest test, and one page is enough because the cap is a sustained
    rate rather than a burst.
    """
    print("ADEME_API_KEY:", "set" if API_KEY else "not set (anonymous)")
    rate = measure()
    print(f"measured: {rate:,.0f} kB/s on one page of {PAGE_SIZE:,} rows")
    midpoint = (ANON_KBPS + AUTH_KBPS) / 2
    if rate >= midpoint:
        print(f"-> authenticated limits (~{AUTH_KBPS} kB/s). The key is live.")
        return 0
    print(
        f"-> anonymous limits (~{ANON_KBPS} kB/s).",
        "The key is not being honoured -- check it was copied whole."
        if API_KEY
        else "Set ADEME_API_KEY to double this.",
    )
    return 0 if not API_KEY else 1


if __name__ == "__main__":
    raise SystemExit(main())
