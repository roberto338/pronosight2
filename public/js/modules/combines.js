// ══════════════════════════════════════════════
// public/js/modules/combines.js — des combinés honnêtes
// ══════════════════════════════════════════════
//
// Uniquement des sélections RÉELLES (values du jour, pronos de Victor publiés
// à une cote du marché), à leur VRAIE cote. La probabilité d'un combiné est
// le produit des probabilités justes du consensus (marge retirée) : les
// sélections portent sur des matchs différents, donc indépendants.
//
// Ce qu'il faut savoir et que l'écran dit : un combiné de values garde une
// valeur positive (elle se multiplie), mais il gagne beaucoup plus rarement.
// Un combiné qui contient une sélection sans valeur la perd vite.
//
// Fonctions pures, testées sous Node. Chaînes externes échappées ici.

import { echapperHtml as e } from './securite.js';
import { icone } from './icones.js';

const pct = (x, d = 1) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(d).replace('.', ',')} %`;
const deux = (x) => Number(x).toFixed(2);

/** Cote totale, probabilité (si toutes connues) et valeur espérée d'un ensemble de sélections. */
export function evaluerCombine(legs = []) {
  const cote = legs.reduce((a, l) => a * Number(l.cote), 1);
  const toutes = legs.length > 0 && legs.every(l => l.proba_juste > 0 && l.proba_juste < 1);
  const proba = toutes ? legs.reduce((a, l) => a * l.proba_juste, 1) : null;
  return { n: legs.length, cote, proba, ev: proba != null ? proba * cote - 1 : null };
}

/** Clé d'un match, pour ne jamais mettre deux sélections du même match. */
const cleMatch = (s) => String(s.match || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Meilleurs combinés du jour : 2 ou 3 sélections de matchs différents,
 * probabilités connues, valeur espérée POSITIVE uniquement.
 */
export function genererCombines(selections = [], { tailles = [2, 3], max = 4, coteMax = 15 } = {}) {
  const ok = selections.filter(s => s.proba_juste > 0 && s.cote > 1)
    .sort((a, b) => (b.cote * b.proba_juste) - (a.cote * a.proba_juste))
    .slice(0, 18);
  const sorties = [];
  const parcourir = (debut, courant) => {
    if (tailles.includes(courant.length)) {
      const r = evaluerCombine(courant);
      if (r.ev > 0 && r.cote <= coteMax) sorties.push({ legs: [...courant], ...r });
    }
    if (courant.length >= Math.max(...tailles)) return;
    for (let i = debut; i < ok.length; i++) {
      if (courant.some(c => cleMatch(c) === cleMatch(ok[i]))) continue;
      courant.push(ok[i]); parcourir(i + 1, courant); courant.pop();
    }
  };
  parcourir(0, []);
  // Les plus rentables d'abord, sans proposer quatre fois la même base.
  sorties.sort((a, b) => b.ev - a.ev);
  const choisis = [], usage = new Map();
  for (const c of sorties) {
    if (c.legs.some(l => (usage.get(l.id) || 0) >= 2)) continue;
    choisis.push(c);
    c.legs.forEach(l => usage.set(l.id, (usage.get(l.id) || 0) + 1));
    if (choisis.length >= max) break;
  }
  return choisis;
}

function ligneLeg(l) {
  const ev = l.proba_juste ? l.cote * l.proba_juste - 1 : null;
  return `<div class="cb-leg">
    <span class="cb-source ${l.source}">${l.source === 'value' ? 'Value' : 'Victor'}</span>
    <div style="flex:1;min-width:0">
      <div class="cb-match">${e(l.match)}</div>
      <div class="cb-pari">${e(l.libelle)}${l.bookmaker ? ` · ${e(l.bookmaker)}` : ''}${ev != null ? ` · <span class="${ev >= 0 ? 'pos' : 'neg'}">${pct(ev)}</span>` : ' · proba inconnue'}</div>
    </div>
    <span class="cote-puce mini"><b>${deux(l.cote)}</b></span>
  </div>`;
}

function blocTotaux(r, { mise = null } = {}) {
  const fois = r.proba != null ? Math.round(r.proba * 100) : null;
  return `<div class="cb-totaux">
    <div><span>Cote totale</span><b>${deux(r.cote)}</b></div>
    <div><span>Chances réelles</span><b>${fois != null ? `${fois} %` : '—'}</b></div>
    <div><span>Valeur</span><b class="${r.ev == null ? '' : r.ev >= 0 ? 'pos' : 'neg'}">${r.ev != null ? pct(r.ev) : '—'}</b></div>
  </div>
  ${fois != null ? `<div class="vm-note" style="margin-top:8px">Passe environ <b>${fois} fois sur 100</b>${mise ? ` · ${String(mise).replace('.', ',')} € rapportent ${(mise * r.cote).toFixed(2).replace('.', ',')} € s'il passe` : ''}.${r.ev != null && r.ev < 0 ? ' Le bookmaker garde l\'avantage sur ce combiné.' : ''}</div>` : ''}`;
}

/** L'écran : combinés proposés, puis « compose ton combiné ». */
export function htmlCombines({ selections = [], choisis = [], charge = true, erreur = false, mise = null } = {}) {
  if (erreur) {
    return `<div class="card"><div class="etat-vide"><div class="etat-vide-icone">${icone('rafraichir')}</div>
      <div class="etat-vide-titre">Sélections indisponibles</div><div class="etat-vide-texte">Le serveur ne répond pas pour l'instant.</div>
      <button class="dash-cta" style="margin-top:14px" onclick="chargerCombines(true)">Réessayer</button></div></div>`;
  }
  if (!charge) return `<div class="card"><div class="vm-note" style="margin:0">Chargement des sélections du jour…</div></div>`;

  const propositions = genererCombines(selections);
  const combinables = selections.filter(s => s.proba_juste > 0).length;
  const intro = `<div class="vm-intro">Uniquement des sélections réelles du jour — values de marché et pronos de Victor — à leur vraie cote. La probabilité vient du consensus des bookmakers, marge retirée. Un combiné de values garde sa valeur, mais il passe beaucoup plus rarement qu'un pari simple.</div>`;

  const cartes = propositions.map((c, i) => `<div class="cb-carte">
    <div class="cb-tete"><span>${c.n} sélections</span><span class="vm-avantage">${icone('flamme', { taille: 15 })}${pct(c.ev)}</span></div>
    ${c.legs.map(ligneLeg).join('')}
    ${blocTotaux(c, { mise })}
    <button class="bouton-jouer" style="margin:12px 0 0" onclick="jouerCombine(${i})">${icone('portefeuille', { taille: 16 })}Je joue ce combiné</button>
  </div>`).join('');

  const vide = selections.length < 2
    ? `<div class="etat-vide" style="padding:20px 10px"><div class="etat-vide-icone">${icone('couches')}</div>
        <div class="etat-vide-titre">Pas de combiné aujourd'hui</div>
        <div class="etat-vide-texte">Il faut au moins deux sélections réelles et cotées sur des matchs différents. Aujourd'hui : ${selections.length}. Plutôt que d'inventer, on attend.</div></div>`
    : `<div class="etat-vide" style="padding:20px 10px"><div class="etat-vide-icone">${icone('couches')}</div>
        <div class="etat-vide-titre">Aucun combiné rentable</div>
        <div class="etat-vide-texte">${combinables < 2 ? 'Pas assez de sélections dont la probabilité est connue.' : 'Aucune association de sélections du jour ne garde une valeur positive.'} Tu peux quand même composer le tien ci-dessous : la valeur réelle s'affiche.</div></div>`;

  // Compose ton combiné
  const ids = new Set(choisis.map(c => c.id));
  const matchsPris = new Set(choisis.map(cleMatch));
  const liste = selections.map(s => {
    const pris = ids.has(s.id), bloque = !pris && matchsPris.has(cleMatch(s));
    return `<button class="cb-choix ${pris ? 'pris' : ''}" ${bloque ? 'disabled' : ''} onclick="basculerSelection('${e(s.id)}')">
      <span class="cb-case">${pris ? icone('coche', { taille: 14, epaisseur: 3 }) : ''}</span>
      ${ligneLeg(s)}</button>`;
  }).join('');
  const r = evaluerCombine(choisis);

  return `<div class="card">
  <div class="titre-section">${icone('couches')}Combinés du jour</div>
  ${intro}
  ${cartes || vide}
</div>
${selections.length ? `<div class="card">
  <div class="titre-section">${icone('cible')}Compose ton combiné</div>
  <div class="vm-note" style="margin:4px 0 12px">Une sélection par match. Touche pour ajouter ou retirer.</div>
  <div class="cb-liste">${liste}</div>
  ${choisis.length >= 2 ? `<div class="cb-carte" style="margin-top:12px">${blocTotaux(r, { mise })}
    <button class="bouton-jouer" style="margin:12px 0 0" onclick="jouerCombine(-1)">${icone('portefeuille', { taille: 16 })}Je joue ce combiné</button></div>`
    : '<div class="vm-note">Choisis au moins deux sélections.</div>'}
</div>` : ''}`;
}

export default { evaluerCombine, genererCombines, htmlCombines };
