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
export type Route =
  | { name: 'search' }
  | { name: 'saved' }
  | { name: 'detail'; numero: string }

export function parse(hash: string): Route {
  const path = hash.replace(/^#/, '')
  if (path === '/saved') return { name: 'saved' }
  const detail = /^\/dpe\/([^/]+)$/.exec(path)
  if (detail) return { name: 'detail', numero: decodeURIComponent(detail[1] as string) }
  return { name: 'search' }
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
