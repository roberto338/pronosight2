-- ══════════════════════════════════════════════
-- 010 — Unicité des pronostics : un pari par match et par jour
--
-- Constaté le 11/08/2026 : le job prematch de 7h00 et le job value de
-- 13h00 analysent tous deux la journée et insèrent chacun leur ligne.
-- Résultat, deux pronostics identiques sur Fluminense vs Rivadavia
-- (« Under 2.5 buts », cotes 1.66 et 1.59).
--
-- Sans contrainte, un pari gagnant comptait DEUX victoires et doublait
-- le ROI. Le taux de réussite — seule mesure qui justifie ce projet —
-- était donc faussé par construction dès qu'un match était réanalysé.
--
-- La clé normalise le libellé du match (minuscules, espaces réduits)
-- pour que « PSV vs Sittard » et « psv  vs  sittard » se rejoignent.
-- ══════════════════════════════════════════════

-- 1. Purge des doublons existants : on garde la ligne la PLUS RÉCENTE,
--    qui reflète la dernière analyse et les cotes les plus fraîches.
DELETE FROM ps_pronostics a
USING ps_pronostics b
WHERE a.date = b.date
  AND lower(regexp_replace(a.match, '\s+', ' ', 'g')) =
      lower(regexp_replace(b.match, '\s+', ' ', 'g'))
  AND a.id < b.id;

-- 2. Contrainte d'unicité
CREATE UNIQUE INDEX IF NOT EXISTS idx_ps_pronostics_unique_jour
  ON ps_pronostics (date, lower(regexp_replace(match, '\s+', ' ', 'g')));
