-- Migration: 015_model_scoring
-- Adds CatBoost intent score columns to session_features.
-- Populated by the ml score job (python3 -m ml score), runs every 5 minutes.
-- No changes to SDK, ingest path, or events_type_check.

ALTER TABLE session_features
  ADD COLUMN IF NOT EXISTS model_prediction_score DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS model_scored_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_session_features_prediction_score
  ON session_features (model_prediction_score);

COMMENT ON COLUMN session_features.model_prediction_score IS
  'CatBoost conversion intent probability (0.0–1.0). NULL = not yet scored. Populated by ml score job.';
COMMENT ON COLUMN session_features.model_scored_at IS
  'Timestamp when model_prediction_score was last written.';
