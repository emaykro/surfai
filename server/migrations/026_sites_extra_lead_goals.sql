-- Migration: 026_sites_extra_lead_goals
-- Per-site override for which goal names should be pushed to Metrica as leads
-- in addition to the default `lead%` pattern. Used for sites where there is no
-- thank-you page and a js_sdk signal like `form_submit` is the actual lead.

ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS metrica_extra_lead_goals TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN sites.metrica_extra_lead_goals IS
  'Goal names (in addition to lead_*) whose conversions on this site should be pushed to Metrica Offline Conversions. Used for sites without a thank-you page where form_submit IS the lead.';
