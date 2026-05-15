-- Migration: 028_goals_metrica_target_name
-- Per-goal override for the Metrica "Target" name used in Offline Conversions
-- CSV. When NULL the conversions worker falls back to METRICA_CONVERSION_TARGET
-- env (currently "lead"), preserving existing behavior for every lead_* goal
-- that has been pushing fine to date.
--
-- Phase 8a (predictive export) introduces a goal lead_predicted whose
-- conversions must be pushed as Target=predicted_lead so they do not pollute
-- the real-lead signal that Yandex Direct's Smart Bidding optimizes on.

ALTER TABLE goals
  ADD COLUMN IF NOT EXISTS metrica_target_name TEXT;

COMMENT ON COLUMN goals.metrica_target_name IS
  'Per-goal override of the Target name sent to Metrica Offline Conversions API. NULL falls back to METRICA_CONVERSION_TARGET env. Each Metrica counter must already have an offline goal configured with this exact name or the upload returns API_ERROR.';
