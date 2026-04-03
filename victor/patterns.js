// ══════════════════════════════════════════════
// victor/patterns.js — Moteur de patterns
// ══════════════════════════════════════════════

import 'dotenv/config';
import { query } from '../db/database.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ══════════════════════════════════════════════
// DETECT PATTERNS — Pour un match donné
// ══════════════════════════════════════════════

/**
 * Détecte les patterns applicables à un match.
 * @param {{ sport, equipe_a, equipe_b, competition, date, impact_enjeu_motivation }} matchContext
 * @returns {{ h2h, situationnels, signal_fort, texte_injection }}
 */
export async function detectPatterns(matchContext) {
  const { sport, equipe_a = '', equipe_b = '', impact_enjeu_motivation = 3 } = matchContext; // Impact par défaut à 3

  let h2h = [];
  let situationnels = [];

  // Ajustement dynamique du seuil de confiance basé sur l'enjeu (exemple simple)
  const seuilConfiance = 55 + (impact_enjeu_motivation - 3) * 5; // +5% si enjeu très fort, -5% si faible

  // ── Requête 1 : Patterns H2H ─────────────────
  try {
    const { rows } = await query(
      `SELECT *
       FROM ps_victor_patterns
       WHERE actif = true
         AND sport = $1
         AND type = 'H2H'
         AND taux_confirmation >= $4
         AND occurrences_total >= 5
         AND (
           (equipe_a ILIKE $2 AND equipe_b ILIKE $3)
           OR (equipe_a ILIKE $3 AND equipe_b ILIKE $2)
           OR (equipe_a IS NULL AND equipe_b IS NULL)
         )
       ORDER BY taux_confirmation DESC`,
      [sport, `%${equipe_a}%`, `%${equipe_b}%`, seuilConfiance]
    );
    h2h = rows;
  } catch (err) {
    console.warn('⚠️ [Patterns] Erreur requête H2H:', err.message);
  }

  // ── Requête 2 : Patterns situationnels/psycho ─
  try {
    const { rows } = await query(
      `SELECT *
       FROM ps_victor_patterns
       WHERE actif = true
         AND sport = $1
         AND type != 'H2H'
         AND taux_confirmation >= $2
         AND occurrences_total >= 5
       ORDER BY taux_confirmation DESC`,
      [sport, seuilConfiance]
    );
    situationnels = rows;
  } catch (err) {
    console.warn('⚠️ [Patterns] Erreur requête situationnels:', err.message);
  }

  // ── Signaux forts (taux >= 70% et ajusté par contexte) ───────────────
  const signal_fort = [...h2h, ...situationnels].filter(
    p => parseFloat(p.taux_confirmation) >= (70 + (impact_enjeu_motivation - 3) * 5) // Seuil fort plus haut si enjeu élevé
  );

  // ── Texte d'injection pour Victor ────────────
  const texte_injection = _buildInjectionText(h2h, situationnels, signal_fort);

  return { h2h, situationnels, signal_fort, texte_injection };
}

// ══════════════════════════════════════════════
// FORMAT PATTERNS FOR VICTOR
// ══════════════════════════════════════════════

/**
 * Formate les patterns pour injection dans le prompt Victor.
 * @param {{ h2h, situationnels, signal_fort }} patternsResult
 * @returns {string}
 */
export function formatPatternsForVictor(patternsResult) {
  if (!patternsResult) {
    return 'Aucun pattern historique significatif détecté.';
  }
  const { h2h = [], situationnels = [], signal_fort = [] } = patternsResult;
  if (h2h.length === 0 && situationnels.length === 0) {
    return 'Aucun pattern historique significatif détecté.';
  }
  return _buildInjectionText(h2h, situationnels, signal_fort);
}

// ── Constructeur interne du texte d'injection ──
function _buildInjectionText(h2h, situationnels, signal_fort) {
  const lines = ['PATTERNS HISTORIQUES DÉTECTÉS :'];

  if (h2h.length > 0) {
    lines.push('\n[H2H]');
    for (const p of h2h) {
      lines.push(`→ ${p.nom} | ${p.taux_confirmation}% sur ${p.occurrences_total} cas`);
      lines.push(`  Pari suggéré : ${p.pari_suggere}`);
      lines.push(`  Fiabilité : ${p.fiabilite}`);
    }
  }

  if (situationnels.length > 0) {
    lines.push('\n[Situationnels / Psychologiques]');
    for (const p of situationnels) {
      lines.push(`→ ${p.nom} | ${p.taux_confirmation}% | Condition: ${p.condition_trigger}`);
      lines.push(`  Pari suggéré : ${p.pari_suggere} | Fiabilité : ${p.fiabilite}`);
    }
  }

  if (signal_fort.length > 0) {
    lines.push(`\n⚡ SIGNAL FORT (>70%) : ${signal_fort.map(p => p.nom).join(', ')}`);
    lines.push('→ Priorité dans l\'analyse Victor');
  }

  return lines.join('\n');
}

// ══════════════════════════════════════════════
// UPDATE PATTERN AFTER RESULT
// ══════════════════════════════════════════════

/**
 * Met à jour les patterns appliqués après vérification d'un résultat.
 * @param {number} pronosticId
 */
export async function updatePatternAfterResult(pronosticId) {
  // ── Récupère le pronostic ─────────────────────
  let prono;
  try {
    const { rows } = await query(
      `SELECT id, match, pronostic_principal, pronostic_correct,
              value_bet, value_bet_correct, patterns_appliques
       FROM ps_pronostics
       WHERE id = $1`,
      [pronosticId]
    );
    if (rows.length === 0) {
      console.warn(`⚠️ [Patterns] Pronostic #${pronosticId} introuvable`);
      return;
    }
    prono = rows[0];
  } catch (err) {
    console.error(`❌ [Patterns] Erreur récupération pronostic #${pronosticId}:`, err.message);
    return;
  }

  // ── Aucun pattern appliqué → rien à faire ────
  const patternsAppliques = prono.patterns_appliques;
  if (!patternsAppliques || !Array.isArray(patternsAppliques) || patternsAppliques.length === 0) {
    console.log(`ℹ️  [Patterns] Aucun pattern appliqué sur "${prono.match}"`);
    return;
  }

  console.log(`🔄 Mise à jour patterns pour "${prono.match}" (${patternsAppliques.length} pattern(s))...`);

  for (const patternNom of patternsAppliques) {
    try {
      // Récupère le pattern pour comparer le pari_suggere
      const { rows: patRows } = await query(
        'SELECT id, nom, pari_suggere, occurrences_total, occurrences_confirmees FROM ps_victor_patterns WHERE nom = $1',
        [patternNom]
      );
      if (patRows.length === 0) {
        console.warn(`   ⚠️  Pattern "${patternNom}" introuvable`);
        continue;
      }

      const pat = patRows[0];

      // Un pattern est "confirmé" si le pronostic était correct
      // (Victor a intégré le pattern dans son pick et le résultat était bon)
      const confirme = prono.pronostic_correct === true ? 1 : 0;

      const newTotal    = (pat.occurrences_total    || 0) + 1;
      const newConfirmes = (pat.occurrences_confirmees || 0) + confirme;
      const newTaux     = parseFloat(((newConfirmes / newTotal) * 100).toFixed(2));
      const desactiverSeuil = await getDynamicDeactivationThreshold(sport); // Seuil dynamique

      await query(
        `UPDATE ps_victor_patterns
         SET occurrences_total        = $1,
             occurrences_confirmees   = $2,
             taux_confirmation        = $3,
             derniere_confirmation    = CASE WHEN $4 = 1 THEN CURRENT_DATE
                                             ELSE derniere_confirmation END,
             actif                    = CASE WHEN $3 < $5 THEN false ELSE true END -- Utilise le seuil dynamique
         WHERE id = $6`,
        [newTotal, newConfirmes, newTaux, confirme, desactiverSeuil, pat.id]
      );

      const statut = confirme ? '✅ Confirmé' : '❌ Non confirmé';
      const desactive = newTaux < desactiverSeuil ? ` 🔴 DÉSACTIVÉ (taux < ${desactiverSeuil}%)` : '';
      console.log(`   ${statut} — "${pat.nom}" → taux: ${newTaux}% (${newConfirmes}/${newTotal})${desactive}`);

    } catch (err) {
      console.error(`   ❌ Erreur update pattern "${patternNom}":`, err.message);
    }
  }
}

// ── Helper pour récupérer le seuil de désactivation dynamique ──
async function getDynamicDeactivationThreshold(sport) {
  try {
    const { rows } = await query(
      `SELECT
         ((sports_prudence -> $1) ->> 'seuil_desactivation')::numeric AS seuil
       FROM ps_victor_rules
       ORDER BY created_at DESC
       LIMIT 1`,
      [sport]
    );
    if (rows.length > 0 && rows[0].seuil !== null) {
      return rows[0].seuil; // Retourne le seuil spécifique au sport
    }
  } catch (err) {
    console.warn(`⚠️ [Patterns] Erreur récupération seuil dynamique pour ${sport}:`, err.message);
  }
  return 45; // Seuil par défaut si non trouvé ou erreur
}


// ══════════════════════════════════════════════
// DISCOVER NEW PATTERNS — Analyse hebdomadaire
// ══════════════════════════════════════════════

/**
 * Analyse les 200 derniers résultats et découvre de nouveaux patterns.
 * Minimum 5 occurrences et 55% de taux pour insertion.
 */
export async function discoverNewPatterns() {
  console.log('\n🔬 Découverte de nouveaux patterns...\n');

  if (!ANTHROPIC_API_KEY) {
    console.warn('⚠️  ANTHROPIC_API_KEY manquante — découverte impossible');
    return;
  }

  // ── Récupère les 200 derniers résultats ───────
  let resultats;
  try {
    const { rows } = await query(
      `SELECT sport, competition, match, equipe_a, equipe_b,
              pronostic_principal, confiance, cote_estimee,
              value_bet, resultat_reel, score_reel,
              pronostic_correct, value_bet_correct, date
       FROM ps_pronostics
       WHERE pronostic_correct IS NOT NULL
       ORDER BY date DESC
       LIMIT 200`
    );
    resultats = rows;
  } catch (err) {
    console.error('❌ [Patterns] Erreur récupération résultats:', err.message);
    return;
  }

  if (resultats.length < 30) {
    console.log(`ℹ️  Pas assez de données (${resultats.length}/30 minimum) — découverte reportée`);
    return;
  }

  console.log(`📊 Analyse de ${resultats.length} résultats...`);

  const prompt = `Tu es un statisticien sportif expert. Analyse ces résultats et identifie des patterns récurrents.

Critères stricts :
- Minimum 5 occurrences dans les données
- Taux de confirmation minimum 55%
- Pattern reproductible (condition claire et identifiable)

Réponds UNIQUEMENT avec un JSON (tableau) :
[
  {
    "nom": "Nom court du pattern",
    "type": "H2H | situationnel | psychologique",
    "sport": "football | basketball | tennis | ...",
    "equipe_a": "nom équipe ou null",
    "equipe_b": "nom équipe ou null",
    "condition_trigger": "Condition précise déclenchant le pattern",
    "pattern_observe": "Ce qui se produit statistiquement",
    "occurrences_total": 0,
    "occurrences_confirmees": 0,
    "taux_confirmation": 0.00,
    "pari_suggere": "Pari précis à placer",
    "fiabilite": "Fort | Moyen | Émergent"
  }
]

Données à analyser :
${JSON.stringify(resultats, null, 2).slice(0, 15000)}`;

  // ── Appel Claude (sans web_search) ────────────
  let claudeResp;
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        system: 'Tu analyses des données sportives et retournes uniquement un JSON valide. Aucun texte hors JSON.',
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    }
    claudeResp = await resp.json();
  } catch (err) {
    console.error('❌ [Patterns] Erreur appel Claude:', err.message);
    return;
  }

  // ── Parse et insertion ────────────────────────
  let newPatterns;
  try {
    const raw = claudeResp.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .replace(/```json\s*/gi, '').replace(/```/g, '').trim();

    const start = raw.indexOf('[');
    const end   = raw.lastIndexOf(']');
    if (start === -1) throw new Error('Aucun tableau JSON trouvé');
    newPatterns = JSON.parse(raw.slice(start, end + 1));
  } catch (err) {
    console.error('❌ [Patterns] Erreur parse JSON:', err.message);
    return;
  }

  let inserted = 0;
  let updated  = 0;

  for (const p of newPatterns) {
    // Filtre de sécurité
    if (!p.nom || p.occurrences_total < 5 || p.taux_confirmation < 55) continue;

    try {
      const result = await query(
        `INSERT INTO ps_victor_patterns
           (nom, type, sport, equipe_a, equipe_b,
            condition_trigger, pattern_observe,
            occurrences_total, occurrences_confirmees, taux_confirmation,
            pari_suggere, fiabilite, actif)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true)
         ON CONFLICT (nom) DO UPDATE SET
           occurrences_total     = EXCLUDED.occurrences_total,
           occurrences_confirmees = EXCLUDED.occurrences_confirmees,
           taux_confirmation      = EXCLUDED.taux_confirmation`,
        [
          p.nom, p.type || 'situationnel', p.sport,
          p.equipe_a || null, p.equipe_b || null,
          p.condition_trigger, p.pattern_observe,
          p.occurrences_total, p.occurrences_confirmees, p.taux_confirmation,
          p.pari_suggere, p.fiabilite || 'Émergent',
        ]
      );

      if (result.rowCount > 0) {
        // ON CONFLICT DO UPDATE retourne toujours 1 — on distingue via xmax
        console.log(`   ✅ [${p.fiabilite}] ${p.nom} (${p.taux_confirmation}%)`);
        inserted++;
      }
    } catch (err) {
      console.error(`   ❌ Erreur insertion "${p.nom}":`, err.message);
    }
  }

  console.log(`\n🔬 Résultat : ${inserted} patterns traités (${updated} mis à jour)\n`);
}
