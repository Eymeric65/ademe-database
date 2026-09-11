import type { SourceId } from '../data/sources'

/**
 * What a listing tells you. This is the shape the search form produces, the
 * shape `saved_search.spec` stores, and the shape `duck.search` reads.
 *
 * Every field is optional because an advert is never complete -- the point of
 * the product is to work from whatever fragment is published.
 */
export type QuerySpec = {
  /** Which published tree. Absent is existing housing, the only one there was. */
  source?: SourceId
  codePostal?: string
  /** A manifest partition: where a search with no postcode looks. */
  departement?: string
  commune?: string
  etiquetteDpe?: string
  etiquetteGes?: string
  /** 'YYYY-MM-DD', inclusive, on the source's date of issue. */
  dateDu?: string
  dateAu?: string
  /** 'YYYY-MM', from searches saved before the day range; read as that month. */
  moisEtablissement?: string
  surface?: number
  /** ± m², because an advert rounds. */
  surfaceTolerance?: number
  consoEp?: number
  emissionGes?: number
  typeBatiment?: string
  periodeConstruction?: string
  secteurActivite?: string
  categorieErp?: string
  categorieScenario?: string
  etapeTravaux?: string
}

export const CLASSES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const

/**
 * Enough to be worth running, and cheap enough to run: somewhere that names
 * one partition, plus something that narrows it. A commune narrows but does
 * not locate -- alone it would read every partition in the country.
 */
export function isRunnable(spec: QuerySpec): boolean {
  const located = Boolean(spec.codePostal?.trim() || spec.departement)
  const narrowed =
    Boolean(spec.commune?.trim()) ||
    Boolean(spec.etiquetteDpe) ||
    Boolean(spec.etiquetteGes) ||
    spec.surface != null ||
    Boolean(spec.dateDu) ||
    Boolean(spec.dateAu) ||
    Boolean(spec.moisEtablissement) ||
    spec.consoEp != null ||
    spec.emissionGes != null ||
    Boolean(spec.typeBatiment) ||
    Boolean(spec.periodeConstruction) ||
    Boolean(spec.secteurActivite) ||
    Boolean(spec.categorieErp) ||
    Boolean(spec.categorieScenario)
  return located && narrowed
}
