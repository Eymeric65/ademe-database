import { describe, expect, it } from 'vitest'
import { SAVED_SOURCES } from '../../db/schema'
import {
  dateBounds,
  formatDate,
  parcelDept,
  parseDecimal,
  parsePoint,
  partitionsForPostcode,
  SOURCE,
  SOURCES,
  searchQuery,
  toHit,
  type Partition,
} from '../../src/data/sources'

/**
 * The query the search screen sends, built without a browser.
 *
 * These functions decide which files a search downloads and what SQL runs on
 * them, which is the whole of the product's cost and most of its correctness.
 */

const part = (dept: string, codes?: string[]): Partition => ({ dept, codes: codes ?? [dept], rows: 1 })

// The shape of the published manifests: DOM merges different codes per source.
const EXISTANT = [
  part('09'), part('48'), part('75'), part('2A'), part('2B'),
  part('971'), part('972'), part('988'), part('DOM', ['975', '976', '978']), part('NG'),
]
const NEUF = [part('09'), part('971'), part('DOM', ['975', '976', '978']), part('NG')]

describe('partitionsForPostcode', () => {
  it('reads the département the postcode starts with', () => {
    expect(partitionsForPostcode(EXISTANT, '09000')).toEqual(['09'])
    expect(partitionsForPostcode(EXISTANT, ' 75 011 ')).toEqual(['75'])
  })

  it('reads both Corsican partitions for a 20xxx postcode', () => {
    expect(partitionsForPostcode(EXISTANT, '20000')).toEqual(['2A', '2B'])
  })

  it('reads an overseas département on three digits, not the DOM file', () => {
    expect(partitionsForPostcode(EXISTANT, '97200')).toEqual(['972'])
  })

  it('reads DOM too for 971, where Saint-Barthélemy and Saint-Martin post', () => {
    // 97133 is 977 and 97150 is 978, both merged into DOM.
    expect(partitionsForPostcode(EXISTANT, '97133')).toEqual(['971', 'DOM'])
  })

  it('finds a merged code inside DOM', () => {
    expect(partitionsForPostcode(EXISTANT, '97600')).toEqual(['DOM'])
  })

  it('reads nothing, rather than everything, for a code the source lacks', () => {
    expect(partitionsForPostcode(NEUF, '98800')).toEqual([])
    expect(partitionsForPostcode(EXISTANT, '9')).toEqual([])
  })
})

describe('dateBounds', () => {
  it('takes a day-precise range', () => {
    expect(dateBounds({ dateDu: '2021-08-01', dateAu: '2021-08-31' })).toEqual({
      from: '2021-08-01',
      to: '2021-08-31',
    })
  })

  it('takes either side alone', () => {
    expect(dateBounds({ dateDu: '2021-08-04' })).toEqual({ from: '2021-08-04' })
    expect(dateBounds({ dateAu: '2021-08-04' })).toEqual({ to: '2021-08-04' })
  })

  it('swaps a range entered backwards', () => {
    expect(dateBounds({ dateDu: '2021-09-01', dateAu: '2021-08-01' })).toEqual({
      from: '2021-08-01',
      to: '2021-09-01',
    })
  })

  it('reads a month from a saved search as its first and last day', () => {
    expect(dateBounds({ moisEtablissement: '2024-02' })).toEqual({
      from: '2024-02-01',
      to: '2024-02-29',
    })
  })

  it('ignores what is not a date', () => {
    expect(dateBounds({ dateDu: '03/08/2021' })).toEqual({})
  })
})

describe('searchQuery', () => {
  const files = ['https://x/data/v1/search/dept=09/part-0000.parquet']

  it('filters the day range on the DATE column, where row groups can be skipped', () => {
    const q = searchQuery(SOURCE.existant, { codePostal: '09000', dateDu: '2021-08-01', dateAu: '2021-08-31' }, files)
    expect(q.sql).toContain('date_etablissement_dpe BETWEEN CAST(? AS DATE) AND CAST(? AS DATE)')
    expect(q.sql).not.toContain('strftime')
    expect(q.params).toEqual(['09000', '2021-08-01', '2021-08-31'])
  })

  it('binds the surface instead of writing it into the SQL', () => {
    const q = searchQuery(SOURCE.existant, { codePostal: '09000', surface: 176 }, files)
    expect(q.sql).not.toContain('176')
    expect(q.sql).toContain('ORDER BY abs(surface_habitable_logement - ?)')
    expect(q.params).toEqual(['09000', 171, 181, 176])
  })

  it('uses each source’s own columns', () => {
    const t = searchQuery(SOURCE.tertiaire, { codePostal: '09100', surface: 100, etiquetteDpe: 'C' }, files)
    expect(t.sql).toContain('surface_utile BETWEEN ? AND ?')
    expect(t.sql).toContain('etiquette_dpe = ?')
    const a = searchQuery(
      SOURCE.audit,
      { codePostal: '09400', etiquetteDpe: 'F', surface: 80, dateDu: '2023-09-01' },
      files,
    )
    // Audit measures are published as text (ADR-0032).
    expect(a.sql).toContain('TRY_CAST(surface_habitable_logement AS DOUBLE) BETWEEN ? AND ?')
    expect(a.sql).toContain('classe_bilan_dpe = ?')
    expect(a.sql).toContain('date_etablissement_audit')
  })

  it('never reads the hive folder name as a column', () => {
    const q = searchQuery(SOURCE.neuf, { codePostal: '09100', etiquetteDpe: 'A' }, files)
    expect(q.sql).toContain('hive_partitioning = false')
  })

  it('refuses to build a query over no files', () => {
    expect(() => searchQuery(SOURCE.existant, { commune: 'Foix' }, [])).toThrow()
  })
})

describe('toHit', () => {
  it('names the partition the row was read from', () => {
    const hit = toHit(SOURCE.audit, {
      id_etape: 'abc',
      n_audit: 'A1',
      code_postal_ban: '09400',
      classe_bilan_dpe: 'F',
      date_etablissement_audit: Date.UTC(2023, 8, 5),
      surface_habitable_logement: '80.25',
      filename: 'https://x/data/v1/audit/search/dept=09/part-0000.parquet?v=abc',
      total: 3n,
    })
    expect(hit).toMatchObject({
      source: 'audit',
      key: 'abc',
      dept: '09',
      classe: 'F',
      date: '2023-09-05',
      surface: 80.25,
    })
  })
})

describe('parsing', () => {
  it('reads a French decimal comma', () => {
    expect(parseDecimal('12,5')).toBe(12.5)
    expect(parseDecimal(' 176 ')).toBe(176)
    expect(parseDecimal('abc')).toBeUndefined()
    expect(parseDecimal('')).toBeUndefined()
  })

  it('formats a date as the day it is, whatever the time zone', () => {
    expect(formatDate(Date.UTC(2021, 7, 3))).toBe('03/08/2021')
    expect(formatDate('2021-08-03')).toBe('03/08/2021')
    expect(formatDate(new Date(Date.UTC(2021, 7, 3)))).toBe('03/08/2021')
    expect(formatDate(null)).toBe('')
  })

  it('reads the département out of a parcel id', () => {
    expect(parcelDept('09001000AE0006')).toBe('09')
    expect(parcelDept('2A004000AB0001')).toBe('2A')
    expect(parcelDept('971010000A0001')).toBe('971')
  })

  it('reads an RNB point', () => {
    expect(parsePoint('SRID=4326;POINT(1.0562 42.9577)')).toEqual({ lon: 1.0562, lat: 42.9577 })
    expect(parsePoint(null)).toBeNull()
  })
})

describe('the source list', () => {
  it('is the one the database accepts', () => {
    // The browser must not import drizzle, so the list is written twice.
    expect([...SOURCES]).toEqual([...SAVED_SOURCES])
  })
})
