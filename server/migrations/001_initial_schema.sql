-- Migration: 001_initial_schema
-- Creates core tables for SURFAI event ingestion

-- Sessions table: one row per browser session
CREATE TABLE IF NOT EXISTS sessions (
  id            SERIAL PRIMARY KEY,
  session_id    TEXT NOT NULL UNIQUE,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sessions_session_id ON sessions (session_id);

-- Raw batches: stores each POST /api/events payload for audit/replay
CREATE TABLE IF NOT EXISTS raw_batches (
  id          SERIAL PRIMARY KEY,
  session_id  TEXT NOT NULL,
  sent_at     BIGINT NOT NULL,
  event_count INTEGER NOT NULL,
  payload     JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_raw_batches_session_id ON raw_batches (session_id);
CREATE INDEX idx_raw_batches_received_at ON raw_batches (received_at);

-- Events table: normalized individual events
CREATE TABLE IF NOT EXISTS events (
  id         SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('mouse', 'scroll', 'idle')),
  data       JSONB NOT NULL,
  ts         BIGINT NOT NULL,
  batch_id   INTEGER REFERENCES raw_batches(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_events_session_id ON events (session_id);
CREATE INDEX idx_events_type ON events (type);
CREATE INDEX idx_events_ts ON events (ts);
