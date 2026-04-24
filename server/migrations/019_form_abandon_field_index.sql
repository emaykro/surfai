-- Migration 019: field index at which the user last abandoned a form
-- 0-based ordinal from the form event's fieldIndex.
-- NULL when no abandon events exist for the session.
ALTER TABLE session_features
  ADD COLUMN IF NOT EXISTS form_last_abandon_field_index SMALLINT;
