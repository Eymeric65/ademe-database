import { useEffect, useRef, useState, type ReactNode } from 'react'
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
 * buttons that open Stripe's portal. Payment, cancelling and the card all live
 * at Stripe; this page only sends people there. See ADR-0047 and ADR-0048.
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
  const [leaving, setLeaving] = useState(false)

  const activating = returned === 'merci' && account != null && account.plan !== 'paid'
  const cancelling = returned === 'resilie' && account != null && !account.endsOn
  const waiting = activating || cancelling

  // Stripe sends the member back before its webhook has told the Worker, so
  // "paid" -- or "ends on" -- arrives a moment after they do. Ask again until
  // it has, for a while.
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

  /**
   * Open Stripe's portal. With `cancel`, straight on its cancel page, whose
   * own confirmation is the last click: the panel before it is the only step
   * of ours, and it adds exactly one (L215-1-1; ADR-0048).
   */
  async function portal(cancel: boolean) {
    setBusy(true)
    setError(null)
    try {
      const { url } = await api.post<{ url: string }>('/api/billing/portal', cancel ? { cancel: true } : {})
      window.location.assign(url)
    } catch (err) {
      setBusy(false)
      setLeaving(false)
      if (err instanceof ApiError && err.status === 404) {
        setError('Aucun abonnement à gérer chez Stripe.')
        await refresh()
      } else if (err instanceof ApiError && err.status === 503) {
        setError('Le paiement n’est pas encore ouvert. Réessayez plus tard.')
      } else {
        setError('Stripe ne répond pas. Réessayez dans un instant.')
      }
    }
  }

  const manage = (
    <>
      <p className="actions">
        <button type="button" className="signin" disabled={busy} onClick={() => void portal(false)}>
          Gérer ma carte et mes factures
        </button>
        {account?.endsOn ? null : (
          <button type="button" className="signin" disabled={busy} onClick={() => setLeaving(true)}>
            Résilier mon abonnement
          </button>
        )}
      </p>
      {error ? <p className="error">{error}</p> : null}
      {leaving ? (
        <BeforeLeaving busy={busy} onContinue={() => void portal(true)} onKeep={() => setLeaving(false)} />
      ) : null}
    </>
  )

  let status: ReactNode = null
  if (cancelling) {
    status = (
      <p className="lede" role="status">
        {waitedOut
          ? 'Résiliation enregistrée chez Stripe, mais la mise à jour tarde. Rechargez cette page dans une minute.'
          : 'Résiliation enregistrée. Mise à jour en cours…'}
      </p>
    )
  } else if (account && (account.renewsOn || account.endsOn)) {
    status = (
      <>
        {returned === 'resilie' ? (
          <p className="lede" role="status">
            Résiliation enregistrée.
          </p>
        ) : null}
        <p className="lede">Votre abonnement est actif.</p>
        <p className="lede">
          {account.renewsOn
            ? `Prochain renouvellement le ${frenchDay(account.renewsOn)}.`
            : `Il se termine le ${frenchDay(account.endsOn as string)} et ne sera pas renouvelé.`}
        </p>
        {manage}
      </>
    )
  } else if (account?.plan === 'paid') {
    status = <p className="lede">Votre accès aux deux derniers mois est actif.</p>
  } else if (account?.subscriptionStatus && UNPAID[account.subscriptionStatus]) {
    status = (
      <>
        <p className="lede">{UNPAID[account.subscriptionStatus]}</p>
        <p className="lede">Mettez votre carte à jour chez Stripe pour retrouver l’accès aux deux derniers mois.</p>
        {manage}
      </>
    )
  } else if (activating) {
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

/**
 * « Avant de partir »: who the subscription pays for, once, then out of the
 * way. Both buttons weigh the same and « Continuer » comes first; no
 * countdown, no offer, no second panel. The legal basis is in ADR-0048.
 */
function BeforeLeaving({ busy, onContinue, onKeep }: { busy: boolean; onContinue: () => void; onKeep: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null)
  const keep = useRef(onKeep)
  keep.current = onKeep

  // Once per opening: focus in, Escape out, focus back where it came from.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    heading.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') keep.current()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      opener?.focus()
    }
  }, [])

  return (
    <div className="leaving-backdrop">
      <div className="leaving" role="dialog" aria-modal="true" aria-labelledby="leaving-title">
        <h2 id="leaving-title" ref={heading} tabIndex={-1}>
          Avant de partir
        </h2>
        <p>
          Je m’appelle Eymeric, je suis étudiant, et je construis et fais tourner ce site seul. Votre abonnement
          paie les serveurs, les données et le temps que j’y passe.
        </p>
        <p>Merci de l’avoir soutenu, ça compte vraiment.</p>
        <p>
          Pour savoir qui est derrière : <a href="https://eymeric.me">eymeric.me</a>
        </p>
        <p className="actions">
          <button type="button" className="signin" disabled={busy} onClick={onContinue}>
            Continuer la résiliation
          </button>
          <button type="button" className="signin" disabled={busy} onClick={onKeep}>
            Garder mon abonnement
          </button>
        </p>
      </div>
    </div>
  )
}
