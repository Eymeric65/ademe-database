import { describe, expect, it } from 'vitest'
import { detailHref, parse } from '../../src/routes'

describe('the hash routes', () => {
  it('keeps the legacy certificate link working', () => {
    expect(parse('#/dpe/2107E0132696Z')).toEqual({
      name: 'detail',
      source: 'existant',
      key: '2107E0132696Z',
      dept: null,
    })
  })

  it('carries the source and partition, so a detail reads one known file', () => {
    expect(parse('#/audit/09/abacf936-8b57-46a1-b920-fc072cb29e7e')).toEqual({
      name: 'detail',
      source: 'audit',
      key: 'abacf936-8b57-46a1-b920-fc072cb29e7e',
      dept: '09',
    })
  })

  it('round-trips through detailHref', () => {
    for (const r of [
      { source: 'neuf', key: '2109N0084499R', dept: '09' },
      { source: 'existant', key: '2107E0132696Z', dept: null },
      { source: 'tertiaire', key: '2109T0155160Q', dept: '2A' },
    ] as const) {
      expect(parse(detailHref(r))).toEqual({ name: 'detail', ...r })
    }
  })

  it('does not take an unknown source for a certificate', () => {
    expect(parse('#/bogus/09/X')).toEqual({ name: 'search' })
    expect(parse('#/saved')).toEqual({ name: 'saved' })
  })
})
