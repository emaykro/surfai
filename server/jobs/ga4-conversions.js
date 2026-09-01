"use strict";

/**
 * Push predicted and real conversions to Google Analytics 4 via Measurement Protocol v2.
 *
 * For each site with ga4_measurement_id and ga4_api_secret configured:
 *   1. Fetches sessions with model_prediction_score >= PREDICTED_SCORE_THRESHOLD (default 0.7)
 *      or real conversions that haven't been pushed to GA4 yet.
 *   2. Sends events to GA4 Measurement Protocol:
 *      - surfai_predicted_lead (for high intent non-converted visitors)
 *      - surfai_real_lead (for confirmed conversions)
 *   3. Records sent events in ga4_conversions_exports table.
 *
 * Usage:
 *   node server/jobs/ga4-conversions.js
 *   node server/jobs/ga4-conversions.js --dry-run
 *   node server/jobs/ga4-conversions.js --threshold=0.7
 *   node server/jobs/ga4-conversions.js --site=<site_id>
 */

require("dotenv").config({ path: require("path").join(__dirname, "../../.env") });

const { pool } = require("../db.js");

const GA4_ENDPOINT = "https://www.google-analytics.com/mp/collect";
const GA4_DEBUG_ENDPOINT = "https://www.google-analytics.com/debug/mp/collect";
const DEFAULT_PREDICTED_THRESHOLD = Number(process.env.GA4_PREDICTED_THRESHOLD || 0.7);
// GA4 Measurement Protocol rejects events stamped more than 72 hours in the
// past, so there is no point selecting sessions we cannot honestly date.
const GA4_MAX_EVENT_AGE_HOURS = 72;
// Optional flat value per predicted lead, in RUB. Unset means no `value` is
// sent at all — preferable to inventing one from the model score.
const LEAD_VALUE_RUB = process.env.GA4_LEAD_VALUE_RUB
  ? Number(process.env.GA4_LEAD_VALUE_RUB)
  : undefined;
const DEFAULT_LOOKBACK_HOURS = Math.min(
  Number(process.env.GA4_LOOKBACK_HOURS || GA4_MAX_EVENT_AGE_HOURS),
  GA4_MAX_EVENT_AGE_HOURS
);

function buildGa4Payload({ clientId, eventName, score, value, currency = "RUB", engagementTimeMs, occurredAt, customParams = {} }) {
  const params = {
    score: score != null ? Number(score) : undefined,
    // `value` is real money to GA4: value-based bidding will optimise spend
    // against it. A model probability is not a monetary amount, so nothing is
    // reported unless an operator sets a deliberate per-lead value. currency
    // only travels with an actual value.
    value: value != null ? Number(value) : undefined,
    currency: value != null ? currency : undefined,
    engagement_time_msec: engagementTimeMs ? Math.round(engagementTimeMs) : 1000,
    ...customParams,
  };

  // Remove undefined properties
  for (const k of Object.keys(params)) {
    if (params[k] === undefined) delete params[k];
  }

  const body = {
    client_id: String(clientId || "anonymous_visitor"),
    non_personalized_ads: false,
    events: [
      {
        name: eventName,
        params,
      },
    ],
  };

  // Without an explicit timestamp GA4 dates the event at receipt, so a
  // backfill lands as a spike of conversions that happened today. Stamp the
  // session's own time whenever it is inside GA4's accepted window.
  if (occurredAt) {
    const ms = occurredAt instanceof Date ? occurredAt.getTime() : new Date(occurredAt).getTime();
    const ageMs = Date.now() - ms;
    if (Number.isFinite(ms) && ageMs >= 0 && ageMs < GA4_MAX_EVENT_AGE_HOURS * 3600_000) {
      body.timestamp_micros = String(ms * 1000);
    }
  }

  return body;
}

async function sendGa4Event({ measurementId, apiSecret, payload, dryRun = false, debug = false }) {
  if (dryRun) {
    console.log(`[dry-run] GA4 ${measurementId} would receive payload:`, JSON.stringify(payload));
    return { ok: true, dryRun: true };
  }

  const endpoint = debug ? GA4_DEBUG_ENDPOINT : GA4_ENDPOINT;
  const url = `${endpoint}?measurement_id=${encodeURIComponent(measurementId)}&api_secret=${encodeURIComponent(apiSecret)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GA4 API error ${res.status}: ${text}`);
  }

  if (debug) {
    const json = await res.json();
    return { ok: true, debugResults: json };
  }

  return { ok: true };
}

async function fetchGa4Sites(siteId = null) {
  const params = [];
  let where = "WHERE ga4_measurement_id IS NOT NULL AND ga4_api_secret IS NOT NULL";
  if (siteId) {
    params.push(siteId);
    where += " AND site_id = $1";
  }

  const { rows } = await pool.query(
    `SELECT site_id, domain, ga4_measurement_id, ga4_api_secret
     FROM sites
     ${where}
     ORDER BY domain`,
    params
  );
  return rows;
}

async function fetchPendingPredictedLeads(siteId, scoreThreshold, lookbackHours = DEFAULT_LOOKBACK_HOURS) {
  const query = `
    SELECT
      sf.session_id,
      sf.site_id,
      sf.visitor_id,
      sf.computed_at,
      sf.model_prediction_score::float AS score,
      sf.session_duration_ms,
      sf.ctx_utm_source,
      sf.ctx_utm_medium,
      sf.ctx_utm_campaign,
      sf.geo_city,
      sf.geo_country
    FROM session_features sf
    WHERE sf.site_id = $1
      AND sf.computed_at >= NOW() - ($3 || ' hours')::interval
      AND sf.model_prediction_score >= $2
      AND (sf.is_bot IS NULL OR sf.is_bot = false)
      AND (sf.geo_is_datacenter IS NULL OR sf.geo_is_datacenter = false)
      AND NOT EXISTS (
        SELECT 1 FROM conversions c WHERE c.session_id = sf.session_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM ga4_conversions_exports ge
        WHERE ge.session_id = sf.session_id AND ge.event_name = 'surfai_predicted_lead'
      )
    ORDER BY sf.computed_at DESC
    LIMIT 200;
  `;
  const { rows } = await pool.query(query, [siteId, scoreThreshold, String(lookbackHours)]);
  return rows;
}

async function recordGa4Export(siteId, sessionId, eventName, score, clientId, payload) {
  await pool.query(
    `INSERT INTO ga4_conversions_exports
       (site_id, session_id, event_name, score, client_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (session_id, event_name) DO NOTHING`,
    [siteId, sessionId, eventName, score, clientId, JSON.stringify(payload)]
  );
}

async function run({
  siteId = null,
  threshold = DEFAULT_PREDICTED_THRESHOLD,
  dryRun = false,
  debug = false,
} = {}) {
  const sites = await fetchGa4Sites(siteId);
  if (!sites.length) {
    console.log("No sites with GA4 credentials configured. (Configure ga4_measurement_id and ga4_api_secret)");
    return { synced: 0, results: [] };
  }

  console.log(`\n=== SURFAI GA4 Measurement Protocol Exporter ===`);
  console.log(`Sites: ${sites.length}, Threshold: ${threshold}, DryRun: ${dryRun}`);

  const results = [];
  let totalSynced = 0;

  for (const site of sites) {
    console.log(`\n[${site.domain}] GA4: ${site.ga4_measurement_id}`);

    const leads = await fetchPendingPredictedLeads(site.site_id, threshold);
    console.log(`  Found ${leads.length} unsynced predicted lead(s)`);

    let siteSynced = 0;

    for (const lead of leads) {
      const clientId = lead.visitor_id || `surfai_${lead.session_id.slice(0, 16)}`;
      const payload = buildGa4Payload({
        clientId,
        eventName: "surfai_predicted_lead",
        score: lead.score,
        value: LEAD_VALUE_RUB,
        engagementTimeMs: lead.session_duration_ms,
        occurredAt: lead.computed_at,
        customParams: {
          traffic_source: lead.ctx_utm_source || "unknown",
          traffic_medium: lead.ctx_utm_medium || "unknown",
          campaign: lead.ctx_utm_campaign || "unknown",
          location_city: lead.geo_city || "unknown",
        },
      });

      try {
        await sendGa4Event({
          measurementId: site.ga4_measurement_id,
          apiSecret: site.ga4_api_secret,
          payload,
          dryRun,
          debug,
        });

        // The debug endpoint validates payloads and ingests nothing, so a
        // debug run must not mark the session as exported — the unique index
        // on (session_id, event_name) would then hide it from every real run.
        if (!dryRun && !debug) {
          await recordGa4Export(
            site.site_id,
            lead.session_id,
            "surfai_predicted_lead",
            lead.score,
            clientId,
            payload
          );
        }

        if (!debug) {
          siteSynced++;
          totalSynced++;
        }
      } catch (err) {
        console.error(`  Error sending session ${lead.session_id} to GA4:`, err.message);
      }
    }

    results.push({
      site_id: site.site_id,
      domain: site.domain,
      synced_count: siteSynced,
    });
  }

  return { synced: totalSynced, results };
}

// ---------------------------------------------------------------------------
// CLI Execution
// ---------------------------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const debug = args.includes("--debug");

  const threshArg = args.find((a) => a.startsWith("--threshold="));
  const threshold = threshArg ? parseFloat(threshArg.replace("--threshold=", "")) : DEFAULT_PREDICTED_THRESHOLD;

  const siteArg = args.find((a) => a.startsWith("--site="));
  const siteId = siteArg ? siteArg.replace("--site=", "") : null;

  run({ siteId, threshold, dryRun, debug })
    .then((res) => {
      console.log("\nGA4 export complete:", JSON.stringify(res, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error("Fatal error:", err.message);
      process.exit(1);
    })
    .finally(() => pool.end());
}

module.exports = {
  run,
  buildGa4Payload,
  sendGa4Event,
  fetchPendingPredictedLeads,
  DEFAULT_PREDICTED_THRESHOLD,
  DEFAULT_LOOKBACK_HOURS,
  GA4_MAX_EVENT_AGE_HOURS,
  LEAD_VALUE_RUB,
};
