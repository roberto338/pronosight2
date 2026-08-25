-- ══════════════════════════════════════════════
-- 012 — Distinguer une cote du marché d'une cote estimée
--
-- Le message Telegram affiche « 💰 Cote : ~1.25 » pour tous les
-- pronostics. Or cette cote a deux origines très différentes :
--
--   · quand The Odds API couvre la compétition, c'est une MOYENNE RÉELLE
--     de plusieurs bookmakers, et elle sert à calculer la value
--     (probabilité × cote − 1). Un pari à value négative est rejeté.
--
--   · quand elle ne la couvre pas, c'est le MODÈLE qui écrit le chiffre.
--     validerEvent() ne contrôle que sa plausibilité (entre 1.01 et 51).
--     Rien ne le confronte au marché.
--
-- Le 25/08, seules 13 compétitions sur les 47 vues par The Odds API
-- étaient réellement cotées : la seconde situation est la plus fréquente.
-- Présenter les deux de la même façon revient à donner un chiffre inventé
-- pour un fait — c'est exactement le défaut corrigé sur le champ `heure`
-- (migration du 25/08) et sur la value (calculée, jamais déclarée).
--
-- Cette colonne permet aussi de comparer les deux populations dans le
-- taux de réussite : un pronostic adossé au marché et un pronostic à
-- l'aveugle n'ont aucune raison de se valoir, et jusqu'ici on ne pouvait
-- pas le mesurer.
-- ══════════════════════════════════════════════

ALTER TABLE ps_pronostics
  ADD COLUMN IF NOT EXISTS cote_confirmee BOOLEAN;

COMMENT ON COLUMN ps_pronostics.cote_confirmee IS
  'true = cote_estimee vient d''une moyenne réelle de bookmakers (The Odds API) et la value a été calculée. false = cote écrite par le modèle, non confrontée au marché. NULL = pronostic antérieur au 25/08/2026, origine inconnue.';

-- Comparer réussite avec et sans cote de marché, sans balayer la table
CREATE INDEX IF NOT EXISTS idx_ps_pronostics_cote_confirmee
  ON ps_pronostics (cote_confirmee, date)
  WHERE cote_confirmee IS NOT NULL;
