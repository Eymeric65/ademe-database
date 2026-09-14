import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { isSource, SOURCE } from '../data/sources'
import { detailHref } from '../routes'

type SavedBuilding = {
  id: string
  numeroDpe: string
  source: string
  dept: string | null
  note: string | null
  createdAt: number
}

export function Saved({ signedIn }: { signedIn: boolean }) {
  const [rows, setRows] = useState<SavedBuilding[] | undefined>(undefined)

  const refresh = useCallback(async () => {
    if (!signedIn) return setRows([])
    try {
      setRows(await api.get<SavedBuilding[]>('/api/buildings'))
    } catch {
      setRows([])
    }
  }, [signedIn])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (!signedIn) {
    return (
      <section>
        <h1>Enregistrés</h1>
        <p className="lede">Connectez-vous pour retrouver vos certificats.</p>
      </section>
    )
  }
  if (rows === undefined) return <p className="lede">Chargement…</p>

  return (
    <section>
      <h1>Enregistrés</h1>
      {rows.length === 0 ? (
        <p className="lede">Aucun certificat enregistré. Lancez une recherche pour commencer.</p>
      ) : (
        <ul className="hits">
          {rows.map((row) => {
            const source = isSource(row.source) ? row.source : 'existant'
            return (
              <li key={row.id} className="hit">
                <div className="hit-body">
                  <p className="hit-address">
                    <a href={detailHref({ source, key: row.numeroDpe, dept: row.dept })}>
                      {row.numeroDpe}
                    </a>
                  </p>
                  <p className="hit-meta">
                    {[SOURCE[source].label, row.note].filter(Boolean).join(' · ')}
                  </p>
                </div>
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    void api.del(`/api/buildings/${row.id}`).then(refresh)
                  }}
                >
                  Retirer
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
