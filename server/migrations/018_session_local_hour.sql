-- Migration 018: local hour of day in the user's own timezone
-- Derived at feature-extraction time from context event ts + ctx_timezone.
-- 0–23 SMALLINT; NULL when ctx_timezone is missing or invalid.
ALTER TABLE session_features
  ADD COLUMN IF NOT EXISTS session_local_hour SMALLINT;
