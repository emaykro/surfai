"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { buildAudiencesCsv, DEFAULT_SCORE_THRESHOLD, MIN_SEGMENT_COUNT } = require("../jobs/audiences-export");

describe("Yandex Audiences Segment Exporter", () => {
  test("buildAudiencesCsv deduplicates and filters empty values", () => {
    const rawIds = ["1710001", "1710002", "1710001", "", null, "1710003", undefined, "1710002"];
    const csv = buildAudiencesCsv(rawIds);
    const lines = csv.split("\n");

    assert.equal(lines.length, 3);
    assert.deepEqual(lines, ["1710001", "1710002", "1710003"]);
  });

  test("has safe defaults for score and segment thresholds", () => {
    assert.equal(DEFAULT_SCORE_THRESHOLD, 0.7);
    assert.equal(MIN_SEGMENT_COUNT, 100);
  });
});
