import { formatDate, LIMIT, type Hit } from '../data/sources'
import { detailHref } from '../routes'
import { ResultsMap } from './ResultsMap'

export function Badge({ letter }: { letter: string | null }) {
  if (!letter) return <span className="badge badge-unknown">?</span>
  return (
    <span className="badge" data-letter={letter}>
      {letter}
    </span>
  )
}

export function area(value: number): string {
  return `${value.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} m²`
}

/** A Google Maps URL, the documented form that needs no key. */
export function mapsHref(lat: number, lon: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`
}

/** "3 certificats plus récents", agreed in number -- and in gender, for audit steps. */
export function newerLabel(n: number, audit: boolean): string {
  const [one, many] = audit
    ? ['étape d’audit plus récente', 'étapes d’audit plus récentes']
    : ['certificat plus récent', 'certificats plus récents']
  return `${n.toLocaleString('fr-FR')} ${n > 1 ? many : one}`
}

/**
 * What a free member is not shown, at the top of the list. The rows under the
 * blur are placeholders written here, never data: the paid rows are not in
 * this browser at all, only their count (ADR-0039).
 */
function RecentLocked({ newer, audit }: { newer: number; audit: boolean }) {
  return (
    <li className="recent-locked">
      <div className="recent-locked-rows" aria-hidden="true">
        {(['C', 'D', 'E'] as const).map((letter) => (
          <div key={letter} className="hit">
            <div className="hit-labels">
              <Badge letter={letter} />
              <Badge letter={letter} />
            </div>
            <div className="hit-body">
              <p className="hit-address">12 rue des Tilleuls</p>
              <p className="hit-meta">Commune · 84 m² · 01/08/2026</p>
            </div>
          </div>
        ))}
      </div>
      <p className="recent-locked-note">
        {newerLabel(newer, audit)} — devenez membre payant pour y accéder
      </p>
    </li>
  )
}

export function Results({
  hits,
  newer,
  audit,
  ran,
}: {
  hits: Hit[]
  /** Recent matches a free member is not shown; 0 for a paid one. */
  newer: number
  audit: boolean
  ran: boolean
}) {
  if (!ran) return null
  if (!hits.length) {
    return (
      <>
        {newer > 0 ? (
          <ul className="hits">
            <RecentLocked newer={newer} audit={audit} />
          </ul>
        ) : null}
        <p className="lede">
          Aucun certificat ne correspond. Élargissez la tolérance sur la surface, ou retirez
          un critère.
        </p>
      </>
    )
  }

  const total = Math.max(hits[0]?.total ?? 0, hits.length)
  const [one, many] = audit ? ['étape d’audit', 'étapes d’audit'] : ['certificat', 'certificats']

  return (
    <>
      <p className="count">
        {total > LIMIT
          ? `${total.toLocaleString('fr-FR')} ${many} : les ${LIMIT} premiers. Affinez pour en voir moins.`
          : `${total} ${total > 1 ? many : one}`}
      </p>
      <div className="results">
        {hits.some((hit) => hit.lat != null && hit.lon != null) ? (
          <ResultsMap hits={hits} newer={newer} audit={audit} />
        ) : null}
        <ul className="hits">
          {newer > 0 ? <RecentLocked newer={newer} audit={audit} /> : null}
          {hits.map((hit) => (
            <li key={`${hit.source}:${hit.key}`} className="hit">
              <div className="hit-labels">
                <Badge letter={hit.classe} />
                <Badge letter={hit.ges} />
              </div>
              <div className="hit-body">
                <p className="hit-address">
                  <a href={detailHref(hit)}>{hit.address ?? hit.key}</a>
                </p>
                <p className="hit-meta">
                  {[
                    hit.commune,
                    hit.surface != null ? area(hit.surface) : null,
                    hit.kind,
                    hit.etape,
                    hit.date ? formatDate(hit.date) : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
                {/* Overseas certificates have no coordinates: their source
                    projection is not Lambert-93 and ADEME's own values land on
                    the wrong continent (ADR-0011). */}
                {hit.lat != null && hit.lon != null ? (
                  <a
                    className="hit-map"
                    href={mapsHref(hit.lat, hit.lon)}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    Voir sur Google Maps
                  </a>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </>
  )
}
