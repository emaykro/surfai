-- Migration: 016_metrica_client_id
-- Captures Yandex Metrica _ym_uid visitor cookie from the SDK context event
-- for cross-system session matching. Enables Offline Conversions API and
-- audience exports to Yandex Direct.
-- No changes to events_type_check.

ALTER TABLE session_features
  ADD COLUMN IF NOT EXISTS metrica_client_id TEXT;

CREATE INDEX IF NOT EXISTS idx_session_features_metrica_client_id
  ON session_features (metrica_client_id)
  WHERE metrica_client_id IS NOT NULL;

COMMENT ON COLUMN session_features.metrica_client_id IS
  '_ym_uid cookie value captured by SDK. Used for cross-system matching with Yandex Metrica Logs API and Offline Conversions API.';
