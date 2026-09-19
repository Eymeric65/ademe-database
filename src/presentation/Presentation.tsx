/**
 * What the product is, for somebody who has not signed in yet -- or who has
 * and wants to send the link to somebody else.
 *
 * Two mounts: a page of its own at #/presentation, and the same sections
 * under the gate on the signed-out landing page, where the gate is already
 * the hero. TRAP: under the gate no heading here may contain "DPE" and no
 * button may reuse a gate or masthead label, or a strict e2e selector
 * (smoke.spec, gate.spec, sign-in.spec) starts matching two elements.
 */
export function Presentation({
  hero,
  signedIn,
  onSignIn,
}: {
  hero: boolean
  signedIn: boolean
  onSignIn: () => void
}) {
  return (
    <div className="presentation">
      {hero ? (
        <section className="pres-hero">
          <div>
            <h1>
              <span>L’annonce montre une lettre.</span> <span>Le diagnostic montre le logement.</span>
            </h1>
            <p className="lede">
              Une annonce immobilière affiche une classe énergie, une surface et une commune.
              L’adresse, la consommation chiffrée et la date du diagnostic restent hors champ. Le
              diagnostic, lui, est public : recherche-maison le retrouve à partir de ce que
              l’annonce publie.
            </p>
            <p className="actions">
              {signedIn ? (
                <a className="signin" href="#/">
                  Lancer une recherche
                </a>
              ) : (
                <button type="button" className="signin" onClick={onSignIn}>
                  Se connecter et chercher
                </button>
              )}
            </p>
          </div>
          <Specimen />
        </section>
      ) : null}

      <section className="pres-section" aria-labelledby="pres-gaps">
        <header>
          <h2 id="pres-gaps">Ce que l’annonce ne dit pas</h2>
          <p>
            Une annonce n’est tenue d’afficher que quelques mentions. Tout ce qu’elle laisse de
            côté, le diagnostiqueur l’a relevé et déposé auprès de l’ADEME.
          </p>
        </header>
        <table className="pres-ledger">
          <thead>
            <tr>
              <td />
              <th scope="col">Dans l’annonce</th>
              <th scope="col">Dans le diagnostic public</th>
            </tr>
          </thead>
          <tbody>
            {GAPS.map(([what, ad, dpe]) => (
              <tr key={what}>
                <th scope="row">{what}</th>
                <td className="ad" data-label="Annonce">
                  {ad}
                </td>
                <td data-label="Diagnostic">{dpe}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="pres-section" aria-labelledby="pres-how">
        <header>
          <h2 id="pres-how">Comment ça marche</h2>
          <p>Trois gestes, l’annonce ouverte dans un autre onglet.</p>
        </header>
        <ol className="pres-steps">
          <li>
            <h3>Recopiez l’annonce</h3>
            <p>
              Code postal ou commune, classe énergie, surface. Si l’annonce les donne, la date du
              diagnostic et la consommation resserrent encore la recherche.
            </p>
          </li>
          <li>
            <h3>Comparez les candidats</h3>
            <p>
              Les certificats qui correspondent s’affichent en liste et sur la carte. Souvent
              quelques-uns, parfois un seul.
            </p>
          </li>
          <li>
            <h3>Ouvrez le diagnostic</h3>
            <p>
              Toutes ses données, l’emplacement sur Google Maps, le bâtiment et sa parcelle.
              Enregistrez-le pour y revenir.
            </p>
          </li>
        </ol>
      </section>

      <section className="pres-section" aria-labelledby="pres-base">
        <header>
          <h2 id="pres-base">Ce que contient la base</h2>
          <p>
            Les jeux publiés par l’ADEME, repris colonne par colonne, et deux référentiels
            nationaux pour situer chaque certificat.
          </p>
        </header>
        <dl className="pres-sources">
          {SOURCES.map(([name, what]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{what}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="pres-section" aria-labelledby="pres-uses">
        <header>
          <h2 id="pres-uses">À quoi ça sert</h2>
        </header>
        <ul className="pres-uses">
          {USES.map(([title, body]) => (
            <li key={title}>
              <h3>{title}</h3>
              <p>{body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="pres-section" aria-labelledby="pres-limits">
        <header>
          <h2 id="pres-limits">Les limites, franchement</h2>
        </header>
        <ul className="pres-limits">
          <li>
            Un logement n’apparaît que si un diagnostic a été déposé auprès de l’ADEME. Pas de
            diagnostic, pas de résultat.
          </li>
          <li>
            L’adresse est celle que l’ADEME a géocodée. Elle peut être approximative ; le détail
            montre aussi l’adresse saisie par le diagnostiqueur.
          </li>
          <li>
            Plusieurs certificats peuvent correspondre à la même annonce. La recherche les montre
            tous et ne choisit pas à votre place.
          </li>
          <li>
            Les données sont publiques, publiées par l’ADEME sous Licence Ouverte, et reprises
            chaque semaine.
          </li>
        </ul>
      </section>

      <section className="pres-close">
        <p>Une annonce vous intéresse ? Retrouvez le logement.</p>
        {signedIn ? (
          <a className="signin" href="#/">
            Ouvrir la recherche
          </a>
        ) : (
          <button type="button" className="signin" onClick={onSignIn}>
            Essayer avec mon compte Google
          </button>
        )}
      </section>
    </div>
  )
}

const GAPS: [string, string, string][] = [
  ['Adresse', 'La commune, parfois le quartier', 'Numéro, rue et coordonnées'],
  ['Surface', 'Arrondie, souvent « environ »', 'Celle que le diagnostiqueur a mesurée'],
  [
    'Énergie',
    'Une lettre, parfois un chiffre',
    'kWh/m²/an et kgCO₂/m²/an, détaillés par usage',
  ],
  ['Date', 'Rarement indiquée', 'Le jour du diagnostic, et donc sa validité'],
  [
    'Équipements',
    '« Chauffage gaz »',
    'Générateurs, isolation, vitrages, ventilation',
  ],
  ['Bâtiment', 'Absent', 'Identifiant RNB et parcelle cadastrale'],
]

const SOURCES: [string, string][] = [
  ['Logement existant', 'Les diagnostics des logements vendus ou loués, depuis juillet 2021.'],
  ['Logement neuf', 'Les diagnostics établis à la construction.'],
  ['Tertiaire', 'Bureaux, commerces et établissements recevant du public.'],
  ['Audit énergétique', 'Les audits réglementaires, avec leurs scénarios de travaux par étapes.'],
  ['Bâtiment RNB', 'L’identifiant national du bâtiment qui porte le certificat.'],
  ['Cadastre', 'La parcelle : section, numéro et contenance.'],
]

const USES: [string, string][] = [
  [
    'Situer un bien avant la visite',
    'Voir la rue, le voisinage, l’exposition, avant de prendre rendez-vous.',
  ],
  [
    'Vérifier ce que dit l’annonce',
    'La classe affichée est-elle celle du certificat ? Le diagnostic est-il encore valable ?',
  ],
  [
    'Anticiper les factures',
    'La consommation par usage et l’énergie de chauffage, telles que le diagnostic les a estimées.',
  ],
  [
    'Préparer des travaux',
    'Les audits énergétiques chiffrent les gains, étape par étape, jusqu’à la rénovation complète.',
  ],
]

/**
 * The hero: one invented listing and the invented certificate behind it,
 * joined by the letter they share. Decorative -- aria-hidden, and the lede
 * beside it says the same thing in words.
 */
function Specimen() {
  return (
    <figure className="specimen" aria-hidden="true">
      <div className="spec-ad">
        <div className="spec-photo">
          <svg viewBox="0 0 120 60" preserveAspectRatio="xMidYMax meet">
            <path d="M22 58V30L60 8l38 22v28M48 58V40h14v18M72 36h12v10H72z" />
          </svg>
        </div>
        <p className="spec-price">189 000 €</p>
        <p className="spec-title">Maison 5 pièces, 92 m²</p>
        <p className="spec-town">Saint-Girons (09)</p>
        <p className="spec-hidden">
          <span>Adresse</span>
          <span className="redact" />
        </p>
        <p className="spec-grade">
          <span className="badge" data-letter="D">
            D
          </span>
          <span>Classe énergie</span>
        </p>
      </div>

      <div className="spec-dpe">
        <p className="spec-head">
          <span>Diagnostic de performance énergétique</span>
          <span className="spec-num">n° 2403E0000000X</span>
        </p>
        <p className="spec-address">
          14 chemin des Tilleuls
          <br />
          09200 Saint-Girons
        </p>
        <ul className="spec-ramp">
          {LETTERS.map((letter, i) => (
            <li
              key={letter}
              className="rung"
              data-letter={letter}
              data-on={letter === 'D' || undefined}
              style={{ width: letter === 'D' ? '92%' : `${30 + i * 7}%` }}
            >
              {letter}
              {letter === 'D' ? <span className="spec-value">243 kWh/m²/an</span> : null}
            </li>
          ))}
        </ul>
        <dl className="spec-facts">
          <div>
            <dt>Surface</dt>
            <dd>91,6 m²</dd>
          </div>
          <div>
            <dt>Émissions</dt>
            <dd>38 kgCO₂/m²/an</dd>
          </div>
          <div>
            <dt>Établi le</dt>
            <dd>12 mars 2024</dd>
          </div>
        </dl>
      </div>
      <figcaption>Exemple fictif</figcaption>
    </figure>
  )
}

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G']
