const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

// ---------------------------------------------------------------------------
// Build a test Fastify app that mirrors server.js security behavior
// (avoids requiring server.js which calls .listen() and needs DB)
// ---------------------------------------------------------------------------

const fastify = require("fastify")({
  logger: false,
  bodyLimit: 256 * 1024,
});

// --- Simulated operator auth (mirrors server.js logic) --------------------

const TEST_OPERATOR_TOKEN = "test-secret-token-123";

async function requireOperatorAuth(request, reply) {
  const auth = request.headers.authorization || "";
  let token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token && request.query && request.query.token) {
    token = request.query.token;
  }
  if (!TEST_OPERATOR_TOKEN || token !== TEST_OPERATOR_TOKEN) {
    return reply.code(401).send({ error: "unauthorized" });
  }
}

// --- Simulated origin validation (mirrors server.js logic) ----------------

function validateOrigin(rawOrigin, allowedOrigins) {
  if (!rawOrigin) return true; // server-to-server — no Origin header
  let parsedOrigin;
  try { parsedOrigin = new URL(rawOrigin).origin; } catch { parsedOrigin = ""; }
  const allowedSet = new Set(allowedOrigins.map((ao) => {
    try { return new URL(ao).origin; } catch { return ao; }
  }));
  return allowedSet.has(parsedOrigin);
}

// --- siteKey requirement --------------------------------------------------

const ALLOW_INGEST_WITHOUT_SITEKEY = false; // secure default

// Minimal ingest schema
const ingestBodySchema = {
  type: "object",
  required: ["sessionId", "sentAt", "events"],
  additionalProperties: false,
  properties: {
    sessionId: { type: "string", minLength: 1 },
    siteKey: { type: "string", minLength: 1 },
    sentAt: { type: "integer" },
    events: { type: "array", minItems: 1, items: { type: "object" } },
  },
};

// --- Routes ---------------------------------------------------------------

// Public ingest — siteKey required by default
fastify.post("/api/events", { schema: { body: ingestBodySchema } }, async (request, reply) => {
  const { siteKey } = request.body;
  if (!siteKey && !ALLOW_INGEST_WITHOUT_SITEKEY) {
    return reply.code(400).send({ error: "siteKey is required" });
  }
  // Simulated origin check for known siteKey
  if (siteKey === "valid-key") {
    const rawOrigin = request.headers.origin || "";
    if (rawOrigin) {
      const allowed = validateOrigin(rawOrigin, ["https://mystore.com"]);
      if (!allowed) {
        return reply.code(403).send({ error: "origin not allowed" });
      }
    }
  } else if (siteKey) {
    return reply.code(403).send({ error: "unknown site key" });
  }
  return { ok: true };
});

// Protected operator endpoint
fastify.get("/api/sessions", { preHandler: [requireOperatorAuth] }, async () => {
  return { sessions: [] };
});

fastify.get("/api/projects", { preHandler: [requireOperatorAuth] }, async () => {
  return { projects: [] };
});

fastify.post("/api/goals", { preHandler: [requireOperatorAuth] }, async () => {
  return { goal: {} };
});

// --- Helpers --------------------------------------------------------------

const ts = Date.now();

function validPayload(overrides = {}) {
  return {
    sessionId: "test-session-123",
    siteKey: "valid-key",
    sentAt: ts,
    events: [{ type: "mouse", data: { x: 100, y: 200, ts } }],
    ...overrides,
  };
}

async function inject(url, opts = {}) {
  return fastify.inject({
    method: opts.method || "GET",
    url,
    payload: opts.payload,
    headers: opts.headers || {},
  });
}

// --- Tests ----------------------------------------------------------------

before(async () => { await fastify.ready(); });
after(async () => { await fastify.close(); });

describe("Operator auth — protected endpoints", () => {
  it("returns 401 for GET /api/sessions without token", async () => {
    const res = await inject("/api/sessions");
    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.equal(body.error, "unauthorized");
  });

  it("returns 401 for GET /api/projects without token", async () => {
    const res = await inject("/api/projects");
    assert.equal(res.statusCode, 401);
  });

  it("returns 401 with wrong token", async () => {
    const res = await inject("/api/sessions", {
      headers: { authorization: "Bearer wrong-token" },
    });
    assert.equal(res.statusCode, 401);
  });

  it("returns 200 with valid Bearer token", async () => {
    const res = await inject("/api/sessions", {
      headers: { authorization: "Bearer " + TEST_OPERATOR_TOKEN },
    });
    assert.equal(res.statusCode, 200);
  });

  it("returns 200 with token via query param (SSE fallback)", async () => {
    const res = await inject("/api/sessions?token=" + TEST_OPERATOR_TOKEN);
    assert.equal(res.statusCode, 200);
  });

  it("POST /api/goals returns 401 without token", async () => {
    const res = await inject("/api/goals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ name: "test", type: "page_rule" }),
    });
    assert.equal(res.statusCode, 401);
  });
});

describe("siteKey requirement", () => {
  it("rejects ingest without siteKey (secure default)", async () => {
    const res = await fastify.inject({
      method: "POST",
      url: "/api/events",
      payload: validPayload({ siteKey: undefined }),
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.equal(body.error, "siteKey is required");
  });

  it("accepts ingest with valid siteKey", async () => {
    const res = await fastify.inject({
      method: "POST",
      url: "/api/events",
      payload: validPayload(),
    });
    assert.equal(res.statusCode, 200);
  });

  it("rejects ingest with unknown siteKey", async () => {
    const res = await fastify.inject({
      method: "POST",
      url: "/api/events",
      payload: validPayload({ siteKey: "unknown-key-abc" }),
    });
    assert.equal(res.statusCode, 403);
  });
});

describe("Origin validation", () => {
  it("rejects browser request from disallowed origin", async () => {
    const res = await fastify.inject({
      method: "POST",
      url: "/api/events",
      payload: validPayload(),
      headers: { origin: "https://evil.com" },
    });
    assert.equal(res.statusCode, 403);
    const body = JSON.parse(res.body);
    assert.equal(body.error, "origin not allowed");
  });

  it("accepts request from allowed origin", async () => {
    const res = await fastify.inject({
      method: "POST",
      url: "/api/events",
      payload: validPayload(),
      headers: { origin: "https://mystore.com" },
    });
    assert.equal(res.statusCode, 200);
  });

  it("allows server-to-server request without Origin header", async () => {
    const res = await fastify.inject({
      method: "POST",
      url: "/api/events",
      payload: validPayload(),
    });
    assert.equal(res.statusCode, 200);
  });

  it("rejects origin with path suffix (startsWith bypass)", async () => {
    // "https://mystore.com.evil.com" should NOT match "https://mystore.com"
    const res = await fastify.inject({
      method: "POST",
      url: "/api/events",
      payload: validPayload(),
      headers: { origin: "https://mystore.com.evil.com" },
    });
    assert.equal(res.statusCode, 403);
  });
});

describe("POST /api/events — ingest remains public", () => {
  it("does not require operator auth token", async () => {
    const res = await fastify.inject({
      method: "POST",
      url: "/api/events",
      payload: validPayload(),
    });
    // Should be 200, not 401
    assert.equal(res.statusCode, 200);
  });
});

describe("Body size limit", () => {
  it("rejects oversized payload", async () => {
    // Generate a payload larger than 256KB
    const bigData = "x".repeat(300 * 1024);
    const res = await fastify.inject({
      method: "POST",
      url: "/api/events",
      payload: bigData,
      headers: { "content-type": "application/json" },
    });
    // Fastify returns 400 for body too large (FST_ERR_CTP_BODY_TOO_LARGE) or parse error
    assert.ok([400, 413].includes(res.statusCode), `expected 400 or 413, got ${res.statusCode}`);
  });
});
