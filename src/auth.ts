import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from './api'
import type { PlanId } from './billing/plans'

/**
 * `plan` is 'decouverte' for a comp set on D1 by hand (ADR-0038) or a Stripe
 * subscription in force (ADR-0047); any plan but 'free' reads the last two
 * months. `planSource` says which of the two, and is null on 'free' (ADR-0049).
 * The rest describes that subscription, and is null without one.
 */
export type Account = {
  id: string
  name: string
  email: string
  plan: PlanId
  planSource: 'lifetime' | 'stripe' | null
  subscriptionStatus: string | null
  /** ISO dates, set only while the subscription entitles. */
  renewsOn: string | null
  endsOn: string | null
}

/**
 * Who is signed in, from /api/me.
 *
 * `undefined` means "not asked yet" and `null` means "nobody". Collapsing the
 * two would flash the signed-out header at a signed-in user on every load,
 * which looks exactly like being logged out.
 */
export function useSession() {
  const [account, setAccount] = useState<Account | null | undefined>(undefined)

  const refresh = useCallback(async () => {
    try {
      setAccount(await api.get<Account>('/api/me'))
    } catch (err) {
      // 401 is the ordinary signed-out answer, not a failure to report.
      if (err instanceof ApiError && err.status === 401) setAccount(null)
      else setAccount(null)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const signInWithGoogle = useCallback(async () => {
    const { url } = await api.post<{ url: string }>('/api/auth/sign-in/social', {
      provider: 'google',
      callbackURL: `${window.location.origin}/`,
    })
    window.location.href = url
  }, [])

  const signOut = useCallback(async () => {
    await api.post('/api/auth/sign-out', {})
    setAccount(null)
  }, [])

  return { account, loading: account === undefined, refresh, signInWithGoogle, signOut }
}
