"use strict";

/**
 * Export behavioral segments to Yandex Audiences for Yandex Direct targeting & exclusion.
 *
 * Supported segment types:
 *   1. hot_lookalike:
 *      Sessions with model_prediction_score >= SCORE_THRESHOLD (default 0.7),
 *      metrica_client_id IS NOT NULL, not converted, and not bots.
 *      Used for Direct Look-alike & Retargeting.
 *
 *   2. negative_waste:
 *      Sessions identified as bots (is_bot = true), datacenter IPs (geo_is_datacenter = true),
 *      or extreme bounces (duration < 3s with 0 clicks & 0 scroll).
 *      Used in Direct for bid adjustment -100% (negative audience to stop ad waste).
 *
 * Usage:
 *   node server/jobs/audiences-export.js
 *   node server/jobs/audiences-export.js --type=all          # export both hot and negative (default)
 *   node server/jobs/audiences-export.js --type=hot          # export only hot lookalike
 *   node server/jobs/audiences-export.js --type=negative     # export only negative waste
 *   node server/jobs/audiences-export.js --score=0.7         # custom hot score threshold
 *   node server/jobs/audiences-export.js --dry-run           # print summary, no API calls
 *
 * Requires: YANDEX_AUDIENCES_TOKEN in environment (ym:audience:write scope).
 */

require("dotenv").config({ path: require("path").join(__dirname, "../../.env") });

const { pool } = require("../db.js");

const AUDIENCES_BASE = "https://api-audience.yandex.ru/v1/management";
const MIN_SEGMENT_COUNT = 100;
const DEFAULT_SCORE_THRESHOLD = 0.7;
// Negative targeting is a lasting exclusion, so it is scoped to a recent
// window rather than the whole history.
const NEGATIVE_LOOKBACK_DAYS = Number(process.env.AUDIENCES_NEGATIVE_LOOKBACK_DAYS || 90);

function getToken() {
  const t = process.env.YANDEX_AUDIENCES_TOKEN;
  if (!t) throw Object.assign(new Error("YANDEX_AUDIENCES_TOKEN is not set"), { code: "TOKEN_MISSING" });
  return t;
}

function authHeaders() {
  return { Authorization: `OAuth ${getToken()}` };
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function uploadCsv(csvContent, filename = "audience.csv", dryRun = false) {
  if (dryRun) {
    console.log(`[dry-run] would upload CSV (${csvContent.split("\n").length} rows)`);
    return "dry-run-segment-id";
  }

  const form = new FormData();
  form.append(
    "file",
    new Blob([csvContent], { type: "text/csv" }),
    filename
  );

  const res = await fetch(`${AUDIENCES_BASE}/segments/upload_csv_file`, {
    method: "POST",
    headers: authHeaders(),
    body: form,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Audiences upload failed ${res.status}: ${body}`);
  }

  const data = await res.json();
  return data.segment?.id ?? data.id;
}

async function confirmSegment(segmentId, name, counterId, dryRun = false) {
  if (dryRun) {
    console.log(`[dry-run] would confirm segment ${segmentId} → "${name}" on counter ${counterId}`);
    return;
  }

  const res = await fetch(
    `${AUDIENCES_BASE}/segment/client_id/${segmentId}/confirm`,
    {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ segment: { name, counter_id: counterId } }),
    }
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Audiences confirm failed ${res.status}: ${body}`);
  }
}

async function deleteSegment(segmentId, dryRun = false) {
  if (dryRun) {
    console.log(`[dry-run] would delete old segment ${segmentId}`);
    return;
  }

  const res = await fetch(`${AUDIENCES_BASE}/segment/${segmentId}`, {
    method: "DELETE",
    headers: authHeaders(),
  });

  // 404 is acceptable — segment may have been deleted manually
  if (!res.ok && res.status !== 404) {
    console.warn(`Warning: failed to delete segment ${segmentId} (${res.status})`);
  }
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function fetchSites(siteId = null) {
  const params = [];
  let where = "WHERE yandex_counter_id IS NOT NULL";
  if (siteId) {
    params.push(siteId);
    where += " AND site_id = $1";
  }

  const { rows } = await pool.query(
    `SELECT site_id, domain, yandex_counter_id
     FROM sites
     ${where}
     ORDER BY domain`,
    params
  );
  return rows;
}

/**
 * High-intent unconverted sessions for lookalike targeting.
 */
async function fetchHighIntentSessions(siteId, scoreThreshold = DEFAULT_SCORE_THRESHOLD) {
  const { rows } = await pool.query(
    `SELECT sf.metrica_client_id
     FROM session_features sf
     WHERE sf.site_id = $1
       AND sf.metrica_client_id IS NOT NULL
       AND sf.model_prediction_score >= $2
       AND (sf.is_bot IS NULL OR sf.is_bot = false)
       AND (sf.geo_is_datacenter IS NULL OR sf.geo_is_datacenter = false)
       AND NOT EXISTS (
         SELECT 1 FROM conversions c WHERE c.session_id = sf.session_id
       )`,
    [siteId, scoreThreshold]
  );
  return rows.map((r) => r.metrica_client_id);
}

/**
 * Negative / waste sessions (bots, datacenters, micro-bounces) for negative targeting (-100% bid adjustment).
 */
async function fetchNegativeWasteSessions(siteId, lookbackDays = NEGATIVE_LOOKBACK_DAYS) {
  const { rows } = await pool.query(
    `SELECT sf.metrica_client_id
     FROM session_features sf
     WHERE sf.site_id = $1
       AND sf.computed_at >= NOW() - ($2 || ' days')::interval
       AND sf.metrica_client_id IS NOT NULL
       AND (
         sf.is_bot = true
         OR sf.geo_is_datacenter = true
         OR sf.bot_risk_level = 'high'
         OR (
           -- Micro-bounce requires *measured* inactivity, never absent
           -- telemetry. COALESCE-ing NULL to 0 here would classify sessions
           -- whose engagement events simply never arrived (blocked tag, the
           -- passive-only event mix of the 2026-04-10 incident) as waste, and
           -- metrica_client_id identifies a device rather than a session — so
           -- a real prospect would be excluded from advertising for good.
           sf.session_duration_ms IS NOT NULL AND sf.session_duration_ms < 3000
           AND sf.click_total IS NOT NULL AND sf.click_total = 0
           AND sf.scroll_max_depth IS NOT NULL AND sf.scroll_max_depth = 0
         )
       )
       AND NOT EXISTS (
         SELECT 1 FROM conversions c WHERE c.session_id = sf.session_id
       )`,
    [siteId, String(lookbackDays)]
  );
  return rows.map((r) => r.metrica_client_id);
}

async function fetchPreviousSegment(siteId, segmentType = "hot_lookalike") {
  const { rows } = await pool.query(
    `SELECT segment_id FROM yandex_audiences_exports
     WHERE site_id = $1 AND segment_type = $2
     ORDER BY exported_at DESC
     LIMIT 1`,
    [siteId, segmentType]
  );
  return rows[0]?.segment_id ?? null;
}

async function recordExport(siteId, segmentId, counterId, sessionCount, scoreThreshold, segmentType = "hot_lookalike") {
  await pool.query(
    `INSERT INTO yandex_audiences_exports
       (site_id, segment_id, counter_id, session_count, score_threshold, segment_type)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [siteId, segmentId, counterId, sessionCount, scoreThreshold, segmentType]
  );
}

function buildAudiencesCsv(clientIds) {
  const unique = [...new Set(clientIds.filter(Boolean))];
  return unique.join("\n");
}

// ---------------------------------------------------------------------------
// Export Engine
// ---------------------------------------------------------------------------

async function exportSiteSegment({
  site,
  segmentType,
  scoreThreshold,
  dryRun = false,
}) {
  const isHot = segmentType === "hot_lookalike";
  const label = isHot ? "Hot Leads Look-alike" : "Negative Bots & Junk";
  const filename = isHot ? "hot_leads_lal.csv" : "negative_waste.csv";
  const segmentName = isHot
    ? `[SURFAI] Hot Leads LAL — ${site.domain} (Score >= ${scoreThreshold})`
    : `[SURFAI] Minus Bots & Junk — ${site.domain} (-100% Bid)`;

  console.log(`  Checking [${label}]...`);

  const rawIds = isHot
    ? await fetchHighIntentSessions(site.site_id, scoreThreshold)
    : await fetchNegativeWasteSessions(site.site_id);

  const unique = [...new Set(rawIds.filter(Boolean))];
  console.log(`    Found ${rawIds.length} sessions (${unique.length} unique client IDs)`);

  if (unique.length < MIN_SEGMENT_COUNT && !dryRun) {
    console.log(`    Skipping — need at least ${MIN_SEGMENT_COUNT} (have ${unique.length})`);
    return { status: "skipped", reason: "below_minimum", count: unique.length, segmentType };
  }

  const csv = buildAudiencesCsv(unique);

  // Upload and confirm the replacement BEFORE retiring the old segment.
  // Deleting first leaves the Direct campaign with no audience whenever the
  // upload fails (expired token, API 5xx): hot_lookalike retargeting stops
  // serving, and the negative_waste segment that applies a -100% bid
  // adjustment disappears, so spend resumes on known bot traffic.
  const prevSegmentId = await fetchPreviousSegment(site.site_id, segmentType);

  console.log(`    Uploading ${unique.length} client IDs to Yandex Audiences…`);
  const segmentId = await uploadCsv(csv, filename, dryRun);
  console.log(`    Upload accepted — segment ID: ${segmentId}`);

  await confirmSegment(segmentId, segmentName, site.yandex_counter_id, dryRun);
  console.log(`    Confirmed segment "${segmentName}"`);

  // Only now is the old segment redundant. A failure here is not fatal — it
  // leaves a stale extra segment, which is recoverable, unlike an empty one.
  if (prevSegmentId) {
    console.log(`    Retiring previous segment: ${prevSegmentId}`);
    try {
      await deleteSegment(prevSegmentId, dryRun);
    } catch (err) {
      console.warn(`    Could not delete previous segment ${prevSegmentId}: ${err.message}`);
    }
  }

  if (!dryRun) {
    await recordExport(site.site_id, segmentId, site.yandex_counter_id, unique.length, isHot ? scoreThreshold : 0, segmentType);
  }

  return {
    status: "exported",
    segmentId,
    segmentType,
    segmentName,
    count: unique.length,
  };
}

async function run({
  siteId = null,
  type = "all",
  scoreThreshold = DEFAULT_SCORE_THRESHOLD,
  dryRun = false,
} = {}) {
  if (!dryRun) {
    getToken(); // fail fast if token missing
  }

  const sites = await fetchSites(siteId);
  if (!sites.length) {
    console.log("No sites with yandex_counter_id configured. Nothing to export.");
    return { results: [] };
  }

  const exportTypes = type === "hot" ? ["hot_lookalike"]
    : type === "negative" ? ["negative_waste"]
    : ["hot_lookalike", "negative_waste"];

  console.log(`\n=== SURFAI Yandex Audiences Exporter ===`);
  console.log(`Sites: ${sites.length}, Types: ${exportTypes.join(", ")}, Threshold: ${scoreThreshold}, DryRun: ${dryRun}`);

  const results = [];

  for (const site of sites) {
    console.log(`\n[${site.domain}] counter=${site.yandex_counter_id}`);
    for (const segmentType of exportTypes) {
      try {
        const res = await exportSiteSegment({ site, segmentType, scoreThreshold, dryRun });
        results.push({ site: site.domain, site_id: site.site_id, ...res });
      } catch (err) {
        console.error(`    Error exporting ${segmentType} for ${site.domain}:`, err.message);
        results.push({ site: site.domain, site_id: site.site_id, segmentType, status: "error", error: err.message });
      }
    }
  }

  return { results };
}

// ---------------------------------------------------------------------------
// CLI Execution
// ---------------------------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  let type = "all";
  const typeArg = args.find((a) => a.startsWith("--type="));
  if (typeArg) type = typeArg.replace("--type=", "");

  const scoreArg = args.find((a) => a.startsWith("--score=") || a === "--score");
  const scoreThreshold = scoreArg
    ? parseFloat(args[args.indexOf(scoreArg) + (scoreArg.includes("=") ? 0 : 1)]?.replace("--score=", "") ?? DEFAULT_SCORE_THRESHOLD)
    : DEFAULT_SCORE_THRESHOLD;

  run({ type, scoreThreshold, dryRun })
    .then((res) => {
      console.log("\nAudiences export complete:", JSON.stringify(res, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error("Fatal error:", err.message);
      process.exit(err.code === "TOKEN_MISSING" ? 2 : 1);
    })
    .finally(() => pool.end());
}

module.exports = {
  run,
  fetchHighIntentSessions,
  fetchNegativeWasteSessions,
  buildAudiencesCsv,
  DEFAULT_SCORE_THRESHOLD,
  MIN_SEGMENT_COUNT,
  NEGATIVE_LOOKBACK_DAYS,
};
