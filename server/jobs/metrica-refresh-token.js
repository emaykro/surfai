"use strict";

/**
 * Rotate the Yandex Metrica OAuth access token via refresh_token.
 *
 * Usage:
 *   node server/jobs/metrica-refresh-token.js               # noop unless < 60 days left
 *   node server/jobs/metrica-refresh-token.js --force       # rotate now regardless
 *   node server/jobs/metrica-refresh-token.js --dry-run     # validate + report, no write
 *   node server/jobs/metrica-refresh-token.js --threshold=30  # custom days-remaining gate
 *
 * Yandex returns a NEW refresh_token on every successful refresh; the old one
 * is invalidated. Therefore the .env write must be atomic and must not happen
 * unless the new access token has been independently validated.
 *
 * Order of operations:
 *   1. Snapshot .env to .env.bak.<ts>
 *   2. POST /token with grant_type=refresh_token
 *   3. Validate the returned access_token against /management/v1/counters
 *   4. Rewrite .env atomically (temp file + rename)
 *   5. Telegram alert on success/failure (best-effort, never blocks the rotation)
 */

const fs = require("node:fs");
const path = require("node:path");

require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const { refreshAccessToken } = require("../features/yandex-metrica");

const ENV_PATH = path.resolve(__dirname, "../../.env");
const METRICA_TOKEN_TTL_DAYS_FALLBACK = 365;

function parseArgs(argv) {
  const args = { force: false, dryRun: false, threshold: 60 };
  for (const a of argv.slice(2)) {
    if (a === "--force") args.force = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a.startsWith("--threshold=")) args.threshold = parseInt(a.slice(12), 10);
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

function daysRemaining() {
  const expiresAt = process.env.YANDEX_METRICA_TOKEN_EXPIRES_AT;
  if (expiresAt && /^\d{4}-\d{2}-\d{2}$/.test(expiresAt)) {
    const expiresMs = new Date(expiresAt + "T00:00:00Z").getTime();
    return Math.floor((expiresMs - Date.now()) / (86400 * 1000));
  }
  // Fallback for envs that have not been rotated since EXPIRES_AT was added.
  const issuedAt = process.env.YANDEX_METRICA_TOKEN_ISSUED_AT;
  if (issuedAt && /^\d{4}-\d{2}-\d{2}$/.test(issuedAt)) {
    const issuedMs = new Date(issuedAt + "T00:00:00Z").getTime();
    const ageDays = (Date.now() - issuedMs) / (86400 * 1000);
    return Math.floor(METRICA_TOKEN_TTL_DAYS_FALLBACK - ageDays);
  }
  return null;
}

async function validateToken(accessToken) {
  const res = await fetch("https://api-metrika.yandex.net/management/v1/counters", {
    headers: { Authorization: `OAuth ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Validation failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return json.rows ?? null;
}

function rewriteEnv(envPath, updates) {
  const original = fs.readFileSync(envPath, "utf8");
  const lines = original.split("\n");
  const seen = new Set();
  const out = lines.map((line) => {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=/);
    if (m && updates[m[1]] != null) {
      seen.add(m[1]);
      return `${m[1]}=${updates[m[1]]}`;
    }
    return line;
  });
  for (const [k, v] of Object.entries(updates)) {
    if (!seen.has(k)) out.push(`${k}=${v}`);
  }
  const tmp = envPath + ".tmp";
  fs.writeFileSync(tmp, out.join("\n"), { mode: 0o600 });
  fs.renameSync(tmp, envPath);
}

async function postTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_ALERT_CHAT_ID;
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: "Markdown" }),
    });
  } catch (_) {
    /* never block rotation on telegram failure */
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log("Usage: node server/jobs/metrica-refresh-token.js [--force] [--dry-run] [--threshold=N]");
    process.exit(0);
  }

  const remaining = daysRemaining();
  console.log(
    `Token issued ${process.env.YANDEX_METRICA_TOKEN_ISSUED_AT || "?"}, expires ${process.env.YANDEX_METRICA_TOKEN_EXPIRES_AT || "?"} → ${remaining ?? "?"} days remaining.`
  );

  if (!args.force && remaining != null && remaining > args.threshold) {
    console.log(`Above threshold (${args.threshold} days). Skipping. Use --force to rotate anyway.`);
    process.exit(0);
  }

  if (args.dryRun) {
    console.log("Dry-run: would call refreshAccessToken() and rewrite .env. No HTTP call performed.");
    process.exit(0);
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${ENV_PATH}.bak.${ts}`;
  fs.copyFileSync(ENV_PATH, backup);
  console.log(`Backed up .env → ${backup}`);

  let payload;
  try {
    payload = await refreshAccessToken();
  } catch (err) {
    const msg = `Metrica token refresh FAILED at OAuth step: ${err.message}`;
    console.error(msg);
    await postTelegram(`🔴 ${msg}\nOld refresh_token still valid. .env untouched.`);
    process.exit(1);
  }

  const { access_token, refresh_token, expires_in } = payload;
  if (!access_token || !refresh_token) {
    const msg = `OAuth response missing tokens: ${JSON.stringify(payload)}`;
    console.error(msg);
    await postTelegram(`🔴 ${msg}`);
    process.exit(1);
  }

  try {
    const counters = await validateToken(access_token);
    console.log(`New access_token validated. Counters reachable: ${counters}`);
  } catch (err) {
    const msg = `New access_token validation failed: ${err.message}. .env NOT rewritten — manual intervention required (refresh_token from response below):\n${refresh_token}`;
    console.error(msg);
    await postTelegram(`🔴 ${msg}`);
    process.exit(1);
  }

  const today = new Date().toISOString().slice(0, 10);
  const ttlSeconds = expires_in || METRICA_TOKEN_TTL_DAYS_FALLBACK * 86400;
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString().slice(0, 10);
  rewriteEnv(ENV_PATH, {
    YANDEX_METRICA_TOKEN: access_token,
    YANDEX_METRICA_REFRESH_TOKEN: refresh_token,
    YANDEX_METRICA_TOKEN_ISSUED_AT: today,
    YANDEX_METRICA_TOKEN_EXPIRES_AT: expiresAt,
  });

  const newRemaining = Math.floor(ttlSeconds / 86400);
  const msg = `Metrica token rotated. Expires ${expiresAt} (~${newRemaining} days). Backup: ${path.basename(backup)}`;
  console.log(msg);
  await postTelegram(`🟢 ${msg}`);
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await postTelegram(`🔴 metrica-refresh-token unexpected error: ${err.message}`);
  process.exit(1);
});
