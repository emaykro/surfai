"use strict";

/**
 * Yandex Metrica API client — Slice 1.
 *
 * Scope today:
 *   - fetchDailyStats(counterId, date)  — Reports API, one day of totals
 *   - refreshAccessToken()              — manual helper to renew via refresh_token
 *
 * Scaffolded for later slices (not implemented yet):
 *   - fetchVisitLogs(counterId, dateFrom, dateTo, fields) — Logs API
 *
 * Auth: reads OAuth token from process.env.YANDEX_METRICA_TOKEN at call time
 * (not at require time), so a missing token only fails the specific call,
 * never the server boot.
 */

const MGMT_HOST = "https://api-metrika.yandex.net";
const OAUTH_HOST = "https://oauth.yandex.ru";

function getToken() {
  const token = process.env.YANDEX_METRICA_TOKEN;
  if (!token) {
    const err = new Error("YANDEX_METRICA_TOKEN is not set");
    err.code = "TOKEN_MISSING";
    throw err;
  }
  return token;
}

/**
 * Thin fetch wrapper with error classification Metrica docs prescribe:
 *   401 -> token expired/invalid (distinct, callers should stop retrying)
 *   429 -> rate limit (caller may back off)
 *   4xx -> request error (bad counter_id, bad date range, missing scope)
 *   5xx -> Metrica-side issue
 */
async function metricaFetch(url, { signal } = {}) {
  const token = getToken();
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `OAuth ${token}`,
      Accept: "application/json",
    },
    signal,
  });

  const body = await res.text();
  let parsed = null;
  try {
    parsed = body ? JSON.parse(body) : null;
  } catch {
    // non-JSON response — keep as string for error context
  }

  if (!res.ok) {
    const err = new Error(
      `Metrica ${res.status} for ${url}: ${
        parsed?.message || parsed?.error_text || body.slice(0, 200)
      }`
    );
    err.status = res.status;
    if (res.status === 401) err.code = "TOKEN_INVALID";
    else if (res.status === 429) err.code = "RATE_LIMIT";
    else if (res.status >= 500) err.code = "SERVER_ERROR";
    else err.code = "REQUEST_ERROR";
    throw err;
  }
  return parsed;
}

/**
 * Fetch one day of counter totals.
 *
 * Returns { visits, users, pageviews, goalsTotal } — the last field is
 * always null in Slice 1 because Metrica has no native "sum across all
 * goals" metric. Populating it cleanly requires first discovering the
 * counter's goal IDs via /management/v1/counter/{id}/goals, then issuing
 * per-goal `ym:s:goal<id>reaches` queries and summing. Deferred to Slice 2
 * or later; for now we just leave the column NULL in reconciliation rows.
 *
 * Uses the /stat/v1/data endpoint (Reports API, synchronous).
 * Docs: https://yandex.ru/dev/metrika/en/stat/intro
 */
async function fetchDailyStats(counterId, dateISO) {
  if (!Number.isInteger(counterId) || counterId <= 0) {
    throw new Error(`Invalid counterId: ${counterId}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) {
    throw new Error(`Invalid date (expected YYYY-MM-DD): ${dateISO}`);
  }

  const metrics = ["ym:s:visits", "ym:s:users", "ym:s:pageviews"].join(",");

  // accuracy= is intentionally omitted: Metrica's default sampling is
  // "medium", which for our <1k-visits/day counters means no sampling at
  // all (sampling only kicks in above ~10k visits/day). `accuracy=full`
  // requires a paid Metrica tier and responds 403 on the free tier.
  const url = new URL(`${MGMT_HOST}/stat/v1/data`);
  url.searchParams.set("ids", String(counterId));
  url.searchParams.set("date1", dateISO);
  url.searchParams.set("date2", dateISO);
  url.searchParams.set("metrics", metrics);
  url.searchParams.set("limit", "1");

  const json = await metricaFetch(url.toString());

  // Shape: { totals: [visits, users, pageviews], ... } — flat array when
  // the query has no dimensions. Values are floats in JSON (e.g. 33.0);
  // we round to integers since we're storing counts.
  const totals = Array.isArray(json?.totals) ? json.totals : [];
  return {
    visits: Math.round(Number(totals[0]) || 0),
    users: Math.round(Number(totals[1]) || 0),
    pageviews: Math.round(Number(totals[2]) || 0),
    goalsTotal: null,
  };
}

/**
 * Refresh the access token using the stored refresh_token. Returns
 * { access_token, refresh_token, expires_in } on success. Caller is
 * responsible for persisting the new values back into `.env` — this
 * function does NOT mutate the environment or any file.
 *
 * Useful as a manual rescue path when we see TOKEN_INVALID errors.
 */
async function refreshAccessToken() {
  const clientId = process.env.YANDEX_OAUTH_CLIENT_ID;
  const clientSecret = process.env.YANDEX_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.YANDEX_METRICA_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Refresh requires YANDEX_OAUTH_CLIENT_ID, YANDEX_OAUTH_CLIENT_SECRET, YANDEX_METRICA_REFRESH_TOKEN"
    );
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch(`${OAUTH_HOST}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json();
  if (!res.ok || json.error) {
    throw new Error(`Refresh failed: ${json.error || res.status} ${json.error_description || ""}`);
  }
  return json;
}

/**
 * Scaffold for Slice 3. Not implemented.
 */
async function fetchVisitLogs() {
  throw new Error("fetchVisitLogs is not implemented (Slice 3 deliverable)");
}

module.exports = {
  fetchDailyStats,
  refreshAccessToken,
  fetchVisitLogs,
  // Exposed for tests only
  _metricaFetch: metricaFetch,
};
