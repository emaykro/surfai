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
 * @param {object} [uaHints] - Pre-parsed UA Client Hints from request headers
 *   (see features/ua-client-hints.js). NOT the raw user-agent — structured
 *   Sec-CH-UA-* fields. Merged directly into the features map.
 * @returns {object} computed features
 */
async function computeAndStore(sessionId, projectId, siteId, clientIp, uaHints) {
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

  // UA Client Hints (parsed by route handler, passed pre-computed here
  // so computeAndStore doesn't need access to request.headers).
  if (uaHints) {
    Object.assign(features, uaHints);
  }

  // Return-visit engagement delta: compare active_ms of this session
  // to the most recent prior session from the same visitor.
  // Null for first-time visitors or when previous session lacks engagement data.
  if (features.visitor_id && features.cross_visit_number > 1) {
    try {
      const { rows: prevRows } = await pool.query(
        `SELECT engagement_active_ms
         FROM session_features
         WHERE visitor_id = $1
           AND session_id != $2
           AND engagement_active_ms IS NOT NULL
         ORDER BY computed_at DESC
         LIMIT 1`,
        [features.visitor_id, sessionId]
      );
      if (prevRows.length) {
        const prev = prevRows[0].engagement_active_ms;
        const curr = features.engagement_active_ms;
        if (typeof curr === "number" && prev > 0) {
          features.engagement_delta_ms = curr - prev;
          features.engagement_delta_ratio = Math.round((curr / prev - 1) * 1000) / 1000;
        }
      }
    } catch {
      // Non-fatal: delta stays null if the lookup fails
    }
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
    "form_last_abandon_field_index",
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
    "metrica_client_id",
    // GeoIP enrichment (added 2026-04-10, populated at ingest from client IP)
    "geo_country", "geo_region", "geo_city", "geo_timezone",
    "geo_latitude", "geo_longitude",
    "geo_asn", "geo_asn_org",
    "geo_is_datacenter", "geo_is_mobile_carrier",
    // Performance / Web Vitals (added 2026-04-10, emitted once per session
    // via PerformanceCollector.beforeFlush)
    "perf_lcp", "perf_fcp", "perf_fid", "perf_inp", "perf_cls",
    "perf_ttfb", "perf_dom_interactive", "perf_dom_content_loaded",
    "perf_load_event", "perf_transfer_size",
    "perf_long_task_count", "perf_long_task_total_ms",
    "perf_slow_lcp", "perf_slow_inp", "perf_slow_fcp", "perf_slow_ttfb",
    // UA Client Hints (added 2026-04-10, parsed from Sec-CH-UA-* request headers)
    "uah_brand", "uah_brand_version", "uah_mobile",
    "uah_platform", "uah_platform_version",
    "uah_model", "uah_arch", "uah_bitness",
    "visitor_id",
    "cross_visit_number", "cross_return_24h", "cross_return_7d",
    "event_count",
    "bot_score", "bot_risk_level", "bot_signals", "is_bot",
    // Temporal enrichment (added 2026-04-25)
    "session_local_hour",
    // Copy intent signal (added 2026-04-25)
    "copy_count",
    // Tab visibility (added 2026-04-25)
    "tab_blur_count",
    "tab_hidden_ms",
    // Return-visit engagement delta (added 2026-04-25)
    "engagement_delta_ms",
    "engagement_delta_ratio",
    // Behavioral cluster label (added 2026-04-25, assigned by `python3 -m ml cluster`)
    "behavior_cluster",
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
