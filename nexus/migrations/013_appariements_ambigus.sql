-- ══════════════════════════════════════════════
-- 013 — File de revue des appariements ambigus
--
-- checkResults apparie un pronostic à une rencontre du jour par le nom des
-- équipes. Jusqu'au 03/09/2026, il prenait le PREMIER candidat qui passait :
-- si deux rencontres correspondaient, il en choisissait une au hasard de
-- l'ordre de collecte et écrivait son score sur le pronostic.
--
-- Vérifié par exécution le 03/09 : « Manchester United vs Arsenal » était
-- apparié à « Manchester City 3-0 Arsenal », « Real Madrid vs Barcelona » à
-- « Real Sociedad 1-4 Barcelona ». Cinq faux positifs sur sept cas testés.
-- Aucune notation erronée sur les 69 pronostics déjà notés — les
-- compétitions couvertes jusque-là ne présentaient pas de paire ambiguë.
--
-- Le correctif refuse désormais de trancher. Mais refuser en silence
-- reviendrait à perdre le pronostic : il resterait non noté, sans que rien
-- n'indique pourquoi. Cette table est la trace, et la file de travail.
-- ══════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ps_appariements_ambigus (
  id            SERIAL PRIMARY KEY,
  pronostic_id  INTEGER NOT NULL REFERENCES ps_pronostics(id) ON DELETE CASCADE,
  match_annonce TEXT    NOT NULL,
  candidats     JSONB   NOT NULL,
  force_match   SMALLINT,
  resolu        BOOLEAN NOT NULL DEFAULT false,
  detecte_le    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolu_le     TIMESTAMPTZ
);

COMMENT ON TABLE ps_appariements_ambigus IS
  'Pronostics que checkResults a refusé de noter faute de pouvoir choisir entre plusieurs rencontres. À arbitrer à la main.';
COMMENT ON COLUMN ps_appariements_ambigus.candidats IS
  'Rencontres du jour qui revendiquaient le pronostic avec la même force d''appariement.';
COMMENT ON COLUMN ps_appariements_ambigus.force_match IS
  '3 = correspondance exacte, 2 = alias connu, 1 = ressemblance. Une ambiguïté à 3 signale des données amont contradictoires.';

-- Un pronostic ne doit apparaître qu'une fois dans la file, même si
-- checkResults le repasse chaque nuit pendant sa fenêtre de rattrapage.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ambigus_pronostic
  ON ps_appariements_ambigus (pronostic_id);

-- La file de travail : ce qui reste à arbitrer, du plus ancien au plus récent.
CREATE INDEX IF NOT EXISTS idx_ambigus_a_traiter
  ON ps_appariements_ambigus (detecte_le)
  WHERE resolu = false;
