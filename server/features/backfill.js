"use strict";

/**
 * Backfill script — computes features for all existing sessions.
 *
 * Usage: node features/backfill.js [--batch-size=100]
 */

const { pool } = require("../db");
const { computeAndStore } = require("./store");

async function backfill() {
  const batchSizeArg = process.argv.find((a) => a.startsWith("--batch-size="));
  const batchSize = batchSizeArg ? parseInt(batchSizeArg.split("=")[1], 10) : 100;

  console.log("Starting feature backfill...");

  // Count total sessions
  const { rows: countRows } = await pool.query("SELECT COUNT(*)::int AS total FROM sessions");
  const total = countRows[0].total;
  console.log(`Found ${total} sessions to process`);

  let offset = 0;
  let processed = 0;
  let failed = 0;

  while (offset < total) {
    const { rows: sessions } = await pool.query(
      "SELECT session_id FROM sessions ORDER BY id ASC LIMIT $1 OFFSET $2",
      [batchSize, offset]
    );

    if (!sessions.length) break;

    for (const session of sessions) {
      try {
        const features = await computeAndStore(session.session_id);
        processed++;
        if (processed % 50 === 0 || processed === total) {
          console.log(`Progress: ${processed}/${total} (${Math.round((processed / total) * 100)}%)`);
        }
      } catch (err) {
        failed++;
        console.error(`Failed to compute features for session ${session.session_id}:`, err.message);
      }
    }

    offset += batchSize;
  }

  console.log(`\nBackfill complete: ${processed} processed, ${failed} failed out of ${total}`);
  await pool.end();
}

backfill().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
