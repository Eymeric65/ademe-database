import { formatDate } from '../data/sources'

/**
 * What each ADEME column means, in French, and the unit it is counted in.
 *
 * ADEME's schema has neither: `description` is empty on all but five columns
 * and there is no unit field, so this is written by hand. Keyed on the column
 * with its `_n1`, `_n2` indices folded to `_nX`. test/unit/fields.test.ts fails
 * on any column of the four vendored schemas missing from here.
 */

type Unit = {
  /** Each step a thousand times the one before: kWh, MWh, GWh. */
  steps: string[]
  per?: string
  digits?: number
}

const UNITS = {
  kwh: { steps: ['kWh', 'MWh', 'GWh', 'TWh'], per: '/an' },
  kwhep: { steps: ['kWhEP', 'MWhEP', 'GWhEP', 'TWhEP'], per: '/an' },
  // An intensity is read against the DPE scale in kWh/m²/an: never rescaled.
  kwh_m2: { steps: ['kWh'], per: '/m²/an' },
  kwhep_m2: { steps: ['kWhEP'], per: '/m²/an' },
  co2: { steps: ['kg CO₂', 't CO₂', 'kt CO₂'], per: '/an' },
  co2_m2: { steps: ['kg CO₂'], per: '/m²/an' },
  eur_an: { steps: ['€'], per: '/an', digits: 0 },
  eur: { steps: ['€'], digits: 0 },
  w_k: { steps: ['W/K', 'kW/K', 'MW/K'] },
  u: { steps: ['W/(m²·K)'], digits: 2 },
  m2: { steps: ['m²'] },
  m: { steps: ['m'], digits: 2 },
  l: { steps: ['L'] },
  ratio: { steps: [''], digits: 2 },
  deg: { steps: [''], digits: 6 },
} satisfies Record<string, Unit>

/** `pct` is a 0–1 fraction shown as a percentage; `flag` a 0/1 answer. */
type UnitId = keyof typeof UNITS | 'pct' | 'flag'

export type Field = { label: string; hint?: string; unit?: UnitId }

const F = (label: string, hint: string, unit?: UnitId): Field => ({ label, hint, unit })
/** ADEME names one quantity differently in each dataset; they share an entry. */
const same = (keys: string[], f: Field) => Object.fromEntries(keys.map((k) => [k, f]))

const EF = 'En énergie finale : ce que mesure le compteur et que l’on paie.'
const EP =
  'En énergie primaire : l’énergie finale plus ce qu’il a fallu pour la produire et l’acheminer. C’est elle qui compte pour l’étiquette.'
const USAGES =
  'Somme des cinq usages que compte le DPE : chauffage, eau chaude, refroidissement, éclairage et auxiliaires.'
const AUX = 'Les auxiliaires sont les pompes, ventilateurs et la ventilation mécanique.'
const COST =
  'Facture annuelle estimée pour une occupation conventionnelle, aux prix de l’énergie retenus par le DPE, abonnements compris.'
const GES = 'En équivalent CO₂ : chaque gaz à effet de serre est compté pour son effet sur le climat.'
const LOSS = 'Chaleur perdue pour chaque degré d’écart entre l’intérieur et l’extérieur.'
const PER_ENERGY = 'Pour l’énergie indiquée par la ligne « Énergie » de ce bilan.'
const STEP = 'Écart avec l’étape précédente du parcours de travaux ; négatif quand la valeur baisse.'
const CUMUL = 'Écart avec l’état initial du logement, cumulé jusqu’à cette étape ; négatif quand la valeur baisse.'
const QUAL = 'Appréciation du diagnostiqueur, d’insuffisante à très bonne.'
const INPUT = 'Tel que le diagnostiqueur l’a saisi, avant géocodage.'
const BAN = 'Selon la Base Adresse Nationale, qui corrige l’adresse saisie.'
const BUILDING = 'Pour un appartement tiré d’un DPE d’immeuble, c’est souvent la valeur de tout l’immeuble.'

const FIELDS: Record<string, Field> = {
  // --- Administratif --------------------------------------------------------
  numero_dpe: F('Numéro du DPE', 'Identifiant unique attribué par l’ADEME quand elle reçoit le diagnostic.'),
  numero_dpe_remplace: F('DPE remplacé', 'Numéro du diagnostic que celui-ci annule et remplace.'),
  numero_dpe_immeuble_associe: F('DPE de l’immeuble', 'Numéro du DPE collectif dont ce logement a été tiré.'),
  n_audit: F('Numéro de l’audit', 'Identifiant de l’audit énergétique attribué par l’ADEME.'),
  n_audit_remplace: F('Audit remplacé', 'Numéro de l’audit que celui-ci annule et remplace.'),
  id_etape: F('Identifiant de l’étape', 'Clé de cette étape du parcours de travaux dans la base de l’ADEME.'),
  etape_travaux: F(
    'Étape du parcours',
    'État initial, étape intermédiaire ou étape finale du parcours de travaux proposé par l’auditeur.',
  ),
  categorie_scenario: F('Scénario', 'Le parcours de travaux auquel appartient cette étape ; un audit en propose au moins deux.'),
  travaux_realises: F('Travaux de l’étape', 'Les travaux prévus à cette étape du parcours.'),
  classe_bilan_dpe: F('Étiquette énergie', 'Classe de A à G du logement à cette étape du parcours.'),
  id_rnb: F('Identifiant RNB', 'Identifiant du bâtiment dans le Référentiel national des bâtiments.'),
  provenance_id_rnb: F(
    'Origine de l’identifiant RNB',
    'Saisi par le logiciel du diagnostiqueur, ou rattaché après coup par l’ADEME.',
  ),
  methode_application_dpe: F(
    'Méthode d’application',
    'Si le DPE porte sur une maison, un appartement ou un immeuble entier, ou s’il est tiré d’un autre diagnostic.',
  ),
  methode_dpe: F('Méthode du DPE', 'Si le DPE tertiaire est établi sur factures ou calculé.'),
  modele_dpe: F('Modèle de DPE', 'Version réglementaire du diagnostic et méthode de calcul employée.'),
  version_dpe: F('Version du format', 'Version du format informatique dans lequel le diagnostic a été transmis à l’ADEME.'),
  ...same(
    ['date_etablissement_dpe', 'date_etablissement_audit'],
    F('Date d’établissement', 'Jour où le diagnostic a été signé ; sa validité court à partir de là.'),
  ),
  ...same(
    ['date_visite_diagnostiqueur', 'date_visite_auditeur'],
    F('Date de la visite', 'Jour où le logement a été visité.'),
  ),
  ...same(
    ['date_reception_dpe', 'date_reception_audit'],
    F('Date de réception', 'Jour où l’ADEME a enregistré le diagnostic.'),
  ),
  ...same(
    ['date_fin_validite_dpe', 'date_fin_validite_audit'],
    F('Fin de validité', 'Au-delà de cette date, le diagnostic ne peut plus être présenté.'),
  ),
  ...same(
    ['date_derniere_modification_dpe', 'date_derniere_modification'],
    F('Dernière modification', 'Dernière fois qu’une donnée de ce diagnostic a changé dans la base de l’ADEME.'),
  ),
  ...same(
    ['numero_immatriculation_copropriete', 'n_immatriculation_copro'],
    F('Immatriculation de la copropriété', 'Numéro de la copropriété au registre national des copropriétés.'),
  ),
  numero_rpls_logement: F('Numéro RPLS', 'Identifiant du logement social au répertoire des logements locatifs sociaux.'),
  categorie_erp: F(
    'Catégorie ERP',
    'Catégorie d’établissement recevant du public, de la 1re (plus de 1 500 personnes) à la 5e (les plus petits).',
  ),
  secteur_activite: F('Secteur d’activité', 'Activité exercée dans le bâtiment.'),
  appartement_non_visite: F(
    'Appartement non visité',
    'Oui si le diagnostic a été établi sans visiter ce logement, à partir des données de l’immeuble.',
    'flag',
  ),

  // --- Bilan ----------------------------------------------------------------
  etiquette_dpe: F(
    'Étiquette énergie',
    'Classe de A (très performant) à G, fixée par la consommation d’énergie primaire et les émissions par m², la plus mauvaise des deux l’emportant.',
  ),
  etiquette_ges: F('Étiquette climat', 'Classe de A à G fixée par les émissions de gaz à effet de serre par m².'),

  // --- Localisation ---------------------------------------------------------
  adresse_ban: F('Adresse', BAN),
  ...same(['adresse_brut', 'n_et_nom_voie_brut'], F('Adresse saisie', `Numéro et voie. ${INPUT}`)),
  adresse_complete_brut: F('Adresse complète saisie', INPUT),
  code_postal_ban: F('Code postal', BAN),
  code_postal_brut: F('Code postal saisi', INPUT),
  code_insee_ban: F('Code INSEE', 'Identifiant officiel de la commune, qui n’est pas son code postal.'),
  ...same(['code_departement_ban', 'n_departement_ban'], F('Département', BAN)),
  ...same(['code_region_ban', 'n_region_ban'], F('Région', 'Code INSEE de la région.')),
  nom_commune_ban: F('Commune', BAN),
  nom_commune_brut: F('Commune saisie', INPUT),
  ...same(['nom_rue_ban', 'nom_voie_ban'], F('Voie', BAN)),
  ...same(['numero_voie_ban', 'n_voie_ban'], F('Numéro dans la voie', BAN)),
  identifiant_ban: F('Identifiant BAN', 'Clé de l’adresse dans la Base Adresse Nationale : commune, voie et numéro.'),
  complement_adresse_batiment: F('Complément d’adresse (bâtiment)', `Bâtiment, escalier, résidence… ${INPUT}`),
  complement_adresse_logement: F('Complément d’adresse (logement)', `Porte, étage, lot… ${INPUT}`),
  nom_residence: F('Résidence', 'Nom de la résidence ou de l’ensemble immobilier.'),
  coordonnee_cartographique_x_ban: F('Coordonnée X', 'Abscisse de l’adresse en projection Lambert 93.', 'm'),
  coordonnee_cartographique_y_ban: F('Coordonnée Y', 'Ordonnée de l’adresse en projection Lambert 93.', 'm'),
  lat: F('Latitude', 'Position de l’adresse, en degrés.', 'deg'),
  lon: F('Longitude', 'Position de l’adresse, en degrés.', 'deg'),
  score_ban: F(
    'Fiabilité du géocodage',
    'Confiance de la Base Adresse Nationale dans la correspondance entre l’adresse saisie et celle retenue. Basse, l’adresse peut être fausse.',
    'pct',
  ),
  statut_geocodage: F('Géocodage', 'Si l’adresse saisie a été retrouvée dans la Base Adresse Nationale.'),
  ...same(
    ['numero_etage_appartement', 'n_etage_appart'],
    F('Étage', 'Étage du logement ; 0 pour le rez-de-chaussée.'),
  ),
  position_logement_dans_immeuble: F(
    'Position dans l’immeuble',
    'Rez-de-chaussée, étage intermédiaire ou dernier étage : cela décide quelles parois donnent sur l’extérieur.',
  ),
  zone_climatique: F(
    'Zone climatique',
    'Zone de la réglementation thermique, de H1a (la plus froide) à H3 (la plus douce), qui fixe le climat du calcul.',
  ),
  classe_altitude: F('Altitude', 'Tranche d’altitude, qui corrige le climat pris en compte.'),

  // --- Le bâtiment ----------------------------------------------------------
  annee_construction: F('Année de construction', 'Année d’achèvement du bâtiment, quand elle est connue.'),
  ...same(
    ['periode_construction', 'periode_constuction'],
    F(
      'Période de construction',
      'Tranche d’années de construction ; elle fixe l’isolation supposée des parois dont on ne sait rien.',
    ),
  ),
  type_batiment: F('Type de bâtiment', 'Maison, appartement ou immeuble.'),
  typologie_logement: F('Typologie', 'Nombre de pièces principales : T1, T2…'),
  surface_habitable_logement: F(
    'Surface habitable',
    'Surface de plancher du logement, hors murs, cloisons, escaliers et parties de moins de 1,80 m de haut.',
    'm2',
  ),
  surface_habitable_immeuble: F('Surface habitable de l’immeuble', 'Somme des surfaces habitables de l’immeuble.', 'm2'),
  surface_tertiaire_immeuble: F(
    'Surface tertiaire de l’immeuble',
    'Part de l’immeuble occupée par des bureaux, commerces ou services.',
    'm2',
  ),
  surface_utile: F('Surface utile', 'Surface de plancher du bâtiment prise en compte par le diagnostic.', 'm2'),
  surface_shon: F(
    'Surface hors œuvre nette',
    'Ancienne mesure de la surface de plancher (SHON), employée par les DPE tertiaires de 2006.',
    'm2',
  ),
  hauteur_sous_plafond: F('Hauteur sous plafond', 'Hauteur moyenne des pièces ; elle fixe le volume à chauffer.', 'm'),
  ...same(
    ['nombre_niveau_logement', 'nb_niveau_logement'],
    F('Niveaux du logement', 'Nombre d’étages du logement lui-même : 2 pour un duplex.'),
  ),
  ...same(['nombre_niveau_immeuble', 'nb_niveau_immeuble'], F('Niveaux de l’immeuble', 'Nombre d’étages de l’immeuble.')),
  ...same(['nombre_appartement', 'nb_appartement'], F('Logements dans l’immeuble', 'Nombre de logements de l’immeuble.')),
  nombre_occupant: F('Occupants', 'Nombre de personnes présentes dans le bâtiment.'),
  ...same(
    ['classe_inertie_batiment', 'classe_inertie_bati'],
    F(
      'Inertie du bâtiment',
      'Capacité des murs et planchers à stocker la chaleur et la fraîcheur ; une inertie lourde amortit les écarts de température.',
    ),
  ),

  // --- Apports et besoins ---------------------------------------------------
  apport_interne_saison_chauffe: F(
    'Apports internes en hiver',
    `Chaleur dégagée par les occupants et les appareils pendant la saison de chauffe ; elle réduit le chauffage. ${BUILDING}`,
    'kwh',
  ),
  apport_interne_saison_froide: F(
    'Apports internes en été',
    'Chaleur dégagée par les occupants et les appareils pendant la saison chaude ; elle s’ajoute à la chaleur à évacuer.',
    'kwh',
  ),
  apport_solaire_saison_chauffe: F(
    'Apports solaires en hiver',
    `Chaleur du soleil entrée par les vitrages pendant la saison de chauffe ; elle réduit le chauffage. ${BUILDING}`,
    'kwh',
  ),
  apport_solaire_saison_froide: F(
    'Apports solaires en été',
    'Chaleur du soleil entrée par les vitrages pendant la saison chaude ; elle s’ajoute à la chaleur à évacuer.',
    'kwh',
  ),
  besoin_chauffage: F(
    'Besoin de chauffage',
    `Chaleur que le logement doit recevoir sur l’année pour rester à 19 °C, avant les pertes de l’installation. Elle ne dépend que du bâti. ${BUILDING}`,
    'kwh',
  ),
  besoin_ecs: F(
    'Besoin d’eau chaude',
    'Énergie qu’il faut pour chauffer l’eau chaude consommée dans l’année, avant les pertes de l’installation.',
    'kwh',
  ),
  besoin_ecs_logement: F('Besoin d’eau chaude du logement', 'Énergie qu’il faut pour chauffer l’eau chaude du logement sur l’année.', 'kwh'),
  besoin_ecs_batiment: F('Besoin d’eau chaude de l’immeuble', 'Énergie qu’il faut pour chauffer l’eau chaude de l’immeuble sur l’année.', 'kwh'),
  ...same(
    ['besoin_refroidissement', 'besoin_redroidissement'],
    F(
      'Besoin de refroidissement',
      'Chaleur à évacuer l’été pour ne pas dépasser 26 °C ; comptée seulement si le logement est climatisé.',
      'kwh',
    ),
  ),

  // --- Consommations --------------------------------------------------------
  ...same(['conso_5_usages_ef', 'conso_5_usages'], F('Consommation totale (énergie finale)', `${USAGES} ${EF}`, 'kwh')),
  ...same(['conso_5_usages_ep', 'ep_conso_5_usages'], F('Consommation totale (énergie primaire)', `${USAGES} ${EP}`, 'kwhep')),
  ...same(
    ['conso_5_usages_par_m2_ef', 'conso_5_usages_m2'],
    F('Consommation totale par m² (énergie finale)', `${USAGES} ${EF}`, 'kwh_m2'),
  ),
  ...same(
    ['conso_5_usages_par_m2_ep', 'ep_conso_5_usages_m2'],
    F(
      'Consommation totale par m² (énergie primaire)',
      `${USAGES} C’est, avec les émissions par m², la valeur qui place le logement sur l’étiquette énergie.`,
      'kwhep_m2',
    ),
  ),
  conso_kwhep_m2_an: F(
    'Consommation par m² (énergie primaire)',
    `La valeur qui place le bâtiment sur l’étiquette énergie. ${EP}`,
    'kwhep_m2',
  ),
  ...same(['conso_chauffage_ef', 'conso_ch'], F('Consommation de chauffage (énergie finale)', EF, 'kwh')),
  ...same(['conso_chauffage_ep', 'ep_conso_ch'], F('Consommation de chauffage (énergie primaire)', EP, 'kwhep')),
  ...same(['conso_ecs_ef', 'conso_ecs'], F('Consommation d’eau chaude (énergie finale)', EF, 'kwh')),
  ...same(['conso_ecs_ep', 'ep_conso_ecs'], F('Consommation d’eau chaude (énergie primaire)', EP, 'kwhep')),
  ...same(['conso_eclairage_ef', 'conso_eclairage'], F('Consommation d’éclairage (énergie finale)', EF, 'kwh')),
  ...same(['conso_eclairage_ep', 'ep_conso_eclairage'], F('Consommation d’éclairage (énergie primaire)', EP, 'kwhep')),
  ...same(
    ['conso_auxiliaires_ef', 'conso_totale_auxiliaire'],
    F('Consommation des auxiliaires (énergie finale)', `${AUX} ${EF}`, 'kwh'),
  ),
  ...same(
    ['conso_auxiliaires_ep', 'ep_conso_totale_auxiliaire'],
    F('Consommation des auxiliaires (énergie primaire)', `${AUX} ${EP}`, 'kwhep'),
  ),
  ...same(
    ['conso_refroidissement_ef', 'conso_fr', 'conso_refroidissement'],
    F('Consommation de refroidissement (énergie finale)', EF, 'kwh'),
  ),
  ...same(['conso_refroidissement_ep', 'ep_conso_fr'], F('Consommation de refroidissement (énergie primaire)', EP, 'kwhep')),
  conso_refroidissement_annuel: F('Consommation de climatisation', `Consommation annuelle de la climatisation. ${EF}`, 'kwh'),
  conso_chauffage_m2_ef: F('Chauffage par m² (énergie finale)', `À cette étape du parcours. ${EF}`, 'kwh_m2'),
  conso_chauffage_m2_ep: F('Chauffage par m² (énergie primaire)', `À cette étape du parcours. ${EP}`, 'kwhep_m2'),
  conso_ecs_m2_ef: F('Eau chaude par m² (énergie finale)', `À cette étape du parcours. ${EF}`, 'kwh_m2'),
  conso_ecs_m2_ep: F('Eau chaude par m² (énergie primaire)', `À cette étape du parcours. ${EP}`, 'kwhep_m2'),
  conso_eclairage_m2_ef: F('Éclairage par m² (énergie finale)', `À cette étape du parcours. ${EF}`, 'kwh_m2'),
  conso_eclairage_m2_ep: F('Éclairage par m² (énergie primaire)', `À cette étape du parcours. ${EP}`, 'kwhep_m2'),
  conso_auxiliaires_m2_ef: F('Auxiliaires par m² (énergie finale)', `À cette étape du parcours. ${AUX} ${EF}`, 'kwh_m2'),
  conso_auxiliaires_m2_ep: F('Auxiliaires par m² (énergie primaire)', `À cette étape du parcours. ${AUX} ${EP}`, 'kwhep_m2'),
  conso_refroidissement_m2_ef: F('Refroidissement par m² (énergie finale)', `À cette étape du parcours. ${EF}`, 'kwh_m2'),
  conso_refroidissement_m2_ep: F('Refroidissement par m² (énergie primaire)', `À cette étape du parcours. ${EP}`, 'kwhep_m2'),

  // --- Coûts ----------------------------------------------------------------
  ...same(['cout_total_5_usages', 'cout_5_usages'], F('Coût total', `${COST} Les cinq usages réunis.`, 'eur_an')),
  ...same(['cout_chauffage', 'cout_ch'], F('Coût du chauffage', COST, 'eur_an')),
  cout_ecs: F('Coût de l’eau chaude', COST, 'eur_an'),
  cout_eclairage: F('Coût de l’éclairage', COST, 'eur_an'),
  ...same(['cout_auxiliaires', 'cout_total_auxiliaire'], F('Coût des auxiliaires', `${COST} ${AUX}`, 'eur_an')),
  ...same(['cout_refroidissement', 'cout_fr'], F('Coût du refroidissement', COST, 'eur_an')),
  cout_travaux: F('Coût des travaux', 'Coût estimé par l’auditeur des travaux de cette étape.', 'eur'),
  couts_cumules_travaux: F('Coût cumulé des travaux', 'Coût estimé des travaux de toutes les étapes jusqu’à celle-ci.', 'eur'),

  // --- Émissions ------------------------------------------------------------
  emission_ges_5_usages: F('Émissions totales', `${USAGES} ${GES}`, 'co2'),
  ...same(
    ['emission_ges_5_usages_par_m2', 'emission_ges_5_usages_m2', 'emission_ges_kg_co2_m2_an'],
    F('Émissions par m²', `La valeur qui place le logement sur l’étiquette climat. ${GES}`, 'co2_m2'),
  ),
  ...same(['emission_ges_chauffage', 'emission_ges_ch'], F('Émissions du chauffage', GES, 'co2')),
  emission_ges_ecs: F('Émissions de l’eau chaude', GES, 'co2'),
  emission_ges_eclairage: F('Émissions de l’éclairage', GES, 'co2'),
  ...same(['emission_ges_auxiliaires', 'emission_ges_totale_auxiliaire'], F('Émissions des auxiliaires', `${AUX} ${GES}`, 'co2')),
  ...same(['emission_ges_refroidissement', 'emission_ges_fr'], F('Émissions du refroidissement', GES, 'co2')),

  // --- Bilan par énergie ----------------------------------------------------
  type_energie_nX: F('Énergie', 'L’énergie dont ces lignes font le bilan.'),
  ...same(
    ['conso_5_usages_ef_energie_nX', 'conso_ef_5_usages_energie_nX'],
    F('Consommation totale (énergie finale)', `${PER_ENERGY} ${EF}`, 'kwh'),
  ),
  ...same(
    ['conso_chauffage_ef_energie_nX', 'conso_ef_chauffage_energie_nX'],
    F('Consommation de chauffage (énergie finale)', `${PER_ENERGY} ${EF}`, 'kwh'),
  ),
  ...same(
    ['conso_ecs_ef_energie_nX', 'conso_ef_ecs_energie_nX'],
    F('Consommation d’eau chaude (énergie finale)', `${PER_ENERGY} ${EF}`, 'kwh'),
  ),
  ...same(['cout_total_5_usages_energie_nX', 'cout_5_usages_energie_nX'], F('Coût total', `${PER_ENERGY} ${COST}`, 'eur_an')),
  cout_chauffage_energie_nX: F('Coût du chauffage', `${PER_ENERGY} ${COST}`, 'eur_an'),
  cout_ecs_energie_nX: F('Coût de l’eau chaude', `${PER_ENERGY} ${COST}`, 'eur_an'),
  emission_ges_5_usages_energie_nX: F('Émissions totales', `${PER_ENERGY} ${GES}`, 'co2'),
  emission_ges_chauffage_energie_nX: F('Émissions du chauffage', `${PER_ENERGY} ${GES}`, 'co2'),
  emission_ges_ecs_energie_nX: F('Émissions de l’eau chaude', `${PER_ENERGY} ${GES}`, 'co2'),
  // The tertiaire DPE: real bills, one line per energy.
  type_usage_energie_nX: F('Usage', 'À quoi sert cette énergie dans le bâtiment.'),
  annee_releve_conso_energie_nX: F('Année du relevé', 'Année des factures dont vient cette consommation.'),
  conso_ef_energie_nX: F('Consommation (énergie finale)', `Relevée sur les factures. ${EF}`, 'kwh'),
  conso_ep_energie_nX: F('Consommation (énergie primaire)', `Relevée sur les factures. ${EP}`, 'kwhep'),
  frais_annuel_energie_nX: F('Dépense annuelle', 'Montant payé pour cette énergie sur l’année relevée.', 'eur_an'),

  // --- Déperditions ---------------------------------------------------------
  ...same(
    ['deperditions_enveloppe', 'deperdition_enveloppe'],
    F('Déperditions de l’enveloppe', `Toutes les pertes du logement : parois, ponts thermiques et renouvellement d’air. ${LOSS}`, 'w_k'),
  ),
  ...same(['deperditions_murs', 'deperdition_mur'], F('Déperditions par les murs', LOSS, 'w_k')),
  ...same(['deperditions_baies_vitrees', 'deperdition_baie_vitree'], F('Déperditions par les fenêtres', LOSS, 'w_k')),
  ...same(['deperditions_portes', 'deperdition_porte'], F('Déperditions par les portes', LOSS, 'w_k')),
  ...same(['deperditions_planchers_bas', 'deperdition_plancher_bas'], F('Déperditions par le plancher bas', LOSS, 'w_k')),
  ...same(
    ['deperditions_planchers_hauts', 'deperdition_plancher_haut'],
    F('Déperditions par le plancher haut', `Par le toit ou les combles. ${LOSS}`, 'w_k'),
  ),
  ...same(
    ['deperditions_ponts_thermiques', 'deperdition_pont_thermique'],
    F('Déperditions par les ponts thermiques', `Aux jonctions entre parois, où l’isolation s’interrompt. ${LOSS}`, 'w_k'),
  ),
  ...same(
    ['deperditions_renouvellement_air', 'deperdition_renouvellement_air'],
    F('Déperditions par le renouvellement d’air', `Air chauffé remplacé par de l’air extérieur, par la ventilation et les fuites. ${LOSS}`, 'w_k'),
  ),
  deperditions_totales_logement: F('Déperditions du logement', LOSS, 'w_k'),
  deperditions_totales_batiment: F('Déperditions du bâtiment', LOSS, 'w_k'),

  // --- Isolation ------------------------------------------------------------
  ...same(
    ['ubat_w_par_m2_k', 'ubat_w_m2_k'],
    F(
      'Isolation moyenne (Ubat)',
      'Chaleur perdue par m² de paroi et par degré d’écart avec l’extérieur. Plus elle est basse, mieux le logement est isolé.',
      'u',
    ),
  ),
  qualite_isolation_enveloppe: F('Isolation de l’enveloppe', `Appréciation d’ensemble, déduite de l’Ubat, d’insuffisante à très bonne.`),
  qualite_isolation_murs: F('Isolation des murs', QUAL),
  qualite_isolation_menuiseries: F('Isolation des fenêtres et portes', QUAL),
  qualite_isolation_plancher_bas: F('Isolation du plancher bas', QUAL),
  qualite_isolation_plancher_haut_comble_perdu: F('Isolation des combles perdus', QUAL),
  qualite_isolation_plancher_haut_comble_amenage: F('Isolation des combles aménagés', QUAL),
  qualite_isolation_plancher_haut_toit_terrasse: F('Isolation du toit-terrasse', QUAL),

  // --- Confort d’été --------------------------------------------------------
  indicateur_confort_ete: F(
    'Confort d’été',
    'Risque de surchauffe l’été, d’insuffisant à bon, jugé sur l’inertie, la toiture, les protections solaires et la ventilation naturelle.',
  ),
  inertie_lourde: F('Inertie lourde', 'Oui si murs et planchers lourds gardent la fraîcheur de la nuit.', 'flag'),
  isolation_toiture: F('Toiture isolée', 'Oui si la toiture est isolée, ce qui retient la chaleur venue du toit.', 'flag'),
  logement_traversant: F(
    'Logement traversant',
    'Oui si le logement a des fenêtres sur des façades opposées, ce qui permet de le rafraîchir la nuit.',
    'flag',
  ),
  ...same(['presence_brasseur_air', 'presence_brasseur'], F('Brasseur d’air', 'Oui si un ventilateur de plafond est installé.', 'flag')),
  protection_solaire_exterieure: F(
    'Protections solaires extérieures',
    'Oui si les fenêtres ont des volets ou des stores extérieurs.',
    'flag',
  ),

  // --- Ventilation ----------------------------------------------------------
  type_ventilation: F('Ventilation', 'Système de renouvellement de l’air et son époque.'),
  ventilation_posterieure_2012: F('Ventilation installée après 2012', 'Oui si la ventilation date de 2013 ou plus tard.', 'flag'),
  surface_ventilee: F('Surface ventilée', 'Surface desservie par la ventilation.', 'm2'),
  etat_composant_ventilation: F('État de la ventilation', 'D’origine, ou neuve ou rénovée à cette étape.'),

  // --- Chauffage ------------------------------------------------------------
  type_installation_chauffage: F('Chauffage individuel ou collectif', 'Qui produit la chaleur : le logement lui-même ou l’immeuble.'),
  type_energie_principale_chauffage: F('Énergie de chauffage', 'Énergie du chauffage principal.'),
  ...same(
    ['type_generateur_chauffage_principal', 'type_generateur_principal_chauffage'],
    F('Chauffage principal', 'L’appareil qui fournit l’essentiel de la chaleur.'),
  ),
  usage_generateur_principal_chauffage: F('Usage du chauffage principal', 'S’il chauffe seulement, ou produit aussi l’eau chaude.'),
  configuration_installation_chauffage_nX: F('Configuration', 'Un seul système, un système avec appoint, plusieurs systèmes…'),
  description_installation_chauffage_nX: F('Description', 'Description de l’installation par le logiciel du diagnostiqueur.'),
  type_installation_chauffage_nX: F('Type d’installation', 'Individuelle, collective, ou collective avec appoint individuel.'),
  type_emetteur_installation_chauffage_nX: F(
    'Émetteurs',
    'Ce qui diffuse la chaleur dans les pièces : radiateurs, plancher chauffant, convecteurs…',
  ),
  surface_chauffee_installation_chauffage_nX: F('Surface chauffée', 'Surface desservie par cette installation.', 'm2'),
  ...same(
    ['conso_chauffage_installation_chauffage_nX', 'conso_ef_installation_chauffage_nX'],
    F('Consommation de chauffage', `De cette installation. ${EF}`, 'kwh'),
  ),
  etat_installation_chauffage_nX: F('État de l’installation', 'D’origine, ou neuve ou rénovée à cette étape.'),
  facteur_couverture_solaire_installation_chauffage_nX: F(
    'Couverture solaire',
    'Part du besoin de chauffage fournie par le solaire thermique.',
    'pct',
  ),
  ...same(
    [
      'facteur_couverture_solaire_saisi_installation_chauffage_nX',
      'facteur_couverture_solaire_installation_chauffage_saisi_nX',
    ],
    F(
      'Couverture solaire saisie',
      'Part du besoin de chauffage fournie par le solaire, saisie d’après une étude plutôt que calculée.',
      'pct',
    ),
  ),
  description_generateur_chauffage_nX_installation_nX: F('Description', 'Description du générateur par le logiciel du diagnostiqueur.'),
  ...same(
    ['type_generateur_nX_installation_nX', 'type_generateur_nX_installation_chauffage_nX'],
    F('Générateur', 'L’appareil qui produit la chaleur : chaudière, pompe à chaleur, convecteur…'),
  ),
  ...same(
    ['type_energie_generateur_nX_installation_nX', 'type_energie_generateur_nX_installation_chauffage_nX'],
    F('Énergie', 'L’énergie que consomme ce générateur.'),
  ),
  ...same(
    ['usage_generateur_nX_installation_nX', 'usage_generateur_nX_installation_chauffage_nX'],
    F('Usage', 'Si le générateur chauffe, produit l’eau chaude, ou les deux.'),
  ),
  ...same(
    ['conso_chauffage_generateur_nX_installation_nX', 'conso_ef_generateur_nX_installation_chauffage_nX'],
    F('Consommation du générateur', EF, 'kwh'),
  ),

  // --- Eau chaude -----------------------------------------------------------
  type_installation_ecs: F('Eau chaude individuelle ou collective', 'Qui produit l’eau chaude : le logement lui-même ou l’immeuble.'),
  type_energie_principale_ecs: F('Énergie de l’eau chaude', 'Énergie de la production d’eau chaude principale.'),
  type_generateur_chauffage_principal_ecs: F('Production d’eau chaude principale', 'L’appareil qui fournit l’essentiel de l’eau chaude.'),
  ...same(
    ['configuration_installation_ecs_nX', 'config_installation_ecs_ef'],
    F('Configuration', 'Un seul système avec ou sans solaire, ou deux systèmes.'),
  ),
  description_installation_ecs_nX: F('Description', 'Description de l’installation par le logiciel du diagnostiqueur.'),
  type_installation_ecs_nX: F('Type d’installation', 'Individuelle ou collective.'),
  ...same(
    ['nombre_logements_desservis_par_installation_ecs_nX', 'nombre_logement_desservi_par_installation_ecs'],
    F('Logements desservis', 'Nombre de logements alimentés par cette installation.'),
  ),
  ...same(
    ['surface_habitable_desservie_par_installation_ecs_nX', 'surface_habitable_desservie_par_installation_ecs'],
    F('Surface desservie', 'Surface habitable alimentée par cette installation.', 'm2'),
  ),
  ...same(
    ['conso_ef_installation_ecs_nX', 'conso_installation_ecs_ef'],
    F('Consommation d’eau chaude', `De cette installation. ${EF}`, 'kwh'),
  ),
  etat_installation_ecs: F('État de l’installation', 'D’origine, ou neuve ou rénovée à cette étape.'),
  ...same(
    ['type_installation_solaire_nX', 'type_installation_solaire'],
    F('Solaire thermique', 'S’il y a des capteurs solaires, pour quel usage, et depuis quand.'),
  ),
  ...same(
    ['facteur_couverture_solaire_nX', 'facteur_couverture_solaire'],
    F('Couverture solaire', 'Part du besoin d’eau chaude fournie par les capteurs solaires.', 'pct'),
  ),
  ...same(
    ['facteur_couverture_solaire_saisi_nX', 'facteur_couverture_solaire_saisi'],
    F('Couverture solaire saisie', 'Part du besoin d’eau chaude fournie par le solaire, saisie d’après une étude plutôt que calculée.', 'pct'),
  ),
  ...same(
    ['production_ecs_solaire_installation_nX', 'production_ecs_solaire_installation'],
    F('Production solaire', 'Énergie fournie par les capteurs solaires sur l’année.', 'kwh'),
  ),
  description_generateur_nX_ecs_nX: F('Description', 'Description du générateur par le logiciel du diagnostiqueur.'),
  ...same(
    ['type_generateur_nX_ecs_nX', 'type_generateur_ecs_nX'],
    F('Générateur', 'L’appareil qui chauffe l’eau : ballon électrique, chaudière, chauffe-eau thermodynamique…'),
  ),
  ...same(
    ['type_energie_generateur_nX_ecs_nX', 'type_energie_generateur_ecs_nX'],
    F('Énergie', 'L’énergie que consomme ce générateur.'),
  ),
  ...same(
    ['usage_generateur_nX_ecs_nX', 'usage_generateur_ecs_nX'],
    F('Usage', 'Si le générateur produit l’eau chaude seulement, ou chauffe aussi.'),
  ),
  ...same(
    ['conso_ef_generateur_nX_ecs_nX', 'conso_ef_generateur_ecs_nX'],
    F('Consommation du générateur', EF, 'kwh'),
  ),
  ...same(
    ['volume_stockage_generateur_nX_ecs_nX', 'volume_stockage_generateur_ecs_nX'],
    F('Volume du ballon', 'Contenance du ballon de stockage d’eau chaude.', 'l'),
  ),
  ...same(
    ['cop_generateur_nX_ecs_nX', 'cop_generateur_ecs_nX'],
    F(
      'Coefficient de performance',
      'Chaleur produite pour chaque kWh d’électricité, pour un chauffe-eau thermodynamique ou une pompe à chaleur : 3 veut dire trois fois plus.',
      'ratio',
    ),
  ),
  ...same(
    ['date_installation_generateur_nX_ecs_nX', 'date_installation_generateur_ecs_nX'],
    F('Installation du générateur', 'Période où le générateur a été installé.'),
  ),

  // --- Climatisation --------------------------------------------------------
  type_generateur_froid: F('Climatisation', 'L’appareil qui refroidit le logement, s’il y en a un.'),
  description_generateur_froid: F('Description de la climatisation', 'Description par le logiciel du diagnostiqueur.'),
  ...same(
    ['type_energie_climatisation', 'type_energie_generateur_froid'],
    F('Énergie de la climatisation', 'L’énergie que consomme la climatisation.'),
  ),
  periode_installation_generateur_froid: F('Installation de la climatisation', 'Période où la climatisation a été installée.'),
  etat_generateur_froid: F('État de la climatisation', 'D’origine, ou neuve ou rénovée à cette étape.'),
  surface_climatisee: F('Surface climatisée', 'Surface refroidie par la climatisation.', 'm2'),

  // --- Énergies renouvelables -----------------------------------------------
  categorie_enr: F('Énergies renouvelables', 'Les équipements d’énergie renouvelable du logement.'),
  ...same(
    ['systeme_production_electricite_origine_renouvelable', 'systeme_production_electricite_origine_enr'],
    F('Production d’électricité renouvelable', 'Le type d’installation qui produit de l’électricité sur place.'),
  ),
  presence_production_pv: F('Panneaux photovoltaïques', 'Oui si des panneaux produisent de l’électricité.', 'flag'),
  ...same(['nombre_module', 'nombre_module_pv'], F('Nombre de panneaux', 'Nombre de modules photovoltaïques.')),
  ...same(
    ['surface_totale_capteurs_pv', 'surface_totale_capteur_pv'],
    F('Surface de panneaux', 'Surface totale des modules photovoltaïques.', 'm2'),
  ),
  production_electricite_pv_kwhep_par_an: F(
    'Production photovoltaïque',
    `Électricité produite par les panneaux en un an, déduite de la consommation. ${EP}`,
    'kwhep',
  ),
  production_electricite_pv_kwh: F('Production photovoltaïque', `Électricité produite par les panneaux en un an. ${EF}`, 'kwh'),
  electricite_pv_autoconsommee: F(
    'Électricité autoconsommée',
    'Part de la production photovoltaïque consommée sur place plutôt que revendue.',
    'kwh',
  ),

  // --- Gains du parcours de travaux (audit) ---------------------------------
  gain_conso_5_usages_m2_ef: F('Gain de consommation par m² (énergie finale)', STEP, 'kwh_m2'),
  gain_conso_5_usages_m2_ep: F('Gain de consommation par m² (énergie primaire)', STEP, 'kwhep_m2'),
  gain_emission_ges_5_usages_m2: F('Gain d’émissions par m²', STEP, 'co2_m2'),
  gain_relatif_conso_5_usages_m2_ef: F('Gain relatif de consommation (énergie finale)', STEP, 'pct'),
  gain_relatif_conso_5_usages_m2_ep: F('Gain relatif de consommation (énergie primaire)', STEP, 'pct'),
  gain_relatif_emission_ges_5_usages_m2: F('Gain relatif d’émissions', STEP, 'pct'),
  gains_cumules_conso_5_usages_m2_ef: F('Gain cumulé de consommation par m² (énergie finale)', CUMUL, 'kwh_m2'),
  gains_cumules_conso_5_usages_m2_ep: F('Gain cumulé de consommation par m² (énergie primaire)', CUMUL, 'kwhep_m2'),
  gains_cumules_emission_ges_5_usages_m2: F('Gain cumulé d’émissions par m²', CUMUL, 'co2_m2'),
  gains_relatifs_cumules_conso_5_usages_m2_ef: F('Gain relatif cumulé de consommation (énergie finale)', CUMUL, 'pct'),
  gains_relatifs_cumules_conso_5_usages_m2_ep: F('Gain relatif cumulé de consommation (énergie primaire)', CUMUL, 'pct'),
  gains_relatifs_cumules_emission_ges_5_usages_m2: F('Gain relatif cumulé d’émissions', CUMUL, 'pct'),
  gain_financier_travaux: F('Gain sur la facture', `Sur la facture annuelle d’énergie. ${STEP}`, 'eur_an'),
  gain_financier_cumule: F('Gain cumulé sur la facture', `Sur la facture annuelle d’énergie. ${CUMUL}`, 'eur_an'),
  gain_sur_facture_min: F('Gain sur la facture (bas)', `Bas de la fourchette, sur la facture annuelle. ${STEP}`, 'eur_an'),
  gain_facture_max: F('Gain sur la facture (haut)', `Haut de la fourchette, sur la facture annuelle. ${STEP}`, 'eur_an'),
  gains_cumules_facture_min: F('Gain cumulé sur la facture (bas)', `Bas de la fourchette, sur la facture annuelle. ${CUMUL}`, 'eur_an'),
  gains_cumules_facture_max: F('Gain cumulé sur la facture (haut)', `Haut de la fourchette, sur la facture annuelle. ${CUMUL}`, 'eur_an'),
}

/** What the index in `_n2` counts, from the word in front of it. */
const COUNTED: Record<string, string> = { generateur: 'générateur', energie: 'énergie' }

export function field(key: string): Field {
  const index: string[] = []
  const stem = key.replace(/_n(\d+)/g, (_, n: string) => {
    index.push(n)
    return '_nX'
  })
  const f = FIELDS[stem]
  if (!f) return { label: key }
  // n1 everywhere is the ordinary case; naming it on every line is noise.
  if (index.every((n) => n === '1')) return f
  const nouns = [...stem.matchAll(/([a-z]+)_nX/g)].map((m) => COUNTED[m[1] ?? ''] ?? 'installation')
  return { ...f, label: `${f.label} (${index.map((n, i) => `${nouns[i]} ${n}`).join(', ')})` }
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return Number(value)
  // ADR-0032: the audit keeps 124 numeric columns as text.
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

export type Row = Record<string, unknown>

/**
 * TRAP: ADEME publishes the season apports in Wh on some records and in kWh on
 * others, within one DPE version. Per m² of a dwelling the two never overlap
 * (kWh stays under 1 000, Wh starts past 10 000), so past 10 000 it is Wh.
 */
const SOMETIMES_WH = new Set([
  'apport_interne_saison_chauffe',
  'apport_interne_saison_froide',
  'apport_solaire_saison_chauffe',
  'apport_solaire_saison_froide',
])

function fromWh(key: string, n: number, row?: Row): number {
  if (!row || !SOMETIMES_WH.has(key)) return n
  const surface = toNumber(row.surface_habitable_logement)
  return surface && n / surface > 10_000 ? n / 1000 : n
}

function quantity(n: number, unit: Unit): string {
  let v = n
  let i = 0
  while (Math.abs(v) >= 1000 && i < unit.steps.length - 1) {
    v /= 1000
    i++
  }
  // Rounding is also what removes the noise of a DECIMAL cast to double.
  const digits: Intl.NumberFormatOptions =
    i > 0
      ? { minimumSignificantDigits: 3, maximumSignificantDigits: 3 }
      : { maximumFractionDigits: unit.digits ?? 1 }
  const suffix = `${unit.steps[i] ?? ''}${unit.per ?? ''}`
  const text = new Intl.NumberFormat('fr-FR', digits).format(v)
  return suffix ? `${text} ${suffix}` : text
}

/** Values arrive from Arrow as numbers, strings, BigInts and epoch days. */
export function formatValue(key: string, value: unknown, encoding?: string, row?: Row): string {
  if (value == null) return ''
  if (encoding === 'date' || value instanceof Date) return formatDate(value)
  const unit = field(key).unit
  const n = unit ? toNumber(value) : null
  if (unit && n != null) {
    if (unit === 'flag') return n ? 'Oui' : 'Non'
    if (unit === 'pct') return new Intl.NumberFormat('fr-FR', { style: 'percent', maximumFractionDigits: 1 }).format(n)
    return quantity(fromWh(key, n, row), UNITS[unit])
  }
  // Codes, years, ids and labels: exactly as they came, no thousands separator.
  if (typeof value === 'bigint') return value.toString()
  return String(value)
}
