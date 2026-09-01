-- Migration 030: Ad Optimization (Yandex Audiences Segment Types + GA4 Integration)

-- 1. Extend yandex_audiences_exports with segment_type ('hot_lookalike' vs 'negative_waste')
ALTER TABLE yandex_audiences_exports
  ADD COLUMN IF NOT EXISTS segment_type TEXT NOT NULL DEFAULT 'hot_lookalike';

CREATE INDEX IF NOT EXISTS idx_audiences_exports_site_type
  ON yandex_audiences_exports (site_id, segment_type, exported_at DESC);

-- 2. Add GA4 credentials to sites table
ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS ga4_measurement_id TEXT,
  ADD COLUMN IF NOT EXISTS ga4_api_secret TEXT;

-- 3. Table to track GA4 conversion exports
CREATE TABLE IF NOT EXISTS ga4_conversions_exports (
  id              SERIAL PRIMARY KEY,
  site_id         TEXT REFERENCES sites(site_id) ON DELETE CASCADE,
  session_id      TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  event_name      TEXT NOT NULL,
  score           DOUBLE PRECISION,
  client_id       TEXT NOT NULL,
  payload         JSONB NOT NULL,
  synced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ga4_exports_site_synced
  ON ga4_conversions_exports (site_id, synced_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ga4_exports_session_event
  ON ga4_conversions_exports (session_id, event_name);
