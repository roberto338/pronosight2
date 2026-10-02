// ══════════════════════════════════════════════
// public/js/modules/paris.js — « Mes paris » : ce que l'utilisateur a VRAIMENT joué
// ══════════════════════════════════════════════
//
// L'ancien historique enregistrait CHAQUE analyse comme un pari, avec une
// mise inventée (10 €) et la cote de l'équipe à domicile quel que soit le
// pari choisi. La bankroll, le P&L et le ROI qui en découlaient étaient donc
// faux. Ici, un pari n'existe que si l'utilisateur l'enregistre, avec SA
// cote et SA mise. Tout le reste (gain, ROI, courbe, série) en découle.
//
// Fonctions pures, testées sous Node. Le stockage est fait par app.js.

export const RESULTATS = ['attente', 'gagne', 'perdu', 'rembourse'];

const nombre = (x) => { const n = Number(String(x ?? '').replace(',', '.')); return Number.isFinite(n) ? n : NaN; };

/** Valide et normalise une saisie. Rend { pari } ou { erreur }. */
export function creerPari({ match = '', competition = '', pari = '', cote, mise, date = null, source = 'perso' } = {}, maintenant = new Date()) {
  const c = nombre(cote), m = nombre(mise);
  if (!String(match).trim()) return { erreur: 'Indique le match.' };
  if (!String(pari).trim()) return { erreur: 'Indique ton pari.' };
  if (!(c > 1 && c < 1000)) return { erreur: 'La cote doit être supérieure à 1.' };
  if (!(m > 0 && m < 1e6)) return { erreur: 'La mise doit être positive.' };
  return {
    pari: {
      id: `${maintenant.getTime()}-${Math.random().toString(36).slice(2, 7)}`,
      cree_le: maintenant.toISOString(),
      date: date || maintenant.toISOString().slice(0, 10),
      match: String(match).trim().slice(0, 120),
      competition: String(competition).trim().slice(0, 80),
      pari: String(pari).trim().slice(0, 120),
      cote: Math.round(c * 100) / 100,
      mise: Math.round(m * 100) / 100,
      source,
      resultat: 'attente',
    },
  };
}

/** Gain net d'un pari réglé : +mise×(cote−1), −mise, ou 0. Null s'il est en attente. */
export function gainNet(p) {
  if (p.resultat === 'gagne') return Math.round(p.mise * (p.cote - 1) * 100) / 100;
  if (p.resultat === 'perdu') return -p.mise;
  if (p.resultat === 'rembourse') return 0;
  return null;
}

/** Bilan de tous les paris : tout ce qu'affichent l'accueil et « Mes paris ». */
export function bilanParis(paris = [], { bankrollInitiale = null } = {}) {
  const regles = paris.filter(p => p.resultat !== 'attente');
  const gagnes = regles.filter(p => p.resultat === 'gagne').length;
  const perdus = regles.filter(p => p.resultat === 'perdu').length;
  const profit = Math.round(regles.reduce((a, p) => a + gainNet(p), 0) * 100) / 100;
  const misesReglees = regles.reduce((a, p) => a + p.mise, 0);
  const enJeu = paris.filter(p => p.resultat === 'attente').reduce((a, p) => a + p.mise, 0);

  // Série en cours, du plus récent au plus ancien, remboursés ignorés.
  const parDate = [...regles].sort((a, b) => String(b.cree_le).localeCompare(String(a.cree_le)));
  let serie = 0, sens = null;
  for (const p of parDate) {
    if (p.resultat === 'rembourse') continue;
    if (!sens) sens = p.resultat;
    if (p.resultat !== sens) break;
    serie++;
  }
  const b0 = Number(bankrollInitiale);
  return {
    total: paris.length, regles: regles.length, attente: paris.length - regles.length,
    gagnes, perdus, profit, enJeu: Math.round(enJeu * 100) / 100,
    roi: misesReglees > 0 ? profit / misesReglees : null,
    taux: gagnes + perdus > 0 ? gagnes / (gagnes + perdus) : null,
    serie: serie ? { n: serie, sens } : null,
    bankroll: b0 > 0 ? Math.round((b0 + profit) * 100) / 100 : null,
  };
}

/** Évolution de la bankroll pari après pari (paris réglés, ordre chronologique). */
export function courbeBankroll(paris = [], bankrollInitiale) {
  const b0 = Number(bankrollInitiale);
  if (!(b0 > 0)) return [];
  const points = [b0];
  [...paris].filter(p => p.resultat !== 'attente')
    .sort((a, b) => String(a.cree_le).localeCompare(String(b.cree_le)))
    .forEach(p => points.push(Math.round((points[points.length - 1] + gainNet(p)) * 100) / 100));
  return points;
}

/** Export CSV (séparateur ; pour Excel en français). */
export function versCsv(paris = []) {
  const entetes = ['Date', 'Match', 'Compétition', 'Pari', 'Cote', 'Mise (€)', 'Résultat', 'Gain net (€)'];
  const lib = { attente: 'En attente', gagne: 'Gagné', perdu: 'Perdu', rembourse: 'Remboursé' };
  const lignes = paris.map(p => [p.date, p.match, p.competition, p.pari, p.cote, p.mise, lib[p.resultat] || p.resultat, gainNet(p) ?? '']
    .map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(';'));
  return '﻿' + [entetes.join(';'), ...lignes].join('\n');
}

export default { RESULTATS, creerPari, gainNet, bilanParis, courbeBankroll, versCsv };
