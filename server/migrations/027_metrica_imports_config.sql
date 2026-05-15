-- Migration: 027_metrica_imports_config
-- Per-site config for importing conversions FROM Metrica into SURFAI.
-- Each entry maps a Metrica goal ID to a SURFAI goal name. The
-- metrica-import-conversions worker polls Reports API and writes matched
-- visits into the conversions table.
--
-- Example for stefcom.ru (calltracking goal):
--   [{"metrica_goal_id": 201469045, "surfai_goal_name": "lead_stefcom_call"}]

ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS metrica_imports JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN sites.metrica_imports IS
  'Array of {metrica_goal_id, surfai_goal_name} configs telling the metrica-import worker which Metrica goals on this site''s counter to pull into our conversions table.';

-- Dedup key: every imported conversion carries metadata->>''metrica_visit_id''.
-- Partial unique index prevents the same visit being imported twice across reruns.
CREATE UNIQUE INDEX IF NOT EXISTS uq_conversions_metrica_visit
  ON conversions ((metadata->>'metrica_visit_id'))
  WHERE metadata ? 'metrica_visit_id';
