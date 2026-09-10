import type { Hit } from '../data/duck'
import { LIMIT } from '../data/duck'

function Badge({ letter }: { letter: string | null }) {
  if (!letter) return <span className="badge badge-unknown">?</span>
  return (
    <span className="badge" data-letter={letter}>
      {letter}
    </span>
  )
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

  return (
    <>
      <p className="count">
        {hits.length === LIMIT
          ? `Les ${LIMIT} premiers résultats. Affinez pour en voir moins.`
          : `${hits.length} certificat${hits.length > 1 ? 's' : ''} correspond${
              hits.length > 1 ? 'ent' : ''
            }`}
      </p>
      <ul className="hits">
        {hits.map((hit) => (
          <li key={hit.numero_dpe} className="hit">
            <div className="hit-labels">
              <Badge letter={hit.etiquette_dpe} />
              <Badge letter={hit.etiquette_ges} />
            </div>
            <div className="hit-body">
              <p className="hit-address">{hit.adresse_ban ?? 'Adresse non géocodée'}</p>
              <p className="hit-meta">
                {[
                  hit.nom_commune_ban,
                  hit.surface_habitable_logement != null
                    ? `${hit.surface_habitable_logement} m²`
                    : null,
                  hit.type_batiment,
                  hit.date_etablissement_dpe,
                ]
                  .filter(Boolean)
                  .join(', ')}
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
