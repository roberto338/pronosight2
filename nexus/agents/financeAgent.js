// ══════════════════════════════════════════════
// nexus/agents/financeAgent.js
// Gestion bankroll, Kelly Criterion, suivi paris
// Actions : status | kelly | record | settle | report | init
// ══════════════════════════════════════════════

import { query } from '../../db/database.js';
import { callAI } from '../lib/ai.js';

// ── Kelly Criterion (demi-Kelly pour sécurité) ─
function kelly(odds, confidence) {
  const b = odds - 1;       // gain net par unité misée
  const p = confidence;     // probabilité estimée de gagner
  const q = 1 - p;          // probabilité de perdre
  const f = (b * p - q) / b;
  return Math.max(0, f / 2); // demi-Kelly, jamais négatif
}

function fmt(n) { return Number(n).toFixed(2); }

// ── Lit ou crée la bankroll ────────────────────
async function getBankroll() {
  const { rows } = await query('SELECT * FROM nexus_bankroll ORDER BY id DESC LIMIT 1');
  return rows[0] || null;
}

async function updateBalance(newBalance) {
  const br = await getBankroll();
  if (!br) throw new Error('Bankroll non initialisée. Utilise /finance init [montant]');
  await query(
    'UPDATE nexus_bankroll SET balance = $1, updated_at = NOW() WHERE id = $2',
    [newBalance, br.id]
  );
}

// ── Parser NLP pour identifier l'action ───────
const PARSE_SYSTEM = `Tu es un assistant de gestion financière pour paris sportifs.
Tu reçois une demande en langage naturel et tu retournes un JSON avec:
{
  "action": "status|kelly|record|settle|report|init",
  "params": {
    "amount":     <nombre si init>,
    "match":      <nom du match si record>,
    "market":     <marché parié si record>,
    "odds":       <cote décimale si kelly/record>,
    "confidence": <confiance 0-1 si kelly/record>,
    "stake":      <mise si record>,
    "bet_id":     <id du pari si settle>,
    "result":     <"won"|"lost"|"void" si settle>,
    "period":     <"week"|"month"|"all" si report>
  }
}
Actions:
- status  : état bankroll actuelle
- kelly   : calculer la mise optimale (Kelly)
- record  : enregistrer un pari
- settle  : enregistrer le résultat d'un pari (won/lost/void)
- report  : rapport de performance (ROI, win rate, profits)
- init    : initialiser la bankroll avec un montant de départ
Retourne UNIQUEMENT le JSON, sans markdown.`;

async function parseRequest(input) {
  const raw = await callAI(PARSE_SYSTEM, input, { maxTokens: 256, temperature: 0.1 });
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Impossible de parser la demande');
  return JSON.parse(match[0]);
}

// ══════════════════════════════════════════════
// ACTIONS
// ══════════════════════════════════════════════

async function actionStatus() {
  const br = await getBankroll();
  if (!br) return '❌ Bankroll non initialisée.\nUtilise: `/finance init 1000` pour commencer avec 1000€';

  const { rows: stats } = await query(`
    SELECT
      COUNT(*)                                           AS total,
      COUNT(*) FILTER (WHERE status='won')              AS wins,
      COUNT(*) FILTER (WHERE status='lost')             AS losses,
      COUNT(*) FILTER (WHERE status='pending')          AS pending,
      COALESCE(SUM(profit) FILTER (WHERE status IN ('won','lost')), 0) AS total_profit,
      COALESCE(SUM(stake)  FILTER (WHERE status IN ('won','lost')), 0) AS total_staked
    FROM nexus_bets
  `);
  const s = stats[0];
  const roi = s.total_staked > 0
    ? ((s.total_profit / s.total_staked) * 100).toFixed(1)
    : '0.0';
  const winRate = (s.wins + s.losses) > 0
    ? ((s.wins / (s.wins + s.losses)) * 100).toFixed(1)
    : '0.0';
  const pnl = parseFloat(br.balance) - parseFloat(br.initial_balance);

  return (
    `💰 *Bankroll — Status*\n${'─'.repeat(22)}\n\n` +
    `💵 Balance actuelle : *${fmt(br.balance)} ${br.currency}*\n` +
    `🏦 Balance initiale : ${fmt(br.initial_balance)} ${br.currency}\n` +
    `📈 P&L total : ${pnl >= 0 ? '+' : ''}${fmt(pnl)} ${br.currency}\n\n` +
    `📊 *Performance*\n` +
    `✅ Paris gagnés : ${s.wins} / Perdus : ${s.losses}\n` +
    `⏳ En attente : ${s.pending}\n` +
    `🎯 Win rate : ${winRate}%\n` +
    `📉 ROI : ${roi}%`
  );
}

async function actionKelly(params) {
  const { odds, confidence } = params;
  if (!odds || !confidence) throw new Error('Besoin de la cote (odds) et de la confiance (0-1)');

  const br = await getBankroll();
  if (!br) return '❌ Bankroll non initialisée. Utilise /finance init [montant]';

  const fraction = kelly(parseFloat(odds), parseFloat(confidence));
  const stake    = parseFloat(br.balance) * fraction;
  const maxStake = parseFloat(br.balance) * 0.05; // Cap à 5% bankroll

  return (
    `🧮 *Kelly Criterion*\n${'─'.repeat(22)}\n\n` +
    `Cote : ${odds} | Confiance : ${(confidence * 100).toFixed(0)}%\n\n` +
    `📐 Fraction Kelly : ${(fraction * 100).toFixed(2)}%\n` +
    `💵 Mise optimale : *${fmt(Math.min(stake, maxStake))} €*\n` +
    `🔒 Bankroll actuelle : ${fmt(br.balance)} €\n\n` +
    `_Cap appliqué à 5% max par pari pour sécurité_`
  );
}

async function actionRecord(params) {
  const { match, market, odds, stake, confidence } = params;
  if (!match || !market || !odds || !stake) {
    throw new Error('Besoin de: match, marché, cote et mise');
  }

  const br = await getBankroll();
  if (!br) return '❌ Bankroll non initialisée. Utilise /finance init [montant]';
  if (parseFloat(stake) > parseFloat(br.balance)) {
    throw new Error(`Mise (${stake}€) supérieure à la balance (${fmt(br.balance)}€)`);
  }

  const { rows } = await query(
    `INSERT INTO nexus_bets (match_name, market, odds, stake, confidence, status)
     VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING id`,
    [match, market, parseFloat(odds), parseFloat(stake), confidence ? parseFloat(confidence) : null]
  );
  const betId = rows[0].id;

  // Déduit la mise de la balance
  await updateBalance(parseFloat(br.balance) - parseFloat(stake));

  return (
    `✅ *Pari enregistré #${betId}*\n${'─'.repeat(22)}\n\n` +
    `⚽ Match : ${match}\n` +
    `🎯 Marché : ${market}\n` +
    `💰 Cote : ${odds} | Mise : ${stake}€\n` +
    `💵 Balance restante : ${fmt(parseFloat(br.balance) - parseFloat(stake))}€\n\n` +
    `_Pour enregistrer le résultat: /finance résultat #${betId} gagné/perdu_`
  );
}

async function actionSettle(params) {
  const { bet_id, result } = params;
  if (!bet_id || !result) throw new Error('Besoin du bet_id et du résultat (won/lost/void)');

  const { rows } = await query('SELECT * FROM nexus_bets WHERE id = $1', [bet_id]);
  if (!rows[0]) throw new Error(`Pari #${bet_id} non trouvé`);
  const bet = rows[0];
  if (bet.status !== 'pending') throw new Error(`Pari #${bet_id} déjà clôturé (${bet.status})`);

  let profit = 0;
  let balanceDelta = 0;

  if (result === 'won') {
    profit = parseFloat(bet.stake) * (parseFloat(bet.odds) - 1);
    balanceDelta = parseFloat(bet.stake) + profit; // remboursement mise + gain
  } else if (result === 'lost') {
    profit = -parseFloat(bet.stake);
    balanceDelta = 0; // mise déjà déduite à l'enregistrement
  } else if (result === 'void') {
    profit = 0;
    balanceDelta = parseFloat(bet.stake); // remboursement mise
  }

  await query(
    `UPDATE nexus_bets SET status=$2, profit=$3, settled_at=NOW() WHERE id=$1`,
    [bet_id, result, profit]
  );

  const br = await getBankroll();
  if (br && balanceDelta > 0) {
    await updateBalance(parseFloat(br.balance) + balanceDelta);
  }

  const icon = result === 'won' ? '✅' : result === 'lost' ? '❌' : '↩️';
  const newBalance = br ? parseFloat(br.balance) + balanceDelta : 0;

  return (
    `${icon} *Pari #${bet_id} clôturé — ${result.toUpperCase()}*\n${'─'.repeat(22)}\n\n` +
    `⚽ ${bet.match_name} — ${bet.market}\n` +
    `💰 Cote : ${bet.odds} | Mise : ${bet.stake}€\n` +
    `${result === 'won' ? `💵 Gain : +${fmt(profit)}€` : result === 'lost' ? `💸 Perte : ${fmt(profit)}€` : `↩️ Remboursé`}\n` +
    `🏦 Nouvelle balance : *${fmt(newBalance)}€*`
  );
}

async function actionReport(params) {
  const period = params?.period || 'all';
  const interval = period === 'week' ? '7 days' : period === 'month' ? '30 days' : '999 days';

  const { rows } = await query(`
    SELECT
      COUNT(*)                                            AS total,
      COUNT(*) FILTER (WHERE status='won')               AS wins,
      COUNT(*) FILTER (WHERE status='lost')              AS losses,
      COUNT(*) FILTER (WHERE status='void')              AS voids,
      COUNT(*) FILTER (WHERE status='pending')           AS pending,
      COALESCE(SUM(profit)  FILTER (WHERE status IN ('won','lost')), 0) AS total_profit,
      COALESCE(SUM(stake)   FILTER (WHERE status IN ('won','lost')), 0) AS total_staked,
      COALESCE(MAX(profit)  FILTER (WHERE status='won'),  0)           AS best_win,
      COALESCE(MIN(profit)  FILTER (WHERE status='lost'), 0)           AS worst_loss,
      COALESCE(AVG(odds)    FILTER (WHERE status IN ('won','lost')), 0) AS avg_odds
    FROM nexus_bets
    WHERE created_at > NOW() - INTERVAL '${interval}'
  `);
  const s = rows[0];
  const br = await getBankroll();

  const settled  = parseInt(s.wins) + parseInt(s.losses);
  const winRate  = settled > 0 ? ((s.wins / settled) * 100).toFixed(1) : '0.0';
  const roi      = parseFloat(s.total_staked) > 0
    ? ((s.total_profit / s.total_staked) * 100).toFixed(1) : '0.0';
  const pnl      = parseFloat(br?.balance || 0) - parseFloat(br?.initial_balance || 0);
  const periodLabel = period === 'week' ? '7 derniers jours' : period === 'month' ? '30 derniers jours' : 'Tout le temps';

  return (
    `📊 *Rapport financier — ${periodLabel}*\n${'─'.repeat(22)}\n\n` +
    `🏦 *Bankroll*\n` +
    `Balance : ${fmt(br?.balance || 0)}€ | Départ : ${fmt(br?.initial_balance || 0)}€\n` +
    `P&L global : ${pnl >= 0 ? '+' : ''}${fmt(pnl)}€\n\n` +
    `📈 *Performance paris*\n` +
    `Total : ${s.total} | ✅ ${s.wins} gagnés | ❌ ${s.losses} perdus\n` +
    `Win rate : ${winRate}% | ROI : ${roi}%\n` +
    `Cote moyenne : ${parseFloat(s.avg_odds).toFixed(2)}\n\n` +
    `💵 *Finances*\n` +
    `Misé : ${fmt(s.total_staked)}€ | P&L paris : ${parseFloat(s.total_profit) >= 0 ? '+' : ''}${fmt(s.total_profit)}€\n` +
    `Meilleur gain : +${fmt(s.best_win)}€ | Pire perte : ${fmt(s.worst_loss)}€\n` +
    (s.pending > 0 ? `⏳ ${s.pending} paris en attente de résultat` : '')
  );
}

async function actionInit(params) {
  const amount = parseFloat(params?.amount);
  if (!amount || amount <= 0) throw new Error('Montant invalide. Ex: /finance init 500');

  const existing = await getBankroll();
  if (existing) {
    await query('UPDATE nexus_bankroll SET balance=$1, initial_balance=$1, updated_at=NOW() WHERE id=$2',
      [amount, existing.id]);
  } else {
    await query('INSERT INTO nexus_bankroll (balance, initial_balance) VALUES ($1, $1)', [amount]);
  }
  return `✅ *Bankroll initialisée à ${fmt(amount)}€*\nTu peux maintenant enregistrer des paris avec /finance pari [match] [marché] [cote] [mise]`;
}

// ══════════════════════════════════════════════
// ENTRY POINT
// ══════════════════════════════════════════════

export async function runFinance({ input, meta = {} }) {
  console.log(`[FinanceAgent] Demande: ${input.slice(0, 80)}`);

  // Action explicite passée en meta (ex: depuis /bankroll, /bet, etc.)
  let action = meta.action || null;
  let params  = meta.params || {};

  // Sinon parser en NLP
  if (!action) {
    const parsed = await parseRequest(input);
    action = parsed.action;
    params = parsed.params || {};
  }

  let output;
  switch (action) {
    case 'status':  output = await actionStatus();         break;
    case 'kelly':   output = await actionKelly(params);    break;
    case 'record':  output = await actionRecord(params);   break;
    case 'settle':  output = await actionSettle(params);   break;
    case 'report':  output = await actionReport(params);   break;
    case 'init':    output = await actionInit(params);     break;
    default:        output = await actionStatus();
  }

  return {
    output,
    meta: { agent: 'finance', action, params },
  };
}
