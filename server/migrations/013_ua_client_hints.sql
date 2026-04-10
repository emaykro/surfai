-- Migration: 013_ua_client_hints
-- Add User-Agent Client Hints columns to session_features. Populated at
-- ingest time from the Sec-CH-UA-* HTTP headers sent by Chromium-based
-- browsers. More reliable than parsing the raw user-agent string.
--
-- All columns are nullable:
--   - Firefox and Safari don't send these headers at all
--   - High-entropy hints (platform_version, model, arch, bitness) only
--     arrive when the client site opts in via Permission-Policy
--   - Older sessions (before this migration) will stay NULL forever

ALTER TABLE session_features ADD COLUMN IF NOT EXISTS uah_brand             TEXT;
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS uah_brand_version     TEXT;
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS uah_mobile            BOOLEAN;
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS uah_platform          TEXT;
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS uah_platform_version  TEXT;
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS uah_model             TEXT;
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS uah_arch              TEXT;
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS uah_bitness           TEXT;
