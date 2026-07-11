// ══════════════════════════════════════════════
// victor/test.js — Test rapide de Victor
// Usage : node victor/test.js
// ══════════════════════════════════════════════

import dotenv from 'dotenv';
dotenv.config({ override: true });
import { runVictor } from './core.js';
import { detectPatterns, formatPatternsForVictor } from './patterns.js';

console.log('🧪 Test Victor — démarrage\n');
console.log('   Modèle  :', 'claude-sonnet-5');
console.log('   API Key :', process.env.ANTHROPIC_API_KEY ? '✅ présente' : '❌ manquante');
console.log('   DB URL  :', process.env.DATABASE_URL ? '✅ présente' : '❌ manquante');
console.log('');

// ── TEST 4C : detectPatterns (Real Madrid vs Barcelona) ──
console.log('══════════════════════════════════════════');
console.log('🧠 TEST PATTERNS — Real Madrid vs Barcelona');
console.log('══════════════════════════════════════════\n');

try {
  const patternsResult = await detectPatterns({
    sport: 'football',
    equipe_a: 'Real Madrid',
    equipe_b: 'Barcelona',
    competition: 'La Liga',
    date: new Date().toISOString().slice(0, 10),
  });

  console.log(`   Patterns H2H trouvés       : ${patternsResult.h2h.length}`);
  console.log(`   Patterns situationnels      : ${patternsResult.situationnels.length}`);
  console.log(`   Signaux forts (>=70%)       : ${patternsResult.signal_fort.length}`);

  if (patternsResult.h2h.length > 0) {
    console.log('\n   [H2H]');
    patternsResult.h2h.forEach(p =>
      console.log(`     • ${p.nom} — ${p.taux_confirmation}% (${p.occurrences_total} cas) → ${p.pari_suggere}`)
    );
  }
  if (patternsResult.situationnels.length > 0) {
    console.log('\n   [Situationnels]');
    patternsResult.situationnels.forEach(p =>
      console.log(`     • ${p.nom} — ${p.taux_confirmation}% → ${p.pari_suggere}`)
    );
  }

  console.log('\n   Texte d\'injection formaté :');
  console.log('   ─────────────────────────────');
  console.log(patternsResult.texte_injection);
  console.log('   ─────────────────────────────\n');

} catch (err) {
  console.error('❌ Test patterns échoué:', err.message);
}

// ── TEST RUNVICTOR ──────────────────────────────────────
console.log('══════════════════════════════════════════');
console.log('🎙️  TEST RUNVICTOR');
console.log('══════════════════════════════════════════\n');

try {
  const result = await runVictor();

  console.log('\n══════════════════════════════════════════');
  console.log('🎙️  RÉSULTAT VICTOR');
  console.log('══════════════════════════════════════════\n');
  console.log(JSON.stringify(result, null, 2));

  console.log(`\n📋 Résumé :`);
  console.log(`   Date          : ${result.date}`);
  console.log(`   Généré à      : ${result.generated_at}`);
  console.log(`   Événements    : ${result.events?.length || 0}`);
  console.log(`   Verdict       : ${result.verdict_journee?.slice(0, 80)}...`);

  if (result.combine_victor?.selections?.length > 0) {
    console.log(`   Combiné Victor: ${result.combine_victor.selections.join(' + ')} → ${result.combine_victor.cote_combinee}`);
  }

  console.log('\n✅ Test terminé avec succès\n');
  process.exit(0);
} catch (err) {
  console.error('\n❌ Test échoué:', err.message);
  process.exit(1);
}
