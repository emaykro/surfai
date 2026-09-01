-- Migration 031: B2B ABM (Account-Based Marketing) and CRM Integrations

-- 1. Table for enriched corporate accounts
CREATE TABLE IF NOT EXISTS b2b_companies (
  id              SERIAL PRIMARY KEY,
  raw_org         TEXT NOT NULL UNIQUE,
  clean_name      TEXT NOT NULL,
  inn             TEXT,
  kpp             TEXT,
  ogrn            TEXT,
  address         TEXT,
  management_name TEXT,
  branch_type     TEXT,
  status          TEXT DEFAULT 'ACTIVE',
  revenue_tier    TEXT,
  raw_dadata      JSONB,
  enriched_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_b2b_companies_clean_name ON b2b_companies (clean_name);
CREATE INDEX IF NOT EXISTS idx_b2b_companies_inn ON b2b_companies (inn);

-- 2. Table for CRM integrations config
CREATE TABLE IF NOT EXISTS crm_integrations (
  id              SERIAL PRIMARY KEY,
  site_id         TEXT REFERENCES sites(site_id) ON DELETE CASCADE,
  project_id      TEXT REFERENCES projects(project_id) ON DELETE CASCADE,
  crm_type        TEXT NOT NULL, -- 'webhook', 'amocrm', 'bitrix24', 'telegram'
  name            TEXT NOT NULL,
  webhook_url     TEXT,
  api_token       TEXT,
  settings        JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crm_integrations_site ON crm_integrations (site_id, enabled);

-- 3. Table for CRM synced leads history
CREATE TABLE IF NOT EXISTS crm_synced_leads (
  id              SERIAL PRIMARY KEY,
  session_id      TEXT REFERENCES sessions(session_id) ON DELETE CASCADE,
  company_id      INTEGER REFERENCES b2b_companies(id) ON DELETE SET NULL,
  crm_type        TEXT NOT NULL,
  external_lead_id TEXT,
  payload         JSONB,
  status          TEXT NOT NULL DEFAULT 'success',
  error_message   TEXT,
  synced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crm_synced_leads_session ON crm_synced_leads (session_id);
CREATE INDEX IF NOT EXISTS idx_crm_synced_leads_company ON crm_synced_leads (company_id);
