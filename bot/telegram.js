// ══════════════════════════════════════════════
// bot/telegram.js — Bot Telegram PronoSight
// ══════════════════════════════════════════════

import 'dotenv/config';
import TelegramBot from '../nexus/lib/telegramCompat.js';

const TOKEN      = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;

// ── Initialisation du bot ─────────────────────
let bot = null;

if (!TOKEN) {
  console.warn('⚠️  TELEGRAM_BOT_TOKEN absent — bot désactivé');
} else {
  try {
    bot = new TelegramBot(TOKEN); // envoi seul — pas de polling (le polling vit dans nexus/telegramHandler.js)
    console.log('📱 Bot Telegram initialisé');
  } catch (err) {
    console.error('❌ Erreur init Telegram:', err.message);
    bot = null;
  }
}

// ── Helper silencieux si bot absent ───────────
async function send(chatId, text, opts = {}) {
  if (!bot || !chatId) return null;
  return bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    ...opts,
  });
}

// ══════════════════════════════════════════════
// ESCAPE MARKDOWN
// Caractères spéciaux à échapper en Markdown v1
// ══════════════════════════════════════════════

/**
 * Un champ que le modèle n'a pas pu remplir. Il répond « donnée
 * indisponible » ou « aucun » — ce qui est honnête, mais n'a rien à
 * faire dans un message destiné à des abonnés. Mieux vaut une ligne
 * absente qu'une ligne qui affiche son propre vide.
 */
function estIndisponible(v) {
  return /^\s*(aucun|aucune|n\/?a|non disponible|donn[ée]e[s]? indisponible[s]?|indisponible|-{1,2}|—)\s*$/i
    .test(String(v || '')) || /donn[ée]e[s]? indisponible/i.test(String(v || ''));
}

/**
 * Rend lisible une sélection de combiné.
 *
 * Le modèle renvoie tantôt une chaîne, tantôt un objet ({match, pari}…).
 * Le 14/08, les abonnés ont lu « [object Object] ➕ [object Object] » :
 * le code appliquait esc() directement à l'objet.
 *
 * On accepte les deux formes, et on écarte ce qui reste illisible plutôt
 * que d'afficher une valeur technique.
 */
function selectionLisible(sel) {
  if (typeof sel === 'string') return esc(sel.trim()) || null;
  if (!sel || typeof sel !== 'object') return null;

  const match = sel.match || sel.rencontre || sel.affiche
             || [sel.equipe_a, sel.equipe_b].filter(Boolean).join(' vs ');
  const pari  = sel.pari || sel.pronostic || sel.pronostic_principal || sel.libelle || sel.selection;

  if (match && pari) return `${esc(match)} : ${esc(pari)}`;
  return esc(pari || match) || null;
}

function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/`/g, '\\`')
    .replace(/\[/g, '\\[');
}

// ══════════════════════════════════════════════
// EMOJI PAR SPORT
// ══════════════════════════════════════════════

export function getEmojiBySport(sport = '') {
  const s = sport.toLowerCase();
  if (s.includes('football') || s === 'foot')  return '⚽';
  if (s.includes('basket') || s === 'nba')     return '🏀';
  if (s.includes('tennis'))                    return '🎾';
  if (s.includes('rugby'))                     return '🏉';
  if (s.includes('mma') || s.includes('ufc'))  return '🥊';
  if (s.includes('box'))                       return '🥊';
  if (s === 'f1' || s.includes('formule'))     return '🏎️';
  if (s.includes('cycl'))                      return '🚴';
  if (s.includes('hand'))                      return '🤾';
  if (s.includes('volley'))                    return '🏐';
  if (s.includes('snooker'))                   return '🎱';
  if (s.includes('golf'))                      return '⛳';
  return '🏆';
}

// ══════════════════════════════════════════════
// BROADCAST DAILY — Analyse complète du jour
// ══════════════════════════════════════════════

export const MENTION_PREVENTION = 'Interdit aux moins de 18 ans. Jouer comporte des risques : endettement, isolement, dépendance. '
  + 'Pour être aidé, appelez le 09 74 75 13 13 (appel non surtaxé).';

const pctSigne = (x) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)} %`);
const pctBrut = (x) => (x == null ? '—' : `${Math.round(x * 100)} %`);
const unites = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)} u`;

/** Une ligne de fiabilité : paris, réussite, ce que prévoyaient les cotes, rendement. */
function ligneFiabilite(libelle, b) {
  if (!b?.n) return `${esc(libelle)} : aucun pari noté\n`;
  return `${esc(libelle)} : ${b.n} paris · ${esc(pctBrut(b.taux))} gagnés (cotes : ${esc(pctBrut(b.attendu))}) · *${esc(pctSigne(b.rendement))}*\n`;
}

/**
 * Texte du bilan public. Pur : testable sans Telegram.
 * Tout est en mise fixe d'une unité, sur des cotes réellement proposées.
 * `victor` : la liste des paris notés, ou le résultat de bilanVictor()
 * (alors avec la fiabilité par période).
 */
export function texteBilan({ victor = [], marche = null } = {}) {
  const pct = pctSigne;
  const bv = Array.isArray(victor) ? null : victor;
  const notes = Array.isArray(victor) ? victor.filter(r => r.gagne === true || r.gagne === false) : [];
  const n = bv ? bv.n : notes.length;
  const gagnes = bv ? bv.gagnes : notes.filter(r => r.gagne).length;
  const rendement = bv ? bv.rendement : n ? notes.reduce((a, r) => a + (r.gagne ? Number(r.cote) - 1 : -1), 0) / n : null;
  let t = `📒 *BILAN PRONOSIGHT* — vérifiable, mise fixe\n━━━━━━━━━━━━━━━\n`;
  t += `🎙️ *Victor (analyse IA)*\n`;
  t += n
    ? `${n} paris à cote de marché · ${gagnes} gagnés · rendement ${esc(pct(rendement))}\n`
    : `Aucun pari noté pour l'instant.\n`;
  if (n && bv?.periodes) {
    t += `\n📈 *Fiabilité dans la durée*\n`;
    for (const cle of ['semaine', 'mois', 'sixMois', 'annee']) t += ligneFiabilite(bv.periodes[cle].libelle, bv.periodes[cle]);
  }
  t += `\n📈 *Values de marché (sans IA)*\n`;
  if (marche?.total?.n) {
    const b = marche.total;
    t += `${b.n} signaux · ${b.gagnes} gagnés · cote moyenne ${esc(b.coteMoyenne.toFixed(2))} · rendement ${esc(pct(b.rendement))}\n`;
    if (marche.trenteJours?.n) t += `30 derniers jours : ${marche.trenteJours.n} signaux · rendement ${esc(pct(marche.trenteJours.rendement))}\n`;
  } else {
    t += `Suivi en cours de constitution.\n`;
  }
  t += `\n_${esc('« Cotes » : la part de paris que les cotes donnaient gagnants. Gagner plus souvent que ça, c\'est battre le bookmaker.')}_\n`;
  t += `_${esc('Un rendement sur moins de quelques centaines de paris dépend surtout de la chance. Résultats passés : aucune garantie de gain.')}_\n`;
  t += `_${esc(MENTION_PREVENTION)}_`;
  return t;
}

const jjmm = (iso) => String(iso).split('-').reverse().slice(0, 2).join('/');

/**
 * Bilan de la semaine ou du mois écoulé, comparé à la période d'avant,
 * puis la fiabilité dans la durée. Pur (testé sans Telegram).
 * @param {{type, debut, fin, courant, avant, periodes}} d  voir victor/recap.js
 */
export function texteBilanPeriode(d) {
  const semaine = d.type === 'semaine';
  const nomMois = new Date(`${d.debut}T12:00:00Z`).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const c = d.courant || {}, av = d.avant || {};
  let t = `📊 *BILAN ${semaine ? 'DE LA SEMAINE' : 'DU MOIS'}* — ${esc(semaine ? `du ${jjmm(d.debut)} au ${jjmm(d.fin)}` : nomMois)}\n━━━━━━━━━━━━━━━\n`;
  t += `🎙️ *Victor*\n`;
  if (c.n) {
    t += `${c.n} paris notés · ${c.gagnes} gagnés · ${c.n - c.gagnes} perdus\n`;
    t += `Réussite *${esc(pctBrut(c.taux))}* — les cotes prévoyaient ${esc(pctBrut(c.attendu))}\n`;
    t += `Rendement *${esc(pctSigne(c.rendement))}* (${esc(unites(c.profit))} à mise fixe)\n`;
    t += c.rendement >= 0 ? `✅ Victor a battu les bookmakers ${semaine ? 'cette semaine' : 'ce mois-ci'}.\n`
      : `❌ Les bookmakers ont eu raison de Victor ${semaine ? 'cette semaine' : 'ce mois-ci'}.\n`;
    if (av.n) {
      const fleche = c.rendement > av.rendement ? '↗️ Mieux' : c.rendement < av.rendement ? '↘️ Moins bien' : '➡️ Pareil';
      t += `${fleche} que ${semaine ? 'la semaine' : 'le mois'} d'avant (${esc(pctSigne(av.rendement))} sur ${av.n} paris)\n`;
    }
  } else {
    t += `Aucun pari noté ${semaine ? 'cette semaine' : 'ce mois-ci'}.\n`;
  }
  const p = d.periodes;
  if (p?.total?.n) {
    t += `\n📈 *Fiabilité dans la durée*\n`;
    for (const cle of ['mois', 'sixMois', 'annee', 'total']) t += ligneFiabilite(p[cle].libelle, p[cle]);
  }
  t += `\n_${esc(c.n && c.n < 30
    ? `Moins de 30 paris : trop peu pour juger, la chance pèse plus que la méthode. C'est la tendance sur plusieurs mois qui compte.`
    : `Mise fixe d'une unité, aux cotes réellement proposées. Les pertes sont comptées comme les gains.`)}_\n`;
  t += `_${esc('Résultats passés : aucune garantie de gain.')}_\n_${esc(MENTION_PREVENTION)}_`;
  return t;
}

/** Envoie le bilan de la semaine ou du mois sur le canal. Rien sans pari noté. */
export async function sendBilanPeriode(donnees) {
  if (!bot || !CHANNEL_ID || !donnees?.courant?.n) return false;
  await send(CHANNEL_ID, texteBilanPeriode(donnees));
  console.log(`📊 Bilan ${donnees.type} (${donnees.debut} → ${donnees.fin}) envoyé sur Telegram`);
  return true;
}

/**
 * Le bilan des pronos de la veille, un par un. Pur (testé sans Telegram).
 * @param {{date, pronos, valeurs, bilan: {victor, marche}}} d  voir victor/recap.js
 */
export function texteRecapVeille(d) {
  const pct = (x) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)} %`);
  const u = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)} u`;
  const jour = String(d.date).split('-').reverse().slice(0, 2).join('/');
  const icone = (g) => (g === true ? '✅' : g === false ? '❌' : '⏳');
  let t = `📒 *LES PRONOS D'HIER — ${esc(jour)}*\n━━━━━━━━━━━━━━━\n`;

  if (d.pronos?.length) {
    for (const p of d.pronos) {
      const cote = Number(p.cote_estimee) > 1 ? ` @ ${Number(p.cote_estimee).toFixed(2)}` : '';
      t += `${icone(p.pronostic_correct)} *${esc(p.equipe_a)} – ${esc(p.equipe_b)}*\n`
        + `    ${esc(p.pronostic_principal)}${esc(cote)}${p.score_reel ? ` · ${esc(p.score_reel)}` : p.pronostic_correct == null ? ' · résultat pas encore connu' : ''}\n`;
    }
    const n = d.pronos.length;
    const g = d.pronos.filter(p => p.pronostic_correct === true).length;
    const notes = d.pronos.filter(p => p.pronostic_correct != null).length;
    const comptes = d.pronos.filter(p => p.pronostic_correct != null && p.cote_confirmee
      && Number(p.cote_estimee) > 1 && !String(p.pari_code || '').startsWith('DC:'));
    const profit = comptes.reduce((a, p) => a + (p.pronostic_correct ? Number(p.cote_estimee) - 1 : -1), 0);
    t += `\n🎙️ Victor hier : *${g}/${notes}* gagné${g > 1 ? 's' : ''}${notes < n ? ` (${n - notes} en attente)` : ''}`
      + `${comptes.length ? ` · ${esc(u(profit))} à mise fixe` : ''}\n`;
  } else {
    t += `🎙️ Victor n'a publié aucun prono hier.\n`;
  }

  const notees = (d.valeurs || []).filter(v => v.gagne === true || v.gagne === false);
  if (d.valeurs?.length) {
    const gv = notees.filter(v => v.gagne).length;
    const pv = notees.reduce((a, v) => a + (v.gagne ? Number(v.cote) - 1 : -1), 0);
    t += `📈 Values hier : *${gv}/${notees.length}* gagnée${gv > 1 ? 's' : ''}`
      + `${notees.length ? ` · ${esc(u(pv))}` : ''}${notees.length < d.valeurs.length ? ` (${d.valeurs.length - notees.length} en attente)` : ''}\n`;
  }

  const bv = d.bilan?.victor, bm = d.bilan?.marche?.total;
  if (bv?.n || bm?.n) {
    t += `\n📊 *Depuis le début* (mise fixe, cotes de marché)\n`;
    if (bv?.n) t += `Victor : ${esc(pct(bv.rendement))} sur ${bv.n} paris\n`;
    if (bm?.n) t += `Values : ${esc(pct(bm.rendement))} sur ${bm.n} paris\n`;
  }
  t += `\n_${esc('Les pertes sont comptées comme les gains. Résultats passés : aucune garantie de gain.')}_\n_${esc(MENTION_PREVENTION)}_`;
  return t;
}

/** Envoie le bilan de la veille sur le canal. Silencieux sans bot. */
export async function sendRecapVeille(donnees) {
  if (!bot || !CHANNEL_ID || !donnees) return false;
  if (!donnees.pronos?.length && !donnees.valeurs?.length) return false;
  await send(CHANNEL_ID, texteRecapVeille(donnees));
  console.log(`📒 Bilan de la veille (${donnees.date}) envoyé sur Telegram`);
  return true;
}

export async function broadcastDaily(victorData) {
  // Ne JAMAIS sortir en silence : une env var manquante rendait tout le
  // système muet sans la moindre trace dans les logs.
  if (!bot || !CHANNEL_ID) {
    throw new Error(
      `Broadcast impossible — ${!bot ? 'TELEGRAM_BOT_TOKEN absent' : 'TELEGRAM_CHANNEL_ID absente'}`
    );
  }

  try {
    const events   = victorData.events || [];
    const date     = victorData.date      || new Date().toISOString().slice(0, 10);
    // L'heure vient de NOTRE horloge, jamais du modèle : il n'en a pas.
    // Il renvoyait « 00:00 », affiché tel quel dans le message du 13/08.
    const genAt    = new Date().toLocaleTimeString('fr-FR',
      { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });
    const combine  = victorData.combine_victor;
    const verdict  = victorData.verdict_journee || '';

    // ── Partie 1 : En-tête + events ──────────────
    // Le job de 13h diffuse ses AJOUTS. L'en-tête doit le dire, sinon
    // l'abonné croit à une seconde analyse complète de la journée.
    let msgEvents = victorData.complement
      ? `🎙️ *VICTOR — Ajout du ${esc(date)}*\n_${events.length} opportunité${events.length > 1 ? 's' : ''} supplémentaire${events.length > 1 ? 's' : ''} · ${esc(genAt)}_\n`
      : `🎙️ *VICTOR — Analyse du ${esc(date)}*\n_Généré à ${esc(genAt)}_\n`;
    msgEvents    += `━━━━━━━━━━━━━━━━━━━━━\n\n`;

    const eventsToShow = events.slice(0, 6);
    for (const ev of eventsToShow) {
      const emoji     = getEmojiBySport(ev.sport);
      const confScore = ev.confiance_score ? `${ev.confiance_score}/5` : '—';

      msgEvents += `${emoji} *${esc(ev.sport)}* | ${esc(ev.competition)}\n`;
      msgEvents += `🆚 *${esc(ev.equipe_a)} vs ${esc(ev.equipe_b)}* — ${esc(ev.heure)}\n`;
      msgEvents += `🎯 *Pronostic :* ${esc(ev.pronostic_principal)}\n`;
      // ── La cote peut manquer, et c'est légitime ────────────────
      // Depuis que le prompt exige un pari réellement coté, le modèle ne
      // remplit plus toujours "cote_estimee" lui-même : la vraie cote est
      // injectée après coup depuis le marché. Sur un match sans cotes, le
      // champ peut donc rester vide — afficher « ~ » ou « ~undefined »
      // à un abonné serait pire que de ne rien afficher.
      const coteAffichable = ev.cote_estimee != null && ev.cote_estimee !== '';
      if (coteAffichable) {
        msgEvents += `💰 *Cote :* ~${esc(ev.cote_estimee)} | ${esc(ev.confiance)}\n`;
      } else {
        msgEvents += `💰 *Cote :* ${esc('non disponible')} | ${esc(ev.confiance)}\n`;
      }

      // ── Dire d'où vient la cote ────────────────────────────────
      // Quand The Odds API ne couvre pas la compétition, ce chiffre est
      // écrit par le modèle et seulement contrôlé sur sa plausibilité
      // (entre 1.01 et 51). L'afficher comme les autres reviendrait à
      // présenter une estimation pour une donnée de marché. Le tilde ne
      // suffit pas à le dire — il faut l'écrire.
      if (ev.cote_confirmee === false && coteAffichable) {
        msgEvents += `ℹ️ ${esc('Cote estimée — non confirmée par le marché')}\n`;
      }

      // ── Meilleure cote du marché ───────────────────────────────
      // La cote affichée est une MOYENNE de bookmakers, marge comprise.
      // Mesuré le 02/10 : à cette cote, les pronostics perdaient 4,7 % face
      // au prix juste de clôture, soit à peu près la marge. Indiquer où se
      // trouve le meilleur prix réduit ce coût pour l'abonné.
      if (ev.cote_max && ev.bookmaker_max) {
        msgEvents += `🏷️ *Meilleure cote :* ${esc(ev.cote_max)} chez ${esc(ev.bookmaker_max)}\n`;
      }

      // ── Prix juste et cote minimum ─────────────────────────────
      // Probabilité du consensus des bookmakers, marge retirée (méthode de
      // la puissance). En dessous de cette cote, le pari perd sur la durée
      // face au marché : l'abonné sait à partir d'où il vaut la peine.
      if (ev.cote_juste && ev.proba_juste) {
        msgEvents += `📐 *Prix juste :* ${esc(ev.cote_juste.toFixed(2))} (${esc(Math.round(ev.proba_juste * 100))} %) — à jouer seulement au-dessus\n`;
      }

      // ⚠️ Ne JAMAIS échapper les parenthèses : en Markdown v1 Telegram
      // elles ne sont pas spéciales, et « \( » s'affiche littéralement.
      // Le message du 13/08 montrait « aucun \(~0\) » aux abonnés.
      if (ev.value_bet && !estIndisponible(ev.value_bet)) {
        const coteVb = ev.cote_value ? ` (~${esc(ev.cote_value)})` : '';
        msgEvents += `💎 *Value bet :* ${esc(ev.value_bet)}${coteVb}\n`;
      }
      if (ev.pari_a_eviter && !estIndisponible(ev.pari_a_eviter)) {
        msgEvents += `⚠️ *Éviter :* ${esc(ev.pari_a_eviter)}\n`;
      }
      if (ev.score_predit && !estIndisponible(ev.score_predit)) {
        msgEvents += `📊 *Score prédit :* ${esc(ev.score_predit)} (${esc(confScore)})\n`;
      }
      if (ev.phrase_signature) {
        msgEvents += `💬 _${esc(ev.phrase_signature)}_\n`;
      }
      msgEvents += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
    }

    // ── Value de marché : le bon prix, sans IA ──────────────
    // Voir victor/valeur.js. Mesuré sur six saisons : CLV +3,9 % au seuil
    // de 2 %. C'est un prix, pas une prédiction : le texte le dit.
    const valeurs = victorData.valeurs_marche || [];
    if (valeurs.length > 0) {
      msgEvents += `📈 *VALUE DE MARCHÉ*\n`;
      msgEvents += `_${esc('Cotes au-dessus du prix juste du consensus des bookmakers. Calcul sans IA.')}_\n\n`;
      for (const v of valeurs) {
        msgEvents += `⚽ *${esc(v.equipe_a)} vs ${esc(v.equipe_b)}*${v.heure ? ` — ${esc(v.heure)}` : ''}\n`;
        msgEvents += `🎯 ${esc(v.libelle)} @ *${esc(v.cote.toFixed(2))}* chez ${esc(v.bookmaker)}\n`;
        msgEvents += `📐 Prix juste ${esc(v.coteJuste.toFixed(2))} · avantage +${esc((v.avantage * 100).toFixed(1))} %\n\n`;
      }
      msgEvents += `_${esc('Sur 6 saisons : ces écarts ont battu la cote de clôture (+3,9 %). Gain non garanti, cote à vérifier avant de jouer.')}_\n`;
      msgEvents += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
    }

    // ── Partie 2 : Combiné + verdict ─────────────
    let msgVerdict = '';

    // Combinés désactivés par défaut : leur cote était écrite par l'IA et
    // aucune mesure n'en a jamais été faite. VICTOR_COMBINES=on les rétablit.
    if (process.env.VICTOR_COMBINES === 'on' && combine?.selections?.length > 0) {
      const lignes = combine.selections.map(selectionLisible).filter(Boolean);
      if (lignes.length > 0) {
        msgVerdict += `🎲 *COMBINÉ VICTOR*\n`;
        msgVerdict += `${lignes.join(' ➕ ')}\n`;
        if (combine.cote_combinee) msgVerdict += `💰 Cote combinée : ~${esc(combine.cote_combinee)}\n`;
        if (combine.risque)        msgVerdict += `⚡ Risque : ${esc(combine.risque)}\n`;
        msgVerdict += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
      }
    }

    if (verdict) {
      msgVerdict += `🏆 *VERDICT DU JOUR*\n${esc(verdict)}\n\n`;
    }

    msgVerdict += `━━━━━━━━━━━━━━━━━━━━━\n`;
    msgVerdict += `_PronoSight — Victor IA | Jouer responsablement_\n`;
    // Message de prévention exigé en France pour toute communication sur les
    // jeux d'argent (ANJ). Indispensable avant de vendre un abonnement.
    msgVerdict += `_${esc(MENTION_PREVENTION)}_`;

    // ── Envoi : découpe si > 4000 chars ──────────
    const fullMsg = msgEvents + msgVerdict;

    if (fullMsg.length <= 4000) {
      await send(CHANNEL_ID, fullMsg);
    } else {
      // Message 1 : events
      if (msgEvents.length > 0) await send(CHANNEL_ID, msgEvents);
      // Message 2 : combiné + verdict
      if (msgVerdict.length > 0) await send(CHANNEL_ID, msgVerdict);
    }

    console.log(`✅ Broadcast Telegram envoyé (${eventsToShow.length} pronostics)`);

  } catch (err) {
    // On loggue ET on remonte : sans le throw, le job concluait
    // « telegramSent: true » alors que rien n'était parti.
    console.error('❌ Erreur broadcast Telegram:', err.message);
    throw err;
  }
}

// ══════════════════════════════════════════════
// SEND ALERT — Alertes urgentes
// ══════════════════════════════════════════════

export async function sendAlert(message, type = 'info') {
  if (!bot || !CHANNEL_ID) {
    console.error(`❌ Alerte non envoyée (${!bot ? 'token' : 'channel id'} absent) : ${message}`);
    return;
  }

  const emojis = {
    success: '✅',
    warning: '⚠️',
    danger:  '🚨',
    info:    'ℹ️',
  };
  const emoji = emojis[type] || 'ℹ️';

  const ts = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });

  const text = `${emoji} *ALERTE PRONOSIGHT*\n${esc(message)}\n_${esc(ts)}_`;

  try {
    await send(CHANNEL_ID, text);
  } catch (err) {
    console.error('❌ Erreur sendAlert:', err.message);
  }
}

// ══════════════════════════════════════════════
// SEND DAILY STATS
// ══════════════════════════════════════════════

export async function sendDailyStats(stats) {
  if (!bot || !CHANNEL_ID || !stats) return;

  try {
    const text =
      `📊 *STATS VICTOR — ${esc(stats.date)}*\n` +
      `━━━━━━━━━━━━━━━\n` +
      `✅ Taux global : ${esc(stats.taux_global)}%\n` +
      `🎯 Confiance Élevé : ${esc(stats.taux_confiance_eleve)}%\n` +
      `💎 Value bets : ${esc(stats.taux_value_bet)}%\n` +
      `💰 ROI simulé : ${esc(stats.roi_mise_fixe)}€ (mise fixe 10€, cotes de marché uniquement)\n` +
      `📋 Total : ${esc(stats.total_pronostics)} pronostics\n` +
      `━━━━━━━━━━━━━━━\n` +
      `_Mise à jour automatique — PronoSight_`;

    await send(CHANNEL_ID, text);
    console.log('📊 Stats journalières envoyées sur Telegram');
  } catch (err) {
    console.error('❌ Erreur sendDailyStats:', err.message);
  }
}

// ══════════════════════════════════════════════
// HEARTBEAT — État de santé quotidien
//
// Envoyé TOUS LES JOURS, y compris quand tout va bien. C'est ce qui
// distingue « ça marche » de « je n'ai pas de nouvelles » : le système
// est resté mort 3 semaines (15/07 → 03/08/2026) sans aucun signal.
// ══════════════════════════════════════════════

export async function sendHeartbeat(diag) {
  if (!bot || !CHANNEL_ID) {
    console.error('❌ Heartbeat impossible — bot ou TELEGRAM_CHANNEL_ID absent');
    return false;
  }

  const ok = diag.problemes.length === 0;

  // Le compteur d'echecs doit refleter ce sur quoi Roberto peut AGIR.
  // Le 25/08, "echoues 2" designait deux jobs des 15 et 16 aout, deja
  // diagnostiques et en attente de purge automatique. Un chiffre alarmant
  // qui n'appelle aucune action apprend a ignorer les suivants.
  const echecs  = diag.jobs.failedRecents ?? diag.jobs.failed;
  const anciens = diag.jobs.failedAnciens ?? 0;
  const scories = anciens > 0 ? esc(' (+' + anciens + ' anciens, purge auto)') : '';
  let text = ok
    ? `✅ *PronoSight — tout va bien*\n`
    : `🚨 *PronoSight — ${diag.problemes.length} problème(s)*\n`;

  text += `━━━━━━━━━━━━━━━\n`;
  text += `📅 ${esc(diag.date)}\n`;
  text += `🎯 Pronostics aujourd'hui : ${diag.pronosticsAujourdhui}\n`;
  text += `📊 Dernier pronostic : ${esc(diag.dernierPronostic || 'jamais')}\n`;
  text += `⚙️ Jobs — en attente ${diag.jobs.pending} · en cours ${diag.jobs.running} · échoués ${echecs}${scories}\n`;
  text += `🛟 Moteur de secours Groq : ${diag.groqOk ? 'OK' : '⚠️ INDISPONIBLE'}\n`;
  if (diag.couverture?.equipes > 0) {
    text += `📡 Données au dernier prematch : ${diag.couverture.avecDonnees}/${diag.couverture.equipes} équipes\n`;
  }

  // "Tout va bien" avec zero pronostic est une contradiction que le
  // lecteur doit trancher seul. On l'explicite : une journee sans cote
  // exploitable est un refus de parier, pas une panne.
  if (ok && diag.pronosticsAujourdhui === 0) {
    text += `ℹ️ ${esc("Aucun pronostic retenu — faute de match jouable ou de cotes, pas de panne")}
`;
  }

  if (diag.jobsBloques > 0) text += `⛔ Jobs figés : ${diag.jobsBloques}\n`;

  if (!ok) {
    text += `━━━━━━━━━━━━━━━\n`;
    diag.problemes.forEach(p => { text += `• ${esc(p)}\n`; });
  }

  text += `━━━━━━━━━━━━━━━\n_Heartbeat automatique_`;

  try {
    await send(CHANNEL_ID, text);
    console.log(`💓 Heartbeat envoyé (${ok ? 'OK' : diag.problemes.length + ' problème(s)'})`);
    return true;
  } catch (err) {
    console.error('❌ Erreur heartbeat:', err.message);
    return false;
  }
}

// ══════════════════════════════════════════════
// COMMANDES BOT (mode non-production uniquement)
// ══════════════════════════════════════════════

if (bot && process.env.NODE_ENV !== 'production') {
  // Import dynamique pour éviter circular dep avec core.js
  const setupCommands = async () => {
    let queryDB;
    try {
      const db = await import('../db/database.js');
      queryDB = db.query;
    } catch {
      console.warn('⚠️  DB non disponible pour les commandes bot');
      return;
    }

    // /aide
    bot.onText(/\/aide/, async (msg) => {
      await send(msg.chat.id,
        `🎙️ *Commandes Victor*\n\n` +
        `/today — Pronostics du jour\n` +
        `/best — Top 3 confiance Élevé\n` +
        `/stats — Performances du jour\n` +
        `/value — Values de marché du jour\n` +
        `/hier — Résultats des pronos d'hier\n` +
        `/semaine — Bilan de la semaine écoulée\n` +
        `/mois — Bilan du mois écoulé\n` +
        `/bilan — Fiabilité de Victor : 7 jours, 30 jours, 6 mois, 1 an\n` +
        `/aide — Cette aide`
      );
    });

    // /hier — les pronos de la veille, un par un, avec leur résultat
    bot.onText(/\/hier/, async (msg) => {
      try {
        const { donneesVeille } = await import('../victor/recap.js');
        const d = await donneesVeille();
        await send(msg.chat.id, d.pronos.length || d.valeurs.length
          ? texteRecapVeille(d)
          : 'ℹ️ Aucun prono ni value publiés hier.');
      } catch (err) {
        await send(msg.chat.id, `❌ Erreur: ${err.message}`);
      }
    });

    // /bilan — le bilan vérifiable, tel quel, sans arrondi flatteur
    bot.onText(/\/bilan/, async (msg) => {
      try {
        const { bilanVictor, bilanValeursMarche } = await import('../victor/valeur-suivi.js');
        const victor = await bilanVictor();
        let marche = null;
        try { marche = await bilanValeursMarche(); } catch { /* table absente : bilan Victor seul */ }
        await send(msg.chat.id, texteBilan({ victor, marche }));
      } catch (err) {
        await send(msg.chat.id, `❌ Erreur: ${err.message}`);
      }
    });

    // /semaine et /mois — la dernière semaine (lundi-dimanche) ou le dernier mois terminé
    bot.onText(/\/(semaine|mois)\b/, async (msg, m) => {
      try {
        const { donneesPeriode } = await import('../victor/recap.js');
        await send(msg.chat.id, texteBilanPeriode(await donneesPeriode(m[1])));
      } catch (err) {
        await send(msg.chat.id, `❌ Erreur: ${err.message}`);
      }
    });

    // /value — les values de marché du jour
    bot.onText(/\/value/, async (msg) => {
      try {
        const { rows } = await queryDB(
          `SELECT match, libelle, pari_code, cote, bookmaker, proba_juste, avantage
           FROM ps_valeurs_marche WHERE date = CURRENT_DATE ORDER BY avantage DESC LIMIT 5`);
        if (rows.length === 0) {
          await send(msg.chat.id, 'ℹ️ Aucune value de marché aujourd\'hui : aucun bookmaker ne paie au-dessus du prix juste.');
          return;
        }
        let txt = `📈 *Values de marché du jour*\n━━━━━━━━━━━━━\n`;
        for (const r of rows) {
          txt += `⚽ *${esc(r.match)}*\n🎯 ${esc(r.libelle || r.pari_code)} @ ${esc(Number(r.cote).toFixed(2))} chez ${esc(r.bookmaker)}\n`;
          txt += `📐 Prix juste ${esc((1 / Number(r.proba_juste)).toFixed(2))} · avantage +${esc((Number(r.avantage) * 100).toFixed(1))} %\n\n`;
        }
        txt += `_${esc(MENTION_PREVENTION)}_`;
        await send(msg.chat.id, txt);
      } catch (err) {
        await send(msg.chat.id, `❌ Erreur: ${err.message}`);
      }
    });

    // /stats
    bot.onText(/\/stats/, async (msg) => {
      try {
        const { rows } = await queryDB(
          `SELECT * FROM ps_victor_stats WHERE date = CURRENT_DATE`
        );
        if (rows.length === 0) {
          await send(msg.chat.id, 'ℹ️ Aucune stat disponible pour aujourd\'hui.');
          return;
        }
        await sendDailyStats(rows[0]);
      } catch (err) {
        await send(msg.chat.id, `❌ Erreur: ${err.message}`);
      }
    });

    // /today
    bot.onText(/\/today/, async (msg) => {
      try {
        const { rows } = await queryDB(
          `SELECT match, sport, pronostic_principal, cote_estimee, confiance
           FROM ps_pronostics
           WHERE date = CURRENT_DATE
           ORDER BY created_at DESC
           LIMIT 6`
        );
        if (rows.length === 0) {
          await send(msg.chat.id, 'ℹ️ Aucun pronostic pour aujourd\'hui.');
          return;
        }
        let txt = `📅 *Pronostics du jour*\n━━━━━━━━━━━━━\n`;
        rows.forEach(r => {
          txt += `${getEmojiBySport(r.sport)} ${esc(r.match)}\n`;
          txt += `🎯 ${esc(r.pronostic_principal)} — ${r.cote_estimee ? `~${esc(r.cote_estimee)}` : 'cote non disponible'} (${esc(r.confiance)})\n\n`;
        });
        await send(msg.chat.id, txt);
      } catch (err) {
        await send(msg.chat.id, `❌ Erreur: ${err.message}`);
      }
    });

    // /best
    bot.onText(/\/best/, async (msg) => {
      try {
        const { rows } = await queryDB(
          `SELECT match, sport, pronostic_principal, cote_estimee,
                  value_bet, cote_value, phrase_signature
           FROM ps_pronostics
           -- Le libellé stocké est « Élevée » / « Très élevée » : l'égalité
           -- stricte avec « Élevé » ne trouvait jamais rien.
           WHERE date = CURRENT_DATE AND confiance ILIKE '%élev%'
           ORDER BY cote_estimee DESC
           LIMIT 3`
        );
        if (rows.length === 0) {
          await send(msg.chat.id, 'ℹ️ Aucun pronostic de confiance élevée aujourd\'hui.');
          return;
        }
        let txt = `🔥 *Top picks du jour (confiance élevée)*\n━━━━━━━━━━━━━\n`;
        rows.forEach((r, i) => {
          txt += `${i + 1}. ${getEmojiBySport(r.sport)} *${esc(r.match)}*\n`;
          txt += `🎯 ${esc(r.pronostic_principal)} — ~${esc(r.cote_estimee)}\n`;
          if (r.value_bet && r.cote_value) txt += `💎 Value: ${esc(r.value_bet)} (~${esc(r.cote_value)})\n`;
          if (r.phrase_signature) txt += `💬 _${esc(r.phrase_signature)}_\n`;
          txt += '\n';
        });
        await send(msg.chat.id, txt);
      } catch (err) {
        await send(msg.chat.id, `❌ Erreur: ${err.message}`);
      }
    });

    console.log('💬 Commandes bot activées \\(mode dev\\)');
  };

  setupCommands().catch(() => {});
}

export default bot;
