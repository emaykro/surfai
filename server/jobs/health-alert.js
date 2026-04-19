"use strict";

/**
 * Health alerter — polls /api/health, compares against the last seen
 * state, and sends a Telegram message ONLY on transitions.
 *
 * Triggers a message when:
 *   - overall status changes (healthy ↔ degraded ↔ unhealthy)
 *   - any individual check's level changes to "warn" or "critical"
 *   - /api/health itself becomes unreachable
 *   - recovery (everything back to ok after being non-ok)
 *
 * Does NOT message when nothing changed — so a persistently-unhealthy
 * state won't spam every 5 minutes. A separate "still-broken" reminder
 * could be added later if we find we're ignoring chronic alerts.
 *
 * Usage:
 *   node server/jobs/health-alert.js                 # one tick
 *   node server/jobs/health-alert.js --dry-run       # print, don't send
 *   node server/jobs/health-alert.js --force         # send regardless of transition (for testing)
 *
 * Env vars:
 *   TELEGRAM_BOT_TOKEN         required — from @BotFather
 *   TELEGRAM_ALERT_CHAT_ID     required — destination chat (private or group)
 *   HEALTH_URL                 default http://127.0.0.1:3100/api/health
 *   OPERATOR_API_TOKEN         required — same token the dashboard uses
 *   ALERT_STATE_FILE           default /var/lib/surfai-alerts/state.json
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../../.env") });
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_ALERT_CHAT_ID;
const HEALTH_URL = process.env.HEALTH_URL || "http://127.0.0.1:3100/api/health";
const OPERATOR_API_TOKEN = process.env.OPERATOR_API_TOKEN;
const STATE_FILE = process.env.ALERT_STATE_FILE || "/var/lib/surfai-alerts/state.json";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const FORCE = args.includes("--force");

// Telegram MarkdownV2 has a strict escaping list. Using classic Markdown ("parse_mode=Markdown")
// is more forgiving but still requires us to avoid unescaped backticks in variable content.
function mdEscape(s) {
  return String(s).replace(/([_*`\[])/g, "\\$1");
}

async function sendTelegram(text) {
  if (DRY_RUN) {
    console.log("[dry-run] would send:\n" + text);
    return { ok: true, dry_run: true };
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
    console.error("telegram send failed:", JSON.stringify(json));
    return { ok: false, error: json.description };
  }
  return { ok: true, message_id: json.result.message_id };
}

function loadPriorState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function savePriorState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function levelOf(check) {
  if (!check) return "unknown";
  return check.level || (check.ok ? "ok" : "critical");
}

function buildTransitionReport(prior, current) {
  // Returns an array of human-readable lines describing what changed,
  // or [] if nothing actionable changed.
  const priorStatus = prior?.status || "unknown";
  const currentStatus = current.status;

  const lines = [];

  if (priorStatus !== currentStatus) {
    lines.push(`*status*: ${priorStatus} → *${currentStatus}*`);
  }

  const priorChecks = prior?.checks || {};
  const currentChecks = current.checks || {};

  for (const [name, check] of Object.entries(currentChecks)) {
    const p = levelOf(priorChecks[name]);
    const c = levelOf(check);
    if (p === c) continue;

    // Flag going *up* (getting worse) or *down* to ok (recovery).
    // If a check drops from "warn" to "critical", that's worse — flag it.
    // If it drops from "critical" to "warn", still bad but less — flag it too.
    const rankOrder = { ok: 0, unknown: 1, warn: 2, critical: 3 };
    const worse = (rankOrder[c] ?? 1) > (rankOrder[p] ?? 1);
    const recovered = c === "ok" && p !== "ok" && p !== "unknown";
    if (worse || recovered) {
      // Add a short per-check detail line.
      const detail = compactCheckDetail(check);
      lines.push(`  ${mdEscape(name)}: ${p} → *${c}*${detail ? "  `" + detail + "`" : ""}`);
    }
  }

  return lines;
}

function compactCheckDetail(check) {
  // One-line summary of the most informative field for a check.
  if (check.error) return String(check.error).slice(0, 120);
  if ("latency_ms" in check) return `${check.latency_ms}ms`;
  if ("used_percent" in check) return `${check.used_percent}% used`;
  if ("age_seconds" in check) return `${check.age_seconds}s ago`;
  if ("age_hours" in check) return `${check.age_hours}h ago`;
  if ("days_remaining" in check) return `${check.days_remaining}d left`;
  return "";
}

async function main() {
  if (!TOKEN || !CHAT_ID) {
    console.error("TELEGRAM_BOT_TOKEN and TELEGRAM_ALERT_CHAT_ID must be set");
    process.exit(1);
  }
  if (!OPERATOR_API_TOKEN) {
    console.error("OPERATOR_API_TOKEN must be set (same token the dashboard uses)");
    process.exit(1);
  }

  const prior = loadPriorState();
  let current;
  let fetchError = null;

  try {
    const res = await fetch(HEALTH_URL, {
      headers: { Authorization: "Bearer " + OPERATOR_API_TOKEN },
    });
    // 503 is the expected shape for "unhealthy" — we still want to parse it.
    current = await res.json();
    // If JSON body is missing the shape we expect, treat as unreachable.
    if (!current || !current.status || !current.checks) {
      throw new Error("malformed /api/health response: " + JSON.stringify(current).slice(0, 200));
    }
  } catch (err) {
    fetchError = err;
  }

  // --- Unreachable ---------------------------------------------------------
  if (fetchError) {
    const wasDown = prior?.status === "unreachable";
    const state = { status: "unreachable", ts: Date.now(), error: fetchError.message.slice(0, 200) };
    if (!wasDown || FORCE) {
      await sendTelegram(
        `🚨 *SURFAI health unreachable*\n\`${mdEscape(fetchError.message.slice(0, 200))}\``
      );
    }
    savePriorState(state);
    console.log("health unreachable:", fetchError.message);
    return;
  }

  // --- Reachable: compute transitions -------------------------------------
  const transitions = FORCE
    ? ["*status*: (forced) " + current.status]
    : buildTransitionReport(prior, current);

  const state = {
    status: current.status,
    checks: current.checks,
    ts: Date.now(),
  };
  savePriorState(state);

  if (transitions.length === 0) {
    console.log(`no change — status=${current.status}`);
    return;
  }

  const emoji =
    current.status === "healthy" ? "✅" :
    current.status === "degraded" ? "⚠️" : "🚨";
  const header = `${emoji} *SURFAI ${current.status}*`;
  const text = header + "\n" + transitions.join("\n");

  const result = await sendTelegram(text);
  console.log("alert sent:", result);
}

main().catch((err) => {
  console.error("health-alert failed:", err);
  process.exit(1);
});
