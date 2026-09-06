import { useState } from 'react'
import { useSession } from './auth'
import { useRoute } from './routes'
import { search, type Hit } from './data/duck'
import { Detail } from './detail/Detail'
import { Saved } from './saved/Saved'
import { Results } from './search/Results'
import { SearchForm } from './search/SearchForm'
import type { QuerySpec } from './search/spec'

function Search() {
  const [hits, setHits] = useState<Hit[]>([])
  const [ran, setRan] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run(spec: QuerySpec) {
    setBusy(true)
    setError(null)
    try {
      setHits(await search(spec))
      setRan(true)
    } catch (err) {
      // The data plane is a set of files on another origin. When it is
      // unreachable the page must say so rather than show an empty result,
      // which reads as "no such property".
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <h1>Retrouvez un logement à partir de son DPE</h1>
      <p className="lede">
        Une annonce publie la classe énergie, la surface et la commune, mais pas
        l’adresse. Le diagnostic, lui, est public. Entrez ce que vous savez.
      </p>
      <SearchForm onSearch={(spec) => void run(spec)} busy={busy} />
      {error ? <p className="error">Les données sont indisponibles : {error}</p> : null}
      <Results hits={hits} ran={ran && !error} />
    </section>
  )
}

/**
 * The signed-out screen for every route that reads the data plane.
 *
 * This is the half a person sees. The half that holds is the route gate in
 * server/index.ts, which refuses the bytes themselves -- see ADR-0012. Keeping
 * the two apart matters: hiding a form is a prompt, not a control.
 */
function Gate({
  title,
  lede,
  cta,
  onSignIn,
}: {
  title: string
  lede: string
  cta: string
  onSignIn: () => void
}) {
  return (
    <section>
      <h1>{title}</h1>
      <p className="lede">{lede}</p>
      <p className="actions">
        <button type="button" className="signin" onClick={onSignIn}>
          {cta}
        </button>
      </p>
      <p className="hint">Un compte Google suffit. Rien d’autre ne vous est demandé.</p>
    </section>
  )
}

/**
 * The energy label is this product's whole subject, so it is also its mark.
 * The badge carries the official DPE colour for its letter -- the same ramp
 * every French listing prints -- which is why the palette is not decorative.
 */
function Badge({ letter }: { letter: string }) {
  return (
    <span className="badge" data-letter={letter} aria-hidden="true">
      {letter}
    </span>
  )
}

export default function App() {
  const { account, loading, signInWithGoogle, signOut } = useSession()
  const route = useRoute()

  return (
    <>
      <header className="masthead">
        <a className="wordmark" href="#/">
          <Badge letter="D" />
          <span>recherche-maison</span>
        </a>

        <nav className="nav" aria-label="Principal">
          <a href="#/" aria-current={route.name === 'search' ? 'page' : undefined}>
            Rechercher
          </a>
          {account ? (
            <a href="#/saved" aria-current={route.name === 'saved' ? 'page' : undefined}>
              Enregistrés
            </a>
          ) : null}
        </nav>

        {/* Nothing is rendered until /api/me has answered: showing the
            signed-out header first would flash "Se connecter" at somebody who
            is already signed in, on every single load. */}
        <div className="account">
          {loading ? null : account ? (
            <>
              <span className="who">{account.email}</span>
              <button type="button" className="link" onClick={() => void signOut()}>
                Se déconnecter
              </button>
            </>
          ) : (
            <button type="button" className="signin" onClick={() => void signInWithGoogle()}>
              Se connecter avec Google
            </button>
          )}
        </div>
      </header>

      <main>
        {/* Nothing until /api/me has answered, for the same reason the header
            waits: rendering the gate first would show "connectez-vous" to
            somebody who already is, on every load. */}
        {loading ? null : route.name === 'saved' ? (
          <Saved signedIn={Boolean(account)} />
        ) : route.name === 'detail' ? (
          account ? (
            <Detail numero={route.numero} />
          ) : (
            <Gate
              title="Ce certificat DPE demande un compte"
              lede="Le diagnostic est public. Connectez-vous pour lire ses 226 données et le garder dans vos certificats."
              cta="Se connecter et consulter"
              onSignIn={() => void signInWithGoogle()}
            />
          )
        ) : account ? (
          <Search />
        ) : (
          <Gate
            title="Retrouvez un logement à partir de son DPE"
            lede="Une annonce publie la classe énergie, la surface et la commune, mais pas l’adresse. Le diagnostic, lui, est public. Connectez-vous pour l’interroger."
            cta="Se connecter et chercher"
            onSignIn={() => void signInWithGoogle()}
          />
        )}
      </main>
    </>
  )
}
