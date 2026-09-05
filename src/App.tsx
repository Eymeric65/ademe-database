import { useSession } from './auth'
import { useRoute } from './routes'

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
          <section>
            <h1>Enregistrés</h1>
            <p className="lede">Les certificats que vous gardez apparaîtront ici.</p>
          </section>
        ) : (
          <section>
            <h1>Retrouvez un logement à partir de son DPE</h1>
            <p className="lede">
              Une annonce publie la classe énergie, la surface et la commune, mais pas
              l’adresse. Le diagnostic, lui, est public. Entrez ce que vous savez.
            </p>
          </section>
        )}
      </main>
    </>
  )
}
