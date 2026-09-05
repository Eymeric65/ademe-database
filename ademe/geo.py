"""Lambert-93 (EPSG:2154) to WGS84.

The source carries `coordonnee_cartographique_x_ban` / `_y_ban` in Lambert-93.
The browser needs degrees, so the projection has to be inverted somewhere.

It is done here, in closed form, rather than through DuckDB's `spatial`
extension or pyproj. Three reasons, recorded in ADR-0006:

  - No runtime download. `INSTALL spatial` fetches a binary at first use, which
    makes the offline test suite depend on the network -- and CLAUDE.md section
    3 is explicit that a skip is not a pass.
  - It is checkable. `tests/test_geo.py` compares this against ADEME's own
    `_geopoint` for real certificates; agreement is ~1e-13 degrees, which is
    double-precision exact and eight orders of magnitude inside the 1e-5 the
    data plane needs.
  - It is thirty lines of closed-form arithmetic with no state.

Formulas: Lambert Conformal Conic 2SP, GRS80. Parameters are IGN's published
EPSG:2154 definition.
"""

from __future__ import annotations

from math import atan, atan2, cos, log, pi, sin, sqrt, tan

# GRS80.
_A = 6378137.0
_F = 1 / 298.257222101
_E = sqrt(2 * _F - _F * _F)

# EPSG:2154.
_LAT0, _LON0 = 46.5, 3.0
_LAT1, _LAT2 = 44.0, 49.0
_X0, _Y0 = 700000.0, 6600000.0


def _m(phi: float) -> float:
    return cos(phi) / sqrt(1 - _E * _E * sin(phi) ** 2)


def _t(phi: float) -> float:
    return tan(pi / 4 - phi / 2) / ((1 - _E * sin(phi)) / (1 + _E * sin(phi))) ** (_E / 2)


_p0, _p1, _p2 = (x * pi / 180 for x in (_LAT0, _LAT1, _LAT2))
_N = (log(_m(_p1)) - log(_m(_p2))) / (log(_t(_p1)) - log(_t(_p2)))
_FC = _m(_p1) / (_N * _t(_p1) ** _N)
_R0 = _A * _FC * _t(_p0) ** _N

# The latitude series converges in about five rounds at French latitudes;
# fifteen is free and removes the question.
_ITERATIONS = 15


def to_wgs84(x: float, y: float) -> tuple[float, float]:
    """(lat, lon) in degrees for a Lambert-93 easting/northing in metres."""
    dx = x - _X0
    dy = _R0 - (y - _Y0)
    r = sqrt(dx * dx + dy * dy) * (1 if _N > 0 else -1)
    theta = atan2(dx, dy)
    t = (r / (_A * _FC)) ** (1 / _N)

    phi = pi / 2 - 2 * atan(t)
    for _ in range(_ITERATIONS):
        phi = pi / 2 - 2 * atan(t * ((1 - _E * sin(phi)) / (1 + _E * sin(phi))) ** (_E / 2))

    return phi * 180 / pi, (theta / _N + _LON0 * pi / 180) * 180 / pi


# The projection is metropolitan France's, and only metropolitan France's. The
# overseas departements use local UTM zones -- 20N for the Antilles, 22N for
# Guyane, 40S for Reunion and Mayotte -- and 975/977/978 their own again.
#
# TRAP: to_wgs84 does not fail on those coordinates. It returns a plausible
# number that is thousands of kilometres wrong, which is precisely what ADEME's
# own `_geopoint` does: Reunion comes out in Scotland and Mayotte in Norway.
# Reproducing that would be lossless and useless, so the coordinate is dropped
# instead. See ADR-0011.
OVERSEAS_PREFIX = "97"


def is_lambert93(dept: str) -> bool:
    """True when this departement's coordinates really are EPSG:2154."""
    return not str(dept).startswith(OVERSEAS_PREFIX)


def wgs84_for(dept: str, x: float | None, y: float | None) -> tuple[float | None, float | None]:
    """(lat, lon) for a certificate, or (None, None) where it cannot be known.

    A pin on the wrong continent is worse than no pin: it is indistinguishable
    from a correct one until somebody opens the map.
    """
    if x is None or y is None or not is_lambert93(dept):
        return None, None
    lat, lon = to_wgs84(x, y)
    return round(lat, 6), round(lon, 6)
