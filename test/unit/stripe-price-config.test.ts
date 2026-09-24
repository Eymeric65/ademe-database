/**
 * Production's live price id is a Worker secret, set with
 * `wrangler secret put STRIPE_PRICE_ID`, not a var in wrangler.jsonc. See
 * ADR-0050.
 *
 * Read through wrangler's own config reader, so this sees what a deploy sees.
 */

import { resolve } from 'node:path'
import { unstable_readConfig } from 'wrangler'
import { describe, expect, it } from 'vitest'

const CONFIG = resolve(import.meta.dirname, '../../wrangler.jsonc')

describe('STRIPE_PRICE_ID', () => {
  it('is not a production var, which would block the secret and be reset by every deploy', () => {
    const vars = unstable_readConfig({ config: CONFIG }).vars
    expect(Object.keys(vars)).not.toContain('STRIPE_PRICE_ID')
  })

  it('stays a var on previews, with a test-mode price', () => {
    const vars = unstable_readConfig({ config: CONFIG, env: 'preview' }).vars
    expect(vars.STRIPE_PRICE_ID).toMatch(/^price_/)
  })
})
