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
        {route.name === 'saved' ? (
          <Saved signedIn={Boolean(account)} />
        ) : route.name === 'detail' ? (
          <Detail numero={route.numero} signedIn={Boolean(account)} />
        ) : (
          <Search />
        )}
      </main>
    </>
  )
}
