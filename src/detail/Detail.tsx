import { useEffect, useState } from 'react'
import { api } from '../api'
import { detail, manifest } from '../data/duck'

type Saved = { id: string; numeroDpe: string }

/** Values arrive from Arrow as Decimals, Dates and BigInts. */
function render(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'object') return String(value)
  return String(value)
}

/**
 * The ETL's own grouping of the 226 columns, which is the only one that means
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
}

const ORDER = Object.keys(GROUPS)

export function Detail({ numero }: { numero: string }) {
  const [row, setRow] = useState<Record<string, unknown> | null | undefined>(undefined)
  const [meta, setMeta] = useState<Record<string, { destination: string }>>({})
  const [saved, setSaved] = useState<Saved | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    void detail(numero).then((r) => live && setRow(r))
    void manifest().then((m) => live && setMeta(m.column_meta ?? {}))
    return () => {
      live = false
    }
  }, [numero])

  useEffect(() => {
    void api
      .get<Saved[]>('/api/buildings')
      .then((rows) => setSaved(rows.find((r) => r.numeroDpe === numero) ?? null))
      .catch(() => setSaved(null))
  }, [numero])

  if (row === undefined) return <p className="lede">Chargement du certificat…</p>
  if (row === null) return <p className="lede">Ce certificat est introuvable.</p>

  const address = render(row.adresse_ban) || numero

  async function toggle() {
    setBusy(true)
    try {
      if (saved) {
        await api.del(`/api/buildings/${saved.id}`)
        setSaved(null)
      } else {
        setSaved(await api.post<Saved>('/api/buildings', { numeroDpe: numero }))
      }
    } finally {
      setBusy(false)
    }
  }

  const groups = new Map<string, [string, unknown][]>()
  for (const [key, value] of Object.entries(row)) {
    if (value == null || value === '') continue
    const group = meta[key]?.destination ?? 'dpe'
    const list = groups.get(group) ?? []
    list.push([key, value])
    groups.set(group, list)
  }
  const ordered = [...groups.entries()].sort(
    (a, b) => ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]),
  )

  return (
    <section>
      <h1>{address}</h1>
      <p className="lede">{numero}</p>

      {/* Vermilion, not the page's blue: a seal is what marks a document as
          yours, which is exactly what this button does. */}
      <button type="button" className="signin seal" onClick={() => void toggle()} disabled={busy}>
        {saved ? 'Retirer' : 'Enregistrer'}
      </button>

      {ordered.map(([group, entries]) => (
        <div key={group} className="group">
          <h2>{GROUPS[group] ?? group}</h2>
          <dl className="facts">
            {entries.map(([key, value]) => (
              <div key={key} className="fact">
                <dt>{key}</dt>
                <dd>{render(value)}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </section>
  )
}
