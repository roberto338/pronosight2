// ══════════════════════════════════════════════
// prono/data/normalisation.js — règles métier, sans base
// ══════════════════════════════════════════════
//
// Ces fonctions portent les décisions qui comptent : ce qu'on retient d'une
// rencontre, comment on lit les buts selon le camp, à partir de quand les
// moyennes d'une ligue sont dignes de confiance.
//
// Elles sont séparées de repository.js pour une raison concrète : importer
// repository.js ouvre un pool PostgreSQL au chargement du module. Les
// règles ci-dessous seraient alors intestables sans base — et donc, en
// pratique, jamais testées.

// Moyennes de repli, mesurées sur les grands championnats européens. Elles
// ne servent QUE tant qu'une compétition n'a pas assez de matchs en base
// pour que ses propres moyennes soient fiables — et l'appelant est informé
// qu'il travaille sur un repli, jamais silencieusement.
export const MOY_DOM_DEFAUT = 1.55;
export const MOY_EXT_DEFAUT = 1.20;
export const MIN_MATCHS_LIGUE = 30;

// Fenêtre d'historique retenue pour le calcul des forces. Au-delà de six
// mois, la pondération par demi-vie de 90 jours rend les matchs négligeables
// (poids < 0,25) : les charger coûterait sans rien changer au résultat.
export const FENETRE_JOURS = 180;

// ══════════════════════════════════════════════
// Sources retenues — une seule, et c'est délibéré
// ══════════════════════════════════════════════
//
// victor/sources.js prefixe les identifiants d'equipe par source : `fd:521`
// pour football-data, `af:85` pour API-Football, `tsdb:133714` pour
// TheSportsDB. Ce cloisonnement protege l'indice de forme des homonymes
// (sources.js:449) et il est juste. Mais il a une consequence pour une
// memoire qui, elle, PERSISTE entre les runs.
//
// dedupe() fusionne bien les doublons a l'interieur d'une journee, en
// donnant la priorite a football-data. Il ne peut rien entre deux jours :
// si football-data est indisponible un soir, la rencontre est enregistree
// sous des identifiants `tsdb:`, et le lendemain la meme equipe revient
// sous `fd:`. Elle existerait alors en base comme DEUX equipes distinctes,
// chacune avec la moitie de son historique — donc deux fois sous le seuil
// des dix matchs, sans que rien ne le signale.
//
// Deuxieme raison, dirimante : seul football-data renseigne codeCompet.
// Sans code de competition, moyennesLigue ne peut pas calculer la reference
// par rapport a laquelle une force vaut 1, et le repli s'appliquerait a
// toutes les rencontres des autres sources.
//
// On ne conserve donc que football-data. C'est deja la seule source de
// buildFormIndex, qui fournit l'essentiel du volume. Les rencontres des
// autres sources continuent d'alimenter Victor exactement comme avant :
// elles ne sont simplement pas memorisees pour le modele.
//
// A rouvrir le jour ou une table de correspondance d'equipes entre sources
// existera — pas avant, et surtout pas par defaut.
export const SOURCES_MEMORISEES = new Set(['football-data']);

// ══════════════════════════════════════════════

/**
 * Convertit une rencontre normalisée par victor/sources.js en ligne de base.
 * Retourne null si la rencontre n'est pas exploitable — et c'est le cas le
 * plus fréquent : on ne conserve que du football terminé avec un score et
 * des identifiants d'équipe.
 *
 * @param {Object} f  fixture au format sources.js
 * @returns {Object|null}
 */
export function ligneDepuisFixture(f) {
  if (!f) return null;

  // Le modèle de Poisson calibré ici est un modèle de FOOTBALL. Les autres
  // sports de Victor (basket, tennis) n'ont ni la même distribution de
  // scores ni la même notion de but : les stocker fausserait les moyennes.
  if (f.sport && f.sport !== 'Football') return null;

  // Une seule source memorisee : voir SOURCES_MEMORISEES ci-dessus.
  if (!SOURCES_MEMORISEES.has(f.source)) return null;

  if (f.status !== 'FT') return null;
  if (f.homeGoals == null || f.awayGoals == null) return null;

  const butsDom = Number(f.homeGoals), butsExt = Number(f.awayGoals);
  if (!Number.isInteger(butsDom) || !Number.isInteger(butsExt)) return null;
  if (butsDom < 0 || butsExt < 0) return null;

  // Sans identifiant d'équipe, la rencontre est inutilisable : indexer par
  // nom ferait fusionner les homonymes de championnats différents. C'est le
  // piège que sources.js:449 documente pour l'indice de forme, et il vaut
  // ici avec la même force.
  if (!f.homeId || !f.awayId) return null;
  if (f.homeId === f.awayId) return null;

  const joueLe = (f.dateISO || f.debutUTC || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(joueLe)) return null;

  return {
    source:          f.source,
    source_match_id: f.fixtureId != null ? String(f.fixtureId) : null,
    competition:     f.competition || null,
    competition_code: f.codeCompet || null,
    joue_le:         joueLe,
    equipe_dom_id:   f.homeId,
    equipe_ext_id:   f.awayId,
    equipe_dom:      f.home || '',
    equipe_ext:      f.away || '',
    buts_dom:        butsDom,
    buts_ext:        butsExt,
  };
}

/**
 * Historique d'une équipe au format attendu par le moteur.
 * Le sens des buts dépend du camp : marqués à domicile = buts_dom, à
 * l'extérieur = buts_ext. Inverser les deux inverserait attaque et défense.
 */
export function versHistorique(lignes, equipeId) {
  const out = [];
  for (const l of lignes) {
    const aDomicile = l.equipe_dom_id === equipeId;
    const aExterieur = l.equipe_ext_id === equipeId;
    if (!aDomicile && !aExterieur) continue;
    out.push({
      date: typeof l.joue_le === 'string' ? l.joue_le : new Date(l.joue_le).toISOString().slice(0, 10),
      butsMarques:   aDomicile ? Number(l.buts_dom) : Number(l.buts_ext),
      butsEncaisses: aDomicile ? Number(l.buts_ext) : Number(l.buts_dom),
      domicile: aDomicile,
      adversaire: aDomicile ? l.equipe_ext : l.equipe_dom,
    });
  }
  return out;
}

/**
 * Moyennes de buts d'une compétition, mesurées sur ses propres rencontres.
 *
 * C'est la référence par rapport à laquelle une force vaut 1. L'utiliser
 * au lieu d'une constante importe : la Ligue 1 et l'Eredivisie n'ont pas le
 * même niveau de buts, et une équipe moyenne en Eredivisie ressortirait
 * comme une attaque d'élite si on la comparait à la moyenne française.
 */
export function moyennesDepuisLignes(lignes) {
  const n = lignes.length;
  if (n < MIN_MATCHS_LIGUE) {
    return {
      moyButsDom: MOY_DOM_DEFAUT,
      moyButsExt: MOY_EXT_DEFAUT,
      nMatchs: n,
      mesuree: false,   // l'appelant DOIT pouvoir le signaler à l'utilisateur
    };
  }
  let dom = 0, ext = 0;
  for (const l of lignes) { dom += Number(l.buts_dom); ext += Number(l.buts_ext); }
  return { moyButsDom: dom / n, moyButsExt: ext / n, nMatchs: n, mesuree: true };
}


export default { ligneDepuisFixture, versHistorique, moyennesDepuisLignes,
  MOY_DOM_DEFAUT, MOY_EXT_DEFAUT, MIN_MATCHS_LIGUE, FENETRE_JOURS, SOURCES_MEMORISEES };
