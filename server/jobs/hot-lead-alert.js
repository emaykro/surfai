"use strict";

/**
 * Hot Lead Alerter — polls recent sessions and sends a Telegram alert
 * to the sales / ops channel whenever a high-intent B2B visitor is detected.
 *
 * Trigger conditions:
 *   1. CatBoost model_prediction_score >= HOT_LEAD_THRESHOLD (default 0.75)
 *   2. OR Strong behavioral triggers:
 *      - Text copied (phone/email) + scroll >= 40% + duration >= 30s
 *      - OR Form engagement (>=2 interactions) + duration >= 45s
 *   3. Excludes confirmed bots and datacenter IPs.
 *   4. Deduplicated via `hot_lead_alerts` table.
 *
 * Usage:
 *   node server/jobs/hot-lead-alert.js
 *   node server/jobs/hot-lead-alert.js --dry-run
 *   node server/jobs/hot-lead-alert.js --threshold=0.8
 *   node server/jobs/hot-lead-alert.js --lookback=60
 *
 * Env vars:
 *   HOT_LEAD_BOT_TOKEN          required — lead-channel bot token
 *                               (falls back to CONTACT_BOT_TOKEN / @Surfaiask_bot)
 *   HOT_LEAD_CHAT_ID            required — destination chat ID for leads.
 *                               Never falls back to TELEGRAM_ALERT_CHAT_ID: the
 *                               ops channel is for infrastructure, not sales.
 *   HOT_LEAD_THRESHOLD          default 0.75
 *   DASHBOARD_BASE_URL          default https://surfai.ru/dashboard
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../../.env") });

const { pool } = require("../db");

// Leads and infrastructure alerts ride separate Telegram channels on purpose:
// a lead needs a human within minutes, and interleaving it with health noise
// is how leads get missed. TELEGRAM_BOT_TOKEN / TELEGRAM_ALERT_CHAT_ID belong
// to @SurfaiOps_bot and are deliberately NOT used here — there is no fallback
// onto the ops channel, because silent misrouting is the failure we are
// avoiding. Configure HOT_LEAD_CHAT_ID explicitly.
const TOKEN = process.env.HOT_LEAD_BOT_TOKEN || process.env.CONTACT_BOT_TOKEN;
const CHAT_ID = process.env.HOT_LEAD_CHAT_ID;
const DEFAULT_THRESHOLD = Number(process.env.HOT_LEAD_THRESHOLD || 0.75);
const DASHBOARD_BASE_URL = process.env.DASHBOARD_BASE_URL || "https://surfai.ru/dashboard";

function parseArgs(argv) {
  const args = { dryRun: false, threshold: DEFAULT_THRESHOLD, lookbackMinutes: 60 };
  for (const a of argv.slice(2)) {
    if (a === "--dry-run") args.dryRun = true;
    else if (a.startsWith("--threshold=")) {
      const n = Number(a.slice(12));
      if (Number.isFinite(n) && n >= 0 && n <= 1) args.threshold = n;
    } else if (a.startsWith("--lookback=")) {
      const n = Number(a.slice(11));
      if (Number.isFinite(n) && n > 0) args.lookbackMinutes = n;
    }
  }
  return args;
}

function mdEscape(s) {
  if (!s) return "";
  return String(s).replace(/([_*`\[])/g, "\\$1");
}

function formatDuration(ms) {
  if (!ms || ms < 1000) return "< 1 сек";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec} сек`;
  const m = Math.floor(sec / 60);
  const remSec = sec % 60;
  return `${m} мин ${remSec > 0 ? remSec + " сек" : ""}`;
}

async function sendTelegram(text) {
  if (!TOKEN || !CHAT_ID) {
    throw new Error(
      "Hot-lead channel is not configured: set HOT_LEAD_BOT_TOKEN (or CONTACT_BOT_TOKEN) " +
        "and HOT_LEAD_CHAT_ID. The ops channel is not used as a fallback by design."
    );
  }
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      chat_id: CHAT_ID,
      parse_mode: "Markdown",
      text,
      disable_web_page_preview: "true",
    }),
  });
  const json = await res.json();
  if (!json.ok) {
    throw new Error(`Telegram error: ${json.description || res.status}`);
  }
  return json.result;
}

async function findHotSessions({ threshold, lookbackMinutes }) {
  const query = `
    SELECT
      sf.session_id,
      sf.site_id,
      sf.project_id,
      sf.model_prediction_score::float AS score,
      sf.session_duration_ms,
      sf.engagement_active_ratio,
      sf.scroll_max_depth,
      sf.copy_count,
      sf.form_total_interactions,
      sf.form_submit_count,
      sf.form_abandon_count,
      sf.cross_visit_number,
      sf.ctx_utm_source,
      sf.ctx_utm_medium,
      sf.ctx_utm_campaign,
      sf.ctx_referrer_host,
      sf.geo_city,
      sf.geo_country,
      sf.geo_asn_org,
      sf.is_bot,
      sf.geo_is_datacenter,
      sess.first_seen_at,
      sess.last_seen_at,
      p.name AS project_name,
      st.domain AS site_domain
    FROM session_features sf
    JOIN sessions sess ON sess.session_id = sf.session_id
    LEFT JOIN projects p ON p.project_id = sf.project_id
    LEFT JOIN sites st ON st.site_id = sf.site_id
    WHERE sess.last_seen_at >= NOW() - ($1 || ' minutes')::interval
      AND (sf.is_bot IS NOT TRUE)
      AND (sf.geo_is_datacenter IS NOT TRUE)
      AND (
        (sf.model_prediction_score >= $2)
        OR (sf.copy_count > 0 AND sf.scroll_max_depth >= 40 AND sf.session_duration_ms >= 30000)
        OR (sf.form_total_interactions >= 2 AND sf.session_duration_ms >= 40000)
      )
      AND NOT EXISTS (
        SELECT 1 FROM hot_lead_alerts hla WHERE hla.session_id = sf.session_id
      )
    ORDER BY COALESCE(sf.model_prediction_score, 0.7) DESC
    LIMIT 20;
  `;

  const { rows } = await pool.query(query, [String(lookbackMinutes), threshold]);
  return rows;
}

function constructAlertMessage(s) {
  const scoreVal = s.score !== null ? `${Math.round(s.score * 100)}%` : "Высокий (эвристика)";
  const domain = s.site_domain || "неизвестный сайт";
  const project = s.project_name ? `${s.project_name} (${domain})` : domain;
  
  const geoParts = [];
  if (s.geo_city) geoParts.push(s.geo_city);
  if (s.geo_country && s.geo_country !== "RU") geoParts.push(s.geo_country);
  const geoText = geoParts.length ? geoParts.join(", ") : "Гео не определено";
  const orgText = s.geo_asn_org ? ` | ${s.geo_asn_org}` : "";

  const duration = formatDuration(s.session_duration_ms);
  const activePercent = s.engagement_active_ratio ? `${Math.round(s.engagement_active_ratio * 100)}%` : "н/д";
  const scroll = s.scroll_max_depth ? `${Math.round(s.scroll_max_depth)}%` : "0%";

  const triggers = [];
  if (s.score >= 0.75) triggers.push(`🤖 CatBoost Intent Score: *${scoreVal}*`);
  if (s.copy_count > 0) triggers.push(`📋 Скопировал текст/контакты: *${s.copy_count} раз(а)*`);
  if (s.form_submit_count > 0) triggers.push(`📝 Отправил форму`);
  else if (s.form_total_interactions > 0) triggers.push(`✍️ Взаимодействовал с формой (${s.form_total_interactions} действ.)`);
  if (s.cross_visit_number && s.cross_visit_number > 1) triggers.push(`🔄 Повторный визит (*№${s.cross_visit_number}*)`);

  const utmParts = [];
  if (s.ctx_utm_source) utmParts.push(`src: \`${mdEscape(s.ctx_utm_source)}\``);
  if (s.ctx_utm_campaign) utmParts.push(`cmp: \`${mdEscape(s.ctx_utm_campaign)}\``);
  if (s.ctx_referrer_host) utmParts.push(`ref: \`${mdEscape(s.ctx_referrer_host)}\``);
  const utmText = utmParts.length ? utmParts.join(" | ") : "Прямой / Органический заход";

  const replayUrl = `${DASHBOARD_BASE_URL}/?session=${encodeURIComponent(s.session_id)}`;

  return (
    `🔥 *ГОРЯЧИЙ B2B-ПОСЕТИТЕЛЬ НА САЙТЕ*\n\n` +
    `🎯 *Вероятность сделки*: *${scoreVal}*\n` +
    `🌐 *Проект*: ${mdEscape(project)}\n` +
    `📍 *Локация*: ${mdEscape(geoText)}${mdEscape(orgText)}\n` +
    `⏱ *Время на сайте*: ${duration} (активен ${activePercent}) | Скролл: ${scroll}\n\n` +
    `📌 *Триггеры интереса*:\n${triggers.map((t) => "• " + t).join("\n")}\n\n` +
    `🏷 *Трафик*: ${utmText}\n` +
    `🔍 [Смотреть Replay сессии](${replayUrl})`
  );
}

async function run() {
  const args = parseArgs(process.argv);
  console.log(`[hot-lead-alert] scanning (lookback=${args.lookbackMinutes}m, threshold=${args.threshold}, dryRun=${args.dryRun})...`);

  try {
    const sessions = await findHotSessions(args);
    if (!sessions.length) {
      console.log("[hot-lead-alert] no new hot sessions found.");
      return;
    }

    console.log(`[hot-lead-alert] found ${sessions.length} hot session(s).`);

    for (const s of sessions) {
      const text = constructAlertMessage(s);
      const reason = s.score >= args.threshold ? "catboost_high_score" : "behavioral_intent_trigger";

      if (args.dryRun) {
        console.log(`\n--- [DRY-RUN ALERT: ${s.session_id}] ---`);
        console.log(text);
      } else {
        await sendTelegram(text);
        await pool.query(
          `INSERT INTO hot_lead_alerts (session_id, site_id, project_id, score, reason, details)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (session_id) DO NOTHING`,
          [
            s.session_id,
            s.site_id,
            s.project_id,
            // NULL when the model never scored this session. Substituting a
            // number here makes a behavioural trigger indistinguishable from a
            // real prediction in any later precision analysis.
            s.score ?? null,
            reason,
            JSON.stringify({
              duration_ms: s.session_duration_ms,
              copy_count: s.copy_count,
              form_interactions: s.form_total_interactions,
              geo_city: s.geo_city,
              asn_org: s.geo_asn_org,
            }),
          ]
        );
        console.log(`[hot-lead-alert] sent alert for session ${s.session_id}`);
      }
    }
  } catch (err) {
    console.error("[hot-lead-alert] error:", err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  run().then(() => process.exit(0));
}

module.exports = { findHotSessions, constructAlertMessage, run };
