// ══════════════════════════════════════════════
// victor/valeur-suivi.js — enregistrer, noter et publier le bilan
//                         des values de marché
// ══════════════════════════════════════════════
//
// Un signal vendu doit pouvoir être vérifié. Chaque value de marché diffusée
// est enregistrée dans ps_valeurs_marche (migration 015), notée après le
// match, et le bilan est public (/bilan). Rien n'est retouché après coup :
// la cote enregistrée est celle diffusée.
//
// Les scores viennent d'ESPN (gratuit, sans clé) : The Odds API facture ses
// scores, et son palier gratuit est déjà consommé par les cotes. La ligue est
// connue par la clé de sport du signal ; les équipes sont rapprochées par le
// nom avec les garde-fous de victor/espn.js (ligue du match, candidat unique).
//
// Toute fonction réseau ou base échoue sans jamais casser l'analyse du jour.

import { query } from '../db/database.js';
import { fetchWithTimeout } from './sources.js';
import { ligueEspn, apparierEquipe } from './espn.js';
import { evaluerCode } from './paris.js';

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';

/** Enregistre les signaux diffusés. Rend le nombre de lignes écrites. */
export async function enregistrerValeursMarche(dateISO, signaux = []) {
  let ecrits = 0;
  for (const s of signaux) {
    try {
      const { rowCount } = await query(
        `INSERT INTO ps_valeurs_marche
           (date, match, competition, equipe_a, equipe_b, debut_utc, sport_key, code_compet,
            pari_code, libelle, cote, bookmaker, proba_juste, avantage, nb_bookmakers)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (date, match, pari_code) DO NOTHING`,
        [dateISO, s.match, s.competition || null, s.equipe_a, s.equipe_b, s.debutUTC || null,
         s.sportKey || null, s.codeCompet || null, s.pari_code, s.libelle || null,
         s.cote, s.bookmaker || null, s.probaJuste, s.avantage, s.bookmakers ?? null],
      );
      ecrits += rowCount;
    } catch (err) {
      console.warn(`   ⚠️  Value de marché non enregistrée (${s.match}) : ${err.message}`);
    }
  }
  return ecrits;
}

const valeurScore = (sc) => {
  const v = typeof sc === 'object' && sc !== null ? (sc.value ?? sc.displayValue) : sc;
  const n = Number(v);
  return v === null || v === undefined || v === '' || Number.isNaN(n) ? null : n;
};

/** Lit un scoreboard ESPN : matchs TERMINÉS seulement. Pur. */
export function lireScoresEspn(json) {
  const out = [];
  for (const ev of Array.isArray(json?.events) ? json.events : []) {
    const c = ev?.competitions?.[0];
    if (!c?.status?.type?.completed) continue;
    const dom = c.competitors?.find(k => k.homeAway === 'home');
    const ext = c.competitors?.find(k => k.homeAway === 'away');
    const bd = valeurScore(dom?.score), be = valeurScore(ext?.score);
    if (!dom?.team || !ext?.team || bd === null || be === null) continue;
    const equipe = (t) => ({ id: String(t.id), noms: [...new Set([t.displayName, t.shortDisplayName, t.name, t.location].filter(Boolean))] });
    out.push({ dom: equipe(dom.team), ext: equipe(ext.team), butsDom: bd, butsExt: be });
  }
  return out;
}

/** Le score d'un signal parmi les matchs terminés d'une ligue, ou null. Pur. */
export function trouverScore(signal, matchs = []) {
  const equipes = [];
  const vus = new Set();
  for (const m of matchs) for (const e of [m.dom, m.ext]) if (!vus.has(e.id)) { vus.add(e.id); equipes.push(e); }
  const a = apparierEquipe(signal.equipe_a, equipes);
  const b = apparierEquipe(signal.equipe_b, equipes);
  if (!a || !b || a.id === b.id) return null;
  const trouves = matchs.filter(m => m.dom.id === a.id && m.ext.id === b.id);
  return trouves.length === 1 ? trouves[0] : null;
}

const ymd = (iso) => String(iso).slice(0, 10).replace(/-/g, '');
const lendemain = (iso) => new Date(Date.parse(`${String(iso).slice(0, 10)}T12:00:00Z`) + 864e5).toISOString().slice(0, 10);

/**
 * Note les signaux dont le match est terminé. Rend { notes, restants }.
 * Appelé par le job check-results du soir.
 */
export async function noterValeursMarche({ jours = 4 } = {}) {
  let rows;
  try {
    ({ rows } = await query(
      `SELECT id, to_char(date, 'YYYY-MM-DD') AS date_iso, equipe_a, equipe_b, competition,
              sport_key, code_compet, pari_code
       FROM ps_valeurs_marche
       WHERE gagne IS NULL AND date >= CURRENT_DATE - $1::int
         AND (debut_utc IS NULL OR debut_utc < NOW() - INTERVAL '2 hours')`, [jours]));
  } catch (err) {
    console.warn(`   ⚠️  Values de marché illisibles : ${err.message}`);
    return { notes: 0, restants: 0 };
  }
  if (rows.length === 0) return { notes: 0, restants: 0 };

  const cache = new Map();   // "ligue:AAAAMMJJ" → matchs terminés
  const scoresDu = async (ligue, iso) => {
    const cle = `${ligue}:${ymd(iso)}`;
    if (!cache.has(cle)) {
      try {
        const r = await fetchWithTimeout(`${BASE}/${ligue}/scoreboard?dates=${ymd(iso)}`,
          { headers: { 'User-Agent': 'PronoSight/1.0' } }, 10_000);
        cache.set(cle, r.ok ? lireScoresEspn(await r.json()) : []);
      } catch { cache.set(cle, []); }
    }
    return cache.get(cle);
  };

  let notes = 0;
  for (const r of rows) {
    const ligue = ligueEspn({ sportKey: r.sport_key, codeCompet: r.code_compet, competition: r.competition });
    if (!ligue) continue;
    const matchs = [...await scoresDu(ligue, r.date_iso), ...await scoresDu(ligue, lendemain(r.date_iso))];
    const score = trouverScore(r, matchs);
    if (!score) continue;
    const gagne = evaluerCode(r.pari_code, score.butsDom, score.butsExt);
    if (gagne === null) continue;
    try {
      await query(
        `UPDATE ps_valeurs_marche SET gagne = $2, score_reel = $3, note_le = NOW()
         WHERE id = $1 AND gagne IS NULL`,
        [r.id, gagne, `${score.butsDom}-${score.butsExt}`]);
      notes++;
    } catch (err) {
      console.warn(`   ⚠️  Notation impossible (#${r.id}) : ${err.message}`);
    }
  }
  console.log(`   📈 Values de marché notées : ${notes}/${rows.length}`);
  return { notes, restants: rows.length - notes };
}

/**
 * Bilan d'une liste de signaux notés, mise fixe d'une unité. Pur.
 * @returns {{n, gagnes, rendement, profit, avantageMoyen, coteMoyenne}}
 */
export function resumerBilan(rows = []) {
  const notes = rows.filter(r => r.gagne === true || r.gagne === false);
  const n = notes.length;
  if (n === 0) return { n: 0, gagnes: 0, rendement: null, profit: 0, avantageMoyen: null, coteMoyenne: null };
  const profit = notes.reduce((a, r) => a + (r.gagne ? Number(r.cote) - 1 : -1), 0);
  return {
    n,
    gagnes: notes.filter(r => r.gagne).length,
    profit,
    rendement: profit / n,
    avantageMoyen: notes.reduce((a, r) => a + Number(r.avantage), 0) / n,
    coteMoyenne: notes.reduce((a, r) => a + Number(r.cote), 0) / n,
  };
}

/** Bilan complet et bilan des 30 derniers jours. */
export async function bilanValeursMarche() {
  const { rows } = await query(
    `SELECT date, cote, avantage, gagne FROM ps_valeurs_marche WHERE gagne IS NOT NULL ORDER BY date`);
  const depuis30 = Date.now() - 30 * 864e5;
  return {
    total: resumerBilan(rows),
    trenteJours: resumerBilan(rows.filter(r => new Date(r.date).getTime() >= depuis30)),
    premier: rows[0]?.date ?? null,
  };
}

// ── Fiabilité dans le temps : semaine, mois, 6 mois, année ──

/** Date AAAA-MM-JJ en heure de Paris. */
export const jourParis = (maintenant = new Date()) => maintenant.toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
/** AAAA-MM-JJ décalé de n jours. Pur. */
export const decalerJour = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

/** Fenêtres glissantes, aujourd'hui compris. */
export const PERIODES = [
  { cle: 'semaine', libelle: '7 derniers jours', jours: 7 },
  { cle: 'mois', libelle: '30 derniers jours', jours: 30 },
  { cle: 'sixMois', libelle: '6 derniers mois', jours: 182 },
  { cle: 'annee', libelle: '12 derniers mois', jours: 365 },
];

/** En dessous, un taux de réussite dit peu de chose : c'est surtout la chance. */
export const SEUIL_ECHANTILLON = 30;

/**
 * Bilan d'une liste de paris notés {date, gagne, cote}, avec ce que les
 * cotes prévoyaient : la moyenne de 1/cote. Gagner plus souvent que ça,
 * c'est battre le bookmaker ; moins souvent, c'est perdre de l'argent,
 * quel que soit le taux de réussite affiché. Pur.
 */
export function resumerFiabilite(rows = []) {
  const notes = rows.filter(r => (r.gagne === true || r.gagne === false) && Number(r.cote) > 1);
  const b = resumerBilan(notes.map(r => ({ ...r, avantage: 0 })));
  return {
    ...b,
    avantageMoyen: null,          // Victor n'a pas d'« avantage » mesuré : on ne fabrique pas de moyenne.
    taux: b.n ? b.gagnes / b.n : null,
    attendu: b.n ? notes.reduce((a, r) => a + 1 / Number(r.cote), 0) / b.n : null,
  };
}

/** Bilan entre deux dates incluses (AAAA-MM-JJ). Pur. */
export const bilanEntre = (rows, debut, fin) => resumerFiabilite(rows.filter(r => r.date >= debut && r.date <= fin));

/** Les fenêtres glissantes et le total. Pur. */
export function bilanParPeriodes(rows = [], maintenant = new Date()) {
  const auj = jourParis(maintenant);
  const sortie = {};
  for (const p of PERIODES) sortie[p.cle] = { libelle: p.libelle, ...bilanEntre(rows, decalerJour(auj, -(p.jours - 1)), auj) };
  sortie.total = { libelle: 'Depuis le début', ...resumerFiabilite(rows) };
  return sortie;
}

/** Mois par mois, du plus ancien au mois en cours. Pur. */
export function evolutionMensuelle(rows = [], maintenant = new Date(), nbMois = 12) {
  let [a, m] = jourParis(maintenant).split('-').map(Number);
  const mois = [];
  for (let i = 0; i < nbMois; i++) {
    mois.unshift(`${a}-${String(m).padStart(2, '0')}`);
    if (--m === 0) { m = 12; a--; }
  }
  return mois.map(cle => ({ mois: cle, ...resumerFiabilite(rows.filter(r => String(r.date).startsWith(cle))) }));
}

/**
 * Les paris de Victor qui comptent pour le bilan, mêmes règles que /bilan :
 * cote de marché confirmée, hors doubles chances (aucune n'est cotée par
 * The Odds API). Du plus ancien au plus récent.
 */
export async function parisNotesVictor() {
  const { rows } = await query(
    `SELECT to_char(date, 'YYYY-MM-DD') AS date, pronostic_correct AS gagne, cote_estimee AS cote
     FROM ps_pronostics
     WHERE pronostic_correct IS NOT NULL AND cote_confirmee = true
       AND cote_estimee IS NOT NULL AND pari_code NOT LIKE 'DC:%'
     ORDER BY date`);
  return rows;
}

/** Bilan de Victor : depuis le début, par période et mois par mois. */
export async function bilanVictor(maintenant = new Date()) {
  const rows = await parisNotesVictor();
  return {
    ...resumerFiabilite(rows),
    premier: rows[0]?.date ?? null,
    periodes: bilanParPeriodes(rows, maintenant),
    mois: evolutionMensuelle(rows, maintenant),
  };
}

/** Values de marché des derniers jours, pour l'app web. Les plus récentes d'abord. */
export async function valeursRecentes({ jours = 14, limite = 120 } = {}) {
  const { rows } = await query(
    `SELECT to_char(date, 'YYYY-MM-DD') AS date, match, competition, equipe_a, equipe_b, debut_utc, pari_code, libelle,
            cote, bookmaker, proba_juste, avantage, nb_bookmakers, score_reel, gagne
     FROM ps_valeurs_marche
     WHERE date >= CURRENT_DATE - $1::int
     ORDER BY date DESC, avantage DESC
     LIMIT $2`, [jours, limite]);
  return rows.map(r => ({
    ...r,
    cote: Number(r.cote), proba_juste: Number(r.proba_juste), avantage: Number(r.avantage),
  }));
}

export default {
  enregistrerValeursMarche, lireScoresEspn, trouverScore, noterValeursMarche, resumerBilan, bilanValeursMarche,
  jourParis, decalerJour, resumerFiabilite, bilanEntre, bilanParPeriodes, evolutionMensuelle, parisNotesVictor, bilanVictor, valeursRecentes,
};
