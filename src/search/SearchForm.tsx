import { useState } from 'react'
import { CLASSES, isRunnable, type QuerySpec } from './spec'

/**
 * The facts an advert publishes, in the order an advert publishes them.
 *
 * Nothing is required on its own -- a listing is never complete. `isRunnable`
 * only asks for somewhere plus something, because a bare postcode would return
 * the whole partition and read as a broken search rather than a wide one.
 */
export function SearchForm({
  onSearch,
  busy,
}: {
  onSearch: (spec: QuerySpec) => void
  busy: boolean
}) {
  const [spec, setSpec] = useState<QuerySpec>({ surfaceTolerance: 5 })
  const set = <K extends keyof QuerySpec>(key: K, value: QuerySpec[K]) =>
    setSpec((s) => ({ ...s, [key]: value }))

  const ready = isRunnable(spec)

  return (
    <form
      className="search"
      onSubmit={(e) => {
        e.preventDefault()
        if (ready) onSearch(spec)
      }}
    >
      <div className="field">
        <label htmlFor="cp">Code postal</label>
        <input
          id="cp"
          inputMode="numeric"
          autoComplete="postal-code"
          value={spec.codePostal ?? ''}
          onChange={(e) => set('codePostal', e.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="commune">Commune</label>
        <input
          id="commune"
          value={spec.commune ?? ''}
          onChange={(e) => set('commune', e.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="dpe">Classe énergie</label>
        <select
          id="dpe"
          value={spec.etiquetteDpe ?? ''}
          onChange={(e) => set('etiquetteDpe', e.target.value || undefined)}
        >
          <option value="">Indifférent</option>
          {CLASSES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="ges">Classe climat</label>
        <select
          id="ges"
          value={spec.etiquetteGes ?? ''}
          onChange={(e) => set('etiquetteGes', e.target.value || undefined)}
        >
          <option value="">Indifférent</option>
          {CLASSES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="surface">Surface (m²)</label>
        <input
          id="surface"
          inputMode="decimal"
          value={spec.surface ?? ''}
          onChange={(e) =>
            set('surface', e.target.value === '' ? undefined : Number(e.target.value))
          }
        />
      </div>

      <div className="field">
        <label htmlFor="tol">Tolérance (± m²)</label>
        <input
          id="tol"
          inputMode="numeric"
          value={spec.surfaceTolerance ?? ''}
          onChange={(e) =>
            set('surfaceTolerance', e.target.value === '' ? undefined : Number(e.target.value))
          }
        />
      </div>

      <div className="field">
        <label htmlFor="mois">Mois du diagnostic</label>
        <input
          id="mois"
          type="month"
          value={spec.moisEtablissement ?? ''}
          onChange={(e) => set('moisEtablissement', e.target.value || undefined)}
        />
      </div>

      <div className="field">
        <label htmlFor="type">Type de bien</label>
        <select
          id="type"
          value={spec.typeBatiment ?? ''}
          onChange={(e) => set('typeBatiment', e.target.value || undefined)}
        >
          <option value="">Indifférent</option>
          <option value="maison">Maison</option>
          <option value="appartement">Appartement</option>
          <option value="immeuble">Immeuble</option>
        </select>
      </div>

      <div className="actions">
        <button type="submit" className="signin" disabled={!ready || busy}>
          {busy ? 'Recherche…' : 'Rechercher'}
        </button>
        {!ready ? (
          <p className="hint">
            Indiquez au moins une commune ou un code postal, et un autre critère.
          </p>
        ) : null}
      </div>
    </form>
  )
}
