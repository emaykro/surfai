"use strict";

/**
 * Import conversions FROM Metrica INTO SURFAI.
 *
 * For every site with `sites.metrica_imports` configured, polls the Metrica
 * Reports API for visits that reached each mapped Metrica goal in the last
 * IMPORT_WINDOW_DAYS days, matches them to SURFAI sessions via the
 * `_ym_uid` (metrica_client_id) cookie, and writes new rows into the
 * conversions table.
 *
 * Dedup is enforced by the unique partial index on
 * conversions.metadata->>'metrica_visit_id' (migration 027).
 *
 * Used right now for stefcom.ru calltracking goal 201469045 — calls happen
 * after the visit ends, so we cannot capture them in real time on the
 * client.
 *
 * Usage:
 *   node server/jobs/metrica-import-conversions.js
 *   node server/jobs/metrica-import-conversions.js --dry-run
 *   node server/jobs/metrica-import-conversions.js --days=30
 *
 * Exit codes:
 *   0  success
 *   1  unexpected error
 *   2  token missing/invalid
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../../.env") });

const { pool } = require("../db");
const { fetchVisitsByGoal } = require("../features/yandex-metrica");

const DEFAULT_IMPORT_WINDOW_DAYS = 14;

function parseArgs(argv) {
  const args = { dryRun: false, days: DEFAULT_IMPORT_WINDOW_DAYS };
  for (const a of argv.slice(2)) {
    if (a === "--dry-run") args.dryRun = true;
    else if (a.startsWith("--days=")) {
      const n = Number(a.slice(7));
      if (!Number.isInteger(n) || n < 1 || n > 90) {
        console.error(`Invalid --days (1..90): ${a.slice(7)}`);
        process.exit(1);
      }
      args.days = n;
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(1);
    }
  }
  return args;
}

function dateISO(d) { return d.toISOString().slice(0, 10); }

/**
 * For a given visitor (clientID) on a given site, find the session_id whose
 * session_features.computed_at is closest to the visit's dateTime, preferring
 * sessions that started on or before the call. Returns null if none.
 */
async function findSessionForVisitor(siteId, clientID, visitDateTime) {
  const visitTs = new Date(visitDateTime + "+0300"); // Metrica returns Moscow-local
  if (Number.isNaN(visitTs.getTime())) return null;

  const { rows } = await pool.query(
    `SELECT session_id
       FROM session_features
      WHERE site_id = $1
        AND metrica_client_id = $2
      ORDER BY ABS(EXTRACT(EPOCH FROM (computed_at - $3::timestamptz))) ASC
      LIMIT 1`,
    [siteId, clientID, visitTs.toISOString()]
  );
  return rows[0]?.session_id ?? null;
}

async function loadImportConfigs() {
  const { rows } = await pool.query(
    `SELECT s.site_id, s.domain, s.yandex_counter_id, s.metrica_imports, s.project_id
       FROM sites s
      WHERE jsonb_array_length(s.metrica_imports) > 0
        AND s.yandex_counter_id IS NOT NULL`
  );
  return rows;
}

async function loadGoalIdByName(name, projectId) {
  const { rows } = await pool.query(
    `SELECT goal_id FROM goals
      WHERE name = $1 AND project_id = $2 AND NOT is_deleted
      LIMIT 1`,
    [name, projectId]
  );
  return rows[0]?.goal_id ?? null;
}

async function insertConversion({ sessionId, visitorId, goalId, projectId, tsMs, visitKey, counterId, metricaGoalId, dryRun }) {
  if (dryRun) {
    console.log(`  [dry-run] would INSERT conversion session=${sessionId} goal=${goalId} key=${visitKey}`);
    return { inserted: false, dryRun: true };
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO conversions
         (session_id, visitor_id, goal_id, source, ts, project_id, metadata)
       VALUES ($1, $2, $3, 'backend_api', $4, $5,
               jsonb_build_object(
                 'metrica_visit_id', $6::text,
                 'metrica_counter_id', $7::bigint,
                 'metrica_goal_id', $8::bigint,
                 'imported_from_metrica', true
               ))
       RETURNING id`,
      [sessionId, visitorId, goalId, tsMs, projectId, visitKey, counterId, metricaGoalId]
    );
    return { inserted: true, id: rows[0].id };
  } catch (err) {
    if (err.code === "23505") return { inserted: false, duplicate: true };
    throw err;
  }
}

async function run({ dryRun, days }) {
  const dateTo = new Date();
  const dateFrom = new Date(dateTo.getTime() - days * 86400 * 1000);
  const date1 = dateISO(dateFrom);
  const date2 = dateISO(dateTo);

  const configs = await loadImportConfigs();
  if (configs.length === 0) {
    console.log("No sites with metrica_imports configured.");
    return { imported: 0, skipped: 0, duplicates: 0 };
  }

  let imported = 0, skipped = 0, duplicates = 0, errors = 0;

  for (const site of configs) {
    const imports = Array.isArray(site.metrica_imports) ? site.metrica_imports : [];
    for (const cfg of imports) {
      const metricaGoalId = Number(cfg.metrica_goal_id);
      const surfaiGoalName = String(cfg.surfai_goal_name || "");
      if (!metricaGoalId || !surfaiGoalName) {
        console.warn(`  ${site.domain}: invalid import config ${JSON.stringify(cfg)}`);
        continue;
      }

      const goalId = await loadGoalIdByName(surfaiGoalName, site.project_id);
      if (!goalId) {
        console.warn(`  ${site.domain}: SURFAI goal "${surfaiGoalName}" not found in project ${site.project_id}`);
        continue;
      }

      let visits;
      try {
        visits = await fetchVisitsByGoal(
          Number(site.yandex_counter_id),
          metricaGoalId,
          date1, date2
        );
      } catch (err) {
        console.error(`  ${site.domain} counter=${site.yandex_counter_id} goal=${metricaGoalId}: ${err.message} [${err.code}]`);
        errors++;
        if (err.code === "TOKEN_MISSING" || err.code === "TOKEN_INVALID") throw err;
        continue;
      }

      console.log(`  ${site.domain} counter=${site.yandex_counter_id} goal=${metricaGoalId}: ${visits.length} visit(s) in [${date1}..${date2}]`);

      for (const visit of visits) {
        const sessionId = await findSessionForVisitor(site.site_id, visit.clientID, visit.dateTime);
        if (!sessionId) {
          skipped++;
          continue;
        }
        const tsMs = new Date(visit.dateTime + "+0300").getTime();
        const result = await insertConversion({
          sessionId,
          visitorId: null,
          goalId,
          projectId: site.project_id,
          tsMs,
          visitKey: visit.visitKey,
          counterId: Number(site.yandex_counter_id),
          metricaGoalId,
          dryRun,
        });
        if (result.inserted) imported++;
        else if (result.duplicate) duplicates++;
      }
    }
  }

  return { imported, skipped, duplicates, errors };
}

(async () => {
  const args = parseArgs(process.argv);
  if (args.dryRun) console.log("[dry-run mode — no writes]");
  try {
    const r = await run(args);
    console.log(`Done. imported=${r.imported} duplicates=${r.duplicates} skipped_no_match=${r.skipped} errors=${r.errors || 0}`);
  } catch (err) {
    console.error("Fatal:", err.message);
    process.exit(err.code === "TOKEN_MISSING" || err.code === "TOKEN_INVALID" ? 2 : 1);
  } finally {
    await pool.end();
  }
})();
