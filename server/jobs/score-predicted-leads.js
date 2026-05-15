"use strict";

/**
 * Generate `lead_predicted` conversions from settled, high-score sessions.
 *
 * A session is eligible when:
 *   - model_prediction_score >= THRESHOLD                (predicted converter)
 *   - sessions.last_seen_at <= NOW() - STALENESS         (settled, score stable)
 *   - no existing lead_predicted conversion for it       (per-session dedup)
 *
 * Writes a conversions row (source=backend_api, goal=lead_predicted). The
 * existing metrica-conversions.js worker then pushes it to Metrica with
 * Target=predicted_lead (configured via goals.metrica_target_name in
 * migration 028).
 *
 * Lookback window: 24 h. Long enough to catch any session that just crossed
 * the staleness gate; short enough to keep the query cheap.
 *
 * Phase 8a — see vault/decisions/2026-05-15 phase 8 predictive export to metrica.md
 *
 * Usage:
 *   node server/jobs/score-predicted-leads.js
 *   node server/jobs/score-predicted-leads.js --dry-run
 *   node server/jobs/score-predicted-leads.js --threshold=0.5
 *
 * Exit codes:
 *   0  success
 *   1  unexpected error
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../../.env") });

const { pool } = require("../db");

const DEFAULT_THRESHOLD = Number(process.env.PREDICTED_LEAD_THRESHOLD || 0.7);
const STALENESS_MINUTES = 15;
const LOOKBACK_HOURS = 24;
const GOAL_NAME = "lead_predicted";

function parseArgs(argv) {
  const args = { dryRun: false, threshold: DEFAULT_THRESHOLD };
  for (const a of argv.slice(2)) {
    if (a === "--dry-run") args.dryRun = true;
    else if (a.startsWith("--threshold=")) {
      const n = Number(a.slice(12));
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        console.error(`Invalid --threshold (0..1): ${a.slice(12)}`);
        process.exit(1);
      }
      args.threshold = n;
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(1);
    }
  }
  return args;
}

async function loadPredictedGoal() {
  const { rows } = await pool.query(
    `SELECT goal_id, project_id FROM goals WHERE name = $1 AND NOT is_deleted LIMIT 1`,
    [GOAL_NAME]
  );
  return rows[0] || null;
}

async function findEligibleSessions(threshold) {
  // Eligible = scored above threshold, settled (last_seen_at older than
  // STALENESS_MINUTES), no existing lead_predicted conversion, within lookback.
  const { rows } = await pool.query(
    `SELECT
       sf.session_id,
       sf.site_id,
       sf.visitor_id,
       sf.model_prediction_score::float AS score,
       sess.last_seen_at,
       EXTRACT(EPOCH FROM sess.last_seen_at) * 1000 AS ts_ms
     FROM session_features sf
     JOIN sessions sess ON sess.session_id = sf.session_id
     WHERE sf.model_prediction_score >= $1
       AND sf.model_scored_at > NOW() - ($2 || ' hours')::interval
       AND sess.last_seen_at  <= NOW() - ($3 || ' minutes')::interval
       AND sess.last_seen_at  >  NOW() - ($2 || ' hours')::interval
       AND NOT EXISTS (
         SELECT 1 FROM conversions c
          JOIN goals g ON g.goal_id = c.goal_id
          WHERE c.session_id = sf.session_id
            AND g.name = $4
       )
     ORDER BY sf.model_prediction_score DESC`,
    [threshold, String(LOOKBACK_HOURS), String(STALENESS_MINUTES), GOAL_NAME]
  );
  return rows;
}

async function insertPredicted({ sessionId, visitorId, siteId, score, tsMs, goalId, projectId, dryRun }) {
  if (dryRun) {
    console.log(`  [dry-run] would INSERT lead_predicted session=${sessionId} score=${score.toFixed(4)} ts=${new Date(tsMs).toISOString()}`);
    return { inserted: true };
  }
  const { rows } = await pool.query(
    `INSERT INTO conversions
       (session_id, visitor_id, goal_id, source, ts, project_id, metadata)
     VALUES ($1, $2, $3, 'backend_api', $4, $5,
             jsonb_build_object(
               'predicted', true,
               'score', $6::float,
               'threshold', $7::float,
               'site_id', $8::text
             ))
     RETURNING id`,
    [sessionId, visitorId, goalId, Math.floor(tsMs), projectId, score, DEFAULT_THRESHOLD, siteId]
  );
  return { inserted: true, id: rows[0].id };
}

async function run({ dryRun, threshold }) {
  const goal = await loadPredictedGoal();
  if (!goal) {
    console.error(`Goal "${GOAL_NAME}" not found in goals table. Aborting.`);
    process.exit(1);
  }

  const eligible = await findEligibleSessions(threshold);
  if (eligible.length === 0) {
    console.log(`No new high-score settled sessions (threshold=${threshold}).`);
    return { generated: 0 };
  }

  console.log(`Found ${eligible.length} eligible session(s) at threshold=${threshold}.`);

  let generated = 0;
  for (const s of eligible) {
    await insertPredicted({
      sessionId: s.session_id,
      visitorId: s.visitor_id,
      siteId: s.site_id,
      score: s.score,
      tsMs: Number(s.ts_ms),
      goalId: goal.goal_id,
      projectId: goal.project_id,
      dryRun,
    });
    generated++;
  }
  return { generated };
}

(async () => {
  const args = parseArgs(process.argv);
  if (args.dryRun) console.log("[dry-run mode — no writes]");
  try {
    const { generated } = await run(args);
    console.log(`Done. generated=${generated}`);
  } catch (err) {
    console.error("Fatal:", err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
