-- Migration 022: store visitor_id for cross-session joins + engagement delta
-- visitor_id: anonymous localStorage-based ID from cross_session events.
--   Stored so we can look up previous sessions from the same visitor
--   without a full-table scan through the events JSONB.
-- engagement_delta_ms: current session engagement_active_ms minus previous
--   session engagement_active_ms for the same visitor. NULL for first visit.
-- engagement_delta_ratio: delta / previous (fraction); positive = more engaged
--   this visit. NULL for first visit or when previous engagement was 0.
ALTER TABLE session_features
  ADD COLUMN IF NOT EXISTS visitor_id              TEXT,
  ADD COLUMN IF NOT EXISTS engagement_delta_ms     INTEGER,
  ADD COLUMN IF NOT EXISTS engagement_delta_ratio  REAL;

CREATE INDEX IF NOT EXISTS idx_sf_visitor_id ON session_features (visitor_id);
