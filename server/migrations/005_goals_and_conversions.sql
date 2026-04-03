-- Migration: 005_goals_and_conversions
-- Goal definitions and conversion tracking for ML labeling

-- Goal type enum
CREATE TYPE goal_type AS ENUM ('page_rule', 'js_sdk', 'datalayer_auto', 'backend_api');

-- Goals table: configurable conversion targets
CREATE TABLE IF NOT EXISTS goals (
  id                    SERIAL PRIMARY KEY,
  goal_id               TEXT NOT NULL UNIQUE DEFAULT gen_random_uuid()::text,
  tenant_id             TEXT NOT NULL DEFAULT 'default',
  name                  TEXT NOT NULL,
  type                  goal_type NOT NULL,
  rules                 JSONB NOT NULL DEFAULT '{}',
  is_primary            BOOLEAN NOT NULL DEFAULT false,
  attribution_window_ms BIGINT NOT NULL DEFAULT 1800000, -- 30 min default
  is_deleted            BOOLEAN NOT NULL DEFAULT false,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_goals_name_tenant UNIQUE (tenant_id, name)
);

CREATE INDEX idx_goals_tenant ON goals (tenant_id) WHERE NOT is_deleted;
CREATE INDEX idx_goals_type ON goals (type);

-- Conversions table: individual conversion events
CREATE TABLE IF NOT EXISTS conversions (
  id            SERIAL PRIMARY KEY,
  conversion_id TEXT NOT NULL UNIQUE DEFAULT gen_random_uuid()::text,
  session_id    TEXT NOT NULL,
  visitor_id    TEXT,
  goal_id       TEXT NOT NULL REFERENCES goals(goal_id),
  source        goal_type NOT NULL,
  value         DOUBLE PRECISION,
  metadata      JSONB DEFAULT '{}',
  ts            BIGINT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_conversions_session FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE INDEX idx_conversions_session ON conversions (session_id);
CREATE INDEX idx_conversions_goal ON conversions (goal_id);
CREATE INDEX idx_conversions_ts ON conversions (ts);
CREATE INDEX idx_conversions_visitor ON conversions (visitor_id) WHERE visitor_id IS NOT NULL;

-- Dedup index: prevent duplicate goal+session within 5s window
-- (enforced in application logic, index supports fast lookups)
CREATE INDEX idx_conversions_dedup ON conversions (session_id, goal_id, ts);

-- Add converted flag to session_features for ML labeling
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS converted BOOLEAN DEFAULT false;
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS conversion_count INTEGER DEFAULT 0;
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS primary_goal_converted BOOLEAN DEFAULT false;

CREATE INDEX idx_session_features_converted ON session_features (converted) WHERE converted = true;
