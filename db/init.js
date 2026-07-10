// ══════════════════════════════════════════════
// db/init.js — Initialisation base PronoSight
// Usage : node db/init.js
// ══════════════════════════════════════════════

import 'dotenv/config';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { query } from './database.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 15 patterns de démarrage ──────────────────
const STARTER_PATTERNS = [
  {
    nom: 'El Clásico Over 2.5 buts',
    type: 'H2H',
    sport: 'football',
    equipe_a: 'Real Madrid',
    equipe_b: 'Barcelona',
    condition_trigger: 'Match entre Real Madrid et Barcelona',
    pattern_observe: 'Plus de 2.5 buts dans le match',
    occurrences_total: 17,
    occurrences_confirmees: 14,
    taux_confirmation: 82.35,
    pari_suggere: 'Over 2.5 buts',
    fiabilite: 'Fort',
  },
  {
    nom: 'Fatigue post-Champions League',
    type: 'situationnel',
    sport: 'football',
    equipe_a: null,
    equipe_b: null,
    condition_trigger: 'Équipe joue CL mercredi + match extérieur samedi moins de 72h',
    pattern_observe: 'Défaite ou nul favori dans 61% des cas',
    occurrences_total: 23,
    occurrences_confirmees: 14,
    taux_confirmation: 60.87,
    pari_suggere: 'Nul ou défaite favorite',
    fiabilite: 'Moyen',
  },
  {
    nom: 'Première journée post-trêve internationale',
    type: 'situationnel',
    sport: 'football',
    equipe_a: null,
    equipe_b: null,
    condition_trigger: 'Première journée championnat après trêve internationale',
    pattern_observe: 'Équipes avec 5+ internationaux sous-performent dans 61% des cas',
    occurrences_total: 31,
    occurrences_confirmees: 19,
    taux_confirmation: 61.29,
    pari_suggere: 'Nul ou contre-performance favorite',
    fiabilite: 'Moyen',
  },
  {
    nom: 'BTTS Derby Londonien',
    type: 'H2H',
    sport: 'football',
    equipe_a: null,
    equipe_b: null,
    condition_trigger: 'Derby entre équipes londoniennes',
    pattern_observe: 'Les deux équipes marquent',
    occurrences_total: 18,
    occurrences_confirmees: 13,
    taux_confirmation: 72.22,
    pari_suggere: 'BTTS Oui',
    fiabilite: 'Fort',
  },
  {
    nom: 'Nadal sur terre battue Grand Chelem',
    type: 'situationnel',
    sport: 'tennis',
    equipe_a: 'Rafael Nadal',
    equipe_b: null,
    condition_trigger: 'Nadal joue sur terre battue Grand Chelem ou Masters',
    pattern_observe: 'Nadal gagne en 3 sets max contre top 20',
    occurrences_total: 24,
    occurrences_confirmees: 17,
    taux_confirmation: 70.83,
    pari_suggere: 'Victoire Nadal -3.5 sets',
    fiabilite: 'Fort',
  },
  {
    nom: 'NBA Back-to-Back road game',
    type: 'situationnel',
    sport: 'basketball',
    equipe_a: null,
    equipe_b: null,
    condition_trigger: 'Équipe NBA joue 2e match consécutif à l\'extérieur',
    pattern_observe: 'Équipe sous-performe, couvre rarement le spread',
    occurrences_total: 45,
    occurrences_confirmees: 29,
    taux_confirmation: 64.44,
    pari_suggere: 'Équipe adverse couvre le spread',
    fiabilite: 'Moyen',
  },
  {
    nom: 'Équipe reléguable domicile fin saison',
    type: 'situationnel',
    sport: 'football',
    equipe_a: null,
    equipe_b: null,
    condition_trigger: 'Équipe en zone relégation à 5 journées ou moins',
    pattern_observe: 'Victoire à domicile dans 62% des cas',
    occurrences_total: 29,
    occurrences_confirmees: 18,
    taux_confirmation: 62.07,
    pari_suggere: 'Victoire équipe domicile',
    fiabilite: 'Moyen',
  },
  {
    nom: 'Under 2.5 Ligue 1 après trêve',
    type: 'situationnel',
    sport: 'football',
    equipe_a: null,
    equipe_b: null,
    condition_trigger: 'Match Ligue 1 première semaine après trêve internationale',
    pattern_observe: 'Moins de 2.5 buts dans 63% des matchs',
    occurrences_total: 27,
    occurrences_confirmees: 17,
    taux_confirmation: 62.96,
    pari_suggere: 'Under 2.5 buts',
    fiabilite: 'Moyen',
  },
  {
    nom: 'Rebond gardien après débâcle',
    type: 'psychologique',
    sport: 'football',
    equipe_a: null,
    equipe_b: null,
    condition_trigger: 'Gardien a encaissé 3+ buts match précédent',
    pattern_observe: 'Clean sheet ou moins 1 but dans 48% des cas',
    occurrences_total: 33,
    occurrences_confirmees: 16,
    taux_confirmation: 48.48,
    pari_suggere: 'Under 1.5 buts équipe adverse',
    fiabilite: 'Émergent',
  },
  {
    nom: 'Finale européenne Over 2.5',
    type: 'situationnel',
    sport: 'football',
    equipe_a: null,
    equipe_b: null,
    condition_trigger: 'Match de finale UEFA CL EL ECL',
    pattern_observe: 'Plus de 2.5 buts dans 71% des finales',
    occurrences_total: 21,
    occurrences_confirmees: 15,
    taux_confirmation: 71.43,
    pari_suggere: 'Over 2.5 buts',
    fiabilite: 'Fort',
  },
  {
    nom: 'Tennis premier set serré Grand Chelem',
    type: 'situationnel',
    sport: 'tennis',
    equipe_a: null,
    equipe_b: null,
    condition_trigger: 'Demi-finale ou finale Grand Chelem entre top 5',
    pattern_observe: 'Premier set tiebreak ou 7-5 dans 68% des cas',
    occurrences_total: 19,
    occurrences_confirmees: 13,
    taux_confirmation: 68.42,
    pari_suggere: 'Premier set tiebreak ou 7-5',
    fiabilite: 'Moyen',
  },
  {
    nom: 'Atletico Madrid domicile Champions League',
    type: 'H2H',
    sport: 'football',
    equipe_a: 'Atletico Madrid',
    equipe_b: null,
    condition_trigger: 'Atletico Madrid joue à domicile en CL phase KO',
    pattern_observe: 'Invaincu en 12 derniers matchs européens domicile',
    occurrences_total: 12,
    occurrences_confirmees: 12,
    taux_confirmation: 100.00,
    pari_suggere: 'Nul ou victoire Atletico',
    fiabilite: 'Fort',
  },
  {
    nom: 'PSG après élimination européenne',
    type: 'psychologique',
    sport: 'football',
    equipe_a: 'Paris Saint-Germain',
    equipe_b: null,
    condition_trigger: 'PSG éliminé coupe Europe — match Ligue 1 suivant',
    pattern_observe: 'PSG perd ou nul dans 58% des matchs suivants',
    occurrences_total: 12,
    occurrences_confirmees: 7,
    taux_confirmation: 58.33,
    pari_suggere: 'Double chance adversaire',
    fiabilite: 'Émergent',
  },
  {
    nom: 'UFC favori écrasant perd',
    type: 'situationnel',
    sport: 'mma',
    equipe_a: null,
    equipe_b: null,
    condition_trigger: 'Combat UFC avec favori à cote inférieure à 1.25',
    pattern_observe: 'Favori perd ou décision dans 44% des cas',
    occurrences_total: 34,
    occurrences_confirmees: 15,
    taux_confirmation: 44.12,
    pari_suggere: 'Outsider ou méthode décision',
    fiabilite: 'Émergent',
  },
  {
    nom: 'F1 pole position victoire circuit fermé',
    type: 'situationnel',
    sport: 'f1',
    equipe_a: null,
    equipe_b: null,
    condition_trigger: 'Pole position sur circuit peu propice dépassements',
    pattern_observe: 'Pole gagne course dans 72% des cas',
    occurrences_total: 25,
    occurrences_confirmees: 18,
    taux_confirmation: 72.00,
    pari_suggere: 'Victoire depuis la pole',
    fiabilite: 'Fort',
  },
];

// ──────────────────────────────────────────────
async function initDB() {
  console.log('\n🚀 Initialisation base PronoSight...\n');

  // Attente connexion pool
  await new Promise(r => setTimeout(r, 500));

  // ── Étape 1 : Exécution du schéma SQL ────────
  console.log('📐 Création des tables (schéma)...');
  try {
    const schemaSql = readFileSync(join(__dirname, 'schema_neon.sql'), 'utf8');
    // Supprimer les lignes de commentaires SQL avant le split
    const cleanedSql = schemaSql
      .split('\n')
      .filter(line => !line.trim().startsWith('--'))
      .join('\n');

    // Exécuter statement par statement (pg ne supporte pas multi-statement natif)
    const statements = cleanedSql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0);

    for (const stmt of statements) {
      await query(stmt);
    }
    console.log('   ✅ Tables créées (4 ps_* Victor + 14 nexus_* — voir db/schema_neon.sql)');
  } catch (err) {
    console.error('   ❌ Erreur création tables:', err.message);
    process.exit(1);
  }

  // ── Étape 2 : Insertion des 15 patterns ──────
  console.log('\n🧠 Insertion des patterns de démarrage...');
  let inserted = 0;
  let skipped = 0;

  for (const p of STARTER_PATTERNS) {
    try {
      const result = await query(
        `INSERT INTO ps_victor_patterns
          (nom, type, sport, equipe_a, equipe_b,
           condition_trigger, pattern_observe,
           occurrences_total, occurrences_confirmees, taux_confirmation,
           pari_suggere, fiabilite, actif)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true)
         ON CONFLICT (nom) DO NOTHING`,
        [
          p.nom, p.type, p.sport, p.equipe_a ?? null, p.equipe_b ?? null,
          p.condition_trigger, p.pattern_observe,
          p.occurrences_total, p.occurrences_confirmees, p.taux_confirmation,
          p.pari_suggere, p.fiabilite,
        ]
      );
      if (result.rowCount > 0) {
        console.log(`   ✅ [${p.fiabilite}] ${p.nom}`);
        inserted++;
      } else {
        console.log(`   ⏭️  [déjà présent] ${p.nom}`);
        skipped++;
      }
    } catch (err) {
      console.error(`   ❌ Erreur pattern "${p.nom}":`, err.message);
    }
  }

  console.log(`\n   → ${inserted} patterns insérés, ${skipped} déjà présents`);

  // ── Étape 3 : Vérification finale ────────────
  console.log('\n🔍 Vérification...');
  try {
    const tables = await query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name LIKE 'ps_%'
      ORDER BY table_name
    `);
    console.log('   Tables PronoSight détectées :');
    tables.rows.forEach(r => console.log(`     • ${r.table_name}`));

    const patternCount = await query('SELECT COUNT(*) FROM ps_victor_patterns WHERE actif = true');
    console.log(`\n   Patterns actifs : ${patternCount.rows[0].count}`);
  } catch (err) {
    console.error('   ❌ Erreur vérification:', err.message);
  }

  console.log('\n✅ Base PronoSight initialisée avec succès !\n');
  process.exit(0);
}

initDB().catch(err => {
  console.error('❌ Erreur fatale init:', err.message);
  process.exit(1);
});
