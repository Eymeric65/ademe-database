/**
 * One département's aggregate, as a page a crawler can read.
 *
 * src/routes.ts is a hash router by design, so the whole app is a single URL
 * to anything that does not run JavaScript. These pages are the domain's real
 * URLs: ~101 of them, one per département, built from src/seo/aggregates.json
 * at build time by scripts/prerender.tsx.
 *
 * They carry statistics only. No address, no certificate, nothing that would
 * move the login gate ADR-0012 put in front of the data -- and no script. The
 * page's own styles are inlined below; the app's stylesheet is linked only so
 * the masthead is the app's own, the way back into the site from a search
 * result.
 */

import { renderToStaticMarkup } from 'react-dom/server'
import { NAMES, deptSlug } from '../data/sources'
import { Presentation } from '../presentation/Presentation'

export type ClassCounts = Record<string, number>

/** One `departements` entry of src/seo/aggregates.json (see ADR-0044). */
export type DepartementAggregate = {
  dept: string
  publishable: boolean
  certificates: number
  etiquette_dpe: ClassCounts
  etiquette_ges: ClassCounts
  passoires: { count: number; classed: number; share: number | null }
  conso_ep_kwh_m2: { counted: number; p25: number; median: number; p75: number } | null
  surface_m2: { counted: number; median: number } | null
  periode_construction: { label: string; count: number }[]
  type_batiment: { label: string; count: number }[]
  par_annee: { year: number; count: number }[]
  communes: { code_insee: string; nom: string; count: number }[]
}

/** When the underlying data stops, and when it was built. */
export type Stamp = { highWater: string; dataBuiltAt: string }

/** A footer link to another département page. */
export type DeptLink = { dept: string; name: string; slug: string }

export const ORIGIN = 'https://recherche-maison.com'

const INDEX_URL = `${ORIGIN}/departements`
const INDEX_TITLE = 'Statistiques par département'

export const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const

// --- numbers and dates, the French way --------------------------------------

/**
 * 31157 -> '31 157', with a non-breaking space.
 *
 * TRAP: not Intl.NumberFormat. Its fr-FR group separator changed from U+00A0
 * to U+202F between ICU versions, so the same source would render differently
 * on two machines and the committed pages would churn.
 */
export function fmt(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

/** 203.7 -> '203,7'. */
function dec(n: number, digits = 1): string {
  return n.toFixed(digits).replace('.', ',')
}

/** 0.1595 -> '16,0 %'. */
function pct(share: number, digits = 1): string {
  return `${dec(share * 100, digits)} %`
}

const MONTHS = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
]

/** '2026-09-07' -> '7 septembre 2026'. */
export function frenchDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-')
  const month = MONTHS[Number(m) - 1] ?? m
  return `${Number(d)} ${month} ${y}`
}

/**
 * Paris, Lyon and Marseille file one INSEE code per arrondissement while
 * nom_commune_ban carries only the city, so the top-communes table would
 * otherwise be twenty rows all called Paris. The code is what tells them
 * apart; the aggregate is right, this is a display concern.
 */
const ARRONDISSEMENTS = [
  { city: 'Paris', base: 75100, last: 75120 },
  { city: 'Lyon', base: 69380, last: 69389 },
  { city: 'Marseille', base: 13200, last: 13216 },
]

export function communeLabel(codeInsee: string, nom: string): string {
  const n = Number(codeInsee)
  for (const a of ARRONDISSEMENTS) {
    if (n > a.base && n <= a.last) {
      const rank = n - a.base
      return `${a.city} ${rank}${rank === 1 ? 'er' : 'e'}`
    }
  }
  return nom
}

// --- the page ---------------------------------------------------------------

const CSS = `
/* The tokens are src/index.css's, copied rather than imported: this page has
   to be complete in one file, with no stylesheet request. */
@font-face {
  font-family: 'Fraunces';
  font-style: normal;
  font-weight: 300 700;
  font-display: swap;
  src: url('/fonts/fraunces-roman-latin.woff2') format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC,
    U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215,
    U+FEFF, U+FFFD;
}
:root {
  --bg: #f4f0e6; --surface: #ece5d6; --border: #d7ceba;
  --text: #221d16; --muted: #6c6254; --accent: #1f4e79; --contrast: #faf7f0;
  --dpe-a: #319834; --dpe-b: #33cc31; --dpe-c: #cbfc34; --dpe-d: #fbfe06;
  --dpe-e: #fbcc05; --dpe-f: #fc9934; --dpe-g: #fc0205;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #15120d; --surface: #221d16; --border: #322d23;
    --text: #ece5d6; --muted: #a99e8c; --accent: #63a2d8; --contrast: #17140e;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
}
h1, h2, h3 { font-family: 'Fraunces', Georgia, 'Times New Roman', serif; font-weight: 620; line-height: 1.2; }
h1 { font-size: clamp(1.7rem, 1.2rem + 2vw, 2.6rem); margin: 0 0 0.6rem; }
h2 { font-size: 1.25rem; margin: 2.4rem 0 0.8rem; }
a { color: var(--accent); }
.wrap { max-width: 56rem; margin: 0 auto; padding: 1.6rem 1rem 3rem; }
/* The app's stylesheet, linked for the masthead, also styles main and h1 for
   the app's own screens; .wrap is what lays these pages out. */
.wrap > main { max-width: none; padding: 0; }
h1 { max-width: none; }
.scroll { overflow-x: auto; }
.lede { color: var(--muted); max-width: 42rem; }
.figures { display: grid; gap: 0.7rem; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); margin: 1.6rem 0 0; }
.figures > div { border: 1px solid var(--border); border-radius: 3px; background: var(--surface); padding: 0.7rem 0.9rem; }
.figures dt { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
.figures dd {
  margin: 0.2rem 0 0; font-size: 1.5rem; font-weight: 700;
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
}
.figures dd small { display: block; font-size: 0.78rem; font-weight: 400; color: var(--muted); font-family: inherit; }
.pair { display: grid; gap: 1.6rem; grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr)); }
.ramp { list-style: none; margin: 0; padding: 0; }
.ramp li { display: grid; grid-template-columns: 1.6rem 1fr auto; align-items: center; gap: 0.5rem; margin: 0.2rem 0; }
.ramp .letter {
  text-align: center; font-weight: 700; border-radius: 2px; color: #221d16;
  font-family: ui-monospace, Menlo, Consolas, monospace;
}
.ramp .letter[data-letter='A'], .ramp .letter[data-letter='G'] { color: #fff; }
.ramp .letter[data-letter='A'] { background: var(--dpe-a); }
.ramp .letter[data-letter='B'] { background: var(--dpe-b); }
.ramp .letter[data-letter='C'] { background: var(--dpe-c); }
.ramp .letter[data-letter='D'] { background: var(--dpe-d); }
.ramp .letter[data-letter='E'] { background: var(--dpe-e); }
.ramp .letter[data-letter='F'] { background: var(--dpe-f); }
.ramp .letter[data-letter='G'] { background: var(--dpe-g); }
.ramp .track { background: var(--surface); border: 1px solid var(--border); border-radius: 2px; height: 1.1rem; }
.ramp .fill { display: block; height: 100%; background: var(--accent); }
.ramp .fill[data-letter='A'] { background: var(--dpe-a); }
.ramp .fill[data-letter='B'] { background: var(--dpe-b); }
.ramp .fill[data-letter='C'] { background: var(--dpe-c); }
.ramp .fill[data-letter='D'] { background: var(--dpe-d); }
.ramp .fill[data-letter='E'] { background: var(--dpe-e); }
.ramp .fill[data-letter='F'] { background: var(--dpe-f); }
.ramp .fill[data-letter='G'] { background: var(--dpe-g); }
.ramp .n { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.85rem; color: var(--muted); white-space: nowrap; }
.ramp .name { grid-column: 1 / 2; width: auto; }
.ramp.labelled li { grid-template-columns: 9.5rem 1fr auto; }
table { border-collapse: collapse; width: 100%; font-size: 0.95rem; }
th, td { text-align: left; padding: 0.35rem 0.6rem 0.35rem 0; border-bottom: 1px solid var(--border); }
td.n, th.n { text-align: right; font-family: ui-monospace, Menlo, Consolas, monospace; }
.note { color: var(--muted); font-size: 0.92rem; max-width: 42rem; }
.cta { margin: 2rem 0; }
.cta a {
  display: inline-block; background: var(--accent); color: var(--contrast);
  text-decoration: none; padding: 0.55rem 1.1rem; border-radius: 3px; font-weight: 600;
}
footer { border-top: 1px solid var(--border); margin-top: 3rem; padding-top: 1.2rem; }
.others { columns: 12rem; font-size: 0.88rem; }
.others a { display: block; text-decoration: none; padding: 0.08rem 0; }
.others a:hover { text-decoration: underline; }
`

type Tab = 'presentation' | 'statistiques'

/**
 * src/App.tsx's masthead, for the pages that run no JavaScript: the same
 * classes, root-absolute paths instead of hash routes, and no account corner --
 * there is no session here to show.
 */
function StaticMasthead({ current }: { current: Tab }) {
  const here = (tab: Tab) => (tab === current ? ('page' as const) : undefined)
  return (
    <header className="masthead">
      <a className="wordmark" href="/">
        <span className="badge" data-letter="D" aria-hidden="true">
          D
        </span>
        <span>recherche-maison</span>
      </a>
      <nav className="nav" aria-label="Principal">
        <a href="/presentation" aria-current={here('presentation')}>
          Présentation
        </a>
        <a href="/departements" aria-current={here('statistiques')}>
          Statistiques
        </a>
        <a href="/">Rechercher</a>
      </nav>
    </header>
  )
}

function Ramp({ rows, letters }: { rows: { key: string; label: string; count: number }[]; letters: boolean }) {
  const max = Math.max(1, ...rows.map((r) => r.count))
  const total = rows.reduce((sum, r) => sum + r.count, 0) || 1
  return (
    <ul className={letters ? 'ramp' : 'ramp labelled'}>
      {rows.map((row) => (
        <li key={row.key}>
          {letters ? (
            <span className="letter" data-letter={row.key}>
              {row.key}
            </span>
          ) : (
            <span className="name">{row.label}</span>
          )}
          <span className="track">
            <span
              className="fill"
              {...(letters ? { 'data-letter': row.key } : {})}
              style={{ width: `${(row.count / max) * 100}%` }}
            />
          </span>
          <span className="n">
            {fmt(row.count)} · {pct(row.count / total)}
          </span>
        </li>
      ))}
    </ul>
  )
}

/**
 * The page, as a complete HTML document.
 *
 * Pure: everything it prints comes from its arguments, which is what lets
 * test/unit/seo-page.test.ts assert on it without a build.
 */
export function renderDepartementPage({
  agg,
  stamp,
  others,
  stylesheet,
}: {
  agg: DepartementAggregate
  stamp: Stamp
  others: readonly DeptLink[]
  stylesheet: string
}): string {
  const name = NAMES[agg.dept] ?? agg.dept
  const slug = deptSlug(agg.dept)
  const url = `${ORIGIN}/departement/${slug}`
  const count = fmt(agg.certificates)
  const share = agg.passoires.share
  const passoires = share == null ? null : pct(share)
  const conso = agg.conso_ep_kwh_m2
  const surface = agg.surface_m2
  const cutoff = frenchDate(stamp.highWater)
  const firstYear = agg.par_annee[0]?.year

  const title = `DPE ${name} (${agg.dept}) : ${count} diagnostics, classes et passoires`
  // Kept short on purpose: a description past ~160 characters is cut in the
  // result, and the cut lands mid-figure.
  const description =
    `${name} (${agg.dept}) : ${count} DPE publics.` +
    (passoires ? ` ${passoires} de passoires thermiques (F+G),` : '') +
    (conso ? ` consommation médiane ${dec(conso.median)} kWhEP/m²/an,` : '') +
    ' répartition des classes A à G.'

  const dataset = {
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name: `Diagnostics de performance énergétique — ${name} (${agg.dept})`,
    description,
    url,
    license: 'https://www.etalab.gouv.fr/licence-ouverte-open-licence',
    inLanguage: 'fr',
    isAccessibleForFree: true,
    creator: { '@type': 'Organization', name: 'ADEME', url: 'https://www.ademe.fr/' },
    isBasedOn: 'https://data.ademe.fr/datasets/dpe03existant',
    spatialCoverage: { '@type': 'Place', name: `${name}, France` },
    ...(firstYear ? { temporalCoverage: `${firstYear}-01-01/${stamp.highWater}` } : {}),
    dateModified: stamp.highWater,
    variableMeasured: [
      { '@type': 'PropertyValue', name: 'Diagnostics', value: agg.certificates },
      ...(share == null
        ? []
        : [{ '@type': 'PropertyValue', name: 'Part de passoires thermiques (F+G)', value: share }]),
      ...(conso
        ? [
            {
              '@type': 'PropertyValue',
              name: 'Consommation médiane',
              value: conso.median,
              unitText: 'kWhEP/m²/an',
            },
          ]
        : []),
    ],
  }

  const breadcrumb = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'recherche-maison', item: `${ORIGIN}/` },
      { '@type': 'ListItem', position: 2, name: INDEX_TITLE, item: INDEX_URL },
      { '@type': 'ListItem', position: 3, name: `${name} (${agg.dept})`, item: url },
    ],
  }

  const dpeRows = LETTERS.map((l) => ({ key: l, label: l, count: agg.etiquette_dpe[l] ?? 0 }))
  const gesRows = LETTERS.map((l) => ({ key: l, label: l, count: agg.etiquette_ges[l] ?? 0 }))

  const markup = renderToStaticMarkup(
    <html lang="fr">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <meta name="description" content={description} />
        <link rel="canonical" href={url} />
        <meta property="og:title" content={title} />
        <meta property="og:description" content={description} />
        <meta property="og:type" content="article" />
        <meta property="og:url" content={url} />
        <meta property="og:locale" content="fr_FR" />
        <meta property="og:site_name" content="recherche-maison" />
        <meta name="twitter:card" content="summary" />
        {/* Prussian blue, the same --color-accent src/index.css leads with. */}
        <meta name="theme-color" content="#1f4e79" />
        <link
          rel="preload"
          href="/fonts/fraunces-roman-latin.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
        {/* Before the inline <style>, so the page's own rules win a tie. */}
        <link rel="stylesheet" href={stylesheet} />
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(dataset) }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumb) }}
        />
      </head>
      <body>
        <StaticMasthead current="statistiques" />

        <div className="wrap">
          <main>
            <h1>
              {name} ({agg.dept}) : {count} diagnostics de performance énergétique
            </h1>
            <p className="lede">
              Une annonce immobilière affiche une lettre. Les diagnostics déposés auprès de l’ADEME
              disent le reste : ce que consomme le parc de ce département, ce qu’il émet, et ce qu’il
              faudrait rénover.
            </p>

            <dl className="figures">
              <div>
                <dt>Diagnostics</dt>
                <dd>{count}</dd>
              </div>
              <div>
                <dt>Passoires thermiques</dt>
                <dd>
                  {passoires ?? '—'}
                  <small>{fmt(agg.passoires.count)} logements classés F ou G</small>
                </dd>
              </div>
              <div>
                <dt>Consommation médiane</dt>
                <dd>
                  {conso ? dec(conso.median) : '—'}
                  <small>kWhEP/m²/an</small>
                </dd>
              </div>
              <div>
                <dt>Surface médiane</dt>
                <dd>
                  {surface ? dec(surface.median) : '—'}
                  <small>m² habitables</small>
                </dd>
              </div>
            </dl>

            <div className="pair">
              <section>
                <h2>Classe énergie</h2>
                <Ramp rows={dpeRows} letters />
              </section>
              <section>
                <h2>Classe climat (GES)</h2>
                <Ramp rows={gesRows} letters />
              </section>
            </div>

            {conso ? (
              <section>
                <h2>Consommation d’énergie primaire</h2>
                <table>
                  <tbody>
                    <tr>
                      <th scope="row">Premier quartile</th>
                      <td className="n">{dec(conso.p25)} kWhEP/m²/an</td>
                    </tr>
                    <tr>
                      <th scope="row">Médiane</th>
                      <td className="n">{dec(conso.median)} kWhEP/m²/an</td>
                    </tr>
                    <tr>
                      <th scope="row">Troisième quartile</th>
                      <td className="n">{dec(conso.p75)} kWhEP/m²/an</td>
                    </tr>
                    {surface ? (
                      <tr>
                        <th scope="row">Surface habitable médiane</th>
                        <td className="n">{dec(surface.median)} m²</td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
                <p className="note">
                  Un logement sur deux consomme moins que la médiane, un sur quatre moins que le
                  premier quartile. Ces valeurs sont celles que les diagnostiqueurs ont estimées,
                  pas des relevés de facture.
                </p>
              </section>
            ) : null}

            <div className="pair">
              {agg.periode_construction.length ? (
                <section>
                  <h2>Période de construction</h2>
                  <Ramp
                    rows={agg.periode_construction.map((p) => ({
                      key: p.label,
                      label: p.label,
                      count: p.count,
                    }))}
                    letters={false}
                  />
                </section>
              ) : null}
              {agg.type_batiment.length ? (
                <section>
                  <h2>Type de bâtiment</h2>
                  <Ramp
                    rows={agg.type_batiment.map((t) => ({
                      key: t.label,
                      label: t.label,
                      count: t.count,
                    }))}
                    letters={false}
                  />
                </section>
              ) : null}
            </div>

            {agg.par_annee.length ? (
              <section>
                <h2>Diagnostics par année</h2>
                <Ramp
                  rows={agg.par_annee.map((y) => ({
                    key: String(y.year),
                    label: String(y.year),
                    count: y.count,
                  }))}
                  letters={false}
                />
                <p className="note">
                  L’année en cours est incomplète : elle s’arrête à la date d’arrêt des données.
                </p>
              </section>
            ) : null}

            {agg.communes.length ? (
              <section>
                <h2>Communes les plus diagnostiquées</h2>
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Commune</th>
                      <th scope="col" className="n">
                        Diagnostics
                      </th>
                      <th scope="col" className="n">
                        Part du département
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {agg.communes.map((c) => (
                      <tr key={c.code_insee}>
                        <th scope="row">{communeLabel(c.code_insee, c.nom)}</th>
                        <td className="n">{fmt(c.count)}</td>
                        <td className="n">{pct(c.count / (agg.certificates || 1))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            ) : null}

            <p className="cta">
              <a href="/">Retrouver le diagnostic d’un logement</a>
            </p>

            <section>
              <h2>D’où viennent ces chiffres</h2>
              <p className="note">
                Ils sont calculés sur les diagnostics de logements existants publiés par l’ADEME,
                repris certificat par certificat. Les données s’arrêtent au {cutoff} ; les
                diagnostics des deux à trois derniers mois ne sont pas comptés ici, ils sont
                réservés aux comptes payants (voir la présentation du site).
              </p>
              <p className="note">
                Un logement n’apparaît que si un diagnostic a été déposé. Le département est celui
                que l’ADEME a géocodé, et un même logement peut porter plusieurs diagnostics.
              </p>
              <p className="note">
                Source : ADEME, « DPE logements existants », publiée sous{' '}
                <a href="https://www.etalab.gouv.fr/licence-ouverte-open-licence">
                  Licence Ouverte / Open Licence (Etalab)
                </a>
                . Agrégats calculés le {frenchDate(stamp.dataBuiltAt)} par recherche-maison.
              </p>
            </section>
          </main>

          <footer>
            <h2>Tous les départements</h2>
            <nav className="others" aria-label="Autres départements">
              {others.map((o) => (
                <a key={o.dept} href={`/departement/${o.slug}`}>
                  {o.dept} {o.name}
                </a>
              ))}
            </nav>
            <p className="note">
              <a href="/">recherche-maison</a> — le diagnostic public d’un logement, à partir de ce
              qu’une annonce en dit. <a href="/presentation">Ce que contient la base</a>.
            </p>
          </footer>
        </div>
      </body>
    </html>,
  )

  return `<!doctype html>${markup}`
}

// --- every département, on one page -----------------------------------------

/**
 * /departements: one row per département page, and the only page that links
 * all of them -- the « Statistiques » tab of every masthead leads here.
 *
 * `rows` arrive in the order they are printed (scripts/prerender.tsx sorts by
 * code). The total is summed from the counts: the mean of a hundred shares
 * weighs the Lozère like Paris.
 */
export function renderDepartementsIndex({
  rows,
  stamp,
  stylesheet,
}: {
  rows: readonly DepartementAggregate[]
  stamp: Stamp
  stylesheet: string
}): string {
  const certificates = rows.reduce((sum, r) => sum + r.certificates, 0)
  const passoires = rows.reduce((sum, r) => sum + r.passoires.count, 0)
  const classed = rows.reduce((sum, r) => sum + r.passoires.classed, 0)
  const cutoff = frenchDate(stamp.highWater)

  const title = 'DPE par département : diagnostics, passoires thermiques et consommation'
  const description =
    `${fmt(certificates)} DPE publics dans ${rows.length} départements : part de passoires ` +
    'thermiques (F+G) et consommation médiane, département par département.'

  const breadcrumb = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'recherche-maison', item: `${ORIGIN}/` },
      { '@type': 'ListItem', position: 2, name: INDEX_TITLE, item: INDEX_URL },
    ],
  }

  const markup = renderToStaticMarkup(
    <html lang="fr">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <meta name="description" content={description} />
        <link rel="canonical" href={INDEX_URL} />
        <meta property="og:title" content={title} />
        <meta property="og:description" content={description} />
        <meta property="og:type" content="website" />
        <meta property="og:url" content={INDEX_URL} />
        <meta property="og:locale" content="fr_FR" />
        <meta property="og:site_name" content="recherche-maison" />
        <meta name="twitter:card" content="summary" />
        <meta name="theme-color" content="#1f4e79" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link
          rel="preload"
          href="/fonts/fraunces-roman-latin.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
        <link rel="stylesheet" href={stylesheet} />
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumb) }}
        />
      </head>
      <body>
        <StaticMasthead current="statistiques" />

        <div className="wrap">
          <main>
            <h1>{INDEX_TITLE}</h1>
            <p className="lede">
              Les diagnostics de performance énergétique publiés par l’ADEME, département par
              département : combien il y en a, quelle part de passoires thermiques, quelle
              consommation. Chaque ligne mène au détail.
            </p>

            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Département</th>
                    <th scope="col" className="n">
                      Diagnostics
                    </th>
                    <th scope="col" className="n">
                      Passoires (F+G)
                    </th>
                    <th scope="col" className="n">
                      Conso. médiane
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.dept}>
                      <th scope="row">
                        <a href={`/departement/${deptSlug(r.dept)}`}>
                          {r.dept} {NAMES[r.dept] ?? r.dept}
                        </a>
                      </th>
                      <td className="n">{fmt(r.certificates)}</td>
                      <td className="n">
                        {r.passoires.share == null ? '—' : pct(r.passoires.share)}
                      </td>
                      <td className="n">
                        {r.conso_ep_kwh_m2 ? dec(r.conso_ep_kwh_m2.median) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row">Ensemble</th>
                    <td className="n">{fmt(certificates)}</td>
                    <td className="n">{classed ? pct(passoires / classed) : '—'}</td>
                    <td className="n">—</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <p className="note">
              Consommation d’énergie primaire médiane, en kWhEP/m²/an. Une médiane ne s’additionne
              pas : la ligne « Ensemble » n’en donne pas.
            </p>

            <p className="cta">
              <a href="/">Retrouver le diagnostic d’un logement</a>
            </p>

            <section>
              <h2>D’où viennent ces chiffres</h2>
              <p className="note">
                Ils sont calculés sur les diagnostics de logements existants publiés par l’ADEME.
                Les données s’arrêtent au {cutoff}. Ne sont pas listés les diagnostics non
                géocodés, ni ceux de Saint-Pierre-et-Miquelon, Mayotte, Saint-Barthélemy et
                Saint-Martin, regroupés dans un seul ensemble.
              </p>
              <p className="note">
                Source : ADEME, « DPE logements existants », publiée sous{' '}
                <a href="https://www.etalab.gouv.fr/licence-ouverte-open-licence">
                  Licence Ouverte / Open Licence (Etalab)
                </a>
                . Agrégats calculés le {frenchDate(stamp.dataBuiltAt)} par recherche-maison.
              </p>
            </section>
          </main>
        </div>
      </body>
    </html>,
  )

  return `<!doctype html>${markup}`
}

// --- the présentation, at a URL of its own ----------------------------------

const PRES_URL = `${ORIGIN}/presentation`

const PRES_TITLE = 'DPE : retrouver le diagnostic d’un logement à partir d’une annonce'

// Under ~160 characters: past that the result is cut, and the cut lands badly.
const PRES_DESCRIPTION =
  'Une annonce affiche une lettre ; le DPE public dit l’adresse, la consommation ' +
  'chiffrée et la date. Ce que contient la base, comment la chercher, et ses limites.'

/**
 * src/presentation/Presentation.tsx, as a page a crawler can read.
 *
 * It is ~300 lines of the best copy on the site and, as a hash route, no
 * crawler has ever seen a word of it: #/presentation never leaves the browser.
 * Rendering it here is safe because the component is prop-only and
 * import-free -- no hook, no context, no fetch -- so renderToStaticMarkup
 * takes it as it is.
 *
 * Unlike renderDepartementPage above, this page LINKS a stylesheet instead of
 * inlining one: the pres-* and spec-* classes are ~400 lines of src/index.css,
 * which Vite emits under a content hash. scripts/prerender.tsx reads that
 * hashed name out of the built index.html and passes it in.
 *
 * Keyword copy lives in the title and the description here, never in the
 * component: its headings also render under the gate on the landing page,
 * where a second "DPE" heading makes a strict e2e selector match twice.
 */
export function renderPresentationPage({ stylesheet }: { stylesheet: string }): string {
  const markup = renderToStaticMarkup(
    <html lang="fr">
      <head>
        <meta charSet="utf-8" />
        {/*
          TRAP: this <base> is load-bearing, not tidiness. The component's two
          calls to action are <a href="#/">, which on this page would otherwise
          resolve to /presentation#/ -- a link back to itself. With the base,
          a fragment-only href resolves against "/" and lands on the app. Every
          other URL written here is root-absolute, so nothing else moves.
        */}
        <base href="/" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{PRES_TITLE}</title>
        <meta name="description" content={PRES_DESCRIPTION} />
        <link rel="canonical" href={PRES_URL} />
        <meta property="og:title" content={PRES_TITLE} />
        <meta property="og:description" content={PRES_DESCRIPTION} />
        <meta property="og:type" content="website" />
        <meta property="og:url" content={PRES_URL} />
        <meta property="og:locale" content="fr_FR" />
        <meta property="og:site_name" content="recherche-maison" />
        <meta name="twitter:card" content="summary" />
        {/* Prussian blue, the same --color-accent src/index.css leads with. */}
        <meta name="theme-color" content="#1f4e79" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link
          rel="preload"
          href="/fonts/fraunces-roman-latin.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
        <link rel="stylesheet" href={stylesheet} />
      </head>
      <body>
        <StaticMasthead current="presentation" />

        <main>
          {/*
            TRAP: signedIn does NOT claim anybody is signed in -- this page has
            no session and ships no JavaScript. It only picks how the two calls
            to action render, and the other branch is <button onClick>, which
            is completely inert here. Two dead buttons on a public landing page
            is the worse outcome; a link into the app is the point.
          */}
          <Presentation hero signedIn onSignIn={() => {}} />

          <footer className="pres-foot">
            <p>
              <a href="/">recherche-maison</a> — le diagnostic public d’un logement, à partir de ce
              qu’une annonce en dit.
            </p>
            <p>
              Données : ADEME, publiées sous{' '}
              <a href="https://www.etalab.gouv.fr/licence-ouverte-open-licence">
                Licence Ouverte / Open Licence (Etalab)
              </a>
              .
            </p>
          </footer>
        </main>
      </body>
    </html>,
  )

  return `<!doctype html>${markup}`
}
