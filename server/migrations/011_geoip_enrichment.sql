-- Migration: 011_geoip_enrichment
-- Add GeoIP-derived columns to session_features. Populated at ingest time
-- from the client IP via the ip-location-db (DB-IP Lite City + RouteViews ASN)
-- MMDB files. Raw client IP is NEVER stored — only these derivatives.
--
-- All columns are nullable — lookups can fail (private IPs, unknown ranges)
-- and historical sessions will stay NULL because no source IP was stored.

ALTER TABLE session_features ADD COLUMN IF NOT EXISTS geo_country            TEXT;
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS geo_region             TEXT;
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS geo_city               TEXT;
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS geo_timezone           TEXT;
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS geo_latitude           DOUBLE PRECISION;
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS geo_longitude          DOUBLE PRECISION;
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS geo_asn                INTEGER;
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS geo_asn_org            TEXT;
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS geo_is_datacenter      BOOLEAN;
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS geo_is_mobile_carrier  BOOLEAN;

-- Helpful indexes for dashboard aggregations by geography
CREATE INDEX IF NOT EXISTS idx_session_features_geo_country ON session_features (geo_country);
CREATE INDEX IF NOT EXISTS idx_session_features_geo_datacenter ON session_features (geo_is_datacenter) WHERE geo_is_datacenter = true;
