import { useEffect, useState, type ReactNode } from 'react'
import { api, ApiError } from '../api'
import type { Account } from '../auth'
import type { CheckoutReturn } from '../routes'

/** How long the page waits for Stripe's webhook after a paid checkout. */
const ACTIVATION_WAIT_MS = 30_000
const POLL_MS = 2_000

/** Statuses in which Stripe still bills but the plan does not read (ADR-0047). */
const UNPAID: Record<string, string> = {
  past_due: 'Le dernier paiement n’est pas passé.',
  unpaid: 'Le dernier paiement n’est pas passé.',
  paused: 'Votre abonnement est suspendu.',
}

/** "2026-10-22" -> « 22 octobre 2026 ». The ISO day is UTC; so is the reading. */
function frenchDay(iso: string): string {
  return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${iso}T00:00:00Z`),
  )
}

/**
 * The « Abonnement » page: what the paid plan gives, the button that opens
 * Stripe Checkout, and, for a member, where the subscription stands and the
 * link to Stripe's portal. Payment, cancelling and the card all live at
 * Stripe; this page only sends people there. See ADR-0047.
 */
export function Subscription({
  account,
  returned,
  onSignIn,
  refresh,
}: {
  account: Account | null
  returned: CheckoutReturn
  onSignIn: () => void
  refresh: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [waitedOut, setWaitedOut] = useState(false)

  const waiting = returned === 'merci' && account != null && account.plan !== 'paid'

  // Stripe sends the member back before its webhook has told the Worker, so
  // "paid" arrives a moment after they do. Ask again until it has, for a while.
  useEffect(() => {
    if (!waiting) return
    const poll = window.setInterval(() => void refresh(), POLL_MS)
    const stop = window.setTimeout(() => {
      window.clearInterval(poll)
      setWaitedOut(true)
    }, ACTIVATION_WAIT_MS)
    return () => {
      window.clearInterval(poll)
      window.clearTimeout(stop)
    }
  }, [waiting, refresh])

  async function checkout() {
    setBusy(true)
    setError(null)
    try {
      const { url } = await api.post<{ url: string }>('/api/billing/checkout', {})
      window.location.assign(url)
    } catch (err) {
      setBusy(false)
      if (err instanceof ApiError && err.status === 409) {
        setError('Ce compte a déjà un abonnement.')
        await refresh()
      } else if (err instanceof ApiError && err.status === 503) {
        setError('Le paiement n’est pas encore ouvert. Réessayez plus tard.')
      } else {
        setError('Stripe ne répond pas. Réessayez dans un instant.')
      }
    }
  }

  const manage = account?.manageUrl ? (
    <a className="signin" href={account.manageUrl}>
      Gérer mon abonnement
    </a>
  ) : null

  let status: ReactNode = null
  if (account && (account.renewsOn || account.endsOn)) {
    status = (
      <>
        <p className="lede">Votre abonnement est actif.</p>
        <p className="lede">
          {account.renewsOn
            ? `Prochain renouvellement le ${frenchDay(account.renewsOn)}.`
            : `Il se termine le ${frenchDay(account.endsOn as string)} et ne sera pas renouvelé.`}
        </p>
        <p className="actions">{manage}</p>
      </>
    )
  } else if (account?.plan === 'paid') {
    status = <p className="lede">Votre accès aux deux derniers mois est actif.</p>
  } else if (account?.subscriptionStatus && UNPAID[account.subscriptionStatus]) {
    status = (
      <>
        <p className="lede">{UNPAID[account.subscriptionStatus]}</p>
        <p className="lede">Mettez votre carte à jour chez Stripe pour retrouver l’accès aux deux derniers mois.</p>
        <p className="actions">{manage}</p>
      </>
    )
  } else if (waiting) {
    status = (
      <p className="lede" role="status">
        {waitedOut
          ? 'Stripe a bien reçu votre paiement, mais l’activation tarde. Rechargez cette page dans une minute.'
          : 'Paiement reçu, activation en cours…'}
      </p>
    )
  }

  return (
    <section className="subscription">
      <h1>Abonnement</h1>
      {status ?? (
        <>
          {returned === 'annule' ? <p className="lede">Paiement annulé : rien n’a été débité.</p> : null}
          <div className="offer">
            <p className="offer-price">5 € par mois, sans engagement</p>
            <ul>
              <li>Les diagnostics publiés au cours des deux derniers mois, dans les résultats, sur la carte et en détail.</li>
              <li>La recherche dans tout le reste de l’historique reste gratuite.</li>
              <li>Résiliable à tout moment : l’accès court jusqu’à la fin du mois payé.</li>
              <li>Paiement par carte, sur la page sécurisée de Stripe.</li>
            </ul>
            <p className="actions">
              {account ? (
                <button type="button" className="signin" disabled={busy} onClick={() => void checkout()}>
                  S’abonner — 5 €/mois
                </button>
              ) : (
                <button type="button" className="signin" onClick={onSignIn}>
                  Se connecter pour s’abonner
                </button>
              )}
            </p>
            {error ? <p className="error">{error}</p> : null}
          </div>
        </>
      )}
    </section>
  )
}
