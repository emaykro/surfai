-- Migration 029: hot_lead_alerts table
-- Tracks sent Telegram alerts for high-intent B2B sessions to prevent duplicates
-- and maintain audit history.

CREATE TABLE IF NOT EXISTS hot_lead_alerts (
  id          SERIAL PRIMARY KEY,
  session_id  TEXT NOT NULL UNIQUE REFERENCES sessions(session_id) ON DELETE CASCADE,
  site_id     TEXT,
  project_id  TEXT,
  score       DOUBLE PRECISION,
  reason      TEXT NOT NULL,
  details     JSONB,
  alerted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hot_lead_alerts_alerted_at ON hot_lead_alerts (alerted_at);
CREATE INDEX IF NOT EXISTS idx_hot_lead_alerts_session_id ON hot_lead_alerts (session_id);
