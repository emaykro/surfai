"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  sanitizeDuration,
  SESSION_MAX_PLAUSIBLE_MS,
  extractAllFeatures,
} = require("../features/extractors");

const HOUR = 3600 * 1000;

describe("session duration guard", () => {
  test("keeps plausible durations untouched", () => {
    assert.equal(sanitizeDuration(0), 0);
    assert.equal(sanitizeDuration(54_188), 54_188); // prod median
    assert.equal(sanitizeDuration(24 * HOUR), 24 * HOUR); // at the SDK cap
  });

  test("nulls the 148-day sessions the missing expiry produced", () => {
    // sessionStorage survives tab restore, so one prod session ran from
    // 2026-04-06 to 2026-09-01 and its features were sums over that span.
    assert.equal(sanitizeDuration(148 * 24 * HOUR), null);
    assert.equal(sanitizeDuration(SESSION_MAX_PLAUSIBLE_MS + 1), null);
  });

  test("leaves slack above the SDK cap for clocks and stale bundles", () => {
    // Cached bundles keep arriving for about an hour after a deploy, and
    // client clocks disagree; 24h exactly must not be rejected.
    assert.ok(SESSION_MAX_PLAUSIBLE_MS > 24 * HOUR);
    assert.equal(sanitizeDuration(25 * HOUR), 25 * HOUR);
  });

  test("rejects negative and non-finite values", () => {
    assert.equal(sanitizeDuration(-1), null);
    assert.equal(sanitizeDuration(NaN), null);
    assert.equal(sanitizeDuration(Infinity), null);
    assert.equal(sanitizeDuration(null), null);
    assert.equal(sanitizeDuration(undefined), null);
  });
});

describe("session duration through the full extractor", () => {
  const ev = (type, ts, extra = {}) => ({ type, data: { ts, ...extra } });
  // extractSession() only runs when the session collector emitted its summary,
  // so every fixture needs one.
  const sessionEv = (ts) =>
    ev("session", ts, {
      pageCount: 1,
      avgNavSpeedMs: 0,
      isBounce: false,
      isHyperEngaged: false,
      timeBucket: "day",
    });

  test("computes a normal session span", () => {
    const base = Date.parse("2026-09-01T12:00:00Z");
    const events = [
      ev("mouse", base, { x: 1, y: 2 }),
      ev("scroll", base + 30_000, { percent: 40 }),
      sessionEv(base + 60_000),
      ev("mouse", base + 90_000, { x: 5, y: 9 }),
    ];
    const f = extractAllFeatures(events);
    assert.equal(f.session_duration_ms, 90_000);
  });

  test("a months-long span reaches the feature store as null, not a number", () => {
    const base = Date.parse("2026-04-06T18:11:38Z");
    const events = [
      ev("mouse", base, { x: 1, y: 2 }),
      sessionEv(base + HOUR),
      ev("mouse", base + 148 * 24 * HOUR, { x: 3, y: 4 }),
    ];
    const f = extractAllFeatures(events);
    assert.equal(f.session_duration_ms, null);
  });
});
