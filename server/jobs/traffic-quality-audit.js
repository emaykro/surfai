"use strict";

/**
 * Traffic Quality Audit — analyzes campaign / UTM traffic efficiency,
 * detects ad spend waste on low-intent/bot cohorts, and outputs
 * actionable recommendations and negative target lists.
 *
 * Usage:
 *   node server/jobs/traffic-quality-audit.js
 *   node server/jobs/traffic-quality-audit.js --days=14
 *   node server/jobs/traffic-quality-audit.js --dimension=campaign
 *   node server/jobs/traffic-quality-audit.js --dry-run
 *
 * Env vars:
 *   DATABASE_URL
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../../.env") });

const { pool } = require("../db");

// Minimum share of a cohort that must carry a model score before the intent
// term is allowed to influence the waste verdict.
const MIN_SCORED_RATIO = Number(process.env.TRAFFIC_AUDIT_MIN_SCORED_RATIO || 0.5);

function parseArgs(argv) {
  const args = { days: 30, dimension: "campaign", dryRun: false, siteId: null };
  for (const a of argv.slice(2)) {
    if (a.startsWith("--days=")) {
      const n = Number(a.slice(7));
      if (Number.isFinite(n) && n > 0) args.days = n;
    } else if (a.startsWith("--dimension=")) {
      const d = a.slice(12);
      if (["campaign", "source", "medium", "referrer", "asn"].includes(d)) {
        args.dimension = d;
      }
    } else if (a.startsWith("--site=")) {
      args.siteId = a.slice(7);
    } else if (a === "--dry-run") {
      args.dryRun = true;
    }
  }
  return args;
}

function getDimensionColumn(dim) {
  switch (dim) {
    case "source":
      return "COALESCE(sf.ctx_utm_source, '(direct / none)')";
    case "medium":
      return "COALESCE(sf.ctx_utm_medium, '(none)')";
    case "referrer":
      return "COALESCE(sf.ctx_referrer_host, '(direct)')";
    case "asn":
      return "COALESCE(sf.geo_asn_org, 'Unknown ASN')";
    case "campaign":
    default:
      return "COALESCE(sf.ctx_utm_campaign, '(no campaign)')";
  }
}

async function analyzeTrafficQuality({ days = 30, dimension = "campaign", siteId = null }) {
  const dimCol = getDimensionColumn(dimension);
  const params = [String(days)];
  let siteFilter = "";

  if (siteId) {
    params.push(siteId);
    siteFilter = `AND sf.site_id = $${params.length}`;
  }

  const query = `
    SELECT
      ${dimCol} AS dimension_name,
      COUNT(*)::int AS sessions_count,
      ROUND(AVG(sf.model_prediction_score)::numeric, 4)::float AS avg_intent_score,
      COUNT(*) FILTER (WHERE sf.model_prediction_score IS NOT NULL)::int AS scored_count,
      COUNT(*) FILTER (WHERE sf.converted = true)::int AS conversions_count,
      ROUND(AVG(COALESCE(sf.session_duration_ms, 0) / 1000.0)::numeric, 1)::float AS avg_duration_sec,
      ROUND(AVG(COALESCE(sf.scroll_max_depth, 0))::numeric, 1)::float AS avg_scroll_depth,
      COUNT(*) FILTER (WHERE sf.is_bot = true OR sf.geo_is_datacenter = true OR sf.bot_risk_level = 'high')::int AS bot_count,
      COUNT(*) FILTER (WHERE sf.copy_count > 0)::int AS copy_event_count,
      COUNT(*) FILTER (WHERE sf.form_total_interactions > 0)::int AS form_interaction_count
    FROM session_features sf
    JOIN sessions s ON s.session_id = sf.session_id
    WHERE s.last_seen_at >= NOW() - ($1 || ' days')::interval
      ${siteFilter}
    GROUP BY ${dimCol}
    HAVING COUNT(*) >= 3
    ORDER BY sessions_count DESC
    LIMIT 100;
  `;

  const { rows } = await pool.query(query, params);

  const enriched = rows.map((r) => {
    const convRate = r.sessions_count > 0 ? (r.conversions_count / r.sessions_count) : 0;
    const botRatio = r.sessions_count > 0 ? (r.bot_count / r.sessions_count) : 0;
    const scoredRatio = r.sessions_count > 0 ? (r.scored_count / r.sessions_count) : 0;

    // The intent term may only be used when enough of the cohort actually
    // carries a model score. Substituting a low default for NULL would make
    // an unscored cohort — e.g. any period when the ML scoring timer is down —
    // look like waste, and the output of this function is a recommendation to
    // switch off ad spend. When the signal is missing, its weight is
    // redistributed over the terms we do trust rather than assumed bad.
    const hasIntentSignal = r.avg_intent_score != null && scoredRatio >= MIN_SCORED_RATIO;

    const durationPenalty = Math.max(0, 1 - (r.avg_duration_sec / 30));
    const intentPenalty = hasIntentSignal ? Math.max(0, 1 - (r.avg_intent_score / 0.5)) : 0;

    const wasteScore = hasIntentSignal
      ? Math.min(100, Math.round(botRatio * 40 + durationPenalty * 30 + intentPenalty * 30))
      : Math.min(100, Math.round((botRatio * 40 + durationPenalty * 30) * (100 / 70)));

    let status = "ok";
    let recommendation = "Эффективный источник";

    if (!hasIntentSignal && r.conversions_count === 0 && botRatio < 0.5) {
      // Not enough evidence to advise switching anything off.
      status = "insufficient_data";
      recommendation = `ℹ️ Недостаточно данных: проскорено ${Math.round(scoredRatio * 100)}% сессий — проверьте ML-скоринг`;
    } else if (r.sessions_count >= 10 && wasteScore >= 65 && r.conversions_count === 0) {
      status = "waste";
      recommendation = "⛔️ Рекомендуется отключить / добавить в минус-список";
    } else if (wasteScore >= 45 && r.conversions_count === 0) {
      status = "warning";
      recommendation = "⚠️ Требует аудита креативов и посадочной страницы";
    } else if ((hasIntentSignal && r.avg_intent_score >= 0.4) || r.conversions_count > 0) {
      status = "high_performing";
      recommendation = "💎 Высокая конверсионная ценность (масштабировать)";
    }

    return {
      ...r,
      conversion_rate: Number(convRate.toFixed(4)),
      bot_ratio: Number(botRatio.toFixed(4)),
      scored_ratio: Number(scoredRatio.toFixed(4)),
      has_intent_signal: hasIntentSignal,
      waste_score: wasteScore,
      status,
      recommendation,
    };
  });

  return enriched;
}

async function run() {
  const args = parseArgs(process.argv);
  console.log(`\n📊 SURFAI Traffic Quality Audit (Last ${args.days} days, Grouping: ${args.dimension})\n`);

  try {
    const results = await analyzeTrafficQuality(args);

    if (!results.length) {
      console.log("No sufficient traffic data found for this period.");
      return;
    }

    console.table(
      results.map((r) => ({
        "Dimension": r.dimension_name.slice(0, 30),
        "Sessions": r.sessions_count,
        "Avg Intent": r.has_intent_signal ? `${Math.round(r.avg_intent_score * 100)}%` : "н/д",
        "Conv": r.conversions_count,
        "Avg Sec": r.avg_duration_sec,
        "Bot %": `${Math.round(r.bot_ratio * 100)}%`,
        "Waste": `${r.waste_score}/100`,
        "Action": r.recommendation.slice(0, 35),
      }))
    );

    const wasteItems = results.filter((r) => r.status === "waste");
    if (wasteItems.length > 0) {
      console.log("\n🚨 КАНДИДАТЫ НА ВЫКЛЮЧЕНИЕ / МИНУСАЦИЮ:");
      for (const w of wasteItems) {
        console.log(`  • ${w.dimension_name} (${w.sessions_count} кликов, ${Math.round(w.bot_ratio * 100)}% ботов, Intent: ${w.has_intent_signal ? Math.round(w.avg_intent_score * 100) + "%" : "н/д"})`);
      }
    }
  } catch (err) {
    console.error("Traffic audit error:", err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  run().then(() => process.exit(0));
}

module.exports = { analyzeTrafficQuality, getDimensionColumn, MIN_SCORED_RATIO };
