import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api, ApiError } from '../api'
import type { Account } from '../auth'
import type { CheckoutReturn } from '../routes'
import { PLANS, planLabel } from './plans'

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
 * The « Abonnement » page: a status line saying which plan the member is on,
 * where its subscription stands and the one or two buttons that act on it,
 * then every plan side by side, the same for everyone. Payment, cancelling and
 * the card all live at Stripe; this page only sends people there. See
 * ADR-0047, ADR-0048 and ADR-0049.
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

  const activating = returned === 'merci' && account != null && account.plan === 'free'
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
      <button type="button" className="signin" disabled={busy} onClick={() => void portal(false)}>
        Gérer ma carte et mes factures
      </button>
      {account?.endsOn ? null : (
        <button type="button" className="signin" disabled={busy} onClick={() => setLeaving(true)}>
          Résilier mon abonnement
        </button>
      )}
    </>
  )

  const offer = account ? (
    <button type="button" className="signin" disabled={busy} onClick={() => void checkout()}>
      Passer à Découverte — 5 €/mois
    </button>
  ) : (
    <button type="button" className="signin" onClick={onSignIn}>
      Se connecter pour s’abonner
    </button>
  )

  // What is happening to the plan, then the buttons that act on it. The cards
  // below never change with the state; this is the only part that does.
  let lines: ReactNode = null
  let buttons: ReactNode = null
  let terms = false
  if (cancelling) {
    lines = (
      <p className="lede" role="status">
        {waitedOut
          ? 'Résiliation enregistrée chez Stripe, mais la mise à jour tarde. Rechargez cette page dans une minute.'
          : 'Résiliation enregistrée. Mise à jour en cours…'}
      </p>
    )
  } else if (account && (account.renewsOn || account.endsOn)) {
    lines = (
      <>
        {returned === 'resilie' ? (
          <p className="lede" role="status">
            Résiliation enregistrée.
          </p>
        ) : null}
        <p className="lede">
          {account.renewsOn
            ? `Prochain renouvellement le ${frenchDay(account.renewsOn)}.`
            : `Il se termine le ${frenchDay(account.endsOn as string)} et ne sera pas renouvelé.`}
        </p>
      </>
    )
    buttons = manage
  } else if (account?.planSource === 'lifetime') {
    lines = <p className="lede">Accordé à vie : rien à payer ni à renouveler.</p>
  } else if (account?.subscriptionStatus && UNPAID[account.subscriptionStatus]) {
    lines = (
      <>
        <p className="lede">{UNPAID[account.subscriptionStatus]}</p>
        <p className="lede">Mettez votre carte à jour chez Stripe pour retrouver l’accès aux deux derniers mois.</p>
      </>
    )
    buttons = manage
  } else if (activating) {
    lines = (
      <p className="lede" role="status">
        {waitedOut
          ? 'Stripe a bien reçu votre paiement, mais l’activation tarde. Rechargez cette page dans une minute.'
          : 'Paiement reçu, activation en cours…'}
      </p>
    )
  } else if (!account || account.plan === 'free') {
    lines = (
      <>
        {returned === 'annule' ? <p className="lede">Paiement annulé : rien n’a été débité.</p> : null}
        <p className="lede">Sans engagement, résiliable à tout moment. Paiement par carte, chez Stripe.</p>
      </>
    )
    buttons = offer
    terms = true
  }

  return (
    <section className="subscription">
      <h1>Abonnement</h1>
      <div className="plan-status">
        <p className="plan-now">
          {account ? (
            <>
              Vous êtes actuellement sur le plan <strong>{planLabel(account.plan)}</strong>.
            </>
          ) : (
            'Connectez-vous pour choisir votre plan.'
          )}
        </p>
        {lines}
        {buttons ? <p className="actions">{buttons}</p> : null}
        {error ? <p className="error">{error}</p> : null}
        {terms ? (
          <p className="offer-terms">
            <a href="/cgv">Conditions générales de vente</a>
          </p>
        ) : null}
      </div>

      <div className="plans">
        {PLANS.map((plan) => {
          const current = account?.plan === plan.id
          return (
            <article
              key={plan.id}
              className={current ? 'plan-card current' : 'plan-card'}
              aria-labelledby={`plan-${plan.id}`}
            >
              {current ? <p className="plan-marker">Votre plan</p> : null}
              <h2 id={`plan-${plan.id}`}>{plan.label}</h2>
              {current && account?.planSource === 'lifetime' ? <p className="plan-tag">Plan à vie</p> : null}
              <p className="plan-price">{plan.price}</p>
              <ul>
                {plan.perks.map((perk) => (
                  <li key={perk}>{perk}</li>
                ))}
              </ul>
            </article>
          )
        })}
      </div>

      {leaving ? (
        <BeforeLeaving busy={busy} onContinue={() => void portal(true)} onKeep={() => setLeaving(false)} />
      ) : null}
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
