-- Migration: 003_dashboard_indexes
-- Indexes to support dashboard queries (session list, event filtering)

CREATE INDEX IF NOT EXISTS idx_sessions_last_seen ON sessions (last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_session_type ON events (session_id, type);
CREATE INDEX IF NOT EXISTS idx_events_session_ts ON events (session_id, ts ASC);
