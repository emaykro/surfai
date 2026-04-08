-- Migration: 008_bot_detection
-- Bot detection and fraud scoring columns on session_features

ALTER TABLE session_features ADD COLUMN IF NOT EXISTS bot_score       DOUBLE PRECISION;
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS bot_risk_level  TEXT CHECK (bot_risk_level IN ('low', 'medium', 'high'));
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS bot_signals     JSONB;
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS is_bot          BOOLEAN DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_session_features_bot_score ON session_features (bot_score);
CREATE INDEX IF NOT EXISTS idx_session_features_is_bot ON session_features (is_bot) WHERE is_bot = true;
CREATE INDEX IF NOT EXISTS idx_session_features_bot_risk ON session_features (bot_risk_level);
