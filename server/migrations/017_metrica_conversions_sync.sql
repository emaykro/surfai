-- Migration: 017_metrica_conversions_sync
-- Tracks which conversions have been pushed to Yandex Metrica Offline
-- Conversions API. NULL = not yet pushed. Populated by metrica-conversions job.

ALTER TABLE conversions
  ADD COLUMN IF NOT EXISTS metrica_synced_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_conversions_metrica_unsynced
  ON conversions (id)
  WHERE metrica_synced_at IS NULL;

COMMENT ON COLUMN conversions.metrica_synced_at IS
  'Timestamp when this conversion was pushed to Metrica Offline Conversions API. NULL = pending.';
