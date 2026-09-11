import { formatDate, LIMIT, type Hit } from '../data/sources'
import { detailHref } from '../routes'

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

export function Results({ hits, ran }: { hits: Hit[]; ran: boolean }) {
  if (!ran) return null
  if (!hits.length) {
    return (
      <p className="lede">
        Aucun certificat ne correspond. Élargissez la tolérance sur la surface, ou retirez
        un critère.
      </p>
    )
  }

  const total = Math.max(hits[0]?.total ?? 0, hits.length)
  const [one, many] = hits[0]?.source === 'audit' ? ['étape d’audit', 'étapes d’audit'] : ['certificat', 'certificats']

  return (
    <>
      <p className="count">
        {total > LIMIT
          ? `${total.toLocaleString('fr-FR')} ${many} : les ${LIMIT} premiers. Affinez pour en voir moins.`
          : `${total} ${total > 1 ? many : one}`}
      </p>
      <ul className="hits">
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
                  href={`https://www.openstreetmap.org/?mlat=${hit.lat}&mlon=${hit.lon}#map=18/${hit.lat}/${hit.lon}`}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  Voir sur la carte
                </a>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </>
  )
}
