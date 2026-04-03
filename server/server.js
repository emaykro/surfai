require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const path = require("path");
const fastify = require("fastify")({ logger: true });
const { pool } = require("./db");
const { computeAndStore } = require("./features/store");

// ---------------------------------------------------------------------------
// CORS — explicit origins; never open `*` in production
// ---------------------------------------------------------------------------

const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:3000";

fastify.register(require("@fastify/cors"), {
  origin: CORS_ORIGIN.split(",").map((o) => o.trim()),
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
  decorateReply: false, // second static plugin needs this
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

const ALL_EVENT_TYPES = ["mouse", "scroll", "idle", "click", "form", "engagement", "session", "context", "cross_session", "goal"];

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
  ],
};

const ingestBodySchema = {
  type: "object",
  required: ["sessionId", "sentAt", "events"],
  additionalProperties: false,
  properties: {
    sessionId: { type: "string", minLength: 1 },
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
    const { sessionId, sentAt, events } = request.body;
    fastify.log.info({ sessionId, eventCount: events.length }, "batch received");

    // Respond immediately — DB write must not block the client
    reply.send({ ok: true });

    // Fire-and-forget persistence + SSE broadcast + feature recomputation
    persistBatch(sessionId, sentAt, events)
      .then(() => {
        broadcastSSE({ sessionId, sentAt, events });
        // Recompute features after new data is persisted
        return computeAndStore(sessionId);
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

fastify.get("/api/events/live", (request, reply) => {
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

fastify.get("/api/sessions", async (request) => {
  const limit = Math.min(parseInt(request.query.limit, 10) || 50, 200);
  const offset = Math.max(parseInt(request.query.offset, 10) || 0, 0);

  const { rows } = await pool.query(
    `SELECT s.session_id, s.first_seen_at, s.last_seen_at,
            COUNT(e.id)::int AS event_count
     FROM sessions s
     LEFT JOIN events e ON e.session_id = s.session_id
     GROUP BY s.id
     ORDER BY s.last_seen_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );

  return { sessions: rows };
});

// ---------------------------------------------------------------------------
// GET /api/sessions/:sessionId — session detail with events
// ---------------------------------------------------------------------------

fastify.get("/api/sessions/:sessionId", async (request, reply) => {
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
  },
};

// POST /api/goals — create goal
fastify.post("/api/goals", { schema: { body: goalBodySchema } }, async (request, reply) => {
  const { name, type, rules, is_primary, attribution_window_ms } = request.body;
  const tenantId = request.headers["x-tenant-id"] || "default";

  const { rows } = await pool.query(
    `INSERT INTO goals (tenant_id, name, type, rules, is_primary, attribution_window_ms)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [tenantId, name, type, JSON.stringify(rules || {}), is_primary || false, attribution_window_ms || 1800000]
  );

  return reply.code(201).send({ goal: rows[0] });
});

// GET /api/goals — list goals
fastify.get("/api/goals", async (request) => {
  const tenantId = request.headers["x-tenant-id"] || "default";

  const { rows } = await pool.query(
    "SELECT * FROM goals WHERE tenant_id = $1 AND NOT is_deleted ORDER BY created_at DESC",
    [tenantId]
  );

  return { goals: rows };
});

// PUT /api/goals/:goalId — update goal
fastify.put("/api/goals/:goalId", async (request, reply) => {
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
fastify.delete("/api/goals/:goalId", async (request, reply) => {
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

fastify.post("/api/conversions", { schema: { body: conversionBodySchema } }, async (request, reply) => {
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

  // Update session_features
  await pool.query(
    `UPDATE session_features
     SET converted = true, conversion_count = COALESCE(conversion_count, 0) + 1
     WHERE session_id = $1`,
    [resolvedSessionId]
  );

  return reply.code(201).send({ ok: true, sessionId: resolvedSessionId });
});

// ---------------------------------------------------------------------------
// GET /api/sessions/:sessionId/conversions — conversions for a session
// ---------------------------------------------------------------------------

fastify.get("/api/sessions/:sessionId/conversions", async (request, reply) => {
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

fastify.get("/api/sessions/:sessionId/features", async (request, reply) => {
  const { sessionId } = request.params;

  const features = await getFeatures(sessionId);
  if (!features) {
    return reply.code(404).send({ error: "no features computed for this session" });
  }

  return { sessionId, features };
});

// ---------------------------------------------------------------------------
// Persistence (non-blocking, after HTTP reply)
// ---------------------------------------------------------------------------

async function persistBatch(sessionId, sentAt, events) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Upsert session
    await client.query(
      `INSERT INTO sessions (session_id) VALUES ($1)
       ON CONFLICT (session_id) DO UPDATE SET last_seen_at = NOW()`,
      [sessionId]
    );

    // Insert raw batch
    const { rows } = await client.query(
      `INSERT INTO raw_batches (session_id, sent_at, event_count, payload)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [sessionId, sentAt, events.length, JSON.stringify({ events })]
    );
    const batchId = rows[0].id;

    // Insert individual events + handle goal conversions
    for (const event of events) {
      await client.query(
        `INSERT INTO events (session_id, type, data, ts, batch_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [sessionId, event.type, JSON.stringify(event.data), event.data.ts, batchId]
      );

      // Goal events → insert into conversions (with dedup check)
      if (event.type === "goal") {
        await persistGoalConversion(client, sessionId, event.data);
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
async function persistGoalConversion(client, sessionId, goalData) {
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
      `INSERT INTO goals (goal_id, name, type) VALUES ($1, $2, 'js_sdk')
       ON CONFLICT (goal_id) DO NOTHING`,
      [goalId, goalId]
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
    `INSERT INTO conversions (session_id, goal_id, source, value, metadata, ts)
     VALUES ($1, $2, 'js_sdk', $3, $4, $5)`,
    [sessionId, resolvedGoalId, value || null, JSON.stringify(metadata || {}), ts]
  );

  // Update session_features converted flag
  await client.query(
    `UPDATE session_features
     SET converted = true,
         conversion_count = COALESCE(conversion_count, 0) + 1
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

fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
});
