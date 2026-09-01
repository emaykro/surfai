"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { confirmLevels, applyLevels, buildTransitionReport } = require("../jobs/health-alert");

// Helper: run one alerter tick against a prior state and return what the
// alerter would persist plus the lines it would have sent.
function tick(prior, checks) {
  const current = { status: "ignored", checks };
  const { effective, streak } = confirmLevels(prior, current);
  const confirmed = applyLevels(current, effective);
  const transitions = buildTransitionReport(prior, confirmed);
  return {
    state: { status: confirmed.status, checks: confirmed.checks, effective, streak },
    transitions,
    // Check names are escaped for Telegram Markdown (ingest_recent →
    // ingest\_recent), so match against an unescaped copy.
    plain: transitions.map((l) => l.replace(/\\/g, "")),
    alerted: transitions.length > 0,
  };
}

const OK = { ok: true, level: "ok" };
const WARN = { ok: true, level: "warn", age_seconds: 950 };
const CRIT = { ok: false, level: "critical", age_seconds: 237812 };

describe("health alerter level confirmation", () => {
  test("does not alert on a single-poll warn blip", () => {
    let s = tick(null, { ingest_recent: OK, database: OK }).state;
    const r = tick(s, { ingest_recent: WARN, database: OK });
    assert.equal(r.alerted, false);
    assert.equal(r.state.status, "healthy");
  });

  test("night-time ingest flapping stays silent across many polls", () => {
    // The exact prod pattern: ok/warn alternating around the threshold.
    let s = tick(null, { ingest_recent: OK, database: OK }).state;
    let alerts = 0;
    for (const level of [WARN, OK, WARN, OK, WARN, OK, WARN, OK]) {
      const r = tick(s, { ingest_recent: level, database: OK });
      if (r.alerted) alerts++;
      s = r.state;
    }
    assert.equal(alerts, 0, "flapping must not page");
  });

  test("alerts once a warn is sustained across consecutive polls", () => {
    let s = tick(null, { ingest_recent: OK, database: OK }).state;
    const first = tick(s, { ingest_recent: WARN, database: OK });
    assert.equal(first.alerted, false);
    const second = tick(first.state, { ingest_recent: WARN, database: OK });
    assert.equal(second.alerted, true);
    assert.equal(second.state.status, "degraded");
    assert.ok(second.plain.some((l) => l.includes("ingest_recent")));
  });

  test("a sustained critical still pages — the ML scoring outage case", () => {
    let s = tick(null, { ml_scoring_recent: OK, database: OK }).state;
    const first = tick(s, { ml_scoring_recent: CRIT, database: OK });
    const second = tick(first.state, { ml_scoring_recent: CRIT, database: OK });
    assert.equal(second.alerted, true);
    assert.equal(second.state.status, "unhealthy");
    assert.ok(second.plain.some((l) => l.includes("ml_scoring_recent")));
  });

  test("a real outage is not masked by an unrelated flapping check", () => {
    // Regression guard for the shipped bug: suppression keyed on overall
    // status swallowed nothing while status was already unhealthy, and the
    // flapping check drowned the real one in noise.
    let s = tick(null, { ingest_recent: OK, ml_scoring_recent: OK }).state;
    let alerts = [];
    for (const ingest of [WARN, OK, WARN, OK]) {
      const r = tick(s, { ingest_recent: ingest, ml_scoring_recent: CRIT });
      if (r.alerted) alerts.push(r.plain);
      s = r.state;
    }
    assert.equal(alerts.length, 1, "exactly one page: the ML outage");
    assert.ok(alerts[0].some((l) => l.includes("ml_scoring_recent")));
    assert.ok(!alerts[0].some((l) => l.includes("ingest_recent")));
  });

  test("recovery to ok is reported without waiting for confirmation", () => {
    let s = tick(null, { ml_scoring_recent: OK }).state;
    s = tick(s, { ml_scoring_recent: CRIT }).state;
    s = tick(s, { ml_scoring_recent: CRIT }).state; // confirmed critical
    const recovered = tick(s, { ml_scoring_recent: OK });
    assert.equal(recovered.alerted, true);
    assert.equal(recovered.state.status, "healthy");
  });
});
