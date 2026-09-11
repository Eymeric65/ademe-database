/**
 * Uploads a preview version of the Worker and prints its URL.
 *
 * `wrangler versions upload` publishes a version WITHOUT deploying it, so the
 * live Worker is untouched and the preview can be handed over before the PR
 * exists (CLAUDE.md section 5). `--env preview` suffixes the Worker name, so
 * the deployed name is `ademe-app-preview` and it binds the separate
 * `ademe-app-preview` D1 -- a preview can never write to real user data.
 *
 * `--preview-alias` is what makes the URL predictable: without it the host is
 * derived from the version id, which is not known until after the upload and
 * changes on every push.
 */

import { execFileSync } from 'node:child_process'

const WORKER = 'ademe-app-preview'

/** DNS labels cap at 63 characters, and the alias shares one with the worker. */
const MAX_LABEL = 63

export function aliasFor(branch: string): string {
  const slug = branch
    .replace(/^feat\//, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  const room = MAX_LABEL - (WORKER.length + 1)
  return (slug.slice(0, room).replace(/-$/, '') || 'preview')
}

/** The account subdomain, which is the only part of the URL we cannot compute. */
function subdomainFrom(stdout: string): string {
  const m = stdout.match(/https?:\/\/[^\s]*?([a-z0-9-]+)\.workers\.dev/i)
  if (!m) {
    throw new Error(
      'could not find a .workers.dev host in wrangler output; set WORKERS_SUBDOMAIN to skip this',
    )
  }
  return m[1] as string
}

function main(): void {
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    encoding: 'utf8',
  }).trim()
  const alias = aliasFor(branch)

  const out = execFileSync(
    'npx',
    ['wrangler', 'versions', 'upload', '--env', 'preview', '--preview-alias', alias],
    { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] },
  )
  process.stdout.write(out)

  const subdomain = process.env.WORKERS_SUBDOMAIN || subdomainFrom(out)
  console.log(`\npreview: https://${alias}-${WORKER}.${subdomain}.workers.dev`)
}

if (process.argv[1]?.endsWith('preview.ts')) main()
