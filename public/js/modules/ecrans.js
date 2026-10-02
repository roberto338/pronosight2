// ══════════════════════════════════════════════
// public/js/modules/ecrans.js — Live, Aujourd'hui, Mes paris, Victor, Compétitions
// ══════════════════════════════════════════════
//
// Une seule source pour les matchs : /api/matchs, le calendrier que Victor
// lui-même consomme. Avant, Live et Aujourd'hui interrogeaient TheSportsDB
// avec une table d'identifiants écrite à la main, en partie fausse, et Live
// montrait le prochain calendrier au lieu des matchs en cours.
//
// Fonctions pures (HTML), testées sous Node. Chaînes externes échappées ici.

import { echapperHtml as e } from './securite.js';
import { icone } from './icones.js';
import { ligneMatch, grouperParCompet, rangCompet } from './accueil.js';
import { gainNet } from './paris.js';

const avecIndex = (matchs) => matchs.map((m, index) => ({ ...m, index }));
const parHeure = (a, b) => String(a.heure || '99').localeCompare(String(b.heure || '99'));
const euros = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2).replace('.', ',')} €`;
const pct = (x) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1).replace('.', ',')} %`);

function vide(ico, titre, texte, action = '') {
  return `<div class="etat-vide"><div class="etat-vide-icone">${icone(ico)}</div>
  <div class="etat-vide-titre">${titre}</div><div class="etat-vide-texte">${texte}</div>${action}</div>`;
}

function blocParCompet(matchs, { favoris = [] } = {}) {
  const fav = new Set(favoris);
  const tries = [...matchs].sort((a, b) => fav.has(b.competition) - fav.has(a.competition)
    || rangCompet(a.competition) - rangCompet(b.competition) || parHeure(a, b));
  return grouperParCompet(tries).map(([compet, liste]) =>
    `<div class="compet-entete">${fav.has(compet) ? icone('cible', { taille: 14 }) : ''}${e(compet || 'Autres')}<span class="compte">${liste.length} match${liste.length > 1 ? 's' : ''}</span></div>
     <div class="a-analyser">${liste.map(ligneMatch).join('')}</div>`).join('');
}

// ── LIVE ────────────────────────────────────────────────
export function htmlLive(matchs = [], { charge = true, maj = null, favoris = [] } = {}) {
  if (!charge) return `<div class="card">${vide('direct', 'Chargement', 'Récupération des scores…')}</div>`;
  const tous = avecIndex(matchs);
  const direct = tous.filter(m => m.statut === 'LIVE');
  const finis = tous.filter(m => m.statut === 'FT');
  const prochains = tous.filter(m => m.statut === 'NS').sort(parHeure).slice(0, 5);
  const heureMaj = maj ? `Actualisé à ${new Date(maj).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} · toutes les 2 min` : '';

  let html = `<div class="card">
  <div class="titre-section"><span class="point-direct"></span>En direct${direct.length ? ` <span class="compteur">${direct.length}</span>` : ''}</div>
  <div class="vm-note" style="margin:4px 0 12px">${heureMaj}</div>
  ${direct.length ? blocParCompet(direct, { favoris })
    : vide('direct', 'Aucun match en cours', prochains.length
      ? `Prochain coup d'envoi à <b>${e(prochains[0].heure || '—')}</b> : ${e(prochains[0].equipe_a)} – ${e(prochains[0].equipe_b)}.`
      : 'Plus aucun match au programme aujourd\'hui.')}
</div>`;
  if (prochains.length) {
    html += `<div class="card"><div class="titre-section">${icone('calendrier')}Prochains coups d'envoi</div>
      <div class="a-analyser" style="margin-top:12px">${prochains.map(ligneMatch).join('')}</div></div>`;
  }
  if (finis.length) {
    html += `<div class="card"><div class="titre-section">${icone('coche')}Terminés aujourd'hui</div>
      <div style="margin-top:12px">${blocParCompet(finis, { favoris })}</div></div>`;
  }
  return html;
}

// ── AUJOURD'HUI ─────────────────────────────────────────
export const FILTRES_JOUR = [
  ['tous', 'Tous'], ['avenir', 'À venir'], ['direct', 'En direct'], ['termines', 'Terminés'],
];

export function filtrerJour(matchs = [], filtre = 'tous') {
  if (filtre === 'avenir') return matchs.filter(m => m.statut === 'NS');
  if (filtre === 'direct') return matchs.filter(m => m.statut === 'LIVE');
  if (filtre === 'termines') return matchs.filter(m => m.statut === 'FT');
  return matchs.filter(m => m.statut !== 'OTHER');
}

export function htmlAujourdhui(matchs = [], { charge = true, filtre = 'tous', favoris = [], jour = new Date() } = {}) {
  const date = jour.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  const compte = (f) => filtrerJour(matchs, f).length;
  const puces = FILTRES_JOUR.map(([cle, lib]) =>
    `<button class="tab ${cle === filtre ? 'active' : ''}" onclick="filtrerAujourdhui('${cle}')">${lib}<span class="tab-compte">${charge ? compte(cle) : ''}</span></button>`).join('');
  const liste = filtrerJour(avecIndex(matchs), filtre);
  return `<div class="card">
  <div class="titre-section">${icone('calendrier')}Programme du ${e(date)}</div>
  <div class="sport-tabs" style="margin:12px 0 6px">${puces}</div>
  ${!charge ? vide('calendrier', 'Chargement', 'Récupération du programme…')
    : liste.length ? blocParCompet(liste, { favoris })
    : vide('calendrier', 'Aucun match', 'Rien ne correspond à ce filtre aujourd\'hui.')}
  <div class="vm-note">Sources : football-data.org, TheSportsDB, API-Football et The Odds API — le même calendrier que celui qu'analyse Victor.</div>
</div>`;
}

// ── MES COMPÉTITIONS ────────────────────────────────────
// On ne propose que des compétitions qui existent dans les données :
// celles du programme du jour et celles déjà suivies.
export function competitionsConnues(matchs = [], favoris = []) {
  const n = new Map();
  for (const m of matchs) if (m.competition) n.set(m.competition, (n.get(m.competition) || 0) + (m.statut === 'FT' ? 0 : 1));
  for (const f of favoris) if (!n.has(f)) n.set(f, 0);
  return [...n.entries()].sort((a, b) => rangCompet(a[0]) - rangCompet(b[0]) || b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function htmlCompetitions(matchs = [], { favoris = [], notifs = 'default' } = {}) {
  const fav = new Set(favoris);
  const liste = competitionsConnues(matchs, favoris);
  const puce = ([c, n]) => `<button class="compet-choix ${fav.has(c) ? 'suivie' : ''}" onclick="basculerFavori(this.dataset.c)" data-c="${e(c)}">
      ${icone(fav.has(c) ? 'coche' : 'cible', { taille: 15 })}<span>${e(c)}</span>${n ? `<small>${n}</small>` : ''}</button>`;
  const banniere = notifs === 'granted'
    ? `<div class="an-source marche">${icone('cloche', { taille: 15 })}Notifications activées : tu seras prévenu quand Victor ou une value touche tes compétitions.</div>`
    : notifs === 'denied'
      ? `<div class="an-source ia">${icone('cloche', { taille: 15 })}Notifications bloquées dans ton navigateur.</div>`
      : `<button class="dash-cta" style="width:100%;margin-bottom:14px" onclick="activerNotifs()">${icone('cloche', { taille: 18 })} Activer les notifications</button>`;
  return `<div class="card">
  <div class="titre-section">${icone('cloche')}Mes compétitions</div>
  <div class="vm-intro">Choisis tes championnats : leurs matchs passent en tête partout dans l'app, et tu es prévenu dès qu'un prono de Victor ou une value de marché y apparaît.</div>
  ${banniere}
  ${liste.length ? `<div class="compet-grille">${liste.map(puce).join('')}</div>`
    : vide('calendrier', 'Programme en cours de chargement', 'Les compétitions apparaissent dès que le calendrier du jour est connu.')}
  <div class="vm-note">Seules les compétitions présentes dans nos sources sont proposées : celles du jour, et celles que tu suis déjà.</div>
</div>`;
}

// ── MES PARIS ───────────────────────────────────────────
export function htmlMesParis(paris = [], bilan, { bankrollInitiale = null, filtre = 'tous' } = {}) {
  const lib = { attente: 'En attente', gagne: 'Gagné', perdu: 'Perdu', rembourse: 'Remboursé' };
  const stat = (val, nom, cls = '') => `<div class="dash-stat"><div class="dash-stat-val ${cls}">${val}</div><div class="dash-stat-lbl">${nom}</div></div>`;
  const resume = `<div class="dash-grid">
    ${stat(bilan.bankroll != null ? `${bilan.bankroll.toFixed(0)} €` : `<button class="lien-volt" onclick="document.getElementById('bkInitial').focus()">Définir</button>`, 'Bankroll')}
    ${stat(bilan.regles ? euros(bilan.profit) : '—', 'Gain net', bilan.profit > 0 ? 'pos' : bilan.profit < 0 ? 'neg' : '')}
    ${stat(pct(bilan.roi), 'Rendement', bilan.roi > 0 ? 'pos' : bilan.roi < 0 ? 'neg' : '')}
    ${stat(bilan.serie ? `${bilan.serie.n} ${bilan.serie.sens === 'gagne' ? 'V' : 'D'}` : '—', 'Série', bilan.serie?.sens === 'gagne' ? 'pos' : bilan.serie ? 'neg' : '')}
  </div>`;

  const filtres = [['tous', 'Tous'], ['attente', 'En attente'], ['gagne', 'Gagnés'], ['perdu', 'Perdus']]
    .map(([k, l]) => `<button class="tab ${k === filtre ? 'active' : ''}" onclick="filtrerParis('${k}')">${l}</button>`).join('');
  const liste = paris.filter(p => filtre === 'tous' || p.resultat === filtre)
    .sort((a, b) => String(b.cree_le).localeCompare(String(a.cree_le)));
  const ligne = (p) => {
    const g = gainNet(p);
    return `<div class="pari-ligne ${p.resultat}">
    <div class="pari-ligne-haut"><div><div class="pari-match">${e(p.match)}</div><div class="pari-meta">${e(p.competition || '')}${p.competition ? ' · ' : ''}${e(String(p.date).split('-').reverse().join('/'))}</div></div>
      <div class="pari-gain">${g == null ? `${p.mise.toFixed(2).replace('.', ',')} € en jeu` : euros(g)}</div></div>
    <div class="pari-ligne-bas"><span class="pari-pari">${e(p.pari)}</span><span class="cote-puce mini"><b>${p.cote.toFixed(2)}</b></span>
      <select class="pari-resultat" onchange="reglerPari('${e(p.id)}', this.value)" aria-label="Résultat">
        ${Object.entries(lib).map(([k, l]) => `<option value="${k}"${k === p.resultat ? ' selected' : ''}>${l}</option>`).join('')}
      </select>
      <button class="pari-suppr" onclick="supprimerPari('${e(p.id)}')" aria-label="Supprimer">${icone('croix', { taille: 15 })}</button></div>
  </div>`;
  };

  return `<div class="card">
  <div class="titre-section">${icone('portefeuille')}Mes paris</div>
  <div style="margin-top:12px">${resume}</div>
  ${bankrollInitiale > 0 ? `<div class="bk-chart" id="bkChart"><canvas id="bkCanvas"></canvas></div>` : ''}
  <div class="bk-ligne">
    <label for="bkInitial">Bankroll de départ</label>
    <input class="bk-input" id="bkInitial" type="number" min="1" inputmode="decimal" placeholder="ex. 200" value="${bankrollInitiale > 0 ? bankrollInitiale : ''}">
    <button class="bouton-discret" onclick="definirBankroll()">Enregistrer</button>
  </div>
</div>
<div class="card">
  <div class="titre-section" style="justify-content:space-between">${icone('historique')}Historique<button class="bouton-discret" style="margin-left:auto;font-size:13px" onclick="ouvrirFormPari({})">+ Ajouter un pari</button></div>
  <div class="sport-tabs" style="margin:12px 0">${filtres}</div>
  ${liste.length ? liste.map(ligne).join('')
    : vide('portefeuille', paris.length ? 'Aucun pari ici' : 'Aucun pari enregistré',
      'Après une analyse, une value ou un prono de Victor, touche « Je joue ce pari » : ta cote et ta mise sont enregistrées, et ton bilan se calcule tout seul.')}
  ${paris.length ? `<div class="bk-actions"><button class="bouton-discret" onclick="exporterParis()">Exporter (CSV)</button><button class="bouton-discret danger" onclick="effacerParis()">Tout effacer</button></div>` : ''}
</div>`;
}

// ── VICTOR : son bilan, pas une deuxième liste de pronos ─
export function htmlVictor({ stats = null, bilan = null, patterns = [], historique = [], aujourdhui = 0 } = {}) {
  const g = stats?.global || {};
  const notes = historique.filter(p => p.pronostic_correct === true || p.pronostic_correct === false).slice(0, 12);
  const sports = (stats?.par_sport || []).filter(s => Number(s.total) > 0);
  const tendances = patterns.slice(0, 8);
  const roi = bilan?.victor;
  return `<div class="card">
  <div class="titre-section">${icone('micro')}Le bilan de Victor</div>
  <div class="dash-grid" style="margin-top:12px">
    <div class="dash-stat"><div class="dash-stat-val">${g.total || 0}</div><div class="dash-stat-lbl">Pronos notés</div></div>
    <div class="dash-stat"><div class="dash-stat-val">${g.total ? `${Math.round(g.taux_global)} %` : '—'}</div><div class="dash-stat-lbl">Réussite</div></div>
    <div class="dash-stat"><div class="dash-stat-val ${roi?.rendement > 0 ? 'pos' : roi?.rendement < 0 ? 'neg' : ''}">${roi?.n ? pct(roi.rendement) : '—'}</div><div class="dash-stat-lbl">Rendement réel</div></div>
    <div class="dash-stat"><div class="dash-stat-val">${roi?.n || 0}</div><div class="dash-stat-lbl">Paris à cote réelle</div></div>
  </div>
  <div class="vm-note">Réussite : sur tous les pronos notés. Rendement : uniquement sur les pronos publiés à une cote du marché, mise fixe, pertes comprises. Un taux de réussite élevé sur des petites cotes peut perdre de l'argent : c'est le rendement qui compte.</div>
  ${aujourdhui ? `<button class="dash-cta" style="width:100%;margin-top:14px" onclick="switchNav('prono')">${aujourdhui > 1 ? `Voir ses ${aujourdhui} pronos du jour` : 'Voir son prono du jour'}</button>` : ''}
</div>
${sports.length ? `<div class="card"><div class="titre-section">${icone('stats')}Par sport</div>
  ${sports.map(s => `<div class="an-forme"><span>${e(s.sport || 'Autre')}</span><span>${Number(s.corrects)}/${Number(s.total)} · <b>${Math.round(Number(s.taux))} %</b></span></div>`).join('')}</div>` : ''}
${notes.length ? `<div class="card"><div class="titre-section">${icone('historique')}Derniers pronos notés</div>
  ${notes.map(p => `<div class="vm-ligne">
    <span class="vm-res ${p.pronostic_correct ? 'ok' : 'ko'}">${icone(p.pronostic_correct ? 'coche' : 'croix', { epaisseur: 3 })}</span>
    <div style="flex:1;min-width:0"><div class="vm-ligne-match">${e(p.equipe_a)} – ${e(p.equipe_b)}</div>
      <div class="vm-ligne-pari">${e(p.pronostic_principal || '')}${p.cote_estimee ? ` @ ${Number(p.cote_estimee).toFixed(2)}${p.cote_confirmee ? '' : ' (est.)'}` : ''}${p.score_reel ? ` · ${e(p.score_reel)}` : ''}</div></div>
    <span class="vm-ligne-date">${e(String(p.date || '').slice(5, 10).split('-').reverse().join('/'))}</span></div>`).join('')}</div>` : ''}
${tendances.length ? `<div class="card"><div class="titre-section">${icone('hausse')}Tendances réelles des 90 derniers jours</div>
  <div class="vm-note" style="margin:4px 0 10px">Fréquences observées sur les matchs joués (football-data.org). Une tendance n'est pas une value : le marché la connaît déjà et l'intègre dans ses cotes.</div>
  ${tendances.map(p => `<div class="vm-ligne"><div style="flex:1;min-width:0">
    <div class="vm-ligne-match">${e(String(p.nom || '').replace(/^\[(Taux|Équipe)\]\s*/, ''))}</div>
    <div class="vm-ligne-pari">${e(p.occurrences_confirmees)} fois sur ${e(p.occurrences_total)} matchs</div></div>
    <b class="tendance-pct">${Math.round(Number(p.taux_confirmation) || 0)} %</b></div>`).join('')}</div>` : ''}`;
}

export default { htmlLive, htmlAujourdhui, filtrerJour, competitionsConnues, htmlCompetitions, htmlMesParis, htmlVictor, FILTRES_JOUR };
