import { useEffect, useState } from 'react'
import { manifest } from '../data/duck'
import { deptOptions, parseDecimal, SOURCE, SOURCES, type SourceId } from '../data/sources'
import { CLASSES, isRunnable, type QuerySpec } from './spec'

/**
 * The facts an advert publishes, in the order an advert publishes them.
 *
 * Nothing is required on its own -- a listing is never complete. `isRunnable`
 * asks for one partition's worth of somewhere plus something, because a bare
 * postcode would return the whole partition and a bare commune would read
 * every partition in the country.
 */

const START: QuerySpec = { source: 'existant', surfaceTolerance: 5 }

/**
 * Changing source keeps where, when, the classes and the measures, and drops
 * the filters only the old source had. An audit starts on its initial state:
 * every audit has one, so each appears once rather than once per step.
 */
function switchTo(spec: QuerySpec, source: SourceId): QuerySpec {
  const {
    typeBatiment: _t,
    periodeConstruction: _p,
    secteurActivite: _s,
    categorieErp: _e,
    categorieScenario: _c,
    etapeTravaux: _w,
    ...kept
  } = spec
  return { ...kept, source, ...(source === 'audit' ? { etapeTravaux: 'état initial' } : {}) }
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export function SearchForm({
  onSearch,
  busy,
}: {
  onSearch: (spec: QuerySpec) => void
  busy: boolean
}) {
  const [spec, setSpec] = useState<QuerySpec>(START)
  const [surfaceText, setSurfaceText] = useState('')
  const [depts, setDepts] = useState<{ value: string; label: string }[]>([])
  const set = <K extends keyof QuerySpec>(key: K, value: QuerySpec[K]) =>
    setSpec((s) => ({ ...s, [key]: value }))

  const src = SOURCE[spec.source ?? 'existant']

  // Each tree lists its own partitions: the DOM merge differs per source.
  useEffect(() => {
    let live = true
    manifest(src.subdir)
      .then((m) => live && setDepts(deptOptions(m.partitions)))
      .catch(() => live && setDepts([]))
    return () => {
      live = false
    }
  }, [src.subdir])

  const ready = isRunnable(spec)
  const badSurface = surfaceText.trim() !== '' && spec.surface === undefined

  return (
    <form
      className="search"
      onSubmit={(e) => {
        e.preventDefault()
        if (ready) onSearch(spec)
      }}
    >
      <fieldset className="sources">
        <legend>Source</legend>
        {SOURCES.map((id) => (
          <label key={id} className="source">
            <input
              type="radio"
              name="source"
              value={id}
              checked={src.id === id}
              onChange={() => setSpec((s) => switchTo(s, id))}
            />
            <span>{SOURCE[id].label}</span>
          </label>
        ))}
      </fieldset>

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
        <label htmlFor="departement">Département</label>
        <select
          id="departement"
          value={spec.departement ?? ''}
          onChange={(e) => set('departement', e.target.value || undefined)}
        >
          <option value="">{spec.codePostal?.trim() ? 'Celui du code postal' : 'Choisir…'}</option>
          {depts.map((d) => (
            <option key={d.value} value={d.value}>
              {d.label}
            </option>
          ))}
        </select>
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
        <label htmlFor="surface">{src.surface.label}</label>
        <input
          id="surface"
          inputMode="decimal"
          value={surfaceText}
          aria-invalid={badSurface || undefined}
          onChange={(e) => {
            setSurfaceText(e.target.value)
            set('surface', parseDecimal(e.target.value))
          }}
        />
      </div>

      <div className="field">
        <label htmlFor="tol">Tolérance (± m²)</label>
        <input
          id="tol"
          inputMode="numeric"
          value={spec.surfaceTolerance ?? ''}
          onChange={(e) => set('surfaceTolerance', parseDecimal(e.target.value))}
        />
      </div>

      <fieldset className="field dates">
        <legend>{src.id === 'audit' ? 'Date de l’audit' : 'Date du diagnostic'}</legend>
        <div className="range">
          <label htmlFor="du">Du</label>
          <input
            id="du"
            type="date"
            value={spec.dateDu ?? ''}
            max={spec.dateAu || undefined}
            onChange={(e) => set('dateDu', e.target.value || undefined)}
          />
          <label htmlFor="au">Au</label>
          <input
            id="au"
            type="date"
            value={spec.dateAu ?? ''}
            min={spec.dateDu || undefined}
            onChange={(e) => set('dateAu', e.target.value || undefined)}
          />
        </div>
      </fieldset>

      {src.choices.map((choice) => (
        <div className="field" key={choice.field}>
          <label htmlFor={choice.field}>{choice.label}</label>
          <select
            id={choice.field}
            value={spec[choice.field] ?? ''}
            onChange={(e) => set(choice.field, e.target.value || undefined)}
          >
            <option value="">{choice.field === 'etapeTravaux' ? 'Toutes' : 'Indifférent'}</option>
            {choice.options.map((o) => (
              <option key={o} value={o}>
                {capital(o)}
              </option>
            ))}
          </select>
        </div>
      ))}

      <details className="refine">
        <summary>Affiner</summary>
        <div className="refine-fields">
          <div className="field">
            <label htmlFor="conso">{src.conso.label}</label>
            <input
              id="conso"
              inputMode="decimal"
              onChange={(e) => set('consoEp', parseDecimal(e.target.value))}
            />
          </div>
          <div className="field">
            <label htmlFor="emission">{src.ges.label}</label>
            <input
              id="emission"
              inputMode="decimal"
              onChange={(e) => set('emissionGes', parseDecimal(e.target.value))}
            />
          </div>
          {src.periodes.length ? (
            <div className="field">
              <label htmlFor="periode">Période de construction</label>
              <select
                id="periode"
                value={spec.periodeConstruction ?? ''}
                onChange={(e) => set('periodeConstruction', e.target.value || undefined)}
              >
                <option value="">Indifférent</option>
                {src.periodes.map((p) => (
                  <option key={p} value={p}>
                    {capital(p)}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </div>
      </details>

      <div className="actions">
        <button type="submit" className="signin" disabled={!ready || busy}>
          {busy ? 'Recherche…' : 'Rechercher'}
        </button>
        {!ready ? (
          <p className="hint">
            Indiquez un code postal ou un département, et un autre critère.
          </p>
        ) : null}
      </div>
    </form>
  )
}
