import { expect, test, type Page } from '@playwright/test'
import { makePaid, signUpViaApi, subscribe, uniqueEmail } from './helpers'

/**
 * The « Abonnement » page, through the browser. See ADR-0047.
 *
 * Stripe is never reached. Checkout is intercepted where the browser calls
 * it -- the Worker's side of that call, and the webhook, are tested against
 * real D1 in test/db/billing.test.ts -- and a subscription is written into D1
 * the way the webhook leaves one. What is asserted here is what a member sees
 * and where each button sends them.
 */

const CHECKOUT = 'https://checkout.stripe.test/c/pay/cs_e2e'

/** "2026-10-22" as the page writes it: « 22 octobre 2026 ». */
function frenchDay(offsetDays: number): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000)
  return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d)
}

async function stubCheckout(page: Page): Promise<string[]> {
  const calls: string[] = []
  await page.route('**/api/billing/checkout', async (route) => {
    calls.push(route.request().method())
    await route.fulfill({ json: { url: CHECKOUT } })
  })
  await page.route('https://checkout.stripe.test/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<h1>Stripe Checkout (stub)</h1>' }),
  )
  return calls
}

test('a free member is offered the plan, and the button opens Stripe Checkout', async ({ page }) => {
  await signUpViaApi(page, uniqueEmail('billing-free'))
  const calls = await stubCheckout(page)
  await page.goto('/')

  await page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name: 'Abonnement' }).click()
  await expect(page.getByRole('heading', { name: 'Abonnement' })).toBeVisible()
  await expect(page.getByText('5 € par mois, sans engagement')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Gérer mon abonnement' })).toHaveCount(0)

  await page.getByRole('button', { name: 'S’abonner — 5 €/mois' }).click()
  await expect(page).toHaveURL(CHECKOUT)
  expect(calls).toEqual(['POST'])
})

test('somebody signed out is asked to sign in first', async ({ page }) => {
  await page.goto('/#/abonnement')
  await expect(page.getByText('5 € par mois, sans engagement')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Se connecter pour s’abonner' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'S’abonner — 5 €/mois' })).toHaveCount(0)
})

test('back from a paid checkout, the page waits for the webhook and then says so', async ({ page }) => {
  const email = uniqueEmail('billing-return')
  await signUpViaApi(page, email)
  await page.goto('/?abonnement=merci')

  // The query is Stripe's; once read, the address is the page's own.
  await expect(page).toHaveURL(/\/#\/abonnement$/)
  await expect(page.getByText('Paiement reçu, activation en cours…')).toBeVisible()

  subscribe(email, { days: 30 })
  await expect(page.getByText('Votre abonnement est actif.')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText(`Prochain renouvellement le ${frenchDay(30)}.`)).toBeVisible()
})

test('back from a cancelled checkout, nothing was charged', async ({ page }) => {
  await signUpViaApi(page, uniqueEmail('billing-cancelled'))
  await page.goto('/?abonnement=annule')
  await expect(page.getByText('Paiement annulé : rien n’a été débité.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'S’abonner — 5 €/mois' })).toBeVisible()
})

test('a subscriber cancelled at period end sees when it ends, and manages it at Stripe', async ({ page }) => {
  const email = uniqueEmail('billing-leaving')
  await signUpViaApi(page, email)
  subscribe(email, { days: 12, cancelAtPeriodEnd: true })
  await page.goto('/#/abonnement')

  await expect(page.getByText('Votre abonnement est actif.')).toBeVisible()
  await expect(page.getByText(`Il se termine le ${frenchDay(12)} et ne sera pas renouvelé.`)).toBeVisible()
  const manage = page.getByRole('link', { name: 'Gérer mon abonnement' })
  await expect(manage).toHaveAttribute(
    'href',
    `https://billing.stripe.test/p/login/e2e?prefilled_email=${encodeURIComponent(email)}`,
  )
  await expect(page.getByRole('button', { name: 'S’abonner — 5 €/mois' })).toHaveCount(0)
})

test('an account given the plan by hand is told so, with nothing to manage', async ({ page }) => {
  const email = uniqueEmail('billing-comped')
  await signUpViaApi(page, email)
  await makePaid(page, email)
  await page.goto('/#/abonnement')

  await expect(page.getByText('Votre accès aux deux derniers mois est actif.')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Gérer mon abonnement' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'S’abonner — 5 €/mois' })).toHaveCount(0)
})

test('a subscription waiting on a failed renewal is sent to Stripe, not to a second checkout', async ({ page }) => {
  const email = uniqueEmail('billing-past-due')
  await signUpViaApi(page, email)
  subscribe(email, { status: 'past_due', days: 25 })
  await page.goto('/#/abonnement')

  await expect(page.getByText('Le dernier paiement n’est pas passé.')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Gérer mon abonnement' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'S’abonner — 5 €/mois' })).toHaveCount(0)
})
