---
status: accepted
date: 2026-09-14
area: frontend
supersedes:
superseded-by:
---

# ADR-0037 — Search results on a Leaflet map over Plan IGN, outbound links to Google Maps

**Status:** accepted · **Decided:** 2026-09-14 · **Area:** frontend

## Context and Problem Statement

A search returns up to 50 certificates, each with coordinates (ADR-0011), shown
only as a list. Where they sit relative to each other is exactly what a person
matching an advert wants to see: ten addresses in one commune say little, ten
dots on a street map say which one fronts the park. Each result also linked out
to OpenStreetMap, which is not the map most people then use to look at the
street.

Showing a map in the page means a map library and a tile server, and tiles are
fetched by the viewer's browser from a third party.

## Decision Drivers

* No API key, billing account or quota to manage for a small private product.
* One component; no framework wrapper to keep in step with React.
* Markers must carry the DPE class colour, the product's whole vocabulary.
* The basemap should recede so the coloured markers read.
* Tests must not depend on a third party being reachable.

## Considered Options

* Leaflet, used directly, over Plan IGN tiles shown in grey
* Leaflet over CARTO Positron tiles
* react-leaflet over Leaflet
* A Google Maps JavaScript API embed

## Decision Outcome

Chosen option: **"Leaflet, used directly, over Plan IGN tiles shown in grey"**,
because it is the smallest dependency that draws coloured markers over raster
tiles, and Plan IGN is the one light basemap measured to serve clean tiles with
no key.

| | |
|---|---|
| Library | `leaflet` (runtime), `@types/leaflet` (dev), in `src/search/ResultsMap.tsx` |
| Tiles | Géoplateforme WMTS, layer `GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2`, matrix set `PM` |
| Grey | CSS `filter: grayscale(1)` on `.leaflet-tile-pane` only, so markers keep colour |
| Attribution | © IGN – Plan IGN, shown in the map corner |
| Markers | `L.circleMarker` filled with the class colour — SVG, no icon images |
| Outbound links | `https://www.google.com/maps/search/?api=1&query=lat,lon` |

Plan IGN is published by the French state as open data on the Géoplateforme
(`data.geopf.fr`), with no key for this layer. It covers France and its overseas
départements, which is everywhere a DPE exists; beyond them the basemap is
blank.

Circle markers rather than Leaflet's default pin: the pin is a PNG that Vite
rewrites to a path Leaflet cannot find, and a pin cannot carry the class colour
anyway.

The Google Maps links are plain Maps URLs, the documented format that needs no
key. Nothing from Google loads until somebody clicks.

### Consequences

* Good, because the results can be read as a place, and a marker's popup opens
  the record.
* Good, because there is no key, no secret and no billing.
* Bad, because every signed-in viewer's browser sends the map's viewport, and
  therefore roughly where they are house-hunting, to IGN. The data itself is
  public; the interest is not. Accepted for a small private product.
* Bad, because the Géoplateforme is a public service under fair use with no SLA.
  If it goes, the markers still draw and only the basemap is blank; the tile
  URL is one constant.
* Neutral, because Leaflet adds about 40 kB gzipped to the bundle.

### Confirmation

`test/e2e/search.spec.ts`: "the results are on a map" counts one marker per
result, opens a record from a popup, and checks that tiles were requested from
`data.geopf.fr`, every one answered by a local pixel so the run never reaches
the network. "a result links to Google Maps at real coordinates" checks the host
and that the coordinates are in Ariège.

## Pros and Cons of the Options

### Leaflet over CARTO Positron tiles

The first choice, for its grey basemap.

* Bad, because on 2026-09-14 every keyless tile from
  `{s}.basemaps.cartocdn.com/light_all` came back stamped "API KEY REQUIRED",
  whatever the Referer (none, `localhost`, the preview host). It now needs a
  CARTO account and a key shipped to the browser.

### react-leaflet over Leaflet

* Good, because markers become JSX.
* Bad, because it is a second dependency pinned to React's major version, for
  one component with one effect.

### A Google Maps JavaScript API embed

* Good, because the map would match the outbound links.
* Bad, because it needs an API key, a billing account, and a key restricted to
  every preview host, which change per branch (ADR-0036).

## More Information

* Related: [ADR-0011](0011-overseas-coordinates-are-published-as-null.md)
