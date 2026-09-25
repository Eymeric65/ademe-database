import { useEffect, useState } from 'react'
import { isSource, type SourceId } from './data/sources'

/**
 * Hash routing, deliberately.
 *
 * The Worker serves the React build through the ASSETS binding, which maps a
 * path to a file. A history-API route like /saved would ask for a file that is
 * not there, so it needs a catch-all rewrite -- a rule to get wrong, in the one
 * place where getting it wrong also affects /api. The hash never leaves the
 * browser.
 */

/**
 * Which record, in which source, in which partition. The partition travels in
 * the link because an audit step's key says nothing about where it lives.
 */
export type DetailRef = { source: SourceId; key: string; dept: string | null }

export type Route =
  | { name: 'search' }
  | { name: 'saved' }
  | { name: 'presentation' }
  | { name: 'subscription' }
  | ({ name: 'detail' } & DetailRef)

export function parse(hash: string): Route {
  const path = hash.replace(/^#/, '')
  if (path === '/saved') return { name: 'saved' }
  if (path === '/presentation') return { name: 'presentation' }
  if (path === '/abonnement') return { name: 'subscription' }
  // The first links, and every row saved before ADR-0034: existing housing.
  const legacy = /^\/dpe\/([^/]+)$/.exec(path)
  if (legacy) {
    return { name: 'detail', source: 'existant', key: decodeURIComponent(legacy[1] as string), dept: null }
  }
  const detail = /^\/([a-z]+)\/(?:([^/]+)\/)?([^/]+)$/.exec(path)
  if (detail && isSource(detail[1])) {
    return {
      name: 'detail',
      source: detail[1],
      key: decodeURIComponent(detail[3] as string),
      dept: detail[2] ? decodeURIComponent(detail[2]) : null,
    }
  }
  return { name: 'search' }
}

export function detailHref({ source, key, dept }: DetailRef): string {
  const k = encodeURIComponent(key)
  return dept ? `#/${source}/${encodeURIComponent(dept)}/${k}` : `#/${source}/${k}`
}

/** How a member came back from Stripe Checkout or its cancel page, if they just did. */
export type CheckoutReturn = 'merci' | 'annule' | 'resilie' | null

/**
 * Read and clear the query Stripe Checkout sends a member back with.
 *
 * Stripe's return URLs (server/stripe.ts) are the one place this app is
 * reached by query rather than by hash. They are answered by the Abonnement
 * page, and the query is dropped from the address at once, so a reload does
 * not replay "paiement reçu" and a copied link does not carry it.
 */
export function takeCheckoutReturn(): CheckoutReturn {
  const value = new URLSearchParams(window.location.search).get('abonnement')
  if (value !== 'merci' && value !== 'annule' && value !== 'resilie') return null
  window.history.replaceState(null, '', '/#/abonnement')
  return value
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parse(window.location.hash))
  useEffect(() => {
    const onChange = () => setRoute(parse(window.location.hash))
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}
