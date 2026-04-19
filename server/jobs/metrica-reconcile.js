"use strict";

/**
 * Daily reconciliation: Yandex Metrica totals vs SURFAI totals per site.
 *
 * Writes one row per (site, date) into metrica_daily_reconciliation.
 * Safe to re-run — UPSERTs on (site_id, date).
 *
 * Usage:
 *   node server/jobs/metrica-reconcile.js                      # yesterday, all sites
 *   node server/jobs/metrica-reconcile.js --date=2026-04-18    # specific day
 *   node server/jobs/metrica-reconcile.js --site=sluhnn.ru     # one site only
 *   node server/jobs/metrica-reconcile.js --dry-run            # print, do not write
 *   node server/jobs/metrica-reconcile.js --verbose            # extra logs
 *
 * The binary ignores YANDEX_METRICA_ENABLED — that flag exists to gate
 * the *scheduled* run (cron/systemd). Manual invocation is always allowed
 * as long as YANDEX_METRICA_TOKEN is present.
 *
 * Exit codes:
 *   0  all sites reconciled (or dry-run successful)
 *   1  config error (missing token, bad args)
 *   2  at least one site failed API fetch
 *   3  database error
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../../.env") });

const { pool } = require("../db");
const { fetchDailyStats } = require("../features/yandex-metrica");

function parseArgs(argv) {
  const args = { dryRun: false, verbose: false, site: null, date: null };
  for (const a of argv.slice(2)) {
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--verbose" || a === "-v") args.verbose = true;
    else if (a.startsWith("--site=")) args.site = a.slice(7);
    else if (a.startsWith("--date=")) args.date = a.slice(7);
    else if (a === "--help" || a === "-h") args.help = true;
    else {
      console.error(`Unknown arg: ${a}`);
      args.help = true;
    }
  }
  if (!args.date) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    args.date = d.toISOString().slice(0, 10);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    console.error(`Invalid --date (expected YYYY-MM-DD): ${args.date}`);
    args.help = true;
  }
  return args;
}

function printHelp() {
  console.log(`metrica-reconcile — daily Metrica/SURFAI reconciliation
Options:
  --date=YYYY-MM-DD   day to reconcile (default: yesterday UTC)
  --site=<domain>     reconcile only this site
  --dry-run           print what would be written, do not touch DB
  --verbose           extra logs
`);
}

/**
 * Fetch SURFAI-side counts for a single site for a specific date.
 * Uses first_seen_at (sessions) and created_at (conversions).
 */
async function fetchSurfaiCounts(siteId, dateISO) {
  const { rows } = await pool.query(
    `
    SELECT
      (SELECT COUNT(*) FROM sessions
         WHERE site_id = $1
           AND first_seen_at >= $2::date
           AND first_seen_at  < $2::date + INTERVAL '1 day') AS sessions,
      (SELECT COUNT(*) FROM conversions c
         JOIN sessions s ON s.session_id = c.session_id
         WHERE s.site_id = $1
           AND c.created_at >= $2::date
           AND c.created_at  < $2::date + INTERVAL '1 day') AS conversions
    `,
    [siteId, dateISO]
  );
  return {
    sessions: Number(rows[0].sessions) || 0,
    conversions: Number(rows[0].conversions) || 0,
  };
}

async function upsertReconciliation(row) {
  await pool.query(
    `
    INSERT INTO metrica_daily_reconciliation (
      site_id, date,
      metrica_visits, metrica_users, metrica_pageviews, metrica_goals_total,
      surfai_sessions, surfai_conversions,
      divergence_ratio, fetched_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
    ON CONFLICT (site_id, date) DO UPDATE SET
      metrica_visits      = EXCLUDED.metrica_visits,
      metrica_users       = EXCLUDED.metrica_users,
      metrica_pageviews   = EXCLUDED.metrica_pageviews,
      metrica_goals_total = EXCLUDED.metrica_goals_total,
      surfai_sessions     = EXCLUDED.surfai_sessions,
      surfai_conversions  = EXCLUDED.surfai_conversions,
      divergence_ratio    = EXCLUDED.divergence_ratio,
      fetched_at          = EXCLUDED.fetched_at
    `,
    [
      row.site_id,
      row.date,
      row.metrica_visits,
      row.metrica_users,
      row.metrica_pageviews,
      row.metrica_goals_total,
      row.surfai_sessions,
      row.surfai_conversions,
      row.divergence_ratio,
    ]
  );
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (!process.env.YANDEX_METRICA_TOKEN) {
    console.error("YANDEX_METRICA_TOKEN is not set — aborting.");
    process.exit(1);
  }

  // Load sites that have a Metrica counter wired up.
  const siteFilter = args.site ? " AND domain = $1" : "";
  const params = args.site ? [args.site] : [];
  const { rows: sites } = await pool.query(
    `SELECT site_id, domain, yandex_counter_id
       FROM sites
      WHERE yandex_counter_id IS NOT NULL${siteFilter}
      ORDER BY domain`,
    params
  );

  if (!sites.length) {
    console.log(
      args.site
        ? `No site "${args.site}" with yandex_counter_id set — nothing to do.`
        : "No sites with yandex_counter_id set — nothing to do."
    );
    await pool.end();
    return 0;
  }

  console.log(
    `Reconciling ${sites.length} site(s) for date=${args.date}${args.dryRun ? " (DRY RUN)" : ""}`
  );

  let failures = 0;
  const results = [];

  for (const site of sites) {
    const prefix = `[${site.domain}]`;
    try {
      const counterId = Number(site.yandex_counter_id);
      const [metrica, surfai] = await Promise.all([
        fetchDailyStats(counterId, args.date),
        fetchSurfaiCounts(site.site_id, args.date),
      ]);
      const divergence =
        surfai.sessions > 0
          ? Number((metrica.visits / surfai.sessions).toFixed(3))
          : null;

      const row = {
        site_id: site.site_id,
        date: args.date,
        metrica_visits: metrica.visits,
        metrica_users: metrica.users,
        metrica_pageviews: metrica.pageviews,
        metrica_goals_total: metrica.goalsTotal,
        surfai_sessions: surfai.sessions,
        surfai_conversions: surfai.conversions,
        divergence_ratio: divergence,
      };
      results.push({ domain: site.domain, ...row });

      console.log(
        `${prefix} metrica: visits=${metrica.visits} users=${metrica.users} pageviews=${metrica.pageviews} goals=${metrica.goalsTotal}` +
          ` | surfai: sessions=${surfai.sessions} conversions=${surfai.conversions}` +
          ` | ratio=${divergence ?? "n/a"}`
      );

      if (!args.dryRun) {
        await upsertReconciliation(row);
      }
    } catch (err) {
      failures++;
      const code = err.code ? ` [${err.code}]` : "";
      console.error(`${prefix} FAILED${code}: ${err.message}`);
      if (args.verbose && err.stack) console.error(err.stack);
      // Keep going — one failed site must not block the others.
    }
  }

  if (args.dryRun) {
    console.log("\n--- dry-run summary ---");
    console.log(JSON.stringify(results, null, 2));
  }

  await pool.end();
  if (failures > 0) {
    console.error(`Done with ${failures} failure(s) out of ${sites.length}.`);
    return 2;
  }
  console.log(`Done. ${sites.length} site(s) reconciled.`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("Unhandled error:", err);
    process.exit(3);
  });
