import { useEffect, useState } from 'react'
import { api } from '../api'
import { buildings, detail, type Building, type Record_ } from '../data/duck'
import { formatDate, SOURCE, type Source } from '../data/sources'
import type { DetailRef } from '../routes'
import { area, Badge } from '../search/Results'
import { field, formatValue } from './fields'

type Saved = { id: string; numeroDpe: string; source?: string }

/** Values arrive from Arrow as numbers, strings, BigInts and epoch days. */
function render(value: unknown, encoding?: string): string {
  if (value == null) return ''
  if (encoding === 'date' || value instanceof Date) return formatDate(value)
  if (typeof value === 'bigint') return value.toString()
  return String(value)
}

/**
 * The ETL's own grouping of the columns, which is the only one that means
 * anything. It travels in the manifest's column_meta; grouping on the column
 * NAME instead produced dozens of one-item groups called "annee" and "apport".
 */
const GROUPS: Record<string, string> = {
  dpe: 'Le certificat',
  adresse: 'Adresse',
  commune: 'Commune',
  dpe_adresse_brut: 'Adresse avant géocodage',
  dpe_installation_chauffage: 'Installations de chauffage',
  dpe_generateur_chauffage: 'Générateurs de chauffage',
  dpe_installation_ecs: 'Installations d’eau chaude',
  dpe_generateur_ecs: 'Générateurs d’eau chaude',
  dpe_bilan_energie: 'Bilan par énergie',
  dpe_energie: 'Consommation par énergie',
}

const ORDER = Object.keys(GROUPS)
const title = (group: string) => GROUPS[group] ?? group.replace(/^dpe_/, '').replace(/_/g, ' ')

export function Detail({ record }: { record: DetailRef }) {
  const src = SOURCE[record.source]
  const [rec, setRec] = useState<Record_ | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<Saved | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    let live = true
    setRec(undefined)
    setError(null)
    detail(record)
      .then((r) => live && setRec(r))
      // An unreachable data plane must say so, not wait forever.
      .catch((err) => live && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      live = false
    }
  }, [record])

  useEffect(() => {
    void api
      .get<Saved[]>('/api/buildings')
      .then((rows) =>
        setSaved(
          rows.find(
            (r) => r.numeroDpe === record.key && (r.source ?? 'existant') === record.source,
          ) ?? null,
        ),
      )
      .catch(() => setSaved(null))
  }, [record])

  if (error) return <p className="error">Les données sont indisponibles : {error}</p>
  if (rec === undefined) return <p className="lede">Chargement…</p>
  if (rec === null) return <p className="lede">Introuvable dans {src.label.toLowerCase()}.</p>

  const row = rec.row
  const address = render(row.adresse_ban) || record.key

  async function toggle() {
    setBusy(true)
    try {
      if (saved) {
        await api.del(`/api/buildings/${saved.id}`)
        setSaved(null)
      } else {
        setSaved(
          await api.post<Saved>('/api/buildings', {
            numeroDpe: record.key,
            source: record.source,
            // The partition it was read from: an audit has no other way back.
            dept: rec?.dept,
          }),
        )
      }
    } finally {
      setBusy(false)
    }
  }

  const surface = row[src.surface.col] == null ? null : Number(row[src.surface.col])
  const summary: [string, string][] = (
    [
      ['Commune', [row.code_postal_ban, row.nom_commune_ban].filter(Boolean).join(' ')],
      [src.surface.label.replace(/ \(m²\)$/, ''), surface != null && Number.isFinite(surface) ? area(surface) : ''],
      [src.id === 'audit' ? 'Date de l’audit' : 'Date du diagnostic', formatDate(row[src.dateCol])],
      ...(src.id === 'audit'
        ? ([
            ['Audit', render(row.n_audit)],
            ['Étape', render(row.etape_travaux)],
            ['Scénario', render(row.categorie_scenario)],
          ] as [string, string][])
        : ([[src.choices[0]?.label ?? '', render(row[src.kindCol])]] as [string, string][])),
    ] as [string, string][]
  ).filter(([, v]) => v)

  const groups = new Map<string, [string, unknown][]>()
  for (const [key, value] of Object.entries(row)) {
    if (value == null || value === '') continue
    const group = rec.meta[key]?.destination ?? 'dpe'
    const list = groups.get(group) ?? []
    list.push([key, value])
    groups.set(group, list)
  }
  const rank = (g: string) => (ORDER.includes(g) ? ORDER.indexOf(g) : ORDER.length)
  const ordered = [...groups.entries()].sort((a, b) => rank(a[0]) - rank(b[0]))

  const explain = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (!next.delete(key)) next.add(key)
      return next
    })

  return (
    <section>
      <p className="eyebrow">{src.label}</p>
      <h1>{address}</h1>
      <p className="lede">{record.key}</p>

      <div className="summary">
        <div className="hit-labels">
          <Badge letter={row[src.classCol] == null ? null : String(row[src.classCol])} />
          <Badge letter={row[src.gesCol] == null ? null : String(row[src.gesCol])} />
        </div>
        <dl className="summary-facts">
          {summary.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        {/* Vermilion, not the page's blue: a seal is what marks a document as
            yours, which is exactly what this button does. */}
        <button type="button" className="signin seal" onClick={() => void toggle()} disabled={busy}>
          {saved ? 'Retirer' : 'Enregistrer'}
        </button>
      </div>

      <Buildings src={src} record={record} rec={rec} />

      {ordered.map(([group, entries]) => (
        <div key={group} className="group">
          <h2>{title(group)}</h2>
          <dl className="facts">
            {entries.map(([key, value]) => {
              const f = field(key)
              const shown = open.has(key)
              return (
                <div key={key} className="fact" data-key={key}>
                  <dt title={key}>
                    {f.label}
                    {f.hint ? (
                      <button
                        type="button"
                        className="fact-info"
                        aria-expanded={shown}
                        aria-label={`Explication : ${f.label}`}
                        onClick={() => explain(key)}
                      >
                        ⓘ
                      </button>
                    ) : null}
                  </dt>
                  <dd>{formatValue(key, value, rec.meta[key]?.encoding, row)}</dd>
                  {shown ? (
                    <dd className="fact-hint">
                      {f.hint} <span className="fact-key">Colonne ADEME : <code>{key}</code></span>
                    </dd>
                  ) : null}
                </div>
              )
            })}
          </dl>
        </div>
      ))}
    </section>
  )
}

/**
 * The building and the parcels, loaded after the facts: four more files, and
 * nobody should wait for them to read the certificate.
 */
function Buildings({ src, record, rec }: { src: Source; record: DetailRef; rec: Record_ }) {
  const [list, setList] = useState<Building[] | null | undefined>(undefined)

  useEffect(() => {
    let live = true
    setList(undefined)
    buildings(src, record.key, rec)
      .then((l) => live && setList(l))
      .catch(() => live && setList(null))
    return () => {
      live = false
    }
  }, [src, record.key, rec])

  return (
    <div className="group building">
      <h2>Bâtiment et parcelle</h2>
      {list === undefined ? (
        <p className="hint">Recherche du bâtiment…</p>
      ) : list === null ? (
        <p className="hint">Le référentiel des bâtiments est indisponible.</p>
      ) : !list.length ? (
        <p className="hint">Aucun bâtiment n’est rattaché à cet enregistrement.</p>
      ) : (
        <ul className="buildings">
          {list.map((b) => (
            <li key={b.rnbId} className="bldg">
              <p className="bldg-head">
                <a
                  className="bldg-id"
                  href={`https://rnb.beta.gouv.fr/carte?q=${encodeURIComponent(b.rnbId)}`}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {b.rnbId}
                </a>
                <span className="hint">
                  {b.method === 'id_rnb'
                    ? 'Identifiant RNB du diagnostic'
                    : b.candidates && b.candidates > 1
                      ? `Par l’adresse : ${b.candidates} bâtiments possibles`
                      : 'Par l’adresse'}
                </span>
              </p>
              {b.addresses.length ? <p className="hit-meta">{b.addresses.join(' · ')}</p> : null}
              {b.point ? (
                <a
                  className="hit-map"
                  href={`https://www.openstreetmap.org/?mlat=${b.point.lat}&mlon=${b.point.lon}#map=19/${b.point.lat}/${b.point.lon}`}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  Le bâtiment sur la carte
                </a>
              ) : null}
              {b.parcels.length ? (
                <div className="parcels-wrap">
                  <table className="parcels">
                    <thead>
                      <tr>
                        <th>Parcelle</th>
                        <th>Section</th>
                        <th>Numéro</th>
                        <th>Contenance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {b.parcels.map((p) => (
                        <tr key={p.id}>
                          <td>{p.id}</td>
                          <td>{p.section}</td>
                          <td>{p.numero}</td>
                          <td>{p.contenance != null ? area(p.contenance) : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
