-- Migration 024: track Yandex Audiences segment exports
-- Each row records one segment uploaded per site so we can delete the old
-- segment before creating a new one (Audiences API has no replace operation).
CREATE TABLE IF NOT EXISTS yandex_audiences_exports (
  id              SERIAL PRIMARY KEY,
  site_id         TEXT REFERENCES sites(site_id) ON DELETE CASCADE,
  segment_id      TEXT        NOT NULL,
  counter_id      BIGINT      NOT NULL,
  session_count   INTEGER     NOT NULL,
  score_threshold REAL        NOT NULL,
  exported_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audiences_exports_site
  ON yandex_audiences_exports (site_id, exported_at DESC);
