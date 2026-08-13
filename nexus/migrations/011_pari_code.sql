-- ══════════════════════════════════════════════
-- 011 — Le pari devient un CODE, plus une phrase
--
-- Trois faux résultats en dix jours, tous dus à l'interprétation d'un
-- libellé en texte libre par expressions régulières :
--
--   03/08  « Portugal -2.5 »            lu comme « Under 2.5 buts »
--   05/08  « Double chance : X ou nul » lu comme « Match nul »
--   12/08  « Pas de match nul »         lu comme « Match nul »
--
-- Le dernier a fait afficher 100 % de réussite sur un pari perdu.
--
-- pari_code porte désormais le sens (1X2:HOME, DC:12, OU:OVER:2.5,
-- BTTS:NO, AH:HOME:-1.5, TT:AWAY:UNDER:1.5). La notation s'appuie sur
-- lui ; pronostic_principal redevient un simple libellé d'affichage.
-- ══════════════════════════════════════════════

ALTER TABLE ps_pronostics
  ADD COLUMN IF NOT EXISTS pari_code VARCHAR(40);

COMMENT ON COLUMN ps_pronostics.pari_code IS
  'Code du vocabulaire fermé (victor/paris.js). Fait foi pour la notation ; pronostic_principal n''est qu''un affichage.';

-- Retrouver rapidement les paris non codés, donc non notables
CREATE INDEX IF NOT EXISTS idx_ps_pronostics_sans_code
  ON ps_pronostics (date) WHERE pari_code IS NULL;
