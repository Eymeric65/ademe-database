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
const PORTAL = 'https://billing.stripe.test/p/session/bps_e2e'

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

/** Answer the portal route in the browser; returns the bodies it was posted. */
async function stubPortal(page: Page): Promise<unknown[]> {
  const calls: unknown[] = []
  await page.route('**/api/billing/portal', async (route) => {
    calls.push(route.request().postDataJSON())
    await route.fulfill({ json: { url: PORTAL } })
  })
  await page.route('https://billing.stripe.test/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<h1>Stripe portal (stub)</h1>' }),
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
  await expect(page.getByRole('button', { name: 'Gérer ma carte et mes factures' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Résilier mon abonnement' })).toHaveCount(0)

  await page.getByRole('button', { name: 'S’abonner — 5 €/mois' }).click()
  await expect(page).toHaveURL(CHECKOUT)
  expect(calls).toEqual(['POST'])
})

test('the offer links the CGV the checkout asks to accept', async ({ page }) => {
  await page.goto('/#/abonnement')
  await expect(page.getByText('5 € par mois, sans engagement')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Conditions générales de vente' })).toHaveAttribute('href', '/cgv')
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

test('a subscriber cancelled at period end sees when it ends, and can still reach their invoices', async ({ page }) => {
  const email = uniqueEmail('billing-leaving')
  await signUpViaApi(page, email)
  subscribe(email, { days: 12, cancelAtPeriodEnd: true })
  const calls = await stubPortal(page)
  await page.goto('/#/abonnement')

  await expect(page.getByText('Votre abonnement est actif.')).toBeVisible()
  await expect(page.getByText(`Il se termine le ${frenchDay(12)} et ne sera pas renouvelé.`)).toBeVisible()
  // Already cancelled: nothing left to cancel.
  await expect(page.getByRole('button', { name: 'Résilier mon abonnement' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'S’abonner — 5 €/mois' })).toHaveCount(0)

  await page.getByRole('button', { name: 'Gérer ma carte et mes factures' }).click()
  await expect(page).toHaveURL(PORTAL)
  expect(calls).toEqual([{}])
})

test('a subscriber cancels through one « avant de partir » panel, never two', async ({ page }) => {
  const email = uniqueEmail('billing-cancel')
  await signUpViaApi(page, email)
  subscribe(email, { days: 20 })
  const calls = await stubPortal(page)
  await page.goto('/#/abonnement')

  await expect(page.getByText(`Prochain renouvellement le ${frenchDay(20)}.`)).toBeVisible()
  const resilier = page.getByRole('button', { name: 'Résilier mon abonnement' })
  await expect(resilier).toBeVisible()

  // « Garder » closes the panel and asks nothing of anybody.
  await resilier.click()
  const panel = page.getByRole('dialog', { name: 'Avant de partir' })
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('link', { name: 'eymeric.me' })).toHaveAttribute('href', 'https://eymeric.me')
  await expect(panel.getByRole('button', { name: 'Continuer la résiliation' })).toBeVisible()
  await panel.getByRole('button', { name: 'Garder mon abonnement' }).click()
  await expect(panel).toHaveCount(0)
  expect(calls).toEqual([])

  // Escape closes it too.
  await resilier.click()
  await expect(panel).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  expect(calls).toEqual([])

  // « Continuer » is the one extra click: straight to Stripe's cancel page.
  await resilier.click()
  await panel.getByRole('button', { name: 'Continuer la résiliation' }).click()
  await expect(page).toHaveURL(PORTAL)
  expect(calls).toEqual([{ cancel: true }])
})

test('back from Stripe\'s cancel page, the page waits for the webhook and then says when it ends', async ({ page }) => {
  const email = uniqueEmail('billing-resilie')
  await signUpViaApi(page, email)
  // No row yet: the webhook that says "cancelled at period end" has not landed.
  await page.goto('/?abonnement=resilie')

  await expect(page).toHaveURL(/\/#\/abonnement$/)
  await expect(page.getByText('Résiliation enregistrée')).toBeVisible()

  subscribe(email, { days: 9, cancelAtPeriodEnd: true })
  await expect(page.getByText(`Il se termine le ${frenchDay(9)} et ne sera pas renouvelé.`)).toBeVisible({
    timeout: 20_000,
  })
})

test('an account given the plan by hand is told so, with nothing to manage', async ({ page }) => {
  const email = uniqueEmail('billing-comped')
  await signUpViaApi(page, email)
  await makePaid(page, email)
  await page.goto('/#/abonnement')

  await expect(page.getByText('Votre accès aux deux derniers mois est actif.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Gérer ma carte et mes factures' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Résilier mon abonnement' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'S’abonner — 5 €/mois' })).toHaveCount(0)
})

test('a subscription waiting on a failed renewal is sent to Stripe, not to a second checkout', async ({ page }) => {
  const email = uniqueEmail('billing-past-due')
  await signUpViaApi(page, email)
  subscribe(email, { status: 'past_due', days: 25 })
  await page.goto('/#/abonnement')

  await expect(page.getByText('Le dernier paiement n’est pas passé.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Gérer ma carte et mes factures' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'S’abonner — 5 €/mois' })).toHaveCount(0)
})

test('a paid member wears the premium star in the header, a free one does not', async ({ page }) => {
  const email = uniqueEmail('billing-star')
  await signUpViaApi(page, email)
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Se déconnecter' })).toBeVisible()
  await expect(page.locator('.account .premium-star')).toHaveCount(0)

  await makePaid(page, email)
  await page.goto('/')
  await expect(page.locator('.account').getByRole('img', { name: 'Membre Premium' })).toBeVisible()
})
