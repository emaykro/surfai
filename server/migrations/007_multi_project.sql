-- Migration: 007_multi_project
-- Multi-project data model: projects, sites, project/site isolation on all tables

-- Required for gen_random_bytes() used in site_key generation
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =========================================================================
-- 1. New tables: projects and sites
-- =========================================================================

CREATE TABLE IF NOT EXISTS projects (
  id          SERIAL PRIMARY KEY,
  project_id  TEXT NOT NULL UNIQUE DEFAULT gen_random_uuid()::text,
  name        TEXT NOT NULL,
  vertical    TEXT NOT NULL CHECK (vertical IN (
    'ecommerce', 'services', 'leadgen', 'education', 'b2b', 'other'
  )),
  status      TEXT NOT NULL DEFAULT 'setup' CHECK (status IN (
    'setup', 'active', 'paused', 'archived'
  )),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_projects_status ON projects (status) WHERE status != 'archived';

CREATE TABLE IF NOT EXISTS sites (
  id              SERIAL PRIMARY KEY,
  site_id         TEXT NOT NULL UNIQUE DEFAULT gen_random_uuid()::text,
  project_id      TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  domain          TEXT NOT NULL,
  site_key        TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex'),
  allowed_origins TEXT[] NOT NULL DEFAULT '{}',
  install_method  TEXT NOT NULL DEFAULT 'gtm' CHECK (install_method IN (
    'gtm', 'direct_script', 'server_only'
  )),
  install_status  TEXT NOT NULL DEFAULT 'pending' CHECK (install_status IN (
    'pending', 'verified', 'error'
  )),
  last_event_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sites_project ON sites (project_id);
CREATE INDEX idx_sites_site_key ON sites (site_key);
CREATE INDEX idx_sites_domain ON sites (domain);

-- =========================================================================
-- 2. Extend existing tables with project_id and site_id (nullable for backcompat)
-- =========================================================================

-- sessions
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS site_id TEXT;

-- raw_batches
ALTER TABLE raw_batches ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE raw_batches ADD COLUMN IF NOT EXISTS site_id TEXT;

-- events
ALTER TABLE events ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS site_id TEXT;

-- session_features
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS site_id TEXT;

-- goals: add project_id alongside existing tenant_id (deprecate tenant_id later)
ALTER TABLE goals ADD COLUMN IF NOT EXISTS project_id TEXT;

-- conversions
ALTER TABLE conversions ADD COLUMN IF NOT EXISTS project_id TEXT;

-- =========================================================================
-- 3. Indexes for project/site filtering
-- =========================================================================

CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions (project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_site ON sessions (site_id);
CREATE INDEX IF NOT EXISTS idx_events_project ON events (project_id);
CREATE INDEX IF NOT EXISTS idx_events_site ON events (site_id);
CREATE INDEX IF NOT EXISTS idx_session_features_project ON session_features (project_id);
CREATE INDEX IF NOT EXISTS idx_raw_batches_project ON raw_batches (project_id);
CREATE INDEX IF NOT EXISTS idx_goals_project ON goals (project_id);
CREATE INDEX IF NOT EXISTS idx_conversions_project ON conversions (project_id);

-- =========================================================================
-- 4. Backfill: create "default" project and "localhost" site for existing data
-- =========================================================================

INSERT INTO projects (project_id, name, vertical, status)
VALUES ('default', 'Default Project', 'other', 'active')
ON CONFLICT (project_id) DO NOTHING;

INSERT INTO sites (site_id, project_id, domain, site_key, allowed_origins, install_method, install_status)
VALUES ('default', 'default', 'localhost', 'default_dev_key_0000', '{http://localhost:3000}', 'direct_script', 'verified')
ON CONFLICT (site_id) DO NOTHING;

-- Backfill existing rows to default project/site
UPDATE sessions SET project_id = 'default', site_id = 'default' WHERE project_id IS NULL;
UPDATE raw_batches SET project_id = 'default', site_id = 'default' WHERE project_id IS NULL;
UPDATE events SET project_id = 'default', site_id = 'default' WHERE project_id IS NULL;
UPDATE session_features SET project_id = 'default', site_id = 'default' WHERE project_id IS NULL;
UPDATE goals SET project_id = 'default' WHERE project_id IS NULL;
UPDATE conversions SET project_id = 'default' WHERE project_id IS NULL;
