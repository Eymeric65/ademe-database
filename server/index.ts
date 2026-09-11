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

import {
  authFor,
  callerFrom,
  deleteSavedBuilding,
  deleteSavedSearch,
  ensureMigrated,
  listSavedBuildings,
  listSavedSearches,
  saveBuilding,
  saveSearch,
  type Caller,
} from './db'

/**
 * `signed-in` asks for a caller and filters on nothing, because the data it
 * guards has no owner. That makes it WEAKER than `owner`, so it must never
 * appear on an /api route -- test/unit/authorization.test.ts refuses that
 * outright. See ADR-0012.
 */
type Scope = 'public' | 'signed-in' | 'self' | 'owner'

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

  // --- saved buildings ----------------------------------------------------
  {
    method: 'GET',
    path: '/api/buildings',
    scope: 'owner',
    handle: async ({ env, caller }) => json(await listSavedBuildings(env, caller)),
  },
  {
    method: 'POST',
    path: '/api/buildings',
    scope: 'owner',
    handle: async ({ request, env, caller }) => {
      const body = await readJson(request)
      const numeroDpe = str(body.numeroDpe)
      if (!numeroDpe) return json({ error: 'numeroDpe is required' }, 400)
      const note = body.note == null ? null : str(body.note)
      const rows = await saveBuilding(env, caller, { id: crypto.randomUUID(), numeroDpe, note })
      return json(rows[0] ?? null, 201)
    },
  },
  {
    method: 'DELETE',
    path: '/api/buildings/:id',
    scope: 'owner',
    handle: async ({ env, caller, params }) => {
      const rows = await deleteSavedBuilding(env, caller, params.id as string)
      // 404, never 403: telling a stranger that an id exists but is not theirs
      // is itself a disclosure, and there is nothing to gain by it.
      return rows.length ? json(rows[0]) : json({ error: 'not found' }, 404)
    },
  },

  // --- saved searches -----------------------------------------------------
  {
    method: 'GET',
    path: '/api/searches',
    scope: 'owner',
    handle: async ({ env, caller }) => json(await listSavedSearches(env, caller)),
  },
  {
    method: 'POST',
    path: '/api/searches',
    scope: 'owner',
    handle: async ({ request, env, caller }) => {
      const body = await readJson(request)
      const name = str(body.name)
      if (!name) return json({ error: 'name is required' }, 400)
      if (body.spec == null || typeof body.spec !== 'object') {
        return json({ error: 'spec must be an object' }, 400)
      }
      const visibility = body.visibility === 'unlisted' ? 'unlisted' : 'private'
      const rows = await saveSearch(env, caller, {
        id: crypto.randomUUID(),
        name,
        spec: body.spec,
        visibility,
      })
      return json(rows[0] ?? null, 201)
    },
  },
  {
    method: 'DELETE',
    path: '/api/searches/:id',
    scope: 'owner',
    handle: async ({ env, caller, params }) => {
      const rows = await deleteSavedSearch(env, caller, params.id as string)
      return rows.length ? json(rows[0]) : json({ error: 'not found' }, 404)
    },
  },

  // --- the data plane -----------------------------------------------------
  // The engine, not the data: 77 MB of open-source WASM that has to load
  // before the app can render anything, including the screen that asks
  // somebody to sign in. Gating it would mean gating the sign-in screen.
  {
    method: 'ANY',
    path: '/data/vendor/*',
    scope: 'public',
    handle: ({ request, env }) => serveObject(request, env, { immutable: true }),
  },
  // The certificates. Public data with no owner, and a session is still
  // required to fetch a byte of it -- ADR-0012.
  {
    method: 'ANY',
    path: '/data/v1/*',
    scope: 'signed-in',
    handle: ({ request, env }) => serveObject(request, env, { immutable: false }),
  },
]

/** Bodies are validated by hand; a schema library is not worth a dependency here. */
async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json()
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** A non-empty string, or ''. Never coerces an object or a number into one. */
function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/**
 * Stream one object out of the data bucket, preserving HTTP ranges.
 *
 * Range is load-bearing, not a nicety: DuckDB-WASM reads a Parquet footer and
 * then only the row groups it needs (ADR-0006). A proxy that answered every
 * request with the whole file would still work, and would download an entire
 * partition per search.
 */
async function serveObject(
  request: Request,
  env: Env,
  { immutable }: { immutable: boolean },
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: 'method not allowed' }, 405)
  }

  const key = decodeURIComponent(new URL(request.url).pathname.slice('/data/'.length))
  // No key can climb out of the bucket, but a `..` in a path is worth refusing
  // on sight rather than reasoning about R2's key semantics every time.
  if (key === '' || key.includes('..')) return json({ error: 'not found' }, 404)

  const headers = new Headers()
  // DuckDB asks HEAD whether ranges are available before it asks for bytes; an
  // answer without this makes it fall back to whole-file reads.
  headers.set('accept-ranges', 'bytes')
  // TRAP: `private`, never `public`, on anything gated. A public directive puts
  // one caller's bytes in a shared edge cache, where the next request reads
  // them without ever reaching the gate above.
  headers.set(
    'cache-control',
    immutable ? 'public, max-age=31536000, immutable' : 'private, max-age=300',
  )

  if (request.method === 'HEAD') {
    const meta = await env.DATA.head(key)
    if (!meta) return json({ error: 'not found' }, 404)
    meta.writeHttpMetadata(headers)
    headers.set('etag', meta.httpEtag)
    headers.set('content-length', String(meta.size))
    return new Response(null, { status: 200, headers })
  }

  const asked = parseRange(request.headers.get('range'))
  let object: R2Object | R2ObjectBody | null
  try {
    object = await env.DATA.get(key, {
      ...(asked ? { range: asked } : {}),
      // Only when the browser is revalidating. Passing the headers
      // unconditionally would let an If-Match arrive and turn a plain read into
      // a 412 nobody asked for.
      ...(request.headers.has('if-none-match') ? { onlyIf: request.headers } : {}),
    })
  } catch {
    // R2 refuses a range that starts past the end of the object.
    return new Response(null, { status: 416, headers })
  }
  if (!object) return json({ error: 'not found' }, 404)

  object.writeHttpMetadata(headers)
  headers.set('etag', object.httpEtag)

  // A precondition that failed comes back as an R2Object with no body.
  if (!('body' in object) || object.body == null) {
    return new Response(null, { status: 304, headers })
  }

  if (asked) {
    const start = 'suffix' in asked ? Math.max(0, object.size - asked.suffix) : asked.offset
    const length = Math.min(
      'suffix' in asked ? asked.suffix : (asked.length ?? object.size - start),
      object.size - start,
    )
    headers.set('content-range', `bytes ${start}-${start + length - 1}/${object.size}`)
    headers.set('content-length', String(length))
    return new Response(object.body, { status: 206, headers })
  }
  headers.set('content-length', String(object.size))
  return new Response(object.body, { status: 200, headers })
}

/** What the client asked for, in R2's own shape but with nothing optional. */
type Span = { offset: number; length?: number } | { suffix: number }

/**
 * `bytes=0-99` -> `{ offset: 0, length: 100 }`.
 *
 * TRAP: parsed here rather than handed to R2 as `range: request.headers`. That
 * shortcut looks equivalent and is not -- the R2Range that comes back carries
 * all three keys with the unused ones undefined, so `'suffix' in range` is true
 * for an ordinary offset range and the Content-Range came out as
 * `bytes NaN-30213/30214` while the whole file was served with status 206.
 *
 * A header this function does not understand (a multi-range, anything odd)
 * returns null, and the caller answers 200 with the whole object. Slower, never
 * wrong.
 */
function parseRange(header: string | null): Span | null {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  const [, rawStart, rawEnd] = m as unknown as [string, string, string]
  if (rawStart === '') {
    const suffix = Number(rawEnd)
    return Number.isFinite(suffix) && suffix > 0 ? { suffix } : null
  }
  const offset = Number(rawStart)
  if (!Number.isFinite(offset)) return null
  if (rawEnd === '') return { offset }
  const end = Number(rawEnd)
  if (!Number.isFinite(end) || end < offset) return null
  return { offset, length: end - offset + 1 }
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

/**
 * Prefixes the router owns. A path under one of these reaches the gate even
 * when no route matches it, which is what keeps 401-before-404 true; anything
 * else is a static asset.
 *
 * TRAP: this list is why the assets fallback sits BELOW the match loop. It used
 * to be the first line of `fetch`, and moving /data/* behind the gate with that
 * ordering left it served straight out of ASSETS -- gated in the route table
 * and wide open in practice.
 */
const ROUTED_PREFIXES = ['/api/', '/data/']

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    let matched: { route: Route; params: Record<string, string> } | null = null
    for (const route of ROUTES) {
      const params = match(route.path, url.pathname)
      if (params && (route.method === request.method || route.method === 'ANY')) {
        matched = { route, params }
        break
      }
    }

    // The React build, served from the ASSETS binding without touching a
    // database. Only what the router does not own.
    if (!matched && !ROUTED_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) {
      return env.ASSETS.fetch(request)
    }

    // Before dispatch, not inside a handler: the Worker has no deploy-time
    // hook that can reach D1, so the first request an isolate serves is what
    // brings the schema up to date. Doing it in one handler only would leave
    // every OTHER route to fail with "no such table" on a fresh database.
    await ensureMigrated(env)

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
