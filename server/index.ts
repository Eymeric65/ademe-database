/**
 * The Worker entry point, and the one place the route gate lives.
 *
 * The gate is a default-deny exception list applied ONCE, before dispatch. Two
 * properties follow from that ordering and neither is decoration:
 *
 *   - A route added later is protected because it is new, not because whoever
 *     added it remembered to protect it. Giving a module its own gate is what
 *     makes adding a module the thing that forgets.
 *   - An unmatched /api path answers 401 without a caller rather than 404. A
 *     gate that ran after routing could not tell "no such route" from "route
 *     exists and nobody checked", and neither could a reviewer.
 *
 * Handlers never build a query; they call the scoped exports of server/db.ts.
 * See CLAUDE.md section 9 and ADR-0003.
 */

import { authFor, callerFrom, ensureMigrated, type Caller } from './db'

type Scope = 'public' | 'self' | 'owner'

export type Route = {
  method: string
  path: string
  scope: Scope
  handle: (ctx: {
    request: Request
    env: Env
    caller: Caller
    params: Record<string, string>
  }) => Promise<Response> | Response
}

/**
 * Every route in the application, with its scope.
 *
 * test/unit/authorization.test.ts reads this declaration as text and asserts
 * the `public` and `self` sets against an allowlist it declares itself, so
 * widening one is an edit somebody has to justify in review.
 */
export const ROUTES: Route[] = [
  {
    method: 'GET',
    path: '/api/health',
    scope: 'public',
    handle: async ({ env }) => json({ ok: true, migrations: (await ensureMigrated(env)).length }),
  },
  // Sign-in has to be reachable without being signed in.
  {
    method: 'ANY',
    path: '/api/auth/*',
    scope: 'public',
    handle: ({ request, env }) => authFor(env, new URL(request.url).origin).handler(request),
  },
  {
    method: 'GET',
    path: '/api/me',
    scope: 'self',
    handle: async ({ request, env, caller }) => {
      const session = await authFor(env, new URL(request.url).origin).api.getSession({
        headers: request.headers,
      })
      // The gate already refused a caller with no subject, so a null session
      // here would mean the two disagreed. Fail closed rather than guess.
      if (!session || session.user.id !== caller.sub) return json({ error: 'unauthorized' }, 401)
      const { id, name, email } = session.user
      return json({ id, name, email })
    },
  },
]

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/** Matches `/api/buildings/:id` against a concrete path, returning its params. */
function match(pattern: string, path: string): Record<string, string> | null {
  // A trailing /* matches the whole subtree. Better Auth owns many paths under
  // /api/auth and routes them itself; enumerating them here would mean this
  // file drifting out of date with the library on every upgrade.
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -1)
    return path.startsWith(prefix) ? {} : null
  }
  const p = pattern.split('/')
  const s = path.split('/')
  if (p.length !== s.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < p.length; i++) {
    const seg = p[i] as string
    const got = s[i] as string
    if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(got)
    else if (seg !== got) return null
  }
  return params
}

/**
 * Resolve the caller from the request's session cookie.
 *
 * A failure here resolves to `callerFrom(null)`, which is an empty subject and
 * therefore matches no row -- the gate then answers 401. An auth outage cannot
 * turn into an authorization bypass.
 */
async function callerFor(request: Request, env: Env): Promise<Caller> {
  try {
    const session = await authFor(env, new URL(request.url).origin).api.getSession({
      headers: request.headers,
    })
    return callerFrom(session?.user.id)
  } catch {
    return callerFrom(null)
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    // Anything that is not the API is the React build, served from the ASSETS
    // binding without touching a database.
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request)

    // Before dispatch, not inside a handler: the Worker has no deploy-time
    // hook that can reach D1, so the first request an isolate serves is what
    // brings the schema up to date. Doing it in one handler only would leave
    // every OTHER route to fail with "no such table" on a fresh database.
    await ensureMigrated(env)

    let matched: { route: Route; params: Record<string, string> } | null = null
    for (const route of ROUTES) {
      const params = match(route.path, url.pathname)
      if (params && (route.method === request.method || route.method === 'ANY')) {
        matched = { route, params }
        break
      }
    }

    const caller = await callerFor(request, env)

    // Default-deny, before dispatch. An unmatched path is treated as if it were
    // a protected route, so a missing route and an unprotected one look the same
    // from outside: both need a caller.
    if (matched?.route.scope !== 'public' && caller.sub === '') {
      return json({ error: 'unauthorized' }, 401)
    }
    if (!matched) return json({ error: 'not found' }, 404)

    return matched.route.handle({ request, env, caller, params: matched.params })
  },
} satisfies ExportedHandler<Env>
