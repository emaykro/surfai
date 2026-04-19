-- Migration: 014_yandex_metrica
-- Slice 1 of the Yandex Metrica enrichment pipeline. No changes to SDK,
-- ingest path, session_features, or events_type_check. Fully additive.
--
-- See vault/decisions/2026-04-19_yandex_metrica_enrichment.md for the
-- three-slice plan. This migration covers Slice 1 only.

-- 1. Map each SURFAI site to a Metrica counter_id (nullable).
ALTER TABLE sites ADD COLUMN IF NOT EXISTS yandex_counter_id BIGINT;

COMMENT ON COLUMN sites.yandex_counter_id IS
  'Yandex Metrica counter id used for attribution enrichment. NULL means the site is not wired to Metrica and the reconciliation worker should skip it.';

-- 2. Pre-populate the 5 production test sites. On local DBs (where these
--    domains do not exist) the UPDATE matches zero rows — harmless.
--    On prod it populates all five.
UPDATE sites SET yandex_counter_id = 98036553 WHERE domain = 'sequoiamusic.ru';
UPDATE sites SET yandex_counter_id = 22719187 WHERE domain = 'sluhnn.ru';
UPDATE sites SET yandex_counter_id = 30950066 WHERE domain = 'stefcom.ru';
UPDATE sites SET yandex_counter_id = 53764975 WHERE domain = 'дома-из-теплостен.рф';
UPDATE sites SET yandex_counter_id = 37804230 WHERE domain = 'химчистка-луч.рф';

-- 3. Daily reconciliation of Metrica totals vs SURFAI totals per site.
--    One row per (site, date) — UPSERT via the UNIQUE constraint.
CREATE TABLE IF NOT EXISTS metrica_daily_reconciliation (
  id                    SERIAL PRIMARY KEY,
  site_id               TEXT NOT NULL REFERENCES sites(site_id) ON DELETE CASCADE,
  date                  DATE NOT NULL,
  metrica_visits        INTEGER,
  metrica_users         INTEGER,
  metrica_pageviews     INTEGER,
  metrica_goals_total   INTEGER,
  surfai_sessions       INTEGER,
  surfai_conversions    INTEGER,
  divergence_ratio      NUMERIC(6,3),  -- metrica_visits / NULLIF(surfai_sessions, 0)
  fetched_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (site_id, date)
);

CREATE INDEX IF NOT EXISTS idx_metrica_recon_date ON metrica_daily_reconciliation(date DESC);
