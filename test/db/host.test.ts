/**
 * One indexable host, and previews out of the index.
 *
 * Both recherche-maison.com and www.recherche-maison.com are custom domains on
 * this Worker, so without the redirect below both answer 200 with the same
 * HTML and Google sees two sites where there is one. The redirect has to be
 * document-level (GET/HEAD) and nothing else: /api/auth/* takes POSTs, and a
 * 301 on a POST drops the body, so a sign-in through the www host would fail
 * in a way no status code explains.
 *
 * Every `wrangler versions upload` publishes the same shell on a
 * *.workers.dev host. Those are crawlable, so they need X-Robots-Tag on the
 * way out -- including on the ASSETS responses, whose headers are immutable
 * and silently drop a set() made on the original object.
 *
 * The exact-hostname gate is load-bearing in the other direction: every test
 * in test/db/ drives the Worker at the literal host `http://x`, so a redirect
 * keyed on "anything that is not the apex" would 301 the whole suite.
 */

import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

describe('the canonical host', () => {
  it('sends www to the apex with the path and query intact', async () => {
    const res = await SELF.fetch('https://www.recherche-maison.com/some/path?q=1', {
      redirect: 'manual',
    })
    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('https://recherche-maison.com/some/path?q=1')
  })

  it('never redirects a POST, because that would drop the body', async () => {
    const res = await SELF.fetch('https://www.recherche-maison.com/api/auth/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'x@example.test' }),
      redirect: 'manual',
    })
    await res.arrayBuffer()
    expect(res.status).not.toBe(301)
  })
})

describe('preview hosts', () => {
  it('tells crawlers to stay away from a workers.dev response', async () => {
    const res = await SELF.fetch('https://abcd-ademe-app-preview.eymeric-chauchat.workers.dev/some/path')
    await res.arrayBuffer()
    expect(res.headers.get('x-robots-tag')).toBe('noindex')
  })

  it('leaves the production host indexable', async () => {
    const res = await SELF.fetch('https://recherche-maison.com/some/path')
    await res.arrayBuffer()
    expect(res.headers.get('x-robots-tag')).toBe(null)
  })
})
