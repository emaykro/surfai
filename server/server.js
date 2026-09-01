require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const path = require("path");
const fastify = require("fastify")({
  logger: {
    level: process.env.LOG_LEVEL || "info",
    redact: ["req.headers.authorization"],
  },
  bodyLimit: 256 * 1024, // 256 KB — fits SDK contract (100 events × ~64KB max)
  // Trust nginx on localhost so that request.ip resolves to the real
  // client IP via X-Forwarded-For instead of 127.0.0.1. This is required
  // for GeoIP enrichment in persistBatch. Only the loopback address is
  // trusted — nginx is the only thing fronting Fastify.
  trustProxy: "127.0.0.1",
});
const { pool } = require("./db");

// ---------------------------------------------------------------------------
// Operator auth — bearer token from env
// ---------------------------------------------------------------------------

const OPERATOR_API_TOKEN = process.env.OPERATOR_API_TOKEN || "";

async function requireOperatorAuth(request, reply) {
  const auth = request.headers.authorization || "";
  let token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  // SSE (EventSource) can't set headers — allow token via query param
  if (!token && request.query && request.query.token) {
    token = request.query.token;
  }
  if (!OPERATOR_API_TOKEN || token !== OPERATOR_API_TOKEN) {
    return reply.code(401).send({ error: "unauthorized" });
  }
}

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------

fastify.addHook("onSend", async (_request, reply, payload) => {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Frame-Options", "DENY");
  // Ask Chromium-based browsers to include high-entropy User-Agent Client
  // Hints on subsequent requests to this origin. Low-entropy hints
  // (Sec-CH-UA, Sec-CH-UA-Mobile, Sec-CH-UA-Platform) are always sent;
  // this header opts in for the richer ones. Cross-origin delivery still
  // depends on the client site's Permission-Policy, so this is best-effort.
  reply.header(
    "Accept-CH",
    "Sec-CH-UA-Platform-Version, Sec-CH-UA-Arch, Sec-CH-UA-Bitness, Sec-CH-UA-Model, Sec-CH-UA-Full-Version-List"
  );
  return payload;
});
const { computeAndStore } = require("./features/store");
const geoip = require("./features/geoip");
const { parseUaClientHints } = require("./features/ua-client-hints");
const { IngestQueue } = require("./queue/ingest-queue");

const ingestQueue = new IngestQueue({
  processor: async (jobs) => {
    for (const job of jobs) {
      const { sessionId, sentAt, events, projectId, siteId, clientIp, uaHints } = job;
      try {
        await persistBatch(sessionId, sentAt, events, projectId, siteId);
        broadcastSSE({ sessionId, sentAt, events, projectId });
        await computeAndStore(sessionId, projectId, siteId, clientIp, uaHints);
      } catch (err) {
        fastify.log.error({ err, sessionId }, "failed to process queued batch or compute features");
      }
    }
  },
  logger: fastify.log,
});

// Previous value of ingestQueue's cumulative drop counter, sampled by
// /api/health so it can tell active shedding from a stale total.
let lastDroppedTotal = 0;

// ---------------------------------------------------------------------------
// CORS — explicit origins; never open `*` in production
// ---------------------------------------------------------------------------

/** Always-allowed origins from ENV (surfai.ru, app.surfai.ru, etc.) */
const STATIC_ORIGINS = (process.env.CORS_ORIGIN || "http://localhost:3000")
  .split(",")
  .map((o) => o.trim());

// ---------------------------------------------------------------------------
// Site key cache — avoids DB lookup on every batch
// ---------------------------------------------------------------------------

/** @type {Map<string, {projectId: string, siteId: string, allowedOrigins: string[], cachedAt: number}>} */
const siteCache = new Map();
const SITE_CACHE_TTL_MS = 60_000; // 60 seconds

/**
 * Dynamic CORS origins — loaded from DB on startup and refreshed every 60s.
 * @type {Set<string>}
 */
let dynamicOrigins = new Set(STATIC_ORIGINS);

async function refreshCorsOrigins() {
  const origins = new Set(STATIC_ORIGINS);
  try {
    const { rows } = await pool.query("SELECT allowed_origins, domain FROM sites");
    for (const row of rows) {
      if (row.allowed_origins) {
        for (const o of row.allowed_origins) origins.add(o);
      }
      if (row.domain) {
        origins.add(`https://${row.domain}`);
        origins.add(`https://www.${row.domain}`);
        origins.add(`http://${row.domain}`);
        origins.add(`http://www.${row.domain}`);
        // IDN domains: browser sends punycode Origin, so add that too
        try {
          const punyOrigin = new URL(`https://${row.domain}`).origin;
          if (punyOrigin !== `https://${row.domain}`) {
            origins.add(punyOrigin);
            origins.add(punyOrigin.replace("https://", "http://"));
            origins.add(punyOrigin.replace("://", "://www."));
            origins.add(punyOrigin.replace("://", "://www.").replace("https://", "http://"));
          }
        } catch { /* invalid domain — skip */ }
      }
    }
  } catch {
    // DB not ready yet — keep static origins
  }
  dynamicOrigins = origins;
}

// Load origins on startup, then refresh every 60s
refreshCorsOrigins();
setInterval(refreshCorsOrigins, SITE_CACHE_TTL_MS);

async function resolveSiteKey(siteKey) {
  const cached = siteCache.get(siteKey);
  if (cached && Date.now() - cached.cachedAt < SITE_CACHE_TTL_MS) {
    return cached;
  }
  const { rows } = await pool.query(
    `SELECT site_id, project_id, allowed_origins FROM sites WHERE site_key = $1`,
    [siteKey]
  );
  if (!rows.length) return null;
  const entry = {
    projectId: rows[0].project_id,
    siteId: rows[0].site_id,
    allowedOrigins: rows[0].allowed_origins || [],
    cachedAt: Date.now(),
  };
  siteCache.set(siteKey, entry);
  return entry;
}

/** Invalidate caches (called when sites are created/updated) */
function invalidateSiteCache(siteKey) {
  if (siteKey) siteCache.delete(siteKey);
  refreshCorsOrigins(); // Reload CORS immediately
}

/** Default project/site for requests without siteKey (dev-only fallback) */
const DEFAULT_PROJECT_ID = "default";
const DEFAULT_SITE_ID = "default";
const ALLOW_INGEST_WITHOUT_SITEKEY = process.env.ALLOW_INGEST_WITHOUT_SITEKEY === "true";

fastify.register(require("@fastify/cors"), {
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, server-to-server)
    if (!origin) return callback(null, true);
    if (dynamicOrigins.has(origin)) return callback(null, true);
    callback(null, false);
  },
});

// ---------------------------------------------------------------------------
// Static file serving (development only — serves client/ for E2E test page)
// ---------------------------------------------------------------------------

fastify.register(require("@fastify/static"), {
  root: path.join(__dirname, "..", "client"),
  prefix: "/",
});

// Serve dashboard files under /dashboard
fastify.register(require("@fastify/static"), {
  root: path.join(__dirname, "..", "dashboard"),
  prefix: "/dashboard/",
  decorateReply: false,
});

// Serve operator cabinet under /cabinet
fastify.register(require("@fastify/static"), {
  root: path.join(__dirname, "..", "cabinet"),
  prefix: "/cabinet/",
  decorateReply: false,
});

// ---------------------------------------------------------------------------
// JSON Schema — mirrors Data Contract from CLAUDE.md exactly
// ---------------------------------------------------------------------------

const mouseDataSchema = {
  type: "object",
  required: ["x", "y", "ts"],
  additionalProperties: false,
  properties: {
    x: { type: "number" },
    y: { type: "number" },
    ts: { type: "number" },
  },
};

const scrollDataSchema = {
  type: "object",
  required: ["percent", "ts"],
  additionalProperties: false,
  properties: {
    percent: { type: "number", minimum: 0, maximum: 100 },
    ts: { type: "number" },
  },
};

const idleDataSchema = {
  type: "object",
  required: ["idleMs", "ts"],
  additionalProperties: false,
  properties: {
    idleMs: { type: "number" },
    ts: { type: "number" },
  },
};

const clickDataSchema = {
  type: "object",
  required: ["x", "y", "elType", "elTagHash", "isCta", "isExternal", "timeSinceStart", "ts"],
  additionalProperties: false,
  properties: {
    x: { type: "number" },
    y: { type: "number" },
    elType: { type: "string" },
    elTagHash: { type: "number" },
    isCta: { type: "boolean" },
    isExternal: { type: "boolean" },
    timeSinceStart: { type: "number" },
    ts: { type: "number" },
  },
};

const formDataSchema = {
  type: "object",
  required: ["action", "formHash", "fieldIndex", "fieldType", "fillDurationMs", "ts"],
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["focus", "blur", "submit", "abandon"] },
    formHash: { type: "number" },
    fieldIndex: { type: "number" },
    fieldType: { type: "string" },
    fillDurationMs: { type: "number" },
    ts: { type: "number" },
  },
};

const engagementDataSchema = {
  type: "object",
  required: ["activeMs", "idleMs", "maxScrollPercent", "scrollSpeed", "microScrolls", "readthrough", "ts"],
  additionalProperties: false,
  properties: {
    activeMs: { type: "number" },
    idleMs: { type: "number" },
    maxScrollPercent: { type: "number", minimum: 0, maximum: 100 },
    scrollSpeed: { type: "string", enum: ["slow", "medium", "fast"] },
    microScrolls: { type: "number" },
    readthrough: { type: "boolean" },
    ts: { type: "number" },
  },
};

const sessionDataSchema = {
  type: "object",
  required: ["pageCount", "avgNavSpeedMs", "isBounce", "isHyperEngaged", "timeBucket", "ts"],
  additionalProperties: false,
  properties: {
    pageCount: { type: "number" },
    avgNavSpeedMs: { type: "number" },
    isBounce: { type: "boolean" },
    isHyperEngaged: { type: "boolean" },
    timeBucket: { type: "string", enum: ["night", "morning", "day", "evening"] },
    ts: { type: "number" },
  },
};

const contextDataSchema = {
  type: "object",
  // Extended fields added 2026-04-10 are NOT in `required` so that cached
  // pre-extension bundles still pass validation. The current SDK always
  // populates them.
  required: ["trafficSource", "deviceType", "browser", "os", "screenW", "screenH", "language", "connectionType", "ts"],
  additionalProperties: false,
  properties: {
    trafficSource: { type: "string" },
    deviceType: { type: "string" },
    browser: { type: "string" },
    os: { type: "string" },
    screenW: { type: "number" },
    screenH: { type: "number" },
    language: { type: "string" },
    connectionType: { type: "string" },
    // Extended fields (optional)
    timezone: { type: "string" },
    timezoneOffset: { type: "number" },
    languages: { type: "array", items: { type: "string" } },
    viewportW: { type: "number" },
    viewportH: { type: "number" },
    devicePixelRatio: { type: "number" },
    colorScheme: { type: "string" },
    reducedMotion: { type: "boolean" },
    hardwareConcurrency: { type: "number" },
    deviceMemory: { type: "number" },
    referrerHost: { type: "string" },
    utmSource: { type: "string" },
    utmMedium: { type: "string" },
    utmCampaign: { type: "string" },
    utmTerm: { type: "string" },
    utmContent: { type: "string" },
    metricaClientId: { type: ["string", "null"] },
    ts: { type: "number" },
  },
};

const crossSessionDataSchema = {
  type: "object",
  required: ["visitorId", "visitNumber", "returnWithin24h", "returnWithin7d", "ts"],
  additionalProperties: false,
  properties: {
    visitorId: { type: "string" },
    visitNumber: { type: "number" },
    returnWithin24h: { type: "boolean" },
    returnWithin7d: { type: "boolean" },
    ts: { type: "number" },
  },
};

const goalDataSchema = {
  type: "object",
  required: ["goalId", "ts"],
  properties: {
    goalId: { type: "string", minLength: 1 },
    value: { type: "number" },
    metadata: { type: "object" },
    ts: { type: "number" },
  },
};

const botSignalsDataSchema = {
  type: "object",
  required: [
    "webdriver", "phantom", "nightmare", "selenium", "cdp",
    "pluginCount", "languageCount", "hasChrome",
    "notificationPermission", "hardwareConcurrency", "deviceMemory",
    "touchSupport", "screenColorDepth", "ts",
  ],
  additionalProperties: false,
  properties: {
    webdriver: { type: "boolean" },
    phantom: { type: "boolean" },
    nightmare: { type: "boolean" },
    selenium: { type: "boolean" },
    cdp: { type: "boolean" },
    pluginCount: { type: "number" },
    languageCount: { type: "number" },
    hasChrome: { type: "boolean" },
    notificationPermission: { type: "string" },
    hardwareConcurrency: { type: "number" },
    deviceMemory: { type: "number" },
    touchSupport: { type: "boolean" },
    screenColorDepth: { type: "number" },
    ts: { type: "number" },
  },
};

const performanceDataSchema = {
  type: "object",
  // All core web vitals are nullable — can be missing on short bounces,
  // unsupported browsers, or before the observers have accumulated data.
  // `longTaskCount` / `longTaskTotalMs` are counters and always present.
  required: ["longTaskCount", "longTaskTotalMs", "ts"],
  additionalProperties: false,
  properties: {
    lcp: { type: ["number", "null"] },
    fcp: { type: ["number", "null"] },
    fid: { type: ["number", "null"] },
    inp: { type: ["number", "null"] },
    cls: { type: ["number", "null"] },
    ttfb: { type: ["number", "null"] },
    domInteractive: { type: ["number", "null"] },
    domContentLoaded: { type: ["number", "null"] },
    loadEvent: { type: ["number", "null"] },
    transferSize: { type: ["number", "null"] },
    longTaskCount: { type: "number" },
    longTaskTotalMs: { type: "number" },
    ts: { type: "number" },
  },
};

const ALL_EVENT_TYPES = ["mouse", "scroll", "idle", "click", "form", "engagement", "session", "context", "cross_session", "goal", "bot_signals", "performance", "copy", "tab_visibility"];

const copyDataSchema = {
  type: "object",
  required: ["ts"],
  additionalProperties: false,
  properties: {
    ts: { type: "number" },
  },
};

const tabVisibilityDataSchema = {
  type: "object",
  required: ["tabBlurCount", "tabHiddenMs", "ts"],
  additionalProperties: false,
  properties: {
    tabBlurCount: { type: "number" },
    tabHiddenMs: { type: "number" },
    ts: { type: "number" },
  },
};

const eventItemSchema = {
  type: "object",
  required: ["type", "data"],
  additionalProperties: false,
  properties: {
    type: { type: "string", enum: ALL_EVENT_TYPES },
    data: { type: "object" },
  },
  allOf: [
    {
      if: { properties: { type: { const: "mouse" } } },
      then: { properties: { data: mouseDataSchema } },
    },
    {
      if: { properties: { type: { const: "scroll" } } },
      then: { properties: { data: scrollDataSchema } },
    },
    {
      if: { properties: { type: { const: "idle" } } },
      then: { properties: { data: idleDataSchema } },
    },
    {
      if: { properties: { type: { const: "click" } } },
      then: { properties: { data: clickDataSchema } },
    },
    {
      if: { properties: { type: { const: "form" } } },
      then: { properties: { data: formDataSchema } },
    },
    {
      if: { properties: { type: { const: "engagement" } } },
      then: { properties: { data: engagementDataSchema } },
    },
    {
      if: { properties: { type: { const: "session" } } },
      then: { properties: { data: sessionDataSchema } },
    },
    {
      if: { properties: { type: { const: "context" } } },
      then: { properties: { data: contextDataSchema } },
    },
    {
      if: { properties: { type: { const: "cross_session" } } },
      then: { properties: { data: crossSessionDataSchema } },
    },
    {
      if: { properties: { type: { const: "goal" } } },
      then: { properties: { data: goalDataSchema } },
    },
    {
      if: { properties: { type: { const: "bot_signals" } } },
      then: { properties: { data: botSignalsDataSchema } },
    },
    {
      if: { properties: { type: { const: "performance" } } },
      then: { properties: { data: performanceDataSchema } },
    },
    {
      if: { properties: { type: { const: "copy" } } },
      then: { properties: { data: copyDataSchema } },
    },
    {
      if: { properties: { type: { const: "tab_visibility" } } },
      then: { properties: { data: tabVisibilityDataSchema } },
    },
  ],
};

const ingestBodySchema = {
  type: "object",
  required: ["sessionId", "sentAt", "events"],
  additionalProperties: false,
  properties: {
    sessionId: { type: "string", minLength: 1 },
    siteKey: { type: "string", minLength: 1 },
    sentAt: { type: "integer" },
    events: {
      type: "array",
      minItems: 1,
      items: eventItemSchema,
    },
  },
};

// ---------------------------------------------------------------------------
// POST /api/events — ingest route
// ---------------------------------------------------------------------------

fastify.post(
  "/api/events",
  { schema: { body: ingestBodySchema } },
  async (request, reply) => {
    const { sessionId, siteKey, sentAt, events } = request.body;

    // Resolve project/site from siteKey
    let projectId = DEFAULT_PROJECT_ID;
    let siteId = DEFAULT_SITE_ID;

    if (!siteKey && !ALLOW_INGEST_WITHOUT_SITEKEY) {
      return reply.code(400).send({ error: "siteKey is required" });
    }

    if (siteKey) {
      const site = await resolveSiteKey(siteKey);
      if (!site) {
        return reply.code(403).send({ error: "unknown site key" });
      }
      projectId = site.projectId;
      siteId = site.siteId;

      // Origin validation (skip if allowed_origins is empty)
      if (site.allowedOrigins.length > 0) {
        const rawOrigin = request.headers.origin || "";
        // Only use Origin header for browser requests — never fall back to Referer
        // which can be spoofed and has path info that weakens the check.
        // Requests without Origin (server-to-server) are allowed through if
        // the siteKey itself is valid — the key acts as the credential.
        if (rawOrigin) {
          let parsedOrigin;
          try { parsedOrigin = new URL(rawOrigin).origin; } catch { parsedOrigin = ""; }
          const allowedSet = new Set(site.allowedOrigins.map((ao) => {
            try { return new URL(ao).origin; } catch { return ao; }
          }));
          if (!allowedSet.has(parsedOrigin)) {
            fastify.log.warn({ siteKey: siteKey.slice(0, 8) + "…", origin: rawOrigin }, "origin mismatch");
            return reply.code(403).send({ error: "origin not allowed" });
          }
        }
      }

      // Update last_event_at (fire-and-forget)
      pool.query(
        "UPDATE sites SET last_event_at = NOW(), install_status = 'verified' WHERE site_id = $1",
        [siteId]
      ).catch(() => {});
    }

    fastify.log.info({ sessionId, projectId, siteId, eventCount: events.length, hasSiteKey: !!siteKey }, "batch received");

    // Capture the client IP for GeoIP enrichment. This is the ONLY place
    // the raw IP is read — it must not be stored in events or raw_batches,
    // only passed to computeAndStore for one-shot lookup.
    const clientIp = request.ip;

    // Parse UA Client Hints from the request headers. Works for Chromium-
    // based browsers; Firefox/Safari will yield all-null values which is
    // fine — CatBoost handles NaN natively.
    const uaHints = parseUaClientHints(request.headers);

    // Respond immediately (<5ms) — DB write and feature computation are decoupled
    reply.send({ ok: true });

    // Enqueue job for buffered high-throughput batch worker
    ingestQueue.enqueue({
      sessionId,
      sentAt,
      events,
      projectId,
      siteId,
      clientIp,
      uaHints,
    });
  }
);

// ---------------------------------------------------------------------------
// SSE — live event stream
// ---------------------------------------------------------------------------

/** @type {Set<import('http').ServerResponse>} */
const sseClients = new Set();

function broadcastSSE(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

fastify.get("/api/events/live", { preHandler: [requireOperatorAuth] }, (request, reply) => {
  const raw = reply.raw;
  raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  raw.write(":\n\n"); // SSE comment to keep connection alive

  sseClients.add(raw);
  fastify.log.info({ clientCount: sseClients.size }, "SSE client connected");

  request.raw.on("close", () => {
    sseClients.delete(raw);
    fastify.log.info({ clientCount: sseClients.size }, "SSE client disconnected");
  });

  // Keep-alive every 15s
  const keepAlive = setInterval(() => {
    try {
      raw.write(":\n\n");
    } catch {
      clearInterval(keepAlive);
      sseClients.delete(raw);
    }
  }, 15_000);

  request.raw.on("close", () => clearInterval(keepAlive));
});

// ---------------------------------------------------------------------------
// GET /api/sessions — list sessions (dashboard)
// Supports dimension filters: traffic_source, country, device_type, bot_risk
// ---------------------------------------------------------------------------

fastify.get("/api/sessions", { preHandler: [requireOperatorAuth] }, async (request) => {
  const limit = Math.min(parseInt(request.query.limit, 10) || 50, 200);
  const offset = Math.max(parseInt(request.query.offset, 10) || 0, 0);
  const { project_id, traffic_source, country, device_type, bot_risk } = request.query;

  const conditions = [];
  const params = [limit, offset]; // $1, $2

  if (project_id) {
    params.push(project_id);
    conditions.push(`s.project_id = $${params.length}`);
  }

  const dimFilters = [];
  if (traffic_source) {
    params.push(traffic_source);
    dimFilters.push(`COALESCE(sf.ctx_traffic_source, 'unknown') = $${params.length}`);
  }
  if (country) {
    params.push(country);
    dimFilters.push(`COALESCE(sf.geo_country, 'unknown') = $${params.length}`);
  }
  if (device_type) {
    params.push(device_type);
    dimFilters.push(`COALESCE(sf.ctx_device_type, 'unknown') = $${params.length}`);
  }
  if (bot_risk) {
    params.push(bot_risk);
    dimFilters.push(`COALESCE(sf.bot_risk_level, 'unknown') = $${params.length}`);
  }

  conditions.push(...dimFilters);
  const needsFeatureJoin = dimFilters.length > 0;
  const whereClause = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

  const { rows } = await pool.query(
    `SELECT s.session_id, s.first_seen_at, s.last_seen_at, s.project_id, s.site_id,
            COUNT(e.id)::int AS event_count,
            sf.converted, sf.conversion_count, sf.model_prediction_score,
            sf.geo_country, sf.ctx_device_type, sf.ctx_browser, sf.bot_risk_level
     FROM sessions s
     LEFT JOIN events e ON e.session_id = s.session_id
     LEFT JOIN session_features sf ON sf.session_id = s.session_id
     ${whereClause}
     GROUP BY s.id, sf.converted, sf.conversion_count, sf.model_prediction_score,
              sf.geo_country, sf.ctx_device_type, sf.ctx_browser, sf.bot_risk_level
     ORDER BY s.last_seen_at DESC
     LIMIT $1 OFFSET $2`,
    params
  );

  return { sessions: rows };
});

// ---------------------------------------------------------------------------
// GET /api/sessions/stats — aggregated segment breakdowns for dashboard
// Must be registered before /:sessionId to avoid route conflict.
// ---------------------------------------------------------------------------

fastify.get("/api/sessions/stats", { preHandler: [requireOperatorAuth] }, async (request) => {
  const { project_id } = request.query;

  const sessionJoin = project_id
    ? "JOIN sessions s ON s.session_id = sf.session_id AND s.project_id = $1"
    : "JOIN sessions s ON s.session_id = sf.session_id";
  const params = project_id ? [project_id] : [];

  const [sources, countries, devices, botRisk, lcpBuckets] = await Promise.all([
    pool.query(
      `SELECT COALESCE(sf.ctx_traffic_source, 'unknown') AS value,
              COUNT(DISTINCT sf.session_id)::int AS sessions,
              COUNT(DISTINCT c.conversion_id)::int AS conversions
       FROM session_features sf
       ${sessionJoin}
       LEFT JOIN conversions c ON c.session_id = sf.session_id
       GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, params),

    pool.query(
      `SELECT COALESCE(sf.geo_country, 'unknown') AS value,
              COUNT(DISTINCT sf.session_id)::int AS sessions,
              COUNT(DISTINCT c.conversion_id)::int AS conversions
       FROM session_features sf
       ${sessionJoin}
       LEFT JOIN conversions c ON c.session_id = sf.session_id
       GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, params),

    pool.query(
      `SELECT COALESCE(sf.ctx_device_type, 'unknown') AS value,
              COUNT(DISTINCT sf.session_id)::int AS sessions,
              COUNT(DISTINCT c.conversion_id)::int AS conversions
       FROM session_features sf
       ${sessionJoin}
       LEFT JOIN conversions c ON c.session_id = sf.session_id
       GROUP BY 1 ORDER BY 2 DESC`, params),

    pool.query(
      `SELECT COALESCE(sf.bot_risk_level, 'unknown') AS value,
              COUNT(DISTINCT sf.session_id)::int AS sessions
       FROM session_features sf
       ${sessionJoin}
       GROUP BY 1 ORDER BY 2 DESC`, params),

    pool.query(
      `SELECT CASE
                WHEN sf.perf_lcp IS NULL THEN 'unknown'
                WHEN sf.perf_lcp < 2500   THEN 'good'
                WHEN sf.perf_lcp < 4000   THEN 'needs_improvement'
                ELSE 'poor'
              END AS value,
              COUNT(DISTINCT sf.session_id)::int AS sessions
       FROM session_features sf
       ${sessionJoin}
       GROUP BY 1 ORDER BY 2 DESC`, params),
  ]);

  return {
    traffic_sources: sources.rows,
    countries:       countries.rows,
    device_types:    devices.rows,
    bot_risk:        botRisk.rows,
    lcp_buckets:     lcpBuckets.rows,
  };
});

// ---------------------------------------------------------------------------
// GET /api/sessions/:sessionId — session detail with events
// ---------------------------------------------------------------------------

fastify.get("/api/sessions/:sessionId", { preHandler: [requireOperatorAuth] }, async (request, reply) => {
  const { sessionId } = request.params;

  const sessionRes = await pool.query(
    `SELECT session_id, first_seen_at, last_seen_at
     FROM sessions WHERE session_id = $1`,
    [sessionId]
  );
  if (sessionRes.rows.length === 0) {
    return reply.code(404).send({ error: "session not found" });
  }

  const typeFilter = request.query.type;
  let eventsQuery, eventsParams;

  if (typeFilter) {
    eventsQuery = `SELECT type, data, ts FROM events
                   WHERE session_id = $1 AND type = $2
                   ORDER BY ts ASC LIMIT 5000`;
    eventsParams = [sessionId, typeFilter];
  } else {
    eventsQuery = `SELECT type, data, ts FROM events
                   WHERE session_id = $1
                   ORDER BY ts ASC LIMIT 5000`;
    eventsParams = [sessionId];
  }

  const eventsRes = await pool.query(eventsQuery, eventsParams);

  return {
    session: sessionRes.rows[0],
    events: eventsRes.rows,
    eventCount: eventsRes.rows.length,
  };
});

// ---------------------------------------------------------------------------
// Project & Site Management API
// ---------------------------------------------------------------------------

const projectBodySchema = {
  type: "object",
  required: ["name", "vertical"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 255 },
    vertical: { type: "string", enum: ["ecommerce", "services", "leadgen", "education", "b2b", "other"] },
    status: { type: "string", enum: ["setup", "active", "paused", "archived"] },
  },
};

// POST /api/projects — create project
fastify.post("/api/projects", { schema: { body: projectBodySchema }, preHandler: [requireOperatorAuth] }, async (request, reply) => {
  const { name, vertical } = request.body;

  const { rows } = await pool.query(
    `INSERT INTO projects (name, vertical) VALUES ($1, $2) RETURNING *`,
    [name, vertical]
  );

  return reply.code(201).send({ project: rows[0] });
});

// GET /api/projects — list projects with stats
fastify.get("/api/projects", { preHandler: [requireOperatorAuth] }, async () => {
  const { rows } = await pool.query(`
    SELECT p.*,
      (SELECT COUNT(*) FROM sites si WHERE si.project_id = p.project_id) AS sites_count,
      (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.project_id
        AND s.last_seen_at > NOW() - INTERVAL '24 hours') AS sessions_24h,
      (SELECT COUNT(*) FROM conversions c WHERE c.project_id = p.project_id
        AND c.created_at > NOW() - INTERVAL '24 hours') AS conversions_24h
    FROM projects p
    WHERE p.status != 'archived'
    ORDER BY p.created_at DESC
  `);

  return { projects: rows };
});

// GET /api/projects/:projectId — project detail
fastify.get("/api/projects/:projectId", { preHandler: [requireOperatorAuth] }, async (request, reply) => {
  const { projectId } = request.params;

  const { rows } = await pool.query(
    "SELECT * FROM projects WHERE project_id = $1", [projectId]
  );
  if (!rows.length) return reply.code(404).send({ error: "project not found" });

  return { project: rows[0] };
});

// PUT /api/projects/:projectId — update project
fastify.put("/api/projects/:projectId", { preHandler: [requireOperatorAuth] }, async (request, reply) => {
  const { projectId } = request.params;
  const { name, vertical, status } = request.body;

  const sets = [];
  const values = [projectId];
  let idx = 2;

  if (name !== undefined) { sets.push(`name = $${idx}`); values.push(name); idx++; }
  if (vertical !== undefined) { sets.push(`vertical = $${idx}`); values.push(vertical); idx++; }
  if (status !== undefined) { sets.push(`status = $${idx}`); values.push(status); idx++; }

  if (sets.length === 0) return reply.code(400).send({ error: "no fields to update" });
  sets.push("updated_at = NOW()");

  const { rows } = await pool.query(
    `UPDATE projects SET ${sets.join(", ")} WHERE project_id = $1 RETURNING *`,
    values
  );
  if (!rows.length) return reply.code(404).send({ error: "project not found" });
  return { project: rows[0] };
});

// POST /api/projects/:projectId/sites — add site to project
const siteBodySchema = {
  type: "object",
  required: ["domain"],
  properties: {
    domain: { type: "string", minLength: 1, maxLength: 255 },
    allowed_origins: { type: "array", items: { type: "string" } },
    install_method: { type: "string", enum: ["gtm", "direct_script", "server_only"] },
  },
};

fastify.post(
  "/api/projects/:projectId/sites",
  { schema: { body: siteBodySchema }, preHandler: [requireOperatorAuth] },
  async (request, reply) => {
    const { projectId } = request.params;
    const { domain, allowed_origins, install_method } = request.body;

    // Verify project exists
    const projRes = await pool.query(
      "SELECT project_id FROM projects WHERE project_id = $1", [projectId]
    );
    if (!projRes.rows.length) {
      return reply.code(404).send({ error: "project not found" });
    }

    const origins = allowed_origins || [];

    const { rows } = await pool.query(
      `INSERT INTO sites (project_id, domain, allowed_origins, install_method)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [projectId, domain, origins, install_method || "gtm"]
    );

    // Invalidate CORS cache so new domain is allowed immediately
    invalidateSiteCache(null);

    return reply.code(201).send({ site: rows[0] });
  }
);

// GET /api/projects/:projectId/sites — list sites for project
fastify.get("/api/projects/:projectId/sites", { preHandler: [requireOperatorAuth] }, async (request) => {
  const { projectId } = request.params;

  const { rows } = await pool.query(
    "SELECT * FROM sites WHERE project_id = $1 ORDER BY created_at DESC",
    [projectId]
  );

  return { sites: rows };
});

// GET /api/sites/:siteId/verify — check if events received in last 5 min
fastify.get("/api/sites/:siteId/verify", { preHandler: [requireOperatorAuth] }, async (request, reply) => {
  const { siteId } = request.params;

  const { rows } = await pool.query(
    "SELECT site_id, install_status, last_event_at FROM sites WHERE site_id = $1",
    [siteId]
  );
  if (!rows.length) return reply.code(404).send({ error: "site not found" });

  const site = rows[0];
  const recentThreshold = new Date(Date.now() - 5 * 60 * 1000);
  const hasRecentEvents = site.last_event_at && new Date(site.last_event_at) > recentThreshold;

  return {
    siteId: site.site_id,
    status: hasRecentEvents ? "verified" : site.last_event_at ? "stale" : "pending",
    lastEventAt: site.last_event_at,
  };
});

// GET /api/sites/:siteId/snippet — return install snippet with auto-configured goals
fastify.get("/api/sites/:siteId/snippet", { preHandler: [requireOperatorAuth] }, async (request, reply) => {
  const { siteId } = request.params;

  const { rows } = await pool.query(
    "SELECT site_key, domain, install_method, project_id FROM sites WHERE site_id = $1",
    [siteId]
  );
  if (!rows.length) return reply.code(404).send({ error: "site not found" });

  const { site_key, domain, install_method, project_id } = rows[0];
  const apiBase = process.env.API_BASE_URL || `http://localhost:${PORT}`;

  // Fetch page_rule goals for this project that match this domain (or have no domain filter)
  const goalsRes = await pool.query(
    `SELECT goal_id, rules FROM goals
     WHERE project_id = $1 AND type = 'page_rule' AND NOT is_deleted`,
    [project_id]
  );

  const pageGoals = [];
  for (const g of goalsRes.rows) {
    const rules = g.rules || {};
    // Include goal if it has no domain filter or matches this site's domain
    if (!rules.domain || rules.domain === domain) {
      pageGoals.push({
        goalId: g.goal_id,
        urlPattern: rules.urlPattern || "",
        matchType: rules.matchType || "contains",
      });
    }
  }

  const pageGoalsStr = pageGoals.length > 0
    ? `,\n        pageGoals: ${JSON.stringify(pageGoals)}`
    : "";

  const extraOpts = `${pageGoalsStr},\n        metrikaCapture: true,\n        dataLayerCapture: true`;

  const directScript = `<script src="${apiBase}/dist/tracker.js"><\/script>
<script>
  var tracker = new SurfaiTracker({
    endpoint: "${apiBase}/api/events",
    siteKey: "${site_key}"${extraOpts}
  });
  tracker.start();
<\/script>`;

  const gtmScript = `<!-- SURFAI Tracker — ${domain} -->
<script>
  (function() {
    var s = document.createElement('script');
    s.src = '${apiBase}/dist/tracker.js';
    s.onload = function() {
      var tracker = new SurfaiTracker({
        endpoint: '${apiBase}/api/events',
        siteKey: '${site_key}'${extraOpts}
      });
      tracker.start();
    };
    document.head.appendChild(s);
  })();
<\/script>`;

  return {
    siteKey: site_key,
    domain,
    installMethod: install_method,
    pageGoals,
    snippets: {
      direct: directScript,
      gtm: gtmScript,
    },
  };
});

// ---------------------------------------------------------------------------
// Goal Configuration CRUD API
// ---------------------------------------------------------------------------

const goalBodySchema = {
  type: "object",
  required: ["name", "type"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 255 },
    type: { type: "string", enum: ["page_rule", "js_sdk", "datalayer_auto", "backend_api"] },
    rules: { type: "object" },
    is_primary: { type: "boolean" },
    attribution_window_ms: { type: "integer", minimum: 0 },
    project_id: { type: "string" },
  },
};

// POST /api/goals — create goal
fastify.post("/api/goals", { schema: { body: goalBodySchema }, preHandler: [requireOperatorAuth] }, async (request, reply) => {
  const { name, type, rules, is_primary, attribution_window_ms, project_id } = request.body;
  const tenantId = request.headers["x-tenant-id"] || "default";
  const projectId = project_id || DEFAULT_PROJECT_ID;

  const { rows } = await pool.query(
    `INSERT INTO goals (tenant_id, name, type, rules, is_primary, attribution_window_ms, project_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [tenantId, name, type, JSON.stringify(rules || {}), is_primary || false, attribution_window_ms || 1800000, projectId]
  );

  return reply.code(201).send({ goal: rows[0] });
});

// GET /api/goals — list goals (filterable by project_id or tenant_id)
fastify.get("/api/goals", { preHandler: [requireOperatorAuth] }, async (request) => {
  const projectId = request.query.project_id;
  const tenantId = request.headers["x-tenant-id"] || "default";

  let query, params;
  if (projectId) {
    query = "SELECT * FROM goals WHERE project_id = $1 AND NOT is_deleted ORDER BY created_at DESC";
    params = [projectId];
  } else {
    query = "SELECT * FROM goals WHERE tenant_id = $1 AND NOT is_deleted ORDER BY created_at DESC";
    params = [tenantId];
  }

  const { rows } = await pool.query(query, params);
  return { goals: rows };
});

// PUT /api/goals/:goalId — update goal
fastify.put("/api/goals/:goalId", { preHandler: [requireOperatorAuth] }, async (request, reply) => {
  const { goalId } = request.params;
  const { name, type, rules, is_primary, attribution_window_ms } = request.body;

  const sets = [];
  const values = [goalId];
  let idx = 2;

  if (name !== undefined) { sets.push(`name = $${idx}`); values.push(name); idx++; }
  if (type !== undefined) { sets.push(`type = $${idx}`); values.push(type); idx++; }
  if (rules !== undefined) { sets.push(`rules = $${idx}`); values.push(JSON.stringify(rules)); idx++; }
  if (is_primary !== undefined) { sets.push(`is_primary = $${idx}`); values.push(is_primary); idx++; }
  if (attribution_window_ms !== undefined) { sets.push(`attribution_window_ms = $${idx}`); values.push(attribution_window_ms); idx++; }

  if (sets.length === 0) return reply.code(400).send({ error: "no fields to update" });

  sets.push("updated_at = NOW()");

  const { rows } = await pool.query(
    `UPDATE goals SET ${sets.join(", ")} WHERE goal_id = $1 AND NOT is_deleted RETURNING *`,
    values
  );

  if (!rows.length) return reply.code(404).send({ error: "goal not found" });
  return { goal: rows[0] };
});

// DELETE /api/goals/:goalId — soft delete
fastify.delete("/api/goals/:goalId", { preHandler: [requireOperatorAuth] }, async (request, reply) => {
  const { goalId } = request.params;

  const { rows } = await pool.query(
    "UPDATE goals SET is_deleted = true, updated_at = NOW() WHERE goal_id = $1 AND NOT is_deleted RETURNING goal_id",
    [goalId]
  );

  if (!rows.length) return reply.code(404).send({ error: "goal not found" });
  return { deleted: true, goalId: rows[0].goal_id };
});

// ---------------------------------------------------------------------------
// POST /api/conversions — server-side conversion registration
// ---------------------------------------------------------------------------

const conversionBodySchema = {
  type: "object",
  required: ["goalId", "ts"],
  properties: {
    sessionId: { type: "string" },
    visitorId: { type: "string" },
    goalId: { type: "string", minLength: 1 },
    value: { type: "number" },
    metadata: { type: "object" },
    ts: { type: "integer" },
  },
};

fastify.post("/api/conversions", { schema: { body: conversionBodySchema }, preHandler: [requireOperatorAuth] }, async (request, reply) => {
  const { sessionId, visitorId, goalId, value, metadata, ts } = request.body;

  if (!sessionId && !visitorId) {
    return reply.code(400).send({ error: "sessionId or visitorId required" });
  }

  // Resolve session
  let resolvedSessionId = sessionId;
  if (!resolvedSessionId && visitorId) {
    // Find latest session for this visitor via cross_session events
    const { rows } = await pool.query(
      `SELECT session_id FROM events
       WHERE type = 'cross_session' AND data->>'visitorId' = $1
       ORDER BY ts DESC LIMIT 1`,
      [visitorId]
    );
    if (!rows.length) {
      return reply.code(404).send({ error: "no session found for visitorId" });
    }
    resolvedSessionId = rows[0].session_id;
  }

  // Check goal exists
  const goalRes = await pool.query(
    "SELECT goal_id FROM goals WHERE goal_id = $1 AND NOT is_deleted",
    [goalId]
  );
  if (!goalRes.rows.length) {
    return reply.code(404).send({ error: "goal not found" });
  }

  // Dedup check
  const dedupRes = await pool.query(
    `SELECT id FROM conversions
     WHERE session_id = $1 AND goal_id = $2 AND ts > $3 LIMIT 1`,
    [resolvedSessionId, goalId, ts - 5000]
  );
  if (dedupRes.rows.length > 0) {
    return { ok: true, deduplicated: true };
  }

  // Insert conversion
  await pool.query(
    `INSERT INTO conversions (session_id, visitor_id, goal_id, source, value, metadata, ts)
     VALUES ($1, $2, $3, 'backend_api', $4, $5, $6)`,
    [resolvedSessionId, visitorId || null, goalId, value || null, JSON.stringify(metadata || {}), ts]
  );

  // Check if goal is primary
  const primaryRes = await pool.query(
    "SELECT is_primary FROM goals WHERE goal_id = $1", [goalId]
  );
  const isPrimary = primaryRes.rows[0]?.is_primary || false;

  // Update session_features. UPSERT: the conversion can arrive before the
  // first computeAndStore() pass — a plain UPDATE would hit no row and the
  // label would be silently lost (found 2026-07-22, ~70 sessions affected).
  await pool.query(
    `INSERT INTO session_features (session_id, converted, conversion_count${isPrimary ? ", primary_goal_converted" : ""})
     VALUES ($1, true, 1${isPrimary ? ", true" : ""})
     ON CONFLICT (session_id) DO UPDATE
     SET converted = true,
         conversion_count = COALESCE(session_features.conversion_count, 0) + 1
         ${isPrimary ? ", primary_goal_converted = true" : ""}`,
    [resolvedSessionId]
  );

  return reply.code(201).send({ ok: true, sessionId: resolvedSessionId });
});

// ---------------------------------------------------------------------------
// GET /api/sessions/:sessionId/conversions — conversions for a session
// ---------------------------------------------------------------------------

fastify.get("/api/sessions/:sessionId/conversions", { preHandler: [requireOperatorAuth] }, async (request, reply) => {
  const { sessionId } = request.params;

  const { rows } = await pool.query(
    `SELECT c.*, g.name AS goal_name, g.type AS goal_type
     FROM conversions c
     JOIN goals g ON g.goal_id = c.goal_id
     WHERE c.session_id = $1
     ORDER BY c.ts ASC`,
    [sessionId]
  );

  return { sessionId, conversions: rows };
});

// ---------------------------------------------------------------------------
// GET /api/sessions/:sessionId/features — computed feature vector
// ---------------------------------------------------------------------------

const { getFeatures } = require("./features/store");

fastify.get("/api/sessions/:sessionId/features", { preHandler: [requireOperatorAuth] }, async (request, reply) => {
  const { sessionId } = request.params;

  const features = await getFeatures(sessionId);
  if (!features) {
    return reply.code(404).send({ error: "no features computed for this session" });
  }

  return { sessionId, features };
});

// ---------------------------------------------------------------------------
// ML retrain readiness
// ---------------------------------------------------------------------------

// How many enriched conversions we need before it's worth retraining
// CatBoost on the new ~103-feature set. Baseline was ~28 on the old
// 57-feature schema (2026-04-08 first model). "Enriched" = the session's
// feature row has a non-null geo_country, which is the most reliable
// marker that the session was captured after the 2026-04-10 data-enrichment
// sprint (GeoIP, perf_*, uah_*). Change this number here; the dashboard
// reads it from the endpoint.
const ML_RETRAIN_TARGET_CONVERSIONS = 50;

// Window for computing "current" daily rate. Short enough that a recent
// slowdown or tag outage drags the ETA visibly, long enough to smooth
// day-to-day noise.
const ML_RATE_WINDOW_DAYS = 14;

fastify.get("/api/ml/readiness", { preHandler: [requireOperatorAuth] }, async () => {
  const { rows } = await pool.query(
    `
    SELECT
      COUNT(*)::int                                        AS enriched_conversions,
      MIN(c.created_at)                                    AS first_enriched_at,
      MAX(c.created_at)                                    AS last_enriched_at,
      COUNT(*) FILTER (WHERE c.created_at >= NOW() - ($1 || ' days')::interval)::int
                                                           AS recent_enriched
    FROM conversions c
    JOIN session_features sf ON sf.session_id = c.session_id
    WHERE sf.geo_country IS NOT NULL
    `,
    [ML_RATE_WINDOW_DAYS]
  );
  const totalRows = await pool.query("SELECT COUNT(*)::int AS n FROM conversions");

  const enriched = rows[0].enriched_conversions || 0;
  const firstAt = rows[0].first_enriched_at;
  const lastAt = rows[0].last_enriched_at;
  const recent = rows[0].recent_enriched || 0;
  const total = totalRows.rows[0].n || 0;

  // Daily rate over the trailing window, not the whole history. A recent
  // drop-off should visibly push the ETA out instead of being masked by
  // healthy early days.
  const dailyRate = +(recent / ML_RATE_WINDOW_DAYS).toFixed(2);
  let etaDays = null;
  let etaDate = null;
  const remaining = Math.max(0, ML_RETRAIN_TARGET_CONVERSIONS - enriched);
  if (remaining === 0) {
    etaDays = 0;
    etaDate = new Date().toISOString().slice(0, 10);
  } else if (dailyRate > 0) {
    etaDays = Math.ceil(remaining / dailyRate);
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + etaDays);
    etaDate = d.toISOString().slice(0, 10);
  }

  return {
    enriched_conversions: enriched,
    total_conversions: total,
    target_conversions: ML_RETRAIN_TARGET_CONVERSIONS,
    first_enriched_at: firstAt,
    last_enriched_at: lastAt,
    recent_enriched: recent,
    rate_window_days: ML_RATE_WINDOW_DAYS,
    daily_rate: dailyRate,
    eta_days: etaDays,
    eta_date: etaDate,
    ready: enriched >= ML_RETRAIN_TARGET_CONVERSIONS,
  };
});

// ---------------------------------------------------------------------------
// Per-site health — detects silent data loss (the 2026-04-10
// химчистка-луч.рф fingerprint: passive timer events still flow while
// interaction events are gone because the tracker/GTM tag was removed)
// ---------------------------------------------------------------------------

const INTERACTION_EVENT_TYPES = ["click", "form", "scroll", "mouse", "performance"];
const PASSIVE_EVENT_TYPES = ["engagement", "idle", "cross_session", "context", "bot_signals", "session"];

fastify.get("/api/sites/health", { preHandler: [requireOperatorAuth] }, async () => {
  const nowMs = Date.now();
  const ms48h = nowMs - 48 * 3600 * 1000;

  // One sweep per concern — 4 small queries are cheaper than one JOIN and far easier to read.
  const [sites, eventMix, sessionBuckets, latestRatio] = await Promise.all([
    pool.query(
      `SELECT site_id, domain, install_status, last_event_at, yandex_counter_id
         FROM sites
        ORDER BY domain`
    ),
    pool.query(
      `SELECT site_id, type, COUNT(*)::int AS n
         FROM events
        WHERE ts >= $1
        GROUP BY site_id, type`,
      [ms48h]
    ),
    pool.query(
      `SELECT site_id,
              COUNT(*) FILTER (WHERE first_seen_at >= NOW() - INTERVAL '24 hours')::int AS sessions_24h,
              COUNT(*) FILTER (WHERE first_seen_at >= NOW() - INTERVAL '48 hours')::int AS sessions_48h,
              COUNT(*) FILTER (WHERE first_seen_at >= NOW() - INTERVAL '7 days')::int   AS sessions_7d
         FROM sessions
        GROUP BY site_id`
    ),
    pool.query(
      `SELECT DISTINCT ON (site_id)
              site_id, date, divergence_ratio, metrica_visits, surfai_sessions
         FROM metrica_daily_reconciliation
        ORDER BY site_id, date DESC`
    ),
  ]);

  const mixBySite = {};
  for (const r of eventMix.rows) {
    if (!mixBySite[r.site_id]) mixBySite[r.site_id] = {};
    mixBySite[r.site_id][r.type] = r.n;
  }
  const bucketsBySite = Object.fromEntries(sessionBuckets.rows.map((r) => [r.site_id, r]));
  const ratioBySite = Object.fromEntries(latestRatio.rows.map((r) => [r.site_id, r]));

  const result = sites.rows.map((s) => {
    const mix = mixBySite[s.site_id] || {};
    const buckets = bucketsBySite[s.site_id] || { sessions_24h: 0, sessions_48h: 0, sessions_7d: 0 };
    const ratioRow = ratioBySite[s.site_id] || null;

    const hasInteraction = INTERACTION_EVENT_TYPES.some((t) => (mix[t] || 0) > 0);
    const hasPassive = PASSIVE_EVENT_TYPES.some((t) => (mix[t] || 0) > 0);
    const missingInteractionTypes = INTERACTION_EVENT_TYPES.filter((t) => !(mix[t] > 0));

    // Session-drop detection: compare last-24h rate to the 7d average. Only
    // meaningful for sites that normally have a non-trivial amount of traffic
    // (>5 sessions/day avg) — otherwise day-to-day variance is too noisy.
    const avgDaily7d = buckets.sessions_7d / 7;
    const sessionDrop =
      avgDaily7d > 5 && buckets.sessions_24h < avgDaily7d * 0.3;

    let health = "green";
    let healthReason = "ok";

    if (buckets.sessions_7d === 0) {
      health = "gray";
      healthReason = "never_tracked";
    } else if (s.install_status !== "verified") {
      health = "yellow";
      healthReason = "unverified";
    } else if (buckets.sessions_48h === 0) {
      health = "red";
      healthReason = "silent";
    } else if (hasPassive && !hasInteraction) {
      // The classic tag-removed-but-cached-tabs-still-flushing fingerprint.
      health = "red";
      healthReason = "passive_only";
    } else if (sessionDrop) {
      health = "red";
      healthReason = "session_drop_70pct";
    } else if (avgDaily7d > 10 && missingInteractionTypes.length >= 3) {
      // A busy site that's missing 3+ of the 5 interaction types probably
      // has a broken event type (e.g. form events stopped firing). Softer
      // flag than passive-only because interactions ARE happening.
      health = "yellow";
      healthReason = "missing_interaction_types";
    } else if (buckets.sessions_24h === 0 && buckets.sessions_48h > 0) {
      health = "yellow";
      healthReason = "quiet_last_24h";
    }

    return {
      site_id: s.site_id,
      domain: s.domain,
      install_status: s.install_status,
      last_event_at: s.last_event_at,
      yandex_counter_id: s.yandex_counter_id,
      sessions_24h: buckets.sessions_24h,
      sessions_48h: buckets.sessions_48h,
      sessions_7d: buckets.sessions_7d,
      avg_daily_7d: Number(avgDaily7d.toFixed(1)),
      event_mix_48h: mix,
      interaction_types_present: INTERACTION_EVENT_TYPES.filter((t) => (mix[t] || 0) > 0),
      interaction_types_missing: missingInteractionTypes,
      has_interaction: hasInteraction,
      has_only_passive: hasPassive && !hasInteraction,
      health,
      health_reason: healthReason,
      latest_ratio: ratioRow ? Number(ratioRow.divergence_ratio) : null,
      latest_ratio_date: ratioRow ? ratioRow.date : null,
    };
  });

  return {
    as_of: new Date().toISOString(),
    interaction_event_types: INTERACTION_EVENT_TYPES,
    passive_event_types: PASSIVE_EVENT_TYPES,
    sites: result,
  };
});

// ---------------------------------------------------------------------------
// Anti-Fraud summary — packages existing bot_signals + datacenter geo into a
// single aggregate view for the operator dashboard. No new ingest, no new
// columns; all data is already persisted by the regular feature-store path.
//
// Three categories are reported side-by-side because they answer different
// questions and intentionally overlap:
//   - bot_sessions      = is_bot = true (hard-rule fingerprint match)
//   - suspicious_sessions = bot_risk_level IN ('medium','high') (soft score)
//   - datacenter_sessions = geo_is_datacenter = true (origin signal)
// Operators can decide which is actionable on which channel.
// ---------------------------------------------------------------------------

fastify.get("/api/antifraud/summary", { preHandler: [requireOperatorAuth] }, async (request) => {
  const days = Math.min(Math.max(parseInt(request.query.days, 10) || 7, 1), 90);
  const siteId = request.query.site_id || null;

  const params = [days];
  let siteClause = "";
  if (siteId) {
    params.push(siteId);
    siteClause = `AND ss.site_id = $${params.length}`;
  }

  // Common FROM/WHERE used by totals/utm/asn aggregates. session_features is
  // the canonical row per session; sessions provides first_seen_at + site_id.
  // by_site adds a separate JOIN to `sites` for the human-readable domain.
  const baseFrom = `
    FROM session_features sf
    JOIN sessions ss ON ss.session_id = sf.session_id
   WHERE ss.first_seen_at >= NOW() - ($1::int * INTERVAL '1 day')
     ${siteClause}
  `;

  // Sub-aggregate UTM and ASN with min-volume floors. A UTM source with 3
  // sessions of which 3 are bots is noise, not a finding — we'd rather miss
  // it than make the operator chase phantom alerts.
  const MIN_UTM_SESSIONS = 20;
  const MIN_ASN_SESSIONS = 30;

  const [totals, bySite, byUtm, topAsn] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(*)::int AS sessions,
         COUNT(*) FILTER (WHERE sf.is_bot = true)::int AS bot_sessions,
         COUNT(*) FILTER (WHERE sf.bot_risk_level IN ('medium','high'))::int AS suspicious_sessions,
         COUNT(*) FILTER (WHERE sf.geo_is_datacenter = true)::int AS datacenter_sessions
       ${baseFrom}`,
      params
    ),
    pool.query(
      `SELECT
         si.site_id,
         si.domain,
         COUNT(*)::int AS sessions,
         COUNT(*) FILTER (WHERE sf.is_bot = true)::int AS bot_sessions,
         COUNT(*) FILTER (WHERE sf.bot_risk_level IN ('medium','high'))::int AS suspicious_sessions,
         COUNT(*) FILTER (WHERE sf.geo_is_datacenter = true)::int AS datacenter_sessions
       FROM session_features sf
       JOIN sessions ss ON ss.session_id = sf.session_id
       JOIN sites si    ON si.site_id    = ss.site_id
      WHERE ss.first_seen_at >= NOW() - ($1::int * INTERVAL '1 day')
        ${siteClause}
       GROUP BY si.site_id, si.domain
       ORDER BY si.domain`,
      params
    ),
    pool.query(
      `SELECT
         COALESCE(NULLIF(sf.ctx_utm_source, ''), '(none)') AS utm_source,
         COUNT(*)::int AS sessions,
         COUNT(*) FILTER (WHERE sf.is_bot = true)::int AS bot_sessions,
         COUNT(*) FILTER (WHERE sf.bot_risk_level IN ('medium','high'))::int AS suspicious_sessions,
         COUNT(*) FILTER (WHERE sf.geo_is_datacenter = true)::int AS datacenter_sessions
       ${baseFrom}
       GROUP BY utm_source
       HAVING COUNT(*) >= ${MIN_UTM_SESSIONS}
       ORDER BY (
         COUNT(*) FILTER (WHERE sf.is_bot = true)::float / NULLIF(COUNT(*), 0)
       ) DESC NULLS LAST,
         COUNT(*) DESC,
         utm_source ASC
       LIMIT 20`,
      params
    ),
    pool.query(
      `SELECT
         sf.geo_asn AS asn,
         MAX(sf.geo_asn_org) AS asn_org,
         COUNT(*)::int AS sessions,
         COUNT(*) FILTER (WHERE sf.is_bot = true)::int AS bot_sessions
       ${baseFrom}
         AND sf.geo_asn IS NOT NULL
       GROUP BY sf.geo_asn
       HAVING COUNT(*) >= ${MIN_ASN_SESSIONS}
          AND COUNT(*) FILTER (WHERE sf.is_bot = true) > 0
       ORDER BY (
         COUNT(*) FILTER (WHERE sf.is_bot = true)::float / NULLIF(COUNT(*), 0)
       ) DESC,
         bot_sessions DESC,
         sf.geo_asn ASC
       LIMIT 15`,
      params
    ),
  ]);

  const t = totals.rows[0] || { sessions: 0, bot_sessions: 0, suspicious_sessions: 0, datacenter_sessions: 0 };
  const pct = (n, total) => (total > 0 ? Number(((n / total) * 100).toFixed(2)) : 0);

  const decorate = (row) => ({
    ...row,
    bot_pct: pct(row.bot_sessions, row.sessions),
    suspicious_pct: row.suspicious_sessions != null ? pct(row.suspicious_sessions, row.sessions) : undefined,
    datacenter_pct: row.datacenter_sessions != null ? pct(row.datacenter_sessions, row.sessions) : undefined,
  });

  return {
    as_of: new Date().toISOString(),
    window_days: days,
    site_id: siteId,
    min_utm_sessions: MIN_UTM_SESSIONS,
    min_asn_sessions: MIN_ASN_SESSIONS,
    totals: {
      sessions: t.sessions,
      bot_sessions: t.bot_sessions,
      bot_pct: pct(t.bot_sessions, t.sessions),
      suspicious_sessions: t.suspicious_sessions,
      suspicious_pct: pct(t.suspicious_sessions, t.sessions),
      datacenter_sessions: t.datacenter_sessions,
      datacenter_pct: pct(t.datacenter_sessions, t.sessions),
    },
    by_site: bySite.rows.map(decorate),
    by_utm_source: byUtm.rows.map(decorate),
    top_bot_asn: topAsn.rows.map((r) => ({
      asn: r.asn,
      asn_org: r.asn_org,
      sessions: r.sessions,
      bot_sessions: r.bot_sessions,
      bot_pct: pct(r.bot_sessions, r.sessions),
    })),
  };
});

// ---------------------------------------------------------------------------
// Traffic quality & Ad Waste analytics API
// ---------------------------------------------------------------------------

fastify.get("/api/analytics/traffic-quality", { preHandler: [requireOperatorAuth] }, async (request) => {
  const days = Math.min(Math.max(parseInt(request.query.days, 10) || 30, 1), 90);
  const siteId = request.query.site_id || null;
  const dimension = request.query.dimension || "campaign";
  const { analyzeTrafficQuality } = require("./jobs/traffic-quality-audit");
  const items = await analyzeTrafficQuality({ days, dimension, siteId });
  return {
    as_of: new Date().toISOString(),
    window_days: days,
    dimension,
    site_id: siteId,
    items,
  };
});

// Corporate-visitor aggregation shared by /api/analytics/b2b-accounts and
// /api/b2b/companies. The two endpoints differ only in whether the enrichment
// table is joined in and in their response shape, so the SQL lives here once.
// Only compile-time constants are interpolated into the query text; siteId is
// always parameterized.
async function fetchB2BAccounts({ days, siteId, withEnrichment = false }) {
  const { classifyAsnOrg } = require("./features/b2b-detector");

  const params = [days];
  let siteClause = "";
  if (siteId) {
    params.push(siteId);
    siteClause = `AND sf.site_id = $${params.length}`;
  }

  const enrichSelect = withEnrichment
    ? `,
      bc.id AS company_id,
      bc.clean_name AS enriched_name,
      bc.inn,
      bc.kpp,
      bc.ogrn,
      bc.address,
      bc.management_name,
      bc.status AS legal_status,
      bc.enriched_at`
    : "";
  const enrichJoin = withEnrichment
    ? "LEFT JOIN b2b_companies bc ON bc.raw_org = sf.geo_asn_org"
    : "";
  const enrichGroup = withEnrichment
    ? `,
             bc.id, bc.clean_name, bc.inn, bc.kpp, bc.ogrn, bc.address,
             bc.management_name, bc.status, bc.enriched_at`
    : "";

  const query = `
    SELECT
      sf.geo_asn_org AS raw_org,
      sf.geo_asn,
      sf.geo_city,
      sf.geo_country,
      sf.geo_is_datacenter,
      sf.geo_is_mobile_carrier,
      COUNT(*)::int AS total_sessions,
      COUNT(DISTINCT DATE(s.last_seen_at))::int AS active_days,
      ROUND(AVG(COALESCE(sf.model_prediction_score, 0.1))::numeric, 4)::float AS avg_intent_score,
      ROUND(AVG(COALESCE(sf.session_duration_ms, 0) / 1000.0)::numeric, 1)::float AS avg_duration_sec,
      COUNT(*) FILTER (WHERE sf.converted = true)::int AS conversions,
      COUNT(*) FILTER (WHERE sf.copy_count > 0)::int AS copy_events,
      MAX(s.last_seen_at) AS last_seen_at${enrichSelect}
    FROM session_features sf
    JOIN sessions s ON s.session_id = sf.session_id
    ${enrichJoin}
    WHERE s.last_seen_at >= NOW() - ($1::int * INTERVAL '1 day')
      AND sf.geo_asn_org IS NOT NULL
      ${siteClause}
    GROUP BY sf.geo_asn_org, sf.geo_asn, sf.geo_city, sf.geo_country,
             sf.geo_is_datacenter, sf.geo_is_mobile_carrier${enrichGroup}
    ORDER BY total_sessions DESC;
  `;

  const { rows } = await pool.query(query, params);

  return rows.filter(
    (r) => classifyAsnOrg(r.raw_org, r.geo_is_datacenter, r.geo_is_mobile_carrier) === "b2b_corporate"
  );
}

// Fields both B2B responses share, derived identically from an aggregated row.
function b2bCommonFields(r) {
  return {
    raw_org: r.raw_org,
    asn: r.geo_asn,
    location: [r.geo_city, r.geo_country].filter(Boolean).join(", ") || "Unknown",
    total_sessions: r.total_sessions,
    active_days: r.active_days,
    avg_intent_score: r.avg_intent_score,
    avg_duration_sec: r.avg_duration_sec,
    conversions: r.conversions,
    copy_events: r.copy_events,
    last_seen_at: r.last_seen_at,
    interest_level:
      r.avg_intent_score >= 0.4 || r.conversions > 0 || r.copy_events > 0 ? "hot" : "warm",
  };
}

fastify.get("/api/analytics/b2b-accounts", { preHandler: [requireOperatorAuth] }, async (request) => {
  const days = Math.min(Math.max(parseInt(request.query.days, 10) || 30, 1), 90);
  const siteId = request.query.site_id || null;
  const { cleanCompanyName } = require("./features/b2b-detector");

  const rows = await fetchB2BAccounts({ days, siteId });
  const b2bAccounts = rows.map((r) => ({
    company_name: cleanCompanyName(r.raw_org),
    ...b2bCommonFields(r),
  }));

  return {
    as_of: new Date().toISOString(),
    window_days: days,
    site_id: siteId,
    total_corporate_accounts: b2bAccounts.length,
    accounts: b2bAccounts,
  };
});

// ---------------------------------------------------------------------------
// B2B ABM Portal & CRM Management APIs
// ---------------------------------------------------------------------------

fastify.get("/api/b2b/companies", { preHandler: [requireOperatorAuth] }, async (request) => {
  const days = Math.min(Math.max(parseInt(request.query.days, 10) || 30, 1), 90);
  const siteId = request.query.site_id || null;
  const { cleanCompanyName } = require("./features/b2b-detector");

  const rows = await fetchB2BAccounts({ days, siteId, withEnrichment: true });
  const companies = rows.map((r) => ({
    id: r.company_id || null,
    company_name: r.enriched_name || cleanCompanyName(r.raw_org),
    inn: r.inn || null,
    kpp: r.kpp || null,
    ogrn: r.ogrn || null,
    address: r.address || null,
    management_name: r.management_name || null,
    legal_status: r.legal_status || "UNKNOWN",
    is_enriched: Boolean(r.inn),
    ...b2bCommonFields(r),
  }));

  return {
    as_of: new Date().toISOString(),
    window_days: days,
    site_id: siteId,
    total_companies: companies.length,
    companies,
  };
});

fastify.post("/api/b2b/companies/enrich", { preHandler: [requireOperatorAuth] }, async (request) => {
  const rawOrg = request.body?.raw_org;
  if (!rawOrg) {
    return { success: false, error: "raw_org is required" };
  }
  const { getOrEnrichCompany } = require("./features/b2b-enrichment");
  const company = await getOrEnrichCompany(rawOrg, true);
  return {
    success: true,
    company,
  };
});

fastify.get("/api/crm/integrations", { preHandler: [requireOperatorAuth] }, async (request) => {
  const { rows } = await pool.query(
    `SELECT ci.*, s.domain AS site_domain
     FROM crm_integrations ci
     LEFT JOIN sites s ON s.site_id = ci.site_id
     ORDER BY ci.created_at DESC`
  );
  return { integrations: rows };
});

fastify.post("/api/crm/integrations", { preHandler: [requireOperatorAuth] }, async (request) => {
  const { site_id, crm_type, name, webhook_url, api_token, settings, enabled } = request.body || {};
  if (!crm_type || !name || !webhook_url) {
    return { success: false, error: "crm_type, name, and webhook_url are required" };
  }

  const { rows } = await pool.query(
    `INSERT INTO crm_integrations
       (site_id, crm_type, name, webhook_url, api_token, settings, enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [site_id || null, crm_type, name, webhook_url, api_token || null, JSON.stringify(settings || {}), enabled ?? true]
  );

  return { success: true, integration: rows[0] };
});

fastify.post("/api/crm/sync-now", { preHandler: [requireOperatorAuth] }, async (request) => {
  const siteId = request.body?.site_id || null;
  const dryRun = Boolean(request.body?.dry_run);
  const { syncPendingB2BLeads } = require("./jobs/crm-sync");
  const res = await syncPendingB2BLeads({ siteId, dryRun });
  return {
    success: true,
    timestamp: new Date().toISOString(),
    ...res,
  };
});

// ---------------------------------------------------------------------------
// Ad Optimization: Yandex Audiences & GA4 Measurement Protocol APIs
// ---------------------------------------------------------------------------

fastify.get("/api/audiences/status", { preHandler: [requireOperatorAuth] }, async (request) => {
  const siteId = request.query.site_id || null;
  const params = [];
  let siteClause = "";
  if (siteId) {
    params.push(siteId);
    siteClause = `AND s.site_id = $1`;
  }

  const { rows: sites } = await pool.query(
    `SELECT s.site_id, s.domain, s.yandex_counter_id,
            (SELECT json_agg(e ORDER BY e.exported_at DESC)
             FROM (
               SELECT DISTINCT ON (segment_type)
                 segment_id, segment_type, session_count, score_threshold, exported_at
               FROM yandex_audiences_exports
               WHERE site_id = s.site_id
               ORDER BY segment_type, exported_at DESC
             ) e) AS segments
     FROM sites s
     WHERE s.yandex_counter_id IS NOT NULL
     ${siteClause}
     ORDER BY s.domain;`,
    params
  );

  return {
    as_of: new Date().toISOString(),
    configured_sites: sites.length,
    sites,
  };
});

fastify.post("/api/audiences/export", { preHandler: [requireOperatorAuth] }, async (request) => {
  const siteId = request.body?.site_id || null;
  const type = request.body?.type || "all";
  const scoreThreshold = Number(request.body?.score_threshold) || 0.7;
  const dryRun = Boolean(request.body?.dry_run);

  const { run: runAudiencesExport } = require("./jobs/audiences-export");
  const result = await runAudiencesExport({ siteId, type, scoreThreshold, dryRun });
  return {
    success: true,
    timestamp: new Date().toISOString(),
    ...result,
  };
});

fastify.get("/api/ga4/status", { preHandler: [requireOperatorAuth] }, async (request) => {
  const siteId = request.query.site_id || null;
  const params = [];
  let siteClause = "";
  if (siteId) {
    params.push(siteId);
    siteClause = `AND s.site_id = $1`;
  }

  const { rows: sites } = await pool.query(
    `SELECT s.site_id, s.domain, s.ga4_measurement_id,
            (s.ga4_api_secret IS NOT NULL) AS has_api_secret,
            COUNT(ge.id)::int AS total_synced_events,
            MAX(ge.synced_at) AS last_synced_at
     FROM sites s
     LEFT JOIN ga4_conversions_exports ge ON ge.site_id = s.site_id
     WHERE s.ga4_measurement_id IS NOT NULL
     ${siteClause}
     GROUP BY s.site_id, s.domain, s.ga4_measurement_id, s.ga4_api_secret
     ORDER BY s.domain;`,
    params
  );

  return {
    as_of: new Date().toISOString(),
    configured_sites: sites.length,
    sites,
  };
});

fastify.post("/api/ga4/sync", { preHandler: [requireOperatorAuth] }, async (request) => {
  const siteId = request.body?.site_id || null;
  const threshold = Number(request.body?.threshold) || 0.7;
  const dryRun = Boolean(request.body?.dry_run);
  const debug = Boolean(request.body?.debug);

  const { run: runGa4Export } = require("./jobs/ga4-conversions");
  const result = await runGa4Export({ siteId, threshold, dryRun, debug });
  return {
    success: true,
    timestamp: new Date().toISOString(),
    ...result,
  };
});

// ---------------------------------------------------------------------------
// Metrica reconciliation read API
// ---------------------------------------------------------------------------

fastify.get("/api/reconciliation/daily", { preHandler: [requireOperatorAuth] }, async (request, reply) => {
  const days = Math.min(Math.max(parseInt(request.query.days, 10) || 30, 1), 365);
  const siteId = request.query.site_id || null;

  const params = [days];
  let siteClause = "";
  if (siteId) {
    params.push(siteId);
    siteClause = `AND r.site_id = $${params.length}`;
  }

  const { rows } = await pool.query(
    `SELECT r.site_id,
            s.domain,
            r.date,
            r.metrica_visits,
            r.metrica_users,
            r.metrica_pageviews,
            r.metrica_goals_total,
            r.surfai_sessions,
            r.surfai_conversions,
            r.divergence_ratio,
            r.fetched_at
       FROM metrica_daily_reconciliation r
       JOIN sites s ON s.site_id = r.site_id
      WHERE r.date >= CURRENT_DATE - ($1::int) ${siteClause}
      ORDER BY r.date DESC, s.domain ASC`,
    params
  );

  return { days, site_id: siteId, rows };
});

// ---------------------------------------------------------------------------
// Health — single aggregated view for monitoring + operator sanity check
// ---------------------------------------------------------------------------

// Assumed Metrica OAuth token lifetime (Yandex issues long-lived tokens
// ~1 year). If YANDEX_METRICA_TOKEN_ISSUED_AT is set in env as YYYY-MM-DD,
// we compute days-remaining and warn when < this threshold.
const METRICA_TOKEN_TTL_DAYS = 365;
const METRICA_TOKEN_WARN_DAYS = 30;

fastify.get("/api/health", { preHandler: [requireOperatorAuth] }, async (_request, reply) => {
  const fs = require("node:fs/promises");
  const os = require("node:os");

  const checks = {};

  // --- Database: connectivity + trivial query latency ---------------------
  const dbStart = Date.now();
  try {
    await pool.query("SELECT 1");
    const latency = Date.now() - dbStart;
    checks.database = {
      ok: true,
      level: latency >= 500 ? "warn" : "ok",
      latency_ms: latency,
    };
  } catch (err) {
    checks.database = {
      ok: false,
      level: "critical",
      error: err.message.slice(0, 200),
    };
  }

  // --- Disk: free % on the filesystem containing the CWD -----------------
  try {
    const stat = await fs.statfs(process.cwd());
    const total = stat.blocks * stat.bsize;
    const free = stat.bavail * stat.bsize;
    const usedPct = +((1 - free / total) * 100).toFixed(1);
    checks.disk = {
      ok: usedPct < 90,
      level: usedPct >= 95 ? "critical" : usedPct >= 80 ? "warn" : "ok",
      used_percent: usedPct,
      free_bytes: free,
      total_bytes: total,
    };
  } catch (err) {
    checks.disk = { ok: false, error: err.message.slice(0, 200) };
  }

  // --- Memory: system-wide free/total ------------------------------------
  {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedPct = +((1 - freeMem / totalMem) * 100).toFixed(1);
    checks.memory = {
      ok: usedPct < 90,
      level: usedPct >= 95 ? "critical" : usedPct >= 85 ? "warn" : "ok",
      used_percent: usedPct,
      free_bytes: freeMem,
      total_bytes: totalMem,
    };
  }

  // --- Ingest liveness: when did we last persist any batch? --------------
  try {
    const { rows } = await pool.query(
      "SELECT MAX(received_at) AS last FROM raw_batches"
    );
    const last = rows[0].last;
    const ageSec = last ? Math.floor((Date.now() - new Date(last).getTime()) / 1000) : null;
    // Flapping around these thresholds is handled by the alerter's
    // consecutive-observation confirmation, not by widening the window —
    // 4h of silence is a lost day of traffic at ~500 sessions/day.
    const warnThreshold = parseInt(process.env.INGEST_SILENCE_WARN_SEC, 10) || 900; // default 15 min
    const critThreshold = parseInt(process.env.INGEST_SILENCE_CRIT_SEC, 10) || 3600; // default 1 hour

    checks.ingest_recent = {
      ok: ageSec == null || ageSec < warnThreshold,
      level: ageSec == null ? "ok" : ageSec >= critThreshold ? "critical" : ageSec >= warnThreshold ? "warn" : "ok",
      last_batch_at: last,
      age_seconds: ageSec,
    };
  } catch (err) {
    checks.ingest_recent = { ok: false, level: "critical", error: err.message.slice(0, 200) };
  }

  // --- Metrica reconcile timer: latest row age ---------------------------
  try {
    const { rows } = await pool.query(
      "SELECT MAX(fetched_at) AS last FROM metrica_daily_reconciliation"
    );
    const last = rows[0].last;
    const ageHours = last ? (Date.now() - new Date(last).getTime()) / 3600_000 : null;
    checks.metrica_reconcile_timer = {
      ok: ageHours == null || ageHours < 36,
      level: ageHours == null ? "ok" : ageHours >= 72 ? "critical" : ageHours >= 36 ? "warn" : "ok",
      last_fetched_at: last,
      age_hours: ageHours == null ? null : +ageHours.toFixed(1),
    };
  } catch (err) {
    checks.metrica_reconcile_timer = { ok: false, level: "warn", error: err.message.slice(0, 200) };
  }

  // --- Metrica OAuth token expiry (soft reminder) ------------------------
  const expiresAt = process.env.YANDEX_METRICA_TOKEN_EXPIRES_AT;
  const issued = process.env.YANDEX_METRICA_TOKEN_ISSUED_AT;
  let remaining = null;
  let source = null;
  if (expiresAt && /^\d{4}-\d{2}-\d{2}$/.test(expiresAt)) {
    const expiresMs = new Date(expiresAt + "T00:00:00Z").getTime();
    remaining = Math.floor((expiresMs - Date.now()) / (86400 * 1000));
    source = "expires_at";
  } else if (issued && /^\d{4}-\d{2}-\d{2}$/.test(issued)) {
    const issuedMs = new Date(issued + "T00:00:00Z").getTime();
    const ageDays = (Date.now() - issuedMs) / (86400 * 1000);
    remaining = Math.floor(METRICA_TOKEN_TTL_DAYS - ageDays);
    source = "issued_at_plus_ttl";
  }
  if (remaining != null) {
    checks.metrica_token_expiry = {
      ok: remaining > METRICA_TOKEN_WARN_DAYS,
      level: remaining <= 7 ? "critical" : remaining <= METRICA_TOKEN_WARN_DAYS ? "warn" : "ok",
      issued_at: issued || null,
      expires_at: expiresAt || null,
      days_remaining: remaining,
      source,
    };
  } else {
    checks.metrica_token_expiry = {
      ok: false,
      level: "warn",
      error: "Neither YANDEX_METRICA_TOKEN_EXPIRES_AT nor YANDEX_METRICA_TOKEN_ISSUED_AT set (expected YYYY-MM-DD)",
    };
  }

  // --- ML scorer freshness: max(model_scored_at) age --------------------
  try {
    const { rows } = await pool.query(
      "SELECT MAX(model_scored_at) AS last FROM session_features WHERE model_scored_at IS NOT NULL"
    );
    const last = rows[0].last;
    const ageSec = last ? Math.floor((Date.now() - new Date(last).getTime()) / 1000) : null;
    checks.ml_scoring_recent = {
      ok: ageSec == null || ageSec < 3600,
      level: ageSec == null ? "ok" : ageSec >= 7200 ? "critical" : ageSec >= 3600 ? "warn" : "ok",
      last_scored_at: last,
      age_seconds: ageSec,
    };
  } catch (err) {
    checks.ml_scoring_recent = { ok: false, level: "warn", error: err.message.slice(0, 200) };
  }

  // --- Ingest queue high-load throughput metrics --------------------------
  // Shed batches are accepted-then-discarded: the SDK already got {ok:true},
  // so silent data loss must not read as "ok". dropped_total is cumulative for
  // the process lifetime, so compare against the previous poll — a counter that
  // stopped moving is history, not an ongoing incident.
  const queueStats = ingestQueue.getStats();
  const queueFill = queueStats.max_queue_size
    ? queueStats.queue_size / queueStats.max_queue_size
    : 0;
  const droppedSinceLastPoll = queueStats.dropped_total - lastDroppedTotal;
  lastDroppedTotal = queueStats.dropped_total;
  const queueLevel =
    droppedSinceLastPoll > 0 ? "critical" : queueFill >= 0.5 ? "warn" : "ok";
  checks.ingest_queue = {
    ok: queueLevel === "ok",
    level: queueLevel,
    fill_ratio: +queueFill.toFixed(3),
    dropped_since_last_poll: droppedSinceLastPoll,
    ...queueStats,
  };

  // --- Aggregate status ---------------------------------------------------
  const levels = Object.values(checks).map((c) => c.level || (c.ok ? "ok" : "critical"));
  let status = "healthy";
  if (levels.includes("critical")) status = "unhealthy";
  else if (levels.includes("warn")) status = "degraded";

  reply.code(status === "unhealthy" ? 503 : 200);
  return {
    status,
    as_of: new Date().toISOString(),
    uptime_seconds: Math.floor(process.uptime()),
    checks,
  };
});

// ---------------------------------------------------------------------------
// Persistence (non-blocking, after HTTP reply)
// ---------------------------------------------------------------------------

async function persistBatch(sessionId, sentAt, events, projectId, siteId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Upsert session
    await client.query(
      `INSERT INTO sessions (session_id, project_id, site_id) VALUES ($1, $2, $3)
       ON CONFLICT (session_id) DO UPDATE SET last_seen_at = NOW()`,
      [sessionId, projectId, siteId]
    );

    // Insert raw batch
    const { rows } = await client.query(
      `INSERT INTO raw_batches (session_id, sent_at, event_count, payload, project_id, site_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [sessionId, sentAt, events.length, JSON.stringify({ events }), projectId, siteId]
    );
    const batchId = rows[0].id;

    // Insert individual events + handle goal conversions
    for (const event of events) {
      await client.query(
        `INSERT INTO events (session_id, type, data, ts, batch_id, project_id, site_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [sessionId, event.type, JSON.stringify(event.data), event.data.ts, batchId, projectId, siteId]
      );

      // Goal events → insert into conversions (with dedup check)
      if (event.type === "goal") {
        await persistGoalConversion(client, sessionId, event.data, projectId);
      }

      // Messenger click → auto-conversion
      if (event.type === "click" && event.data.hrefHost) {
        const MESSENGER_HOSTS = ["wa.me", "api.whatsapp.com", "t.me", "vk.me", "m.me", "viber.click"];
        const host = event.data.hrefHost.replace(/^www\./, "");
        if (MESSENGER_HOSTS.includes(host)) {
          await persistGoalConversion(client, sessionId, {
            goalId: "messenger_click",
            ts: event.data.ts,
            metadata: { host },
          }, projectId);
        }
      }
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Persist a goal conversion event into the conversions table.
 * Deduplicates: same goal_id + session_id within 5s window.
 */
async function persistGoalConversion(client, sessionId, goalData, projectId) {
  const { goalId, value, metadata, ts } = goalData;

  // Check if goal exists (auto-create js_sdk goals on first hit)
  const goalRes = await client.query(
    "SELECT goal_id FROM goals WHERE goal_id = $1 AND NOT is_deleted",
    [goalId]
  );
  let resolvedGoalId = goalId;
  if (goalRes.rows.length === 0) {
    // Auto-register as js_sdk goal
    await client.query(
      `INSERT INTO goals (goal_id, name, type, project_id) VALUES ($1, $2, 'js_sdk', $3)
       ON CONFLICT (goal_id) DO NOTHING`,
      [goalId, goalId, projectId]
    );
    resolvedGoalId = goalId;
  }

  // Dedup check: same goal + session within 5s
  const dedupRes = await client.query(
    `SELECT id FROM conversions
     WHERE session_id = $1 AND goal_id = $2 AND ts > $3
     LIMIT 1`,
    [sessionId, resolvedGoalId, ts - 5000]
  );
  if (dedupRes.rows.length > 0) return;

  // Insert conversion
  await client.query(
    `INSERT INTO conversions (session_id, goal_id, source, value, metadata, ts, project_id)
     VALUES ($1, $2, 'js_sdk', $3, $4, $5, $6)`,
    [sessionId, resolvedGoalId, value || null, JSON.stringify(metadata || {}), ts, projectId]
  );

  // Check if goal is primary
  const primaryRes = await client.query(
    "SELECT is_primary FROM goals WHERE goal_id = $1", [resolvedGoalId]
  );
  const isPrimary = primaryRes.rows[0]?.is_primary || false;

  // Update session_features converted flag. UPSERT: the goal event can arrive
  // in the same batch that first creates the session, before computeAndStore()
  // has written a features row — a plain UPDATE would lose the label.
  await client.query(
    `INSERT INTO session_features (session_id, converted, conversion_count${isPrimary ? ", primary_goal_converted" : ""})
     VALUES ($1, true, 1${isPrimary ? ", true" : ""})
     ON CONFLICT (session_id) DO UPDATE
     SET converted = true,
         conversion_count = COALESCE(session_features.conversion_count, 0) + 1
         ${isPrimary ? ", primary_goal_converted = true" : ""}`,
    [sessionId]
  );
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT, 10) || 3000;

// Graceful shutdown — drain buffered ingest jobs, then close the DB pool.
// Order matters: the queue holds accepted-but-unpersisted batches, and
// draining them needs a live pool.
fastify.addHook("onClose", async () => {
  try {
    await ingestQueue.flushAndDrain();
  } catch (err) {
    fastify.log.error({ err }, "failed to drain ingest queue on shutdown");
  }
  await pool.end();
});

// systemd sends SIGTERM on `systemctl restart`. Without an explicit handler
// Node exits immediately, `onClose` never runs, and every batch still buffered
// in the ingest queue is lost on each deploy.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    fastify.log.info({ signal, queued: ingestQueue.getStats().queue_size }, "shutting down");
    fastify.close().then(
      () => process.exit(0),
      (err) => {
        fastify.log.error({ err }, "graceful shutdown failed");
        process.exit(1);
      }
    );
  });
}

// Load GeoIP MMDB readers once at startup (optional — server keeps working
// without them, just with NULL geo_* columns on session_features).
// maxmind@5 is async-only, so we chain the listen() call after init().
geoip.init(fastify.log).finally(() => {
  fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
    if (err) {
      fastify.log.error(err);
      process.exit(1);
    }
  });
});
