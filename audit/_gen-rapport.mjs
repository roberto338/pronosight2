import { readFileSync, writeFileSync } from 'node:fs';

const f = readFileSync('audit/findings.jsonl', 'utf8').trim().split('\n').map(JSON.parse);
const ordre = { P0: 0, P1: 1, P2: 2, P3: 3 };
f.sort((a, b) => ordre[a.severite] - ordre[b.severite] || a.id.localeCompare(b.id));
const n = (s) => f.filter(x => x.severite === s).length;

const inv = readFileSync('audit/INVENTAIRE.csv', 'utf8').trim().split('\n').slice(1);
const lus = inv.filter(r => r.includes(',LU,')).length;

let md = `# RAPPORT D'AUDIT — PronoSight

Audit du 03/09/2026. Lecture seule : aucune modification apportée au code pendant les phases 0 à 3.

## Résumé exécutif

**Couverture** — ${lus} fichiers audités en profondeur sur ${inv.length} suivis par git (27 023 lignes au total).
Les fichiers lus couvrent 100 % du chemin qui produit et note les pronostics : \`server.js\`,
\`cron/scheduler.js\`, \`config/env.js\`, l'ensemble de \`queues/\`, et le cœur de \`victor/\`
(\`core.js\`, \`paris.js\`, \`odds.js\`, \`sources.js\`, \`prompt.js\`). Le solde — \`nexus/\` (78 fichiers,
module en veille) et \`public/\` (frontend) — reste à lire.

**Findings** — ${f.length} constats : **${n('P0')} P0**, **${n('P1')} P1**, ${n('P2')} P2, ${n('P3')} P3.

**Les trois risques majeurs**

1. La clé \`VICTOR_API_KEY\` **en service aujourd'hui** est lisible dans l'historique d'un dépôt
   GitHub public depuis le 31/03 (F-012). Le retrait du 05/08 n'a rien corrigé.
2. Trois routes HTTP **sans authentification** transforment une requête anonyme en dépense :
   les crédits de cotes peuvent être vidés en moins de deux minutes, et le débit football-data
   dont dépend toute la couche statistique peut être saturé en permanence (F-001, F-002, F-004).
3. Le matching d'équipes confond des clubs distincts — Manchester United avec Manchester City,
   Real Madrid avec Real Sociedad. Un pronostic peut être noté avec le score d'un autre match,
   et donc fausser le taux de réussite (F-018). Vérifié : ce n'est pas encore arrivé sur les
   69 pronostics notés, mais le risque devient actuel maintenant que Victor publie sur la Liga
   et la Premier League.

**Réponse chiffrée au quota** — le goulot n'est PAS celui qu'on croyait. Depuis le cache de
6 h déployé le 31/08, la consommation The Odds API est tombée à **4 crédits/jour** (mesuré les
01, 02 et 03/09), soit 120 sur 500 par mois. Le facteur limitant est désormais le **débit de
football-data** : 10 requêtes/minute pour 8 requêtes par run, ce qui autorise **2 runs
simultanés** — exactement le rythme actuel. Détail dans \`QUOTA.md\`.

---

## Findings

`;

for (const x of f) {
  md += `### [${x.severite}] ${x.id} — ${x.titre}\n\n`;
  md += `**Emplacement** : \`${x.fichier}\`${x.lignes ? ` — ${x.lignes}` : ''}  \n`;
  md += `**Axe** : ${x.axe} · **Effort** : ${x.effort}\n\n`;
  md += `**Constat**\n\n${x.preuve}\n\n`;
  md += `**Impact**\n\n${x.impact}\n\n`;
  md += `**Correctif**\n\n${x.correctif}\n\n---\n\n`;
}

md += `## Manques structurels

Ces quatre briques **n'existent pas** dans le code. Ce ne sont pas des régressions : elles n'ont
jamais été construites. Elles sont donc exclues des compteurs P0–P3 ci-dessus.

Vérifié le 03/09 par recherche sur \`kelly\`, \`brier\`, \`closing\` et \`backtest\` : aucune occurrence.

| Brique | Ce qu'elle apporterait | Coût | À partir de quand |
|---|---|---|---|
| **Calibration** (Brier, log-loss) | Savoir si un « 70 % » de Victor vaut vraiment 70 %. C'est le seul contrôle possible sur \`probabilite\`, aujourd'hui non vérifiée (F-020) | S | Dès maintenant : 61 paris notés suffisent pour une première courbe |
| **CLV** (closing line value) | Meilleur indicateur précoce de qualité, bien avant que le ROI ne soit significatif | M — nécessite de stocker la cote au pronostic ET à la clôture | Dès maintenant, c'est ce qui fait gagner le plus de temps |
| **Kelly** | Dimensionnement des mises | S | Seulement une fois la calibration mesurée — sans elle, Kelly amplifie une erreur d'estimation |
| **Backtest** | Valider une stratégie sans attendre des mois | L | Quand l'historique dépassera ~200 paris |

L'ordre compte : **calibration d'abord**. Kelly sur des probabilités non calibrées augmente la
mise sur les paris où le modèle se trompe le plus.
`;

writeFileSync('audit/RAPPORT.md', md);
console.log(`RAPPORT.md écrit — ${f.length} findings, ${lus}/${inv.length} fichiers`);
