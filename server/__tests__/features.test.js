"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  extractAllFeatures,
  extractMouse,
  extractScroll,
  extractClicks,
  extractForm,
  slidingWindow,
} = require("../features/extractors");

// ---------------------------------------------------------------------------
// Mouse dynamics
// ---------------------------------------------------------------------------

describe("extractMouse", () => {
  it("returns zero count for empty input", () => {
    const result = extractMouse([]);
    assert.equal(result.mouse_event_count, 0);
  });

  it("computes velocity and distance for a straight line", () => {
    const events = [
      { type: "mouse", data: { x: 0, y: 0, ts: 1000 } },
      { type: "mouse", data: { x: 100, y: 0, ts: 2000 } },
      { type: "mouse", data: { x: 200, y: 0, ts: 3000 } },
    ];
    const result = extractMouse(events);

    assert.equal(result.mouse_event_count, 3);
    assert.equal(result.mouse_total_distance, 200);
    // velocity = 100px / 1000ms = 0.1 px/ms
    assert.ok(Math.abs(result.mouse_avg_velocity - 0.1) < 0.001);
    // Straight line → curvature should be ~1.0
    assert.ok(Math.abs(result.mouse_avg_curvature - 1.0) < 0.001);
  });

  it("detects jitter (direction changes)", () => {
    const events = [
      { type: "mouse", data: { x: 0, y: 0, ts: 1000 } },
      { type: "mouse", data: { x: 100, y: 0, ts: 2000 } },
      { type: "mouse", data: { x: 0, y: 0, ts: 3000 } }, // reverse direction
    ];
    const result = extractMouse(events);
    // Jitter should be > 0 (direction reversal = ~π radians)
    assert.ok(result.mouse_avg_jitter > 2.5);
  });
});

// ---------------------------------------------------------------------------
// Scroll behavior
// ---------------------------------------------------------------------------

describe("extractScroll", () => {
  it("returns zero count for empty input", () => {
    const result = extractScroll([]);
    assert.equal(result.scroll_event_count, 0);
  });

  it("detects max depth and direction changes", () => {
    const events = [
      { type: "scroll", data: { percent: 0, ts: 1000 } },
      { type: "scroll", data: { percent: 50, ts: 2000 } },
      { type: "scroll", data: { percent: 80, ts: 3000 } },
      { type: "scroll", data: { percent: 60, ts: 4000 } }, // direction change
      { type: "scroll", data: { percent: 90, ts: 5000 } }, // direction change
    ];
    const result = extractScroll(events);

    assert.equal(result.scroll_max_depth, 90);
    assert.equal(result.scroll_direction_changes, 2);
    assert.equal(result.scroll_event_count, 5);
  });

  it("detects pauses > 2s", () => {
    const events = [
      { type: "scroll", data: { percent: 10, ts: 1000 } },
      { type: "scroll", data: { percent: 30, ts: 5000 } }, // 4s gap = pause
      { type: "scroll", data: { percent: 50, ts: 6000 } },
    ];
    const result = extractScroll(events);
    assert.equal(result.scroll_pause_count, 1);
  });
});

// ---------------------------------------------------------------------------
// Click patterns
// ---------------------------------------------------------------------------

describe("extractClicks", () => {
  it("returns zero for empty input", () => {
    const result = extractClicks([]);
    assert.equal(result.click_total, 0);
  });

  it("computes rhythm and detects CTA clicks", () => {
    const events = [
      { type: "click", data: { x: 100, y: 200, elType: "a", elTagHash: 1, isCta: true, isExternal: false, timeSinceStart: 1000, ts: 1000 } },
      { type: "click", data: { x: 300, y: 400, elType: "button", elTagHash: 2, isCta: false, isExternal: true, timeSinceStart: 2500, ts: 2500 } },
      { type: "click", data: { x: 500, y: 200, elType: "a", elTagHash: 3, isCta: true, isExternal: false, timeSinceStart: 4000, ts: 4000 } },
    ];
    const result = extractClicks(events);

    assert.equal(result.click_total, 3);
    assert.ok(Math.abs(result.click_avg_rhythm_ms - 1500) < 1);
    assert.ok(Math.abs(result.click_cta_ratio - 2 / 3) < 0.01);
    assert.ok(Math.abs(result.click_external_ratio - 1 / 3) < 0.01);
  });

  it("detects rage clicks", () => {
    // 4 fast clicks in same area
    const events = [
      { type: "click", data: { x: 100, y: 100, elType: "div", elTagHash: 1, isCta: false, isExternal: false, timeSinceStart: 1000, ts: 1000 } },
      { type: "click", data: { x: 105, y: 102, elType: "div", elTagHash: 1, isCta: false, isExternal: false, timeSinceStart: 1100, ts: 1100 } },
      { type: "click", data: { x: 98, y: 99, elType: "div", elTagHash: 1, isCta: false, isExternal: false, timeSinceStart: 1200, ts: 1200 } },
      { type: "click", data: { x: 103, y: 101, elType: "div", elTagHash: 1, isCta: false, isExternal: false, timeSinceStart: 1300, ts: 1300 } },
    ];
    const result = extractClicks(events);
    assert.ok(result.click_rage_count >= 1, `Expected rage clicks >= 1, got ${result.click_rage_count}`);
  });
});

// ---------------------------------------------------------------------------
// Form behavior
// ---------------------------------------------------------------------------

describe("extractForm", () => {
  it("returns zero for empty input", () => {
    const result = extractForm([]);
    assert.equal(result.form_total_interactions, 0);
  });

  it("detects corrections and submissions", () => {
    const events = [
      { type: "form", data: { action: "focus", formHash: 1, fieldIndex: 0, fieldType: "text", fillDurationMs: 0, ts: 1000 } },
      { type: "form", data: { action: "blur", formHash: 1, fieldIndex: 0, fieldType: "text", fillDurationMs: 2000, ts: 3000 } },
      { type: "form", data: { action: "focus", formHash: 1, fieldIndex: 0, fieldType: "text", fillDurationMs: 0, ts: 4000 } }, // correction
      { type: "form", data: { action: "blur", formHash: 1, fieldIndex: 0, fieldType: "text", fillDurationMs: 1000, ts: 5000 } },
      { type: "form", data: { action: "submit", formHash: 1, fieldIndex: 0, fieldType: "text", fillDurationMs: 0, ts: 6000 } },
    ];
    const result = extractForm(events);

    assert.equal(result.form_total_interactions, 5);
    assert.equal(result.form_correction_count, 1);
    assert.equal(result.form_submit_count, 1);
    assert.equal(result.form_abandon_count, 0);
  });

  it("detects hesitation (fill > 3s)", () => {
    const events = [
      { type: "form", data: { action: "focus", formHash: 1, fieldIndex: 0, fieldType: "email", fillDurationMs: 0, ts: 1000 } },
      { type: "form", data: { action: "blur", formHash: 1, fieldIndex: 0, fieldType: "email", fillDurationMs: 5000, ts: 6000 } },
    ];
    const result = extractForm(events);
    assert.equal(result.form_hesitation_count, 1);
  });
});

// ---------------------------------------------------------------------------
// Sliding window
// ---------------------------------------------------------------------------

describe("slidingWindow", () => {
  it("returns empty for empty series", () => {
    assert.deepEqual(slidingWindow([], 1000), []);
  });

  it("computes windowed stats", () => {
    const series = [
      { ts: 0, value: 10 },
      { ts: 200, value: 20 },
      { ts: 400, value: 30 },
      { ts: 600, value: 40 },
      { ts: 800, value: 50 },
    ];
    const windows = slidingWindow(series, 500);
    assert.ok(windows.length > 0);
    // First window should capture values from 0-500ms
    assert.ok(windows[0].avg > 0);
    assert.ok(windows[0].count >= 2);
  });
});

// ---------------------------------------------------------------------------
// Full extraction orchestrator
// ---------------------------------------------------------------------------

describe("extractAllFeatures", () => {
  it("combines all extractors", () => {
    const events = [
      { type: "mouse", data: { x: 0, y: 0, ts: 1000 } },
      { type: "mouse", data: { x: 100, y: 0, ts: 2000 } },
      { type: "scroll", data: { percent: 50, ts: 1500 } },
      { type: "click", data: { x: 100, y: 200, elType: "a", elTagHash: 1, isCta: true, isExternal: false, timeSinceStart: 2000, ts: 2000 } },
    ];

    const features = extractAllFeatures(events);

    assert.equal(features.mouse_event_count, 2);
    assert.equal(features.scroll_event_count, 1);
    assert.equal(features.click_total, 1);
    assert.equal(features.event_count, 4);
    assert.equal(features.mouse_total_distance, 100);
  });
});
