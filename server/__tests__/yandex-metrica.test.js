"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { fetchDailyStats, fetchVisitLogs } = require("../features/yandex-metrica");

const REAL_FETCH = global.fetch;

function mockFetch(responder) {
  global.fetch = async (url, opts) => {
    const { status, body } = await responder(String(url), opts);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
      json: async () => (typeof body === "string" ? JSON.parse(body) : body),
    };
  };
}

describe("Yandex Metrica client", () => {
  before(() => {
    process.env.YANDEX_METRICA_TOKEN = "test-token";
  });

  after(() => {
    global.fetch = REAL_FETCH;
    delete process.env.YANDEX_METRICA_TOKEN;
  });

  describe("fetchDailyStats", () => {
    it("rejects invalid counterId", async () => {
      await assert.rejects(() => fetchDailyStats("not-a-number", "2026-04-18"), /Invalid counterId/);
      await assert.rejects(() => fetchDailyStats(0, "2026-04-18"), /Invalid counterId/);
      await assert.rejects(() => fetchDailyStats(-1, "2026-04-18"), /Invalid counterId/);
    });

    it("rejects invalid date format", async () => {
      await assert.rejects(() => fetchDailyStats(123, "2026/04/18"), /Invalid date/);
      await assert.rejects(() => fetchDailyStats(123, "18-04-2026"), /Invalid date/);
      await assert.rejects(() => fetchDailyStats(123, ""), /Invalid date/);
    });

    it("builds the expected Reports API request and parses totals", async () => {
      let seenUrl = null;
      let seenAuth = null;
      mockFetch(async (url, opts) => {
        seenUrl = url;
        seenAuth = opts.headers.Authorization;
        return {
          status: 200,
          body: { totals: [1234.0, 987.0, 4567.0] },
        };
      });

      const result = await fetchDailyStats(98036553, "2026-04-18");

      assert.match(seenUrl, /\/stat\/v1\/data\?/);
      assert.match(seenUrl, /ids=98036553/);
      assert.match(seenUrl, /date1=2026-04-18/);
      assert.match(seenUrl, /date2=2026-04-18/);
      assert.match(seenUrl, /ym%3As%3Avisits/);
      assert.match(seenUrl, /ym%3As%3Ausers/);
      assert.match(seenUrl, /ym%3As%3Apageviews/);
      assert.ok(!/accuracy=/.test(seenUrl), "accuracy param should be omitted");
      assert.equal(seenAuth, "OAuth test-token");

      assert.deepEqual(result, {
        visits: 1234,
        users: 987,
        pageviews: 4567,
        goalsTotal: null,
      });
    });

    it("returns zeros when totals array is empty", async () => {
      mockFetch(async () => ({ status: 200, body: { totals: [] } }));
      const result = await fetchDailyStats(123, "2026-04-18");
      assert.deepEqual(result, { visits: 0, users: 0, pageviews: 0, goalsTotal: null });
    });

    it("classifies 401 as TOKEN_INVALID", async () => {
      mockFetch(async () => ({ status: 401, body: { message: "invalid token" } }));
      await assert.rejects(
        () => fetchDailyStats(123, "2026-04-18"),
        (err) => err.code === "TOKEN_INVALID" && err.status === 401
      );
    });

    it("classifies 429 as RATE_LIMIT", async () => {
      mockFetch(async () => ({ status: 429, body: { message: "too many" } }));
      await assert.rejects(
        () => fetchDailyStats(123, "2026-04-18"),
        (err) => err.code === "RATE_LIMIT"
      );
    });

    it("classifies 500 as SERVER_ERROR", async () => {
      mockFetch(async () => ({ status: 502, body: "gateway" }));
      await assert.rejects(
        () => fetchDailyStats(123, "2026-04-18"),
        (err) => err.code === "SERVER_ERROR"
      );
    });
  });

  describe("fetchVisitLogs", () => {
    it("is scaffolded for Slice 3 and throws until implemented", async () => {
      await assert.rejects(() => fetchVisitLogs(), /Slice 3/);
    });
  });

  describe("token guard", () => {
    it("throws TOKEN_MISSING when env var is absent", async () => {
      const saved = process.env.YANDEX_METRICA_TOKEN;
      delete process.env.YANDEX_METRICA_TOKEN;
      try {
        await assert.rejects(
          () => fetchDailyStats(123, "2026-04-18"),
          (err) => err.code === "TOKEN_MISSING"
        );
      } finally {
        process.env.YANDEX_METRICA_TOKEN = saved;
      }
    });
  });
});
