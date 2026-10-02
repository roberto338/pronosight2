// ══════════════════════════════════════════════
// public/js/modules/valeurs.js — l'écran « Value de marché » et le bilan
// ══════════════════════════════════════════════
//
// La value de marché est le seul signal de PronoSight qui ait battu la cote
// de clôture sur six saisons (CLV +3,9 %, 1 621 paris, méthode de la
// puissance). L'écran la montre telle quelle : cote, prix juste, avantage,
// nombre de bookmakers — et à côté, le bilan noté, gains ET pertes.
//
// Fonctions pures : elles rendent du HTML, sans toucher au DOM, pour être
// testées sous Node. Toute chaîne venue du serveur est échappée ici.

import { echapperHtml as e } from './securite.js';
import { icone, ecusson } from './icones.js';

const pct = (x, d = 1) => (x == null || !Number.isFinite(Number(x))
  ? '—'
  : `${x >= 0 ? '+' : '−'}${Math.abs(Number(x) * 100).toFixed(d)} %`);

const heureParis = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? ''
    : d.toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });
};

/** Mise fixe de 1 % de la bankroll, arrondie à 0,5. Rien sans bankroll définie. */
export function miseConseillee(bankroll) {
  const b = Number(bankroll);
  if (!Number.isFinite(b) || b <= 0) return null;
  return Math.max(0.5, Math.round(b * 0.01 * 2) / 2);
}

/** Une value du jour. */
export function carteValeur(v, { bankroll = null, index = null } = {}) {
  const cote = Number(v.cote), pj = Number(v.proba_juste);
  const prixJuste = pj > 0 ? (1 / pj).toFixed(2) : '—';
  const mise = miseConseillee(bankroll);
  const heure = heureParis(v.debut_utc);
  const [a, b] = v.equipe_a && v.equipe_b ? [v.equipe_a, v.equipe_b] : String(v.match || '').split(/\s+vs\s+/i);
  return `<div class="vm-carte">
  <div class="vm-haut">
    <div class="vm-compet">${e(v.competition || '')}${heure ? ` · ${heure}` : ''}</div>
    <div class="vm-avantage">${icone('flamme', { taille: 15 })}${pct(v.avantage)}</div>
  </div>
  <div class="affiche" style="margin:12px 0 4px">
    <div class="affiche-equipe">${ecusson(e(a || ''))}<span class="affiche-nom">${e(a || '')}</span></div>
    <div class="affiche-centre">VS</div>
    <div class="affiche-equipe ext">${ecusson(e(b || ''))}<span class="affiche-nom">${e(b || '')}</span></div>
  </div>
  <div class="vm-pari">${e(v.libelle || v.pari_code)}</div>
  <div class="vm-chiffres">
    <div><span>Cote</span><b>${Number.isFinite(cote) ? cote.toFixed(2) : '—'}</b><small>${e(v.bookmaker || '')}</small></div>
    <div><span>Prix juste</span><b>${prixJuste}</b><small>${pj > 0 ? `${(pj * 100).toFixed(0)} % de chances` : ''}</small></div>
    <div><span>Consensus</span><b>${v.nb_bookmakers ?? '—'}</b><small>bookmakers</small></div>
  </div>
  ${mise ? `<div class="vm-mise">Mise fixe conseillée : <b>${String(mise).replace('.', ',')} €</b> (1 % de ta bankroll)</div>` : ''}
  ${index != null ? `<button class="bouton-jouer" onclick="jouerPari('value', ${Number(index)})">${icone('portefeuille', { taille: 16 })}Je joue ce pari</button>` : ''}
</div>`;
}

/** Le bilan vérifiable : Victor et la value de marché, côte à côte. */
export function htmlBilan(bilan) {
  if (!bilan) return '';
  const bloc = (titre, b, vide) => {
    if (!b?.n) return `<div class="vm-bilan-col"><div class="vm-bilan-titre">${titre}</div><div class="vm-bilan-vide">${vide}</div></div>`;
    const couleur = b.rendement >= 0 ? 'var(--ev-pos)' : 'var(--ev-neg)';
    return `<div class="vm-bilan-col">
    <div class="vm-bilan-titre">${titre}</div>
    <div class="vm-bilan-roi" style="color:${couleur}">${pct(b.rendement)}</div>
    <div class="vm-bilan-det">${b.n} paris · ${b.gagnes} gagnés<br>${b.profit >= 0 ? '+' : '−'}${Math.abs(b.profit).toFixed(1).replace('.', ',')} unités${b.coteMoyenne ? ` · cote moy. ${b.coteMoyenne.toFixed(2)}` : ''}</div>
  </div>`;
  };
  return `<div class="vm-bilan">
  ${bloc('Values de marché', bilan.marche?.total, 'Suivi en cours de constitution')}
  ${bloc('Victor (IA)', bilan.victor, 'Aucun pari noté à cote de marché')}
</div>
<div class="vm-note">Rendement à mise fixe, aux cotes réellement publiées. Tous les paris notés sont comptés, perdus compris. Sur moins de quelques centaines de paris, le résultat dépend surtout de la chance.</div>`;
}

/** Les dernières values notées. */
export function htmlNotees(notees = [], { max = 10 } = {}) {
  if (!notees.length) return '';
  return notees.slice(0, max).map(v => `<div class="vm-ligne">
  <span class="vm-res ${v.gagne ? 'ok' : 'ko'}">${icone(v.gagne ? 'coche' : 'croix', { epaisseur: 3 })}</span>
  <div style="flex:1;min-width:0">
    <div class="vm-ligne-match">${e(v.match)}</div>
    <div class="vm-ligne-pari">${e(v.libelle || v.pari_code)} @ ${Number(v.cote).toFixed(2)}${v.score_reel ? ` · ${e(v.score_reel)}` : ''}</div>
  </div>
  <span class="vm-ligne-date">${e(String(v.date || '').slice(5).split('-').reverse().join('/'))}</span>
</div>`).join('');
}

/** L'écran complet. `valeurs` : réponse de /api/victor/valeurs ; `bilan` : de /api/victor/bilan. */
export function htmlEcranValeurs({ valeurs = null, bilan = null, bankroll = null, erreur = false } = {}) {
  if (erreur) {
    return `<div class="card"><div class="etat-vide"><div class="etat-vide-icone">${icone('rafraichir')}</div>
      <div class="etat-vide-titre">Values indisponibles</div>
      <div class="etat-vide-texte">Le serveur ne répond pas pour l'instant.</div>
      <button class="dash-cta" onclick="rechargerValeurs()" style="margin-top:16px">Réessayer</button></div></div>`;
  }
  const jour = valeurs?.aujourdhui || [];
  const liste = jour.length
    ? jour.map((v, index) => carteValeur(v, { bankroll, index })).join('')
    : `<div class="etat-vide"><div class="etat-vide-icone">${icone('loupe')}</div>
        <div class="etat-vide-titre">Aucune value aujourd'hui</div>
        <div class="etat-vide-texte">Aucun bookmaker ne paie au-dessus du prix juste du marché. C'est fréquent, et c'est voulu : on ne force jamais un signal.</div></div>`;
  return `<div class="card">
  <div class="card-title">${icone('flamme')}Values du jour</div>
  <div class="vm-intro">Un bookmaker paie <b>au-dessus du prix juste</b>, calculé sur le consensus d'au moins 5 bookmakers, marge retirée. Aucun avis d'IA : seulement les cotes. Sur six saisons, ces paris ont battu la cote de clôture de <b>+3,9 %</b> en moyenne — un avantage mesuré, pas une garantie de gain.</div>
  ${liste}
</div>
<div class="card">
  <div class="card-title">${icone('bouclier')}Bilan vérifiable</div>
  ${bilan ? htmlBilan(bilan) : '<div class="vm-note">Chargement…</div>'}
</div>
${valeurs?.notees?.length ? `<div class="card">
  <div class="card-title">${icone('historique')}Dernières values notées</div>
  ${htmlNotees(valeurs.notees)}
</div>` : ''}
<div class="vm-note" style="text-align:center;margin:8px 0 24px">Jeu interdit aux moins de 18 ans. Jouer comporte des risques : endettement, dépendance. Appelez le 09 74 75 13 13 (appel non surtaxé).</div>`;
}

export default { miseConseillee, carteValeur, htmlBilan, htmlNotees, htmlEcranValeurs };
