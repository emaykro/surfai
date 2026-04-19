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

const ALL_EVENT_TYPES = ["mouse", "scroll", "idle", "click", "form", "engagement", "session", "context", "cross_session", "goal", "bot_signals", "performance"];

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

    // Respond immediately — DB write must not block the client
    reply.send({ ok: true });

    // Fire-and-forget persistence + SSE broadcast + feature recomputation
    persistBatch(sessionId, sentAt, events, projectId, siteId)
      .then(() => {
        broadcastSSE({ sessionId, sentAt, events, projectId });
        // Recompute features after new data is persisted. clientIp and
        // uaHints are passed through so GeoIP lookup and UA-CH data land
        // in session_features in the same UPSERT as the behavioral features.
        return computeAndStore(sessionId, projectId, siteId, clientIp, uaHints);
      })
      .then(() => {
        fastify.log.debug({ sessionId }, "features recomputed");
      })
      .catch((err) => {
        fastify.log.error({ err, sessionId }, "failed to persist batch or compute features");
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
// ---------------------------------------------------------------------------

fastify.get("/api/sessions", { preHandler: [requireOperatorAuth] }, async (request) => {
  const limit = Math.min(parseInt(request.query.limit, 10) || 50, 200);
  const offset = Math.max(parseInt(request.query.offset, 10) || 0, 0);
  const projectId = request.query.project_id;

  let whereClause = "";
  const params = [limit, offset];

  if (projectId) {
    whereClause = "WHERE s.project_id = $3";
    params.push(projectId);
  }

  const { rows } = await pool.query(
    `SELECT s.session_id, s.first_seen_at, s.last_seen_at, s.project_id, s.site_id,
            COUNT(e.id)::int AS event_count
     FROM sessions s
     LEFT JOIN events e ON e.session_id = s.session_id
     ${whereClause}
     GROUP BY s.id
     ORDER BY s.last_seen_at DESC
     LIMIT $1 OFFSET $2`,
    params
  );

  return { sessions: rows };
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

  // Update session_features
  await pool.query(
    `UPDATE session_features
     SET converted = true,
         conversion_count = COALESCE(conversion_count, 0) + 1
         ${isPrimary ? ", primary_goal_converted = true" : ""}
     WHERE session_id = $1`,
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

  // Update session_features converted flag
  await client.query(
    `UPDATE session_features
     SET converted = true,
         conversion_count = COALESCE(conversion_count, 0) + 1
         ${isPrimary ? ", primary_goal_converted = true" : ""}
     WHERE session_id = $1`,
    [sessionId]
  );
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT, 10) || 3000;

// Graceful shutdown — close DB pool
fastify.addHook("onClose", async () => {
  await pool.end();
});

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
