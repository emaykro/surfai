"use strict";

const { pool } = require("../db");
const { extractAllFeatures } = require("./extractors");
const { calculateBotScore } = require("./bot-scoring");
const geoip = require("./geoip");

/**
 * Fetch all events for a session from the database, compute features,
 * and upsert into session_features.
 *
 * @param {string} sessionId
 * @param {string} [projectId]
 * @param {string} [siteId]
 * @param {string} [clientIp] - Client IP for GeoIP enrichment. NOT stored
 *   anywhere; only the lookup result is persisted into geo_* columns.
 * @returns {object} computed features
 */
async function computeAndStore(sessionId, projectId, siteId, clientIp) {
  // Fetch all events for the session, ordered by timestamp
  const { rows: events } = await pool.query(
    `SELECT type, data, ts FROM events
     WHERE session_id = $1
     ORDER BY ts ASC`,
    [sessionId]
  );

  if (!events.length) return null;

  const features = extractAllFeatures(events);

  // Bot detection scoring
  const botSignalEvents = events.filter((e) => e.type === "bot_signals");
  const botResult = calculateBotScore(features, botSignalEvents);
  Object.assign(features, botResult);

  // GeoIP enrichment. Returns an object of nulls if the readers are not
  // loaded or the lookup fails — never throws. Merged directly into the
  // features map so it lands in the same UPSERT.
  if (clientIp) {
    Object.assign(features, geoip.lookup(clientIp));
  }

  // Build the upsert query dynamically from the features object
  const columns = [];
  const values = [sessionId]; // $1 = session_id
  const placeholders = [];
  const updates = [];
  let idx = 2;

  const FEATURE_COLUMNS = [
    "mouse_avg_velocity", "mouse_max_velocity", "mouse_avg_acceleration",
    "mouse_avg_jitter", "mouse_avg_curvature", "mouse_total_distance",
    "mouse_event_count", "mouse_velocity_1s", "mouse_velocity_5s", "mouse_velocity_30s",
    "scroll_max_depth", "scroll_avg_speed", "scroll_direction_changes",
    "scroll_pause_count", "scroll_fast_ratio", "scroll_slow_ratio", "scroll_event_count",
    "click_total", "click_avg_rhythm_ms", "click_rhythm_std",
    "click_spatial_clusters", "click_rage_count", "click_cta_ratio", "click_external_ratio",
    "form_total_interactions", "form_avg_fill_ms", "form_hesitation_count",
    "form_correction_count", "form_field_skip_rate", "form_submit_count", "form_abandon_count",
    "engagement_active_ms", "engagement_idle_ms", "engagement_active_ratio",
    "engagement_max_scroll", "engagement_readthrough", "engagement_micro_scrolls",
    "session_duration_ms", "session_page_count", "session_avg_nav_speed",
    "session_is_bounce", "session_is_hyper", "session_time_bucket",
    "ctx_traffic_source", "ctx_device_type", "ctx_browser", "ctx_os",
    "ctx_screen_w", "ctx_screen_h", "ctx_connection_type",
    "ctx_timezone", "ctx_tz_offset", "ctx_language_count",
    "ctx_viewport_w", "ctx_viewport_h", "ctx_dpr",
    "ctx_color_scheme", "ctx_reduced_motion",
    "ctx_hardware_concurrency", "ctx_device_memory",
    "ctx_referrer_host",
    "ctx_utm_source", "ctx_utm_medium", "ctx_utm_campaign",
    "ctx_utm_term", "ctx_utm_content",
    // GeoIP enrichment (added 2026-04-10, populated at ingest from client IP)
    "geo_country", "geo_region", "geo_city", "geo_timezone",
    "geo_latitude", "geo_longitude",
    "geo_asn", "geo_asn_org",
    "geo_is_datacenter", "geo_is_mobile_carrier",
    "cross_visit_number", "cross_return_24h", "cross_return_7d",
    "event_count",
    "bot_score", "bot_risk_level", "bot_signals", "is_bot",
  ];

  for (const col of FEATURE_COLUMNS) {
    let val = features[col];

    // Serialize JSONB columns
    if ((col.startsWith("mouse_velocity_") || col === "bot_signals") && val != null) {
      val = JSON.stringify(val);
    }

    columns.push(col);
    values.push(val !== undefined ? val : null);
    placeholders.push(`$${idx}`);
    updates.push(`${col} = $${idx}`);
    idx++;
  }

  // Project/site isolation
  if (projectId) {
    columns.push("project_id");
    values.push(projectId);
    placeholders.push(`$${idx}`);
    updates.push(`project_id = $${idx}`);
    idx++;
  }
  if (siteId) {
    columns.push("site_id");
    values.push(siteId);
    placeholders.push(`$${idx}`);
    updates.push(`site_id = $${idx}`);
    idx++;
  }

  // Always update computed_at
  updates.push("computed_at = NOW()");

  const sql = `
    INSERT INTO session_features (session_id, ${columns.join(", ")}, computed_at)
    VALUES ($1, ${placeholders.join(", ")}, NOW())
    ON CONFLICT (session_id) DO UPDATE SET
      ${updates.join(",\n      ")}
  `;

  await pool.query(sql, values);

  return features;
}

/**
 * Get stored features for a session.
 * @param {string} sessionId
 * @returns {object|null}
 */
async function getFeatures(sessionId) {
  const { rows } = await pool.query(
    "SELECT * FROM session_features WHERE session_id = $1",
    [sessionId]
  );
  return rows[0] || null;
}

module.exports = { computeAndStore, getFeatures };
