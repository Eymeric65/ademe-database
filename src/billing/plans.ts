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
  perks: string[]
}

export const PLANS: readonly Plan[] = [
  { id: 'free', label: 'Gratuit', price: '0 €', perks: ['Recherche dans tous les DPE publiés'] },
  {
    id: 'decouverte',
    label: 'Découverte',
    price: '5 €/mois',
    perks: ['Tout le plan Gratuit', 'Les deux derniers mois disponibles à la recherche'],
  },
]

export function planLabel(id: PlanId): string {
  return PLANS.find((p) => p.id === id)?.label ?? id
}
