// ══════════════════════════════════════════════
// victor/patterns-compute.js — Calcul de patterns réels
//
// ps_victor_patterns est restée VIDE depuis la création du projet :
// discoverNewPatterns() dérivait les patterns de ps_pronostics, qui n'a
// jamais contenu un seul pronostic noté. Le moteur tournait sur du vide,
// et le prompt invoquait des patterns qui n'ont jamais existé.
//
// Ici on inverse la dépendance : les patterns sont calculés à partir de
// l'HISTORIQUE RÉEL DES MATCHS (football-data), pas des performances de
// Victor. Ils sont donc disponibles immédiatement, sans attendre des mois
// de tracking, et ils sont vrais par construction.
//
// Deux familles :
//   1. Taux de base par compétition (Over 2.5, BTTS, victoire dom., nul)
//   2. Profils d'équipe domicile/extérieur (là où l'échantillon suffit)
// ══════════════════════════════════════════════

import { query } from '../db/database.js';

const FD_KEY = process.env.FOOTBALL_DATA_KEY;

// Nombre minimum d'observations avant de publier un pattern.
// En dessous, le taux n'est que du bruit.
const MIN_OCCURRENCES      = 12;
const MIN_OCCURRENCES_TEAM = 8;

/** Fiabilité dérivée de l'écart au hasard ET de la taille d'échantillon. */
function fiabilite(taux, n) {
  if (n >= 30 && (taux >= 70 || taux <= 30)) return 'Fort';
  if (n >= 20 && (taux >= 62 || taux <= 38)) return 'Moyen';
  return 'Émergent';
}

/**
 * Récupère l'historique des matchs terminés sur `jours` jours.
 * Découpé en tranches de 10 jours (limite football-data) et espacé
 * pour rester sous les 10 requêtes/minute.
 */
async function historique(jours = 90) {
  if (!FD_KEY) return [];
  const matchs = [];
  const FENETRE = 10;

  for (let debut = jours; debut > 0; debut -= FENETRE) {
    const dateFrom = new Date(Date.now() - debut * 864e5).toISOString().slice(0, 10);
    const dateTo   = new Date(Date.now() - Math.max(debut - FENETRE, 0) * 864e5).toISOString().slice(0, 10);
    try {
      const resp = await fetch(
        `https://api.football-data.org/v4/matches?dateFrom=${dateFrom}&dateTo=${dateTo}&status=FINISHED`,
        { headers: { 'X-Auth-Token': FD_KEY }, signal: AbortSignal.timeout(20000) }
      );
      if (resp.status === 429) {
        await new Promise(r => setTimeout(r, 61_000));
        debut += FENETRE; // on refait cette tranche
        continue;
      }
      if (resp.ok) {
        const d = await resp.json();
        matchs.push(...(d.matches || []));
      }
    } catch { /* tranche perdue : le calcul reste valide sur le reste */ }
    await new Promise(r => setTimeout(r, 7000)); // ~8.5 req/min
  }
  return matchs;
}

/** Agrège un ensemble de matchs en compteurs. */
function agreger(matchs) {
  const c = { n: 0, over25: 0, over15: 0, under35: 0, btts: 0, domGagne: 0, nul: 0, extGagne: 0 };
  for (const m of matchs) {
    const h = m.score?.fullTime?.home, a = m.score?.fullTime?.away;
    if (h == null || a == null) continue;
    c.n++;
    if (h + a > 2.5) c.over25++;
    if (h + a > 1.5) c.over15++;
    if (h + a < 3.5) c.under35++;
    if (h > 0 && a > 0) c.btts++;
    if (h > a) c.domGagne++;
    else if (h === a) c.nul++;
    else c.extGagne++;
  }
  return c;
}

/**
 * Calcule les patterns et les écrit dans ps_victor_patterns.
 * Idempotent : ON CONFLICT (nom) DO UPDATE — relancer met à jour les taux.
 * @returns {Promise<{calcules:number, ecrits:number, matchs:number}>}
 */
export async function computePatterns({ jours = 90, ecrire = true } = {}) {
  console.log(`\n🧮 Calcul des patterns sur ${jours} jours d'historique réel...`);
  const matchs = await historique(jours);
  console.log(`   📚 ${matchs.length} match(s) terminé(s) récupéré(s)`);

  if (matchs.length === 0) {
    console.warn('   ⚠️  Aucun historique — patterns non calculés');
    return { calcules: 0, ecrits: 0, matchs: 0 };
  }

  const patterns = [];

  // ── 1. Taux de base par compétition ─────────────────────────
  const parCompet = new Map();
  for (const m of matchs) {
    const nom = m.competition?.name;
    if (!nom) continue;
    if (!parCompet.has(nom)) parCompet.set(nom, []);
    parCompet.get(nom).push(m);
  }

  // Chaque marché avec son inverse. Un pattern doit TOUJOURS être exprimé
  // dans le sens qui se confirme : « le nul tombe 24% du temps » n'est pas
  // exploitable et serait de toute façon filtré par le seuil de 55% de
  // detectPatterns. « Pas de nul 76% du temps » est actionnable.
  const marches = [
    // [libellé, champ, pari si taux >= 50, libellé inverse, pari inverse]
    ['Over 2.5 buts',   'over25',   'Over 2.5 buts',              'Under 2.5 buts',        'Under 2.5 buts'],
    ['Under 3.5 buts',  'under35',  'Under 3.5 buts',             'Over 3.5 buts',         'Over 3.5 buts'],
    ['Over 1.5 buts',   'over15',   'Over 1.5 buts',              'Under 1.5 buts',        'Under 1.5 buts'],
    ['BTTS',            'btts',     'Les deux équipes marquent',  'BTTS Non',              'Une équipe ne marque pas'],
    ['Victoire domicile', 'domGagne', 'Victoire domicile',        'Domicile ne gagne pas', 'Double chance : nul ou extérieur'],
    ['Match nul',       'nul',      'Match nul',                  'Pas de match nul',      'Double chance : pas de nul'],
  ];

  for (const [compet, list] of parCompet) {
    const c = agreger(list);
    if (c.n < MIN_OCCURRENCES) continue;

    for (const [libelle, champ, pari, libelleInv, pariInv] of marches) {
      const brut    = (100 * c[champ]) / c.n;
      const inverse = brut < 50;
      const taux    = inverse ? 100 - brut : brut;
      const conf    = inverse ? c.n - c[champ] : c[champ];
      const lib     = inverse ? libelleInv : libelle;

      patterns.push({
        nom:   `[Taux] ${compet} — ${lib}`,
        type:  'situationnel',
        sport: 'Football',
        equipe_a: null, equipe_b: null,
        condition_trigger: `Match de ${compet}`,
        pattern_observe: `${lib} : ${conf} fois sur ${c.n} matchs (${taux.toFixed(1)}%) sur les ${jours} derniers jours.`,
        occurrences_total: c.n,
        occurrences_confirmees: conf,
        taux_confirmation: Number(taux.toFixed(2)),
        pari_suggere: inverse ? pariInv : pari,
        fiabilite: fiabilite(taux, c.n),
      });
    }
  }

  // ── 2. Profils d'équipe à domicile / à l'extérieur ──────────
  const parEquipe = new Map(); // "id|DOM" ou "id|EXT"
  const pousser = (id, nom, lieu, m) => {
    if (id == null) return;
    const cle = `${id}|${lieu}`;
    if (!parEquipe.has(cle)) parEquipe.set(cle, { nom, lieu, matchs: [] });
    parEquipe.get(cle).matchs.push(m);
  };
  for (const m of matchs) {
    pousser(m.homeTeam?.id, m.homeTeam?.shortName || m.homeTeam?.name, 'DOM', m);
    pousser(m.awayTeam?.id, m.awayTeam?.shortName || m.awayTeam?.name, 'EXT', m);
  }

  for (const { nom, lieu, matchs: list } of parEquipe.values()) {
    const c = agreger(list);
    if (c.n < MIN_OCCURRENCES_TEAM) continue;
    const gagne = lieu === 'DOM' ? c.domGagne : c.extGagne;
    const tauxV = (100 * gagne) / c.n;
    const tauxO = (100 * c.over25) / c.n;
    const ou    = lieu === 'DOM' ? 'à domicile' : 'à l\'extérieur';

    // Signal de victoire — exprimé dans le sens qui se confirme
    if (tauxV >= 65 || tauxV <= 25) {
      const gagneSouvent = tauxV >= 65;
      patterns.push({
        nom:   `[Équipe] ${nom} ${ou} — ${gagneSouvent ? 'gagne souvent' : 'gagne rarement'}`,
        type:  'situationnel', sport: 'Football',
        equipe_a: nom, equipe_b: null,
        condition_trigger: `${nom} joue ${ou}`,
        pattern_observe: gagneSouvent
          ? `${nom} a gagné ${gagne} de ses ${c.n} derniers matchs ${ou} (${tauxV.toFixed(1)}%).`
          : `${nom} n'a PAS gagné ${c.n - gagne} de ses ${c.n} derniers matchs ${ou} (${(100 - tauxV).toFixed(1)}%).`,
        occurrences_total: c.n,
        occurrences_confirmees: gagneSouvent ? gagne : c.n - gagne,
        taux_confirmation: Number((gagneSouvent ? tauxV : 100 - tauxV).toFixed(2)),
        pari_suggere: gagneSouvent
          ? (lieu === 'DOM' ? 'Victoire domicile' : 'Victoire extérieur')
          : `Double chance contre ${nom}`,
        fiabilite: fiabilite(gagneSouvent ? tauxV : 100 - tauxV, c.n),
      });
    }

    // Signal de volume de buts — idem
    if (tauxO >= 70 || tauxO <= 30) {
      const beaucoupDeButs = tauxO >= 70;
      patterns.push({
        nom:   `[Équipe] ${nom} ${ou} — matchs ${beaucoupDeButs ? 'ouverts' : 'fermés'}`,
        type:  'situationnel', sport: 'Football',
        equipe_a: nom, equipe_b: null,
        condition_trigger: `${nom} joue ${ou}`,
        pattern_observe: beaucoupDeButs
          ? `${c.over25} des ${c.n} derniers matchs de ${nom} ${ou} ont dépassé 2.5 buts (${tauxO.toFixed(1)}%).`
          : `${c.n - c.over25} des ${c.n} derniers matchs de ${nom} ${ou} sont restés sous 2.5 buts (${(100 - tauxO).toFixed(1)}%).`,
        occurrences_total: c.n,
        occurrences_confirmees: beaucoupDeButs ? c.over25 : c.n - c.over25,
        taux_confirmation: Number((beaucoupDeButs ? tauxO : 100 - tauxO).toFixed(2)),
        pari_suggere: beaucoupDeButs ? 'Over 2.5 buts' : 'Under 2.5 buts',
        fiabilite: fiabilite(beaucoupDeButs ? tauxO : 100 - tauxO, c.n),
      });
    }
  }

  console.log(`   🧮 ${patterns.length} pattern(s) calculé(s)`);
  if (!ecrire) return { calcules: patterns.length, ecrits: 0, matchs: matchs.length, patterns };

  // ── 3. Écriture idempotente ─────────────────────────────────
  let ecrits = 0;
  for (const p of patterns) {
    try {
      await query(
        `INSERT INTO ps_victor_patterns
           (nom, type, sport, equipe_a, equipe_b, condition_trigger, pattern_observe,
            occurrences_total, occurrences_confirmees, taux_confirmation,
            pari_suggere, fiabilite, derniere_confirmation, actif)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,CURRENT_DATE,true)
         ON CONFLICT (nom) DO UPDATE SET
           pattern_observe        = EXCLUDED.pattern_observe,
           occurrences_total      = EXCLUDED.occurrences_total,
           occurrences_confirmees = EXCLUDED.occurrences_confirmees,
           taux_confirmation      = EXCLUDED.taux_confirmation,
           pari_suggere           = EXCLUDED.pari_suggere,
           fiabilite              = EXCLUDED.fiabilite,
           derniere_confirmation  = CURRENT_DATE,
           actif                  = true`,
        [p.nom, p.type, p.sport, p.equipe_a, p.equipe_b, p.condition_trigger, p.pattern_observe,
         p.occurrences_total, p.occurrences_confirmees, p.taux_confirmation, p.pari_suggere, p.fiabilite]
      );
      ecrits++;
    } catch (err) {
      console.warn(`   ⚠️  Pattern "${p.nom}" non écrit: ${err.message}`);
    }
  }

  // Les patterns calculés il y a plus de 30 jours et non rafraîchis
  // reposent sur un historique périmé : on les désactive.
  const { rowCount: perimes } = await query(
    `UPDATE ps_victor_patterns SET actif = false
     WHERE actif = true AND derniere_confirmation < CURRENT_DATE - 30`
  );
  if (perimes > 0) console.log(`   🧹 ${perimes} pattern(s) périmé(s) désactivé(s)`);

  console.log(`   ✅ ${ecrits} pattern(s) écrit(s) en base`);
  return { calcules: patterns.length, ecrits, matchs: matchs.length };
}

export default computePatterns;
