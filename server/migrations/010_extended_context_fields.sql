-- Migration: 010_extended_context_fields
-- Add extended context columns to session_features to match the new
-- ContextCollector fields introduced on 2026-04-10:
--   - timezone (IANA) + timezone offset
--   - viewport size + device pixel ratio
--   - color scheme preference + reduced-motion preference
--   - hardware concurrency + device memory
--   - referrer host + 5 UTM campaign params
--   - language count (derived from the full languages array in the event)
--
-- All columns are nullable — existing rows stay NULL and will never be
-- backfilled (no source data for them). CatBoost handles NaN natively.

ALTER TABLE session_features ADD COLUMN IF NOT EXISTS ctx_timezone            TEXT;
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS ctx_tz_offset           INTEGER;
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS ctx_language_count      INTEGER;
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS ctx_viewport_w          INTEGER;
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS ctx_viewport_h          INTEGER;
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS ctx_dpr                 DOUBLE PRECISION;
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS ctx_color_scheme        TEXT;
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS ctx_reduced_motion      BOOLEAN;
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS ctx_hardware_concurrency INTEGER;
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS ctx_device_memory       DOUBLE PRECISION;
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS ctx_referrer_host       TEXT;
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS ctx_utm_source          TEXT;
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS ctx_utm_medium          TEXT;
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS ctx_utm_campaign        TEXT;
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS ctx_utm_term            TEXT;
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS ctx_utm_content         TEXT;
