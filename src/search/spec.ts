/**
 * What a listing tells you. This is the shape the search form produces, the
 * shape `saved_search.spec` stores, and the shape `duck.search` reads.
 *
 * Every field is optional because an advert is never complete -- the point of
 * the product is to work from whatever fragment is published.
 */
export type QuerySpec = {
  codePostal?: string
  commune?: string
  etiquetteDpe?: string
  etiquetteGes?: string
  /** 'YYYY-MM'; the advert says "DPE réalisé en mars 2024", not the day. */
  moisEtablissement?: string
  surface?: number
  /** ± m², because an advert rounds. */
  surfaceTolerance?: number
  consoEp?: number
  emissionGes?: number
  typeBatiment?: string
  periodeConstruction?: string
}

export const CLASSES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const

/** Enough to be worth running: a bare postcode returns the whole partition. */
export function isRunnable(spec: QuerySpec): boolean {
  const located = Boolean(spec.codePostal?.trim() || spec.commune?.trim())
  const narrowed =
    Boolean(spec.etiquetteDpe) ||
    Boolean(spec.etiquetteGes) ||
    spec.surface != null ||
    Boolean(spec.moisEtablissement) ||
    Boolean(spec.typeBatiment)
  return located && narrowed
}
