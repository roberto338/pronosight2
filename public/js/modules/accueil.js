// ══════════════════════════════════════════════
// public/js/modules/accueil.js — l'écran d'accueil qui donne envie d'analyser
// ══════════════════════════════════════════════
//
// L'accueil montrait une bankroll, un taux de réussite et un état vide :
// rien à faire. Il montre maintenant ce qui se joue aujourd'hui et un bouton
// « Analyser » sur chaque affiche, comme une app de sport montre ses matchs.
//
// Fonctions pures, testées sous Node. Les noms venus des API sont échappés ici.

import { echapperHtml as e } from './securite.js';
import { icone, ecusson } from './icones.js';

// Les compétitions que les gens suivent le plus passent devant.
const PRIORITE = ['ligue des champions', 'champions league', 'ligue 1', 'premier league', 'la liga',
  'primera division', 'serie a', 'bundesliga', 'europa league', 'ligue 2', 'nba', 'eredivisie', 'primeira liga'];

const simple = (s = '') => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export function rangCompet(competition = '') {
  const c = simple(competition);
  const i = PRIORITE.findIndex(p => c.includes(p));
  return i === -1 ? PRIORITE.length : i;
}

/** Les matchs à proposer : pas encore terminés, grandes compétitions d'abord, puis l'heure. */
export function matchsAAnalyser(matchs = [], { max = 6 } = {}) {
  return matchs
    .map((m, index) => ({ ...m, index }))
    .filter(m => m.statut !== 'FT' && m.equipe_a && m.equipe_b)
    .sort((a, b) => (b.statut === 'LIVE') - (a.statut === 'LIVE')
      || rangCompet(a.competition) - rangCompet(b.competition)
      || String(a.heure || '99').localeCompare(String(b.heure || '99')))
    .slice(0, max);
}

/** Bandeau du haut : le programme du jour en trois chiffres et une action. */
export function htmlUne({ aVenir = null, valeurs = 0, pronos = 0, jour = new Date() } = {}) {
  const date = jour.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  const chiffre = (n, lib, cls = '') => `<div class="une-chiffre ${cls}"><b>${n ?? '–'}</b><span>${lib}</span></div>`;
  return `<div class="une">
  <div class="une-sur">${e(date)}</div>
  <div class="une-titre">Le terrain du jour</div>
  <div class="une-texte">Choisis une affiche : PronoSight compare les cotes du marché, en tire les vraies probabilités du match et te montre où se cache la valeur.</div>
  <div class="une-chiffres">
    ${chiffre(aVenir, 'matchs à venir')}
    ${chiffre(valeurs, valeurs > 1 ? 'values repérées' : 'value repérée', valeurs ? 'chaud' : '')}
    ${chiffre(pronos, pronos > 1 ? 'pronos de Victor' : 'prono de Victor')}
  </div>
  <button class="dash-cta" onclick="${valeurs ? "switchNav('valeurs')" : "switchNav('today')"}">
    ${valeurs ? `${icone('flamme', { taille: 18 })}Voir les values du jour` : `${icone('loupe', { taille: 18 })}Choisir un match`}
  </button>
</div>`;
}

/** Une affiche cliquable : heure, deux écussons, bouton Analyser. */
export function ligneMatch(m) {
  const direct = m.statut === 'LIVE';
  const [s1, s2] = String(m.score || '').split('-');
  const score = (v) => (m.score ? `<span class="match-ligne-score">${e(v)}</span>` : '');
  return `<div class="match-ligne" onclick="analyserDepuisAccueil(${m.index})">
  <div class="match-ligne-heure ${direct ? 'direct' : ''}">${direct ? 'LIVE' : e(m.heure || '—')}<small>${direct ? 'en cours' : 'coup d\'envoi'}</small></div>
  <div class="match-ligne-equipes">
    <div class="match-ligne-equipe">${ecusson(e(m.equipe_a), { taille: 26 })}<span>${e(m.equipe_a)}</span>${score(s1)}</div>
    <div class="match-ligne-equipe">${ecusson(e(m.equipe_b), { taille: 26 })}<span>${e(m.equipe_b)}</span>${score(s2)}</div>
  </div>
  <button class="bouton-analyser" onclick="event.stopPropagation();analyserDepuisAccueil(${m.index})" aria-label="Analyser ${e(m.equipe_a)} contre ${e(m.equipe_b)}">${icone('loupe', { taille: 16, epaisseur: 2.4 })}<span>Analyser</span></button>
</div>`;
}

/** La liste « À analyser maintenant », groupée par compétition. */
export function htmlAAnalyser(matchs = [], { max = 6, charge = true } = {}) {
  if (!charge) return `<div class="vm-note" style="margin:0">Chargement du programme…</div>`;
  const choisis = matchsAAnalyser(matchs, { max });
  if (!choisis.length) {
    return `<div class="etat-vide" style="padding:24px 10px">
  <div class="etat-vide-icone">${icone('calendrier')}</div>
  <div class="etat-vide-titre">Pas de match à venir</div>
  <div class="etat-vide-texte">Le programme de la journée est terminé. Reviens demain matin, ou analyse une affiche de ton choix.</div>
  <button class="dash-cta" style="margin-top:16px" onclick="ouvrirAnalyseLibre()">Analyser un match</button>
</div>`;
  }
  let html = '', courante = null;
  for (const m of choisis) {
    if (m.competition !== courante) {
      courante = m.competition;
      const n = matchs.filter(x => x.competition === courante && x.statut !== 'FT').length;
      html += `<div class="compet-entete">${e(courante || 'Autres')}<span class="compte">${n} match${n > 1 ? 's' : ''}</span></div>`;
    }
    html += ligneMatch(m);
  }
  const reste = matchs.filter(m => m.statut !== 'FT').length - choisis.length;
  if (reste > 0) {
    html += `<button class="victor-actualiser" style="width:100%;justify-content:center;padding:12px;margin-top:4px" onclick="switchNav('today')">Voir les ${reste} autres matchs ${icone('fleche', { taille: 16 })}</button>`;
  }
  return html;
}

export default { rangCompet, matchsAAnalyser, htmlUne, ligneMatch, htmlAAnalyser };
