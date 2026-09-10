import { useEffect, useState } from 'react'

/**
 * Hash routing, deliberately.
 *
 * The Worker serves the React build through the ASSETS binding, which maps a
 * path to a file. A history-API route like /saved would ask for a file that is
 * not there, so it needs a catch-all rewrite -- a rule to get wrong, in the one
 * place where getting it wrong also affects /api. The hash never leaves the
 * browser.
 */
export type Route = { name: 'search' } | { name: 'saved' }

export function parse(hash: string): Route {
  return hash.replace(/^#/, '') === '/saved' ? { name: 'saved' } : { name: 'search' }
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
