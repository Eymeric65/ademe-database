import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { field, formatValue } from '../../src/detail/fields'

/**
 * What the detail page prints next to each ADEME column.
 *
 * The values are the ones a real certificate showed before this existed:
 * `1230.3000000000002` is what a DECIMAL cast to double looks like through
 * String(), and nobody could tell a kWh from a W/K.
 */

// Intl puts a narrow no-break space in "2 220" and before units; compare text.
const text = (s: string) => s.replace(/[  ]/g, ' ')
const fmt = (key: string, value: unknown, encoding?: string, row?: Record<string, unknown>) =>
  text(formatValue(key, value, encoding, row))

describe('formatValue', () => {
  it('puts energies in MWh once they pass a thousand kWh', () => {
    expect(fmt('besoin_chauffage', 13029)).toBe('13,0 MWh/an')
    expect(fmt('besoin_ecs', 1230.3000000000002)).toBe('1,23 MWh/an')
    expect(fmt('conso_5_usages_ef', 14034.300000000001)).toBe('14,0 MWh/an')
    expect(fmt('conso_5_usages_ep', 26665.2)).toBe('26,7 MWhEP/an')
    expect(fmt('conso_auxiliaires_ef', 569.4)).toBe('569,4 kWh/an')
  })

  it('never rescales an intensity per m²', () => {
    expect(fmt('conso_5_usages_par_m2_ep', 234)).toBe('234 kWhEP/m²/an')
    expect(fmt('emission_ges_5_usages_par_m2', 9)).toBe('9 kg CO₂/m²/an')
  })

  it('gives each physical quantity its unit, without the float noise', () => {
    expect(fmt('deperditions_murs', 76.60000000000001)).toBe('76,6 W/K')
    expect(fmt('emission_ges_5_usages', 1063.6000000000001)).toBe('1,06 t CO₂/an')
    expect(fmt('ubat_w_par_m2_k', 0.75)).toBe('0,75 W/(m²·K)')
    expect(fmt('surface_habitable_logement', 113.9)).toBe('113,9 m²')
    expect(fmt('hauteur_sous_plafond', 2.5)).toBe('2,5 m')
    expect(fmt('volume_stockage_generateur_n1_ecs_n1', 300)).toBe('300 L')
    // Not in any schema: the ETL adds them. Six decimals is ten centimetres.
    expect(fmt('lon', 1.6274339999999998)).toBe('1,627434')
    expect(fmt('lat', 42.846709999999995)).toBe('42,84671')
  })

  it('reads a season apport ADEME published in Wh as Wh', () => {
    // Some records carry the apports in Wh, the rest in kWh: 1 980 000 for a
    // 76.6 m² house can only be Wh; 2732.5 for 113.9 m² is kWh.
    const house = { surface_habitable_logement: 76.6 }
    expect(fmt('apport_interne_saison_chauffe', 1980000, undefined, house)).toBe('1,98 MWh/an')
    expect(fmt('apport_solaire_saison_chauffe', '2620000', undefined, { surface_habitable_logement: '76.6' })).toBe(
      '2,62 MWh/an',
    )
    expect(fmt('apport_interne_saison_chauffe', 2732.5, undefined, { surface_habitable_logement: 113.9 })).toBe(
      '2,73 MWh/an',
    )
    // Only the apports: a besoin is kWh on every record.
    expect(fmt('besoin_chauffage', 17100, undefined, house)).toBe('17,1 MWh/an')
  })

  it('keeps euros whole', () => {
    expect(fmt('cout_chauffage', 2220.2000000000003)).toBe('2 220 €/an')
    expect(fmt('cout_total_5_usages', 2887.4)).toBe('2 887 €/an')
    expect(fmt('cout_travaux', 51710)).toBe('51 710 €')
  })

  it('shows a fraction as a percentage', () => {
    expect(fmt('score_ban', 0.22)).toBe('22 %')
    expect(fmt('facteur_couverture_solaire_n1', 0.5)).toBe('50 %')
  })

  it('answers a 0/1 flag in words', () => {
    expect(fmt('inertie_lourde', 1)).toBe('Oui')
    expect(fmt('ventilation_posterieure_2012', 0)).toBe('Non')
  })

  it('reads the audit numbers stored as text the same way', () => {
    // ADR-0032: 124 audit columns stay text.
    expect(fmt('besoin_chauffage', '13029')).toBe('13,0 MWh/an')
    expect(fmt('besoin_chauffage', 'n/a')).toBe('n/a')
  })

  it('leaves codes, years and labels exactly as they came', () => {
    expect(fmt('code_postal_ban', '65350')).toBe('65350')
    expect(fmt('annee_construction', 1976)).toBe('1976')
    expect(fmt('annee_releve_conso_energie_n1', 2021)).toBe('2021')
    expect(fmt('etiquette_dpe', 'D')).toBe('D')
    expect(fmt('numero_etage_appartement', 0)).toBe('0')
    expect(fmt('date_etablissement_dpe', Date.UTC(2026, 8, 7), 'date')).toBe('07/09/2026')
  })
})

describe('field', () => {
  it('names a column in French and says what it is for', () => {
    const f = field('besoin_chauffage')
    expect(f.label).toBe('Besoin de chauffage')
    expect(f.hint).toBeTruthy()
  })

  it('names the generator and installation only when there is more than one', () => {
    expect(field('conso_chauffage_generateur_n1_installation_n1').label).not.toMatch(/générateur \d/)
    expect(field('conso_chauffage_generateur_n2_installation_n1').label).toMatch(/générateur 2, installation 1/)
  })

  it('knows every column ADEME publishes, in all four sources', () => {
    const missing: string[] = []
    for (const file of ['ademe-schema', 'dpe02neuf-schema', 'dpe01tertiaire-schema', 'audit-schema']) {
      const schema = JSON.parse(
        readFileSync(new URL(`../../schema/${file}.json`, import.meta.url), 'utf8'),
      ) as { key: string }[]
      for (const { key } of schema) {
        if (key.startsWith('_')) continue // the dataset's own internals, never exported
        const f = field(key)
        if (f.label === key || !f.hint) missing.push(`${file}: ${key}`)
      }
    }
    expect(missing).toEqual([])
  })
})
