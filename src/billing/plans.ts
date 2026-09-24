/**
 * The plans the « Abonnement » page lays side by side. `id` is what /api/me
 * says in `plan`; adding a plan is one entry here, plus its value in the
 * `user.plan` CHECK. See ADR-0049.
 */
export type PlanId = 'free' | 'decouverte'

export type Plan = {
  id: PlanId
  label: string
  price: string
}

export const PLANS: readonly Plan[] = [
  { id: 'free', label: 'Gratuit', price: '0 €' },
  { id: 'decouverte', label: 'Découverte', price: '5 €/mois' },
]

/**
 * The comparison rows, the same in every card and in this order, each naming
 * the plans that include it. A new plan adds its id to the rows it grants.
 */
export const FEATURES: readonly { label: string; plans: readonly PlanId[] }[] = [
  { label: 'Accès aux DPE historiques', plans: ['free', 'decouverte'] },
  { label: 'Accès aux DPE des deux derniers mois', plans: ['decouverte'] },
]

export function planLabel(id: PlanId): string {
  return PLANS.find((p) => p.id === id)?.label ?? id
}
