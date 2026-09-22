/**
 * The terms of sale and the legal notice, rendered to static pages by
 * scripts/prerender.tsx. Prop-less and import-free, like the Présentation, so
 * renderToStaticMarkup takes them as they are.
 *
 * Everything about the publisher is in PUBLISHER and nowhere else. A value
 * still reading « à compléter » fails test/unit/seo-sitemap.test.ts: the
 * publisher's identity is the operator's to supply, never the code's to guess.
 */

export const PUBLISHER = {
  /** Nom et prénom de l'entrepreneur individuel, ou dénomination sociale. */
  name: 'Eymeric Chauchat',
  /** Forme juridique, e.g. « entrepreneur individuel (micro-entreprise) ». */
  status: 'entrepreneur individuel (EI), nom commercial Chauquest',
  siret: '109 335 455 00019',
  address: '173 rue de Courcelles, 75017 Paris',
  email: 'eymeric.chauchat@gmail.com',
  /** « TVA non applicable, art. 293 B du CGI » under the franchise en base. */
  vat: 'TVA non applicable, art. 293 B du CGI',
  /** The consumer mediator every seller to consumers must name (art. L612-1). */
  mediator: '[à compléter : nom et site du médiateur de la consommation]',
}

const SITE = 'recherche-maison.com'

export function Cgv() {
  return (
    <article className="legal">
      <h1>Conditions générales de vente</h1>
      <p className="lede">
        Les présentes conditions régissent l’abonnement payant au service {SITE}, édité par{' '}
        {PUBLISHER.name}.
      </p>

      <h2>1. Le service</h2>
      <p>
        {SITE} permet de rechercher et de consulter les diagnostics de performance énergétique (DPE)
        publiés par l’ADEME en données ouvertes. Un compte gratuit donne accès à la recherche dans
        l’historique des diagnostics. L’abonnement donne en outre accès aux diagnostics publiés au cours
        des deux derniers mois, dans les résultats, sur la carte et en détail.
      </p>
      <p>
        Les diagnostics sont reproduits tels que l’ADEME les publie. {SITE} ne les établit pas, ne les
        vérifie pas et n’en garantit ni l’exactitude ni l’exhaustivité.
      </p>

      <h2>2. Prix</h2>
      <p>
        L’abonnement coûte 5 € TTC par mois. {PUBLISHER.vat}. Toute modification du prix est annoncée
        par e-mail au moins trente jours avant de s’appliquer, à compter du renouvellement suivant ;
        l’abonné qui la refuse peut résilier avant cette date.
      </p>

      <h2>3. Souscription et paiement</h2>
      <p>
        L’abonnement se souscrit depuis la page « Abonnement » du site, avec un compte. Le paiement se
        fait par carte bancaire sur la page de paiement sécurisée de Stripe, prestataire de paiement ;
        {' '}{SITE} ne reçoit ni ne conserve aucune donnée de carte. L’abonnement prend effet dès la
        confirmation du paiement.
      </p>

      <h2>4. Durée et renouvellement</h2>
      <p>
        L’abonnement est souscrit pour un mois. Il se renouvelle ensuite automatiquement chaque mois, à
        la date anniversaire de la souscription, et le prix du mois est prélevé sur la carte enregistrée,
        jusqu’à résiliation.
      </p>
      <p>
        Si un prélèvement échoue, l’accès aux deux derniers mois est suspendu ; Stripe tente à nouveau
        le prélèvement pendant quelques jours, et l’abonnement prend fin si aucune tentative n’aboutit.
      </p>

      <h2>5. Résiliation</h2>
      <p>
        L’abonné peut résilier à tout moment, sans frais, depuis la page « Abonnement », bouton « Gérer
        mon abonnement », qui ouvre son espace client Stripe. La résiliation prend effet à la fin du mois
        en cours, déjà payé : l’accès reste ouvert jusqu’à cette date et aucun autre prélèvement n’a lieu.
        Le mois entamé n’est pas remboursé au prorata.
      </p>

      <h2>6. Droit de rétractation</h2>
      <p>
        Le consommateur dispose en principe d’un délai de quatorze jours pour se rétracter (article
        L221-18 du Code de la consommation). Conformément à l’article L221-28, 13°, ce droit ne peut être
        exercé pour la fourniture d’un contenu numérique sans support matériel dont l’exécution a
        commencé, avec son accord préalable et exprès, avant la fin de ce délai, et pour lequel il a
        renoncé à son droit de rétractation. En souscrivant, l’abonné demande l’accès immédiat aux
        diagnostics des deux derniers mois et renonce expressément à ce droit.
      </p>

      <h2>7. Responsabilité</h2>
      <p>
        Le service est fourni en l’état, avec les données disponibles au moment de la consultation.
        {' '}{SITE} s’efforce d’en assurer la disponibilité mais ne peut garantir un accès sans
        interruption. Sa responsabilité ne saurait être engagée pour une décision prise sur la foi d’un
        diagnostic.
      </p>

      <h2>8. Données personnelles</h2>
      <p>
        Les données traitées pour la gestion du compte et de l’abonnement sont décrites dans les{' '}
        <a href="/mentions-legales">mentions légales</a>.
      </p>

      <h2>9. Réclamations et médiation</h2>
      <p>
        Toute réclamation peut être adressée à {PUBLISHER.email}. À défaut de solution amiable, le
        consommateur peut recourir gratuitement au médiateur de la consommation : {PUBLISHER.mediator}.
      </p>

      <h2>10. Droit applicable</h2>
      <p>Les présentes conditions sont soumises au droit français.</p>
    </article>
  )
}

export function MentionsLegales() {
  return (
    <article className="legal">
      <h1>Mentions légales</h1>

      <h2>Éditeur</h2>
      <p>
        {SITE} est édité par {PUBLISHER.name}, {PUBLISHER.status}, SIRET {PUBLISHER.siret},{' '}
        {PUBLISHER.address}. Contact : {PUBLISHER.email}. Directeur de la publication :{' '}
        {PUBLISHER.name}.
      </p>

      <h2>Hébergement</h2>
      <p>
        Le site, les comptes et les données publiées sont hébergés par Cloudflare, Inc., 101 Townsend
        Street, San Francisco, CA 94107, États-Unis — cloudflare.com.
      </p>

      <h2>Données publiques</h2>
      <p>
        Les diagnostics proviennent de l’ADEME et sont réutilisés sous la{' '}
        <a href="https://www.etalab.gouv.fr/licence-ouverte-open-licence">
          Licence Ouverte / Open Licence (Etalab)
        </a>
        . Ils sont reproduits tels que publiés, sans modification de leur contenu.
      </p>

      <h2>Données personnelles</h2>
      <p>
        Pour tenir un compte, {SITE} conserve le nom et l’adresse e-mail transmis par Google lors de la
        connexion, ainsi que les logements et recherches que l’utilisateur choisit d’enregistrer. Pour
        un abonné, il conserve aussi les identifiants client et d’abonnement Stripe, l’état de
        l’abonnement et sa date de fin ; les données de carte sont traitées par Stripe seul.
      </p>
      <p>
        Ces traitements reposent sur l’exécution du contrat (le compte et l’abonnement). Les données
        sont conservées tant que le compte existe, et supprimées à sa suppression, sauf les pièces que la
        loi impose de garder. Sous-traitants : Cloudflare (hébergement), Google (connexion), Stripe
        (paiement).
      </p>
      <p>
        Chacun peut accéder à ses données, les faire rectifier ou supprimer, et demander la suppression
        de son compte, en écrivant à {PUBLISHER.email}. Une réclamation peut être portée devant la CNIL
        (cnil.fr).
      </p>

      <h2>Cookies</h2>
      <p>
        Le site ne dépose que les cookies strictement nécessaires à la connexion. Il n’utilise ni mesure
        d’audience, ni publicité, ni aucun autre traceur.
      </p>
    </article>
  )
}
