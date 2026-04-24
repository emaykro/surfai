"use strict";

/**
 * Export high-intent unconverted sessions to Yandex Audiences for retargeting.
 *
 * For each site with a yandex_counter_id:
 *   1. Selects sessions where model_prediction_score >= SCORE_THRESHOLD,
 *      metrica_client_id IS NOT NULL, and no conversion recorded.
 *   2. Uploads a CSV of Metrica clientIds (_ym_uid values) to the
 *      Yandex Audiences API (ClientID segment type).
 *   3. Deletes the previous segment for that site before creating the new one.
 *   4. Records the new segment_id in yandex_audiences_exports.
 *
 * Usage:
 *   node server/jobs/audiences-export.js
 *   node server/jobs/audiences-export.js --score 0.8   # custom threshold
 *   node server/jobs/audiences-export.js --dry-run     # print CSV, no API calls
 *
 * Requires: YANDEX_AUDIENCES_TOKEN in environment (ym:audience:write scope).
 *
 * Exit codes:
 *   0  success (or dry-run or no-op when < MIN_LOOKALIKE_COUNT sessions)
 *   1  unexpected error
 *   2  token missing
 */

require("dotenv").config({ path: require("path").join(__dirname, "../../.env") });

const { pool } = require("../db.js");

const AUDIENCES_BASE = "https://api-audience.yandex.ru/v1/management";
const MIN_LOOKALIKE_COUNT = 100;
const DEFAULT_SCORE_THRESHOLD = 0.7;

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

async function uploadCsv(csvContent, dryRun) {
  if (dryRun) {
    console.log(`[dry-run] would upload CSV (${csvContent.split("\n").length} rows)`);
    return "dry-run-segment-id";
  }

  const form = new FormData();
  form.append(
    "file",
    new Blob([csvContent], { type: "text/csv" }),
    "lookalike.csv"
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

async function confirmSegment(segmentId, name, counterId, dryRun) {
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

async function deleteSegment(segmentId, dryRun) {
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

async function fetchSites() {
  const { rows } = await pool.query(
    `SELECT site_id, domain, yandex_counter_id
     FROM sites
     WHERE yandex_counter_id IS NOT NULL
     ORDER BY domain`
  );
  return rows;
}

async function fetchHighIntentSessions(siteId, scoreThreshold) {
  const { rows } = await pool.query(
    `SELECT sf.metrica_client_id
     FROM session_features sf
     WHERE sf.site_id = $1
       AND sf.metrica_client_id IS NOT NULL
       AND sf.model_prediction_score >= $2
       AND (sf.is_bot IS NULL OR sf.is_bot = false)
       AND NOT EXISTS (
         SELECT 1 FROM conversions c WHERE c.session_id = sf.session_id
       )`,
    [siteId, scoreThreshold]
  );
  return rows.map((r) => r.metrica_client_id);
}

async function fetchPreviousSegment(siteId) {
  const { rows } = await pool.query(
    `SELECT segment_id FROM yandex_audiences_exports
     WHERE site_id = $1
     ORDER BY exported_at DESC
     LIMIT 1`,
    [siteId]
  );
  return rows[0]?.segment_id ?? null;
}

async function recordExport(siteId, segmentId, counterId, sessionCount, scoreThreshold) {
  await pool.query(
    `INSERT INTO yandex_audiences_exports
       (site_id, segment_id, counter_id, session_count, score_threshold)
     VALUES ($1, $2, $3, $4, $5)`,
    [siteId, segmentId, counterId, sessionCount, scoreThreshold]
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run({ scoreThreshold = DEFAULT_SCORE_THRESHOLD, dryRun = false } = {}) {
  getToken(); // fail fast if token missing

  const sites = await fetchSites();
  if (!sites.length) {
    console.log("No sites with yandex_counter_id configured. Nothing to export.");
    return;
  }

  console.log(`Exporting lookalike audiences for ${sites.length} site(s) — score threshold: ${scoreThreshold}`);

  for (const site of sites) {
    console.log(`\n[${site.domain}] counter=${site.yandex_counter_id}`);

    const clientIds = await fetchHighIntentSessions(site.site_id, scoreThreshold);
    console.log(`  High-intent unconverted sessions with metrica_client_id: ${clientIds.length}`);

    if (clientIds.length < MIN_LOOKALIKE_COUNT) {
      console.log(`  Skipping — need at least ${MIN_LOOKALIKE_COUNT} (have ${clientIds.length})`);
      continue;
    }

    // Deduplicate (same visitor may have multiple sessions)
    const uniqueIds = [...new Set(clientIds)];
    console.log(`  Unique Metrica client IDs: ${uniqueIds.length}`);

    const csv = uniqueIds.join("\n");
    const segmentName = `SURFAI High Intent — ${site.domain}`;

    // Delete previous segment for this site before creating the new one
    const prevSegmentId = await fetchPreviousSegment(site.site_id);
    if (prevSegmentId) {
      console.log(`  Deleting previous segment: ${prevSegmentId}`);
      await deleteSegment(prevSegmentId, dryRun);
    }

    // Upload and confirm
    console.log(`  Uploading ${uniqueIds.length} client IDs…`);
    const segmentId = await uploadCsv(csv, dryRun);
    console.log(`  Upload accepted — temporary segment_id: ${segmentId}`);

    await confirmSegment(segmentId, segmentName, site.yandex_counter_id, dryRun);
    console.log(`  Confirmed segment "${segmentName}"`);

    if (!dryRun) {
      await recordExport(site.site_id, segmentId, site.yandex_counter_id, uniqueIds.length, scoreThreshold);
    }

    console.log(`  Done. Segment ${segmentId} ready for Yandex Direct retargeting.`);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const scoreArg = args.find((a) => a.startsWith("--score=") || a === "--score");
const scoreThreshold = scoreArg
  ? parseFloat(args[args.indexOf(scoreArg) + (scoreArg.includes("=") ? 0 : 1)]?.replace("--score=", "") ?? DEFAULT_SCORE_THRESHOLD)
  : DEFAULT_SCORE_THRESHOLD;

run({ scoreThreshold, dryRun })
  .then(() => {
    console.log("\nAudiences export complete.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("Fatal error:", err.message);
    process.exit(err.code === "TOKEN_MISSING" ? 2 : 1);
  })
  .finally(() => pool.end());
