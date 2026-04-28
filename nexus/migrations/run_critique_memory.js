// nexus/migrations/run_critique_memory.js
// Seed Roberto's critique preferences into nexus_ltm.
//
// Usage: node nexus/migrations/run_critique_memory.js
//
// Idempotent — uses ON CONFLICT DO UPDATE so it's safe to re-run.
// ─────────────────────────────────────────────────────────────────
import dotenv from 'dotenv'; dotenv.config();
import pg from 'pg'; const { Client } = pg;

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const SQL = `
INSERT INTO nexus_ltm (category, key, value) VALUES
  (
    'preference',
    'critique_auto',
    'Appliquer le framework critique Roberto automatiquement sur toute nouvelle idée ou projet non encore lancé. Déclencher sur les mots-clés: j''ai une idée, et si on faisait, je veux lancer, qu''est-ce que tu penses, je pense à créer, nouveau projet, nouvelle app, nouveau business.'
  ),
  (
    'preference',
    'critique_model',
    'Toujours utiliser Claude (claude-3-5-sonnet) pour les critiques business, jamais Gemini. La critique nécessite le meilleur raisonnement disponible.'
  ),
  (
    'preference',
    'critique_framework',
    'Framework critique en 8 étapes: 1-Verdict immédiat, 2-Diagnostic 3D (business/technique/exécution), 3-Concurrence, 4-Viabilité financière, 5-Acquisition premiers clients, 6-MVP solo plan minimal, 7-Risques + plan B, 8-Score /25 avec tableau.'
  ),
  (
    'preference',
    'critique_profile',
    'Profil Roberto: entrepreneur solo, 5 projets actifs (PronoSight, MÉTAFICTION, NutriPlan, Nexus, Fruity Arena), stack Node.js+PostgreSQL+Render+Claude+React Native, marchés francophone + diaspora haïtienne + anglophone. Toute critique calibrée sur cette réalité solo.'
  )
ON CONFLICT (key) DO UPDATE SET
  value     = EXCLUDED.value,
  last_seen = NOW();
`;

try {
  await client.connect();
  await client.query(SQL);
  console.log('✅ Mémoire LTM critique seedée (4 entrées preference)');
  console.log('   • critique_auto     — déclenchement automatique');
  console.log('   • critique_model    — toujours Claude, jamais Gemini');
  console.log('   • critique_framework — 8 étapes + score /25');
  console.log('   • critique_profile  — profil Roberto calibré');
} catch (err) {
  console.error('❌ Erreur seed critique LTM:', err.message);
  process.exit(1);
} finally {
  await client.end();
}
