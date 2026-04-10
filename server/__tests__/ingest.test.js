const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

// Build a lightweight test app with the same schemas as server.js
// (avoids requiring server.js which calls .listen())

const fastify = require("fastify")({ logger: false });
fastify.register(require("@fastify/cors"), { origin: "*" });

// ---------------------------------------------------------------------------
// Schemas (must mirror server.js exactly)
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
    // Extended fields (added 2026-04-10) — optional on validation
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

const performanceDataSchema = {
  type: "object",
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
    { if: { properties: { type: { const: "mouse" } } }, then: { properties: { data: mouseDataSchema } } },
    { if: { properties: { type: { const: "scroll" } } }, then: { properties: { data: scrollDataSchema } } },
    { if: { properties: { type: { const: "idle" } } }, then: { properties: { data: idleDataSchema } } },
    { if: { properties: { type: { const: "click" } } }, then: { properties: { data: clickDataSchema } } },
    { if: { properties: { type: { const: "form" } } }, then: { properties: { data: formDataSchema } } },
    { if: { properties: { type: { const: "engagement" } } }, then: { properties: { data: engagementDataSchema } } },
    { if: { properties: { type: { const: "session" } } }, then: { properties: { data: sessionDataSchema } } },
    { if: { properties: { type: { const: "context" } } }, then: { properties: { data: contextDataSchema } } },
    { if: { properties: { type: { const: "cross_session" } } }, then: { properties: { data: crossSessionDataSchema } } },
    { if: { properties: { type: { const: "goal" } } }, then: { properties: { data: goalDataSchema } } },
    { if: { properties: { type: { const: "performance" } } }, then: { properties: { data: performanceDataSchema } } },
  ],
};

const ingestBodySchema = {
  type: "object",
  required: ["sessionId", "sentAt", "events"],
  additionalProperties: false,
  properties: {
    sessionId: { type: "string", minLength: 1 },
    sentAt: { type: "integer" },
    events: { type: "array", minItems: 1, items: eventItemSchema },
  },
};

fastify.post("/api/events", { schema: { body: ingestBodySchema } }, async () => ({ ok: true }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ts = Date.now();

function validPayload(overrides = {}) {
  return {
    sessionId: "test-session-123",
    sentAt: ts,
    events: [{ type: "mouse", data: { x: 100, y: 200, ts } }],
    ...overrides,
  };
}

async function inject(payload) {
  return fastify.inject({ method: "POST", url: "/api/events", payload });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

before(async () => { await fastify.ready(); });
after(async () => { await fastify.close(); });

describe("POST /api/events — core event types", () => {
  it("accepts valid mouse event", async () => {
    const res = await inject(validPayload());
    assert.equal(res.statusCode, 200);
  });

  it("accepts valid scroll event", async () => {
    const res = await inject(validPayload({ events: [{ type: "scroll", data: { percent: 42, ts } }] }));
    assert.equal(res.statusCode, 200);
  });

  it("accepts valid idle event", async () => {
    const res = await inject(validPayload({ events: [{ type: "idle", data: { idleMs: 12000, ts } }] }));
    assert.equal(res.statusCode, 200);
  });
});

describe("POST /api/events — Phase 2 event types", () => {
  it("accepts valid click event", async () => {
    const res = await inject(validPayload({
      events: [{ type: "click", data: { x: 100, y: 200, elType: "button", elTagHash: 123456, isCta: true, isExternal: false, timeSinceStart: 5000, ts } }],
    }));
    assert.equal(res.statusCode, 200);
  });

  it("accepts valid form event", async () => {
    const res = await inject(validPayload({
      events: [{ type: "form", data: { action: "focus", formHash: 789, fieldIndex: 0, fieldType: "email", fillDurationMs: 0, ts } }],
    }));
    assert.equal(res.statusCode, 200);
  });

  it("accepts valid engagement event", async () => {
    const res = await inject(validPayload({
      events: [{ type: "engagement", data: { activeMs: 30000, idleMs: 5000, maxScrollPercent: 85, scrollSpeed: "medium", microScrolls: 3, readthrough: true, ts } }],
    }));
    assert.equal(res.statusCode, 200);
  });

  it("accepts valid session event", async () => {
    const res = await inject(validPayload({
      events: [{ type: "session", data: { pageCount: 3, avgNavSpeedMs: 2000, isBounce: false, isHyperEngaged: false, timeBucket: "day", ts } }],
    }));
    assert.equal(res.statusCode, 200);
  });

  it("accepts valid context event", async () => {
    const res = await inject(validPayload({
      events: [{ type: "context", data: { trafficSource: "organic", deviceType: "desktop", browser: "Chrome", os: "macOS", screenW: 1920, screenH: 1080, language: "en", connectionType: "4g", ts } }],
    }));
    assert.equal(res.statusCode, 200);
  });

  it("accepts context event with extended fields (timezone, viewport, utm, hardware)", async () => {
    const res = await inject(validPayload({
      events: [{
        type: "context",
        data: {
          trafficSource: "paid",
          deviceType: "mobile",
          browser: "Chrome",
          os: "Android",
          screenW: 390,
          screenH: 844,
          language: "ru-RU",
          connectionType: "4g",
          timezone: "Europe/Moscow",
          timezoneOffset: -180,
          languages: ["ru-RU", "ru", "en"],
          viewportW: 390,
          viewportH: 720,
          devicePixelRatio: 3,
          colorScheme: "dark",
          reducedMotion: false,
          hardwareConcurrency: 8,
          deviceMemory: 4,
          referrerHost: "yandex.ru",
          utmSource: "yandex",
          utmMedium: "cpc",
          utmCampaign: "spring_sale",
          utmTerm: "analytics",
          utmContent: "ad1",
          ts,
        },
      }],
    }));
    assert.equal(res.statusCode, 200);
  });

  it("accepts valid cross_session event", async () => {
    const res = await inject(validPayload({
      events: [{ type: "cross_session", data: { visitorId: "abc-123", visitNumber: 2, returnWithin24h: true, returnWithin7d: true, ts } }],
    }));
    assert.equal(res.statusCode, 200);
  });

  it("accepts valid goal event", async () => {
    const res = await inject(validPayload({
      events: [{ type: "goal", data: { goalId: "purchase", ts } }],
    }));
    assert.equal(res.statusCode, 200);
  });

  it("accepts valid performance event with nulls for unknown metrics", async () => {
    const res = await inject(validPayload({
      events: [{
        type: "performance",
        data: {
          lcp: 2400,
          fcp: 1200,
          fid: 18,
          inp: 80,
          cls: 0.0523,
          ttfb: 340,
          domInteractive: 1800,
          domContentLoaded: 2100,
          loadEvent: 3500,
          transferSize: 45230,
          longTaskCount: 3,
          longTaskTotalMs: 280,
          ts,
        },
      }],
    }));
    assert.equal(res.statusCode, 200);
  });

  it("accepts performance event with all vitals as null (bounce session)", async () => {
    const res = await inject(validPayload({
      events: [{
        type: "performance",
        data: {
          lcp: null,
          fcp: null,
          fid: null,
          inp: null,
          cls: null,
          ttfb: null,
          domInteractive: null,
          domContentLoaded: null,
          loadEvent: null,
          transferSize: null,
          longTaskCount: 0,
          longTaskTotalMs: 0,
          ts,
        },
      }],
    }));
    assert.equal(res.statusCode, 200);
  });

  it("accepts goal event with value and metadata", async () => {
    const res = await inject(validPayload({
      events: [{ type: "goal", data: { goalId: "signup", value: 49.99, metadata: { plan: "pro" }, ts } }],
    }));
    assert.equal(res.statusCode, 200);
  });

  it("accepts mixed Phase 1 + Phase 2 events in one batch", async () => {
    const res = await inject(validPayload({
      events: [
        { type: "mouse", data: { x: 10, y: 20, ts } },
        { type: "click", data: { x: 10, y: 20, elType: "link", elTagHash: 111, isCta: false, isExternal: true, timeSinceStart: 1000, ts } },
        { type: "context", data: { trafficSource: "direct", deviceType: "mobile", browser: "Safari", os: "iOS", screenW: 375, screenH: 812, language: "ru", connectionType: "4g", ts } },
      ],
    }));
    assert.equal(res.statusCode, 200);
  });
});

describe("POST /api/events — rejections", () => {
  it("rejects empty sessionId", async () => {
    const res = await inject(validPayload({ sessionId: "" }));
    assert.equal(res.statusCode, 400);
  });

  it("rejects missing sessionId", async () => {
    const p = validPayload();
    delete p.sessionId;
    assert.equal((await inject(p)).statusCode, 400);
  });

  it("rejects missing events", async () => {
    const p = validPayload();
    delete p.events;
    assert.equal((await inject(p)).statusCode, 400);
  });

  it("rejects empty events array", async () => {
    assert.equal((await inject(validPayload({ events: [] }))).statusCode, 400);
  });

  it("rejects truly unknown event type", async () => {
    assert.equal((await inject(validPayload({ events: [{ type: "pageview", data: { ts } }] }))).statusCode, 400);
  });

  it("rejects scroll percent > 100", async () => {
    assert.equal((await inject(validPayload({ events: [{ type: "scroll", data: { percent: 150, ts } }] }))).statusCode, 400);
  });

  it("rejects scroll percent < 0", async () => {
    assert.equal((await inject(validPayload({ events: [{ type: "scroll", data: { percent: -1, ts } }] }))).statusCode, 400);
  });

  it("rejects string for numeric sentAt", async () => {
    assert.equal((await inject(validPayload({ sentAt: "bad" }))).statusCode, 400);
  });

  it("rejects mouse data missing required field", async () => {
    assert.equal((await inject(validPayload({ events: [{ type: "mouse", data: { y: 200, ts } }] }))).statusCode, 400);
  });

  it("rejects click event missing required fields", async () => {
    assert.equal((await inject(validPayload({ events: [{ type: "click", data: { x: 10, ts } }] }))).statusCode, 400);
  });

  it("rejects form event with invalid action", async () => {
    assert.equal((await inject(validPayload({
      events: [{ type: "form", data: { action: "invalid", formHash: 0, fieldIndex: 0, fieldType: "text", fillDurationMs: 0, ts } }],
    }))).statusCode, 400);
  });

  it("rejects engagement event with invalid scrollSpeed", async () => {
    assert.equal((await inject(validPayload({
      events: [{ type: "engagement", data: { activeMs: 0, idleMs: 0, maxScrollPercent: 50, scrollSpeed: "turbo", microScrolls: 0, readthrough: false, ts } }],
    }))).statusCode, 400);
  });

  it("rejects goal event missing goalId", async () => {
    assert.equal((await inject(validPayload({
      events: [{ type: "goal", data: { ts } }],
    }))).statusCode, 400);
  });

  it("rejects goal event with empty goalId", async () => {
    assert.equal((await inject(validPayload({
      events: [{ type: "goal", data: { goalId: "", ts } }],
    }))).statusCode, 400);
  });

  it("rejects session event with invalid timeBucket", async () => {
    assert.equal((await inject(validPayload({
      events: [{ type: "session", data: { pageCount: 1, avgNavSpeedMs: 0, isBounce: true, isHyperEngaged: false, timeBucket: "midnight", ts } }],
    }))).statusCode, 400);
  });
});
