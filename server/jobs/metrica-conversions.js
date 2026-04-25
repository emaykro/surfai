"use strict";

/**
 * Push unsynced conversions to Yandex Metrica Offline Conversions API.
 *
 * For each conversion that has metrica_client_id (_ym_uid) and belongs to a
 * site with a yandex_counter_id, sends a CSV row to the Metrica Management
 * API. Marks pushed rows with metrica_synced_at = NOW() so they are not
 * re-sent.
 *
 * Usage:
 *   node server/jobs/metrica-conversions.js            # push all pending
 *   node server/jobs/metrica-conversions.js --dry-run  # print CSV, no write
 *
 * Requires: YANDEX_METRICA_TOKEN in environment (read from ../.env).
 *
 * Target name: conversions are pushed with the SURFAI goal name as the Metrica
 * "Target". Operators should create goals with matching names in their Metrica
 * counters, or set METRICA_CONVERSION_TARGET to a fallback name.
 *
 * Exit codes:
 *   0  success (or dry-run)
 *   1  unexpected error
 *   2  token missing or invalid
 */

require("dotenv").config({ path: require("path").join(__dirname, "../../.env") });

const { pool } = require("../db.js");

const MGMT_BASE = "https://api-metrika.yandex.net";
const FALLBACK_TARGET = process.env.METRICA_CONVERSION_TARGET || "lead";

function getToken() {
  const t = process.env.YANDEX_METRICA_TOKEN;
  if (!t) throw Object.assign(new Error("YANDEX_METRICA_TOKEN is not set"), { code: "TOKEN_MISSING" });
  return t;
}

// Metrica offline conversions expect YYYY-MM-DD HH:MM:SS.
// The API interprets the time in the counter's timezone; for Russia-hosted
// counters that's MSK (UTC+3). We apply the offset here so the timestamps
// appear correct in Metrica reports.
function toMetricaDateTime(date) {
  const msk = new Date(date.getTime() + 3 * 60 * 60 * 1000);
  return msk.toISOString().replace("T", " ").slice(0, 19);
}

async function uploadToMetrica(counterId, csvContent, dryRun) {
  if (dryRun) {
    console.log(`[dry-run] counter ${counterId} — would POST:\n${csvContent}\n`);
    return;
  }

  const token = getToken();
  const form = new FormData();
  form.append("file", new Blob([csvContent], { type: "text/csv" }), "conversions.csv");

  const url = `${MGMT_BASE}/management/v1/counter/${counterId}/offline_conversions/upload`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `OAuth ${token}` },
    body: form,
  });

  const body = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(body); } catch { /* keep raw */ }

  if (!res.ok) {
    const err = new Error(
      `Metrica ${res.status} for counter ${counterId}: ${parsed?.message || body.slice(0, 200)}`
    );
    err.status = res.status;
    err.code = res.status === 401 ? "TOKEN_INVALID"
             : res.status === 429 ? "RATE_LIMIT"
             : "API_ERROR";
    throw err;
  }
  return parsed;
}

async function run({ dryRun = false } = {}) {
  // Fetch conversions that have a Metrica client ID and belong to a mapped site
  const { rows } = await pool.query(
    `SELECT
       c.id,
       c.ts,
       c.value,
       COALESCE(g.name, $1) AS target_name,
       sf.metrica_client_id,
       si.yandex_counter_id::bigint AS counter_id
     FROM conversions c
     JOIN sessions sess ON sess.session_id = c.session_id
     JOIN sites si      ON si.site_id = sess.site_id
     JOIN session_features sf ON sf.session_id = c.session_id
     LEFT JOIN goals g  ON g.goal_id = c.goal_id
     WHERE sf.metrica_client_id IS NOT NULL
       AND si.yandex_counter_id IS NOT NULL
       AND c.metrica_synced_at IS NULL
     ORDER BY si.yandex_counter_id, c.ts`,
    [FALLBACK_TARGET]
  );

  if (rows.length === 0) {
    console.log("No pending conversions to push.");
    return { pushed: 0 };
  }

  console.log(`Found ${rows.length} conversion(s) to push.`);

  // Group by Metrica counter
  const byCounter = new Map();
  for (const row of rows) {
    const key = String(row.counter_id);
    if (!byCounter.has(key)) byCounter.set(key, []);
    byCounter.get(key).push(row);
  }

  let totalPushed = 0;
  const pushedIds = [];

  for (const [counterId, counterRows] of byCounter) {
    const lines = ["ClientId,Target,DateTime,Price,Currency"];
    for (const row of counterRows) {
      const dt    = toMetricaDateTime(new Date(Number(row.ts)));
      const price = row.value != null ? Number(row.value).toFixed(2) : "";
      const cur   = row.value != null ? "RUB" : "";
      // Escape commas in target_name just in case
      const target = String(row.target_name).replace(/,/g, " ");
      lines.push(`${row.metrica_client_id},${target},${dt},${price},${cur}`);
    }
    const csv = lines.join("\n");

    try {
      await uploadToMetrica(Number(counterId), csv, dryRun);
      if (!dryRun) {
        counterRows.forEach(r => pushedIds.push(r.id));
        console.log(`  counter ${counterId}: pushed ${counterRows.length} row(s)`);
      }
      totalPushed += counterRows.length;
    } catch (err) {
      console.error(`  counter ${counterId}: ${err.message} [${err.code}]`);
      if (err.code === "TOKEN_INVALID" || err.code === "TOKEN_MISSING") throw err;
      // Other errors (rate limit, API error): log and continue with next counter
    }
  }

  // Mark pushed conversions as synced
  if (!dryRun && pushedIds.length > 0) {
    await pool.query(
      "UPDATE conversions SET metrica_synced_at = NOW() WHERE id = ANY($1::int[])",
      [pushedIds]
    );
  }

  return { pushed: totalPushed };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
(async () => {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  if (dryRun) console.log("[dry-run mode — no writes]");

  try {
    const { pushed } = await run({ dryRun });
    console.log(`Done. Pushed: ${pushed}`);
  } catch (err) {
    console.error("Fatal:", err.message);
    process.exit(err.code === "TOKEN_MISSING" || err.code === "TOKEN_INVALID" ? 2 : 1);
  } finally {
    await pool.end();
  }
})();
