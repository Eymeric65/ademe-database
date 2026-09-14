import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useEffect, useRef } from 'react'
import type { Hit } from '../data/sources'
import { detailHref } from '../routes'

// see ADR-0037
const TILES =
  'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0' +
  '&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&TILEMATRIXSET=PM' +
  '&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/png'
const ATTRIBUTION = '&copy; <a href="https://www.ign.fr/">IGN</a> – Plan IGN'

/** The badge's own colour, read from the stylesheet so there is one ramp. */
function colour(letter: string | null): string {
  const value = letter
    ? getComputedStyle(document.documentElement).getPropertyValue(`--dpe-${letter.toLowerCase()}`).trim()
    : ''
  return value || '#9e9e9e'
}

/** One marker per result that has coordinates; its popup opens the record. */
export function ResultsMap({ hits }: { hits: Hit[] }) {
  const container = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map | null>(null)
  const layer = useRef<L.FeatureGroup | null>(null)

  useEffect(() => {
    const el = container.current
    if (!el) return
    const m = L.map(el, { scrollWheelZoom: false }).setView([46.6, 2.4], 5)
    L.tileLayer(TILES, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(m)
    const group = L.featureGroup().addTo(m)
    map.current = m
    layer.current = group
    // TRAP: Leaflet measures its container once. The search is hidden while a
    // record is open and the layout switches columns at a breakpoint, and a
    // map sized while hidden draws one grey tile in a corner until resized.
    let fitted = false
    const observer = new ResizeObserver(() => {
      if (!el.offsetWidth) return
      m.invalidateSize()
      if (!fitted && group.getLayers().length) {
        m.fitBounds(group.getBounds(), { padding: [24, 24], maxZoom: 17 })
        fitted = true
      }
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      m.remove()
      map.current = null
      layer.current = null
    }
  }, [])

  useEffect(() => {
    const m = map.current
    const group = layer.current
    if (!m || !group) return
    group.clearLayers()
    for (const hit of hits) {
      if (hit.lat == null || hit.lon == null) continue
      // Built as nodes, not an HTML string: the address is somebody's data.
      const popup = document.createElement('div')
      const link = popup.appendChild(document.createElement('a'))
      link.href = detailHref(hit)
      link.textContent = hit.address ?? hit.key
      if (hit.commune) popup.appendChild(document.createElement('div')).textContent = hit.commune
      L.circleMarker([hit.lat, hit.lon], {
        radius: 8,
        weight: 1.5,
        color: '#1f1f1f',
        fillColor: colour(hit.classe),
        fillOpacity: 0.95,
      })
        .bindPopup(popup)
        .addTo(group)
    }
    if (group.getLayers().length && m.getContainer().offsetWidth) {
      m.fitBounds(group.getBounds(), { padding: [24, 24], maxZoom: 17 })
    }
  }, [hits])

  return <div ref={container} className="results-map" />
}
