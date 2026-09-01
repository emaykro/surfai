"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { buildGa4Payload, DEFAULT_PREDICTED_THRESHOLD } = require("../jobs/ga4-conversions");

describe("GA4 Measurement Protocol Exporter", () => {
  test("buildGa4Payload constructs compliant Measurement Protocol v2 body", () => {
    const payload = buildGa4Payload({
      clientId: "visitor_abc123",
      eventName: "surfai_predicted_lead",
      score: 0.85,
      value: 850,
      currency: "RUB",
      engagementTimeMs: 45000,
      customParams: {
        traffic_source: "yandex",
        campaign: "direct_search_cpa",
      },
    });

    assert.equal(payload.client_id, "visitor_abc123");
    assert.equal(payload.non_personalized_ads, false);
    assert.equal(payload.events.length, 1);

    const event = payload.events[0];
    assert.equal(event.name, "surfai_predicted_lead");
    assert.equal(event.params.score, 0.85);
    assert.equal(event.params.value, 850);
    assert.equal(event.params.currency, "RUB");
    assert.equal(event.params.engagement_time_msec, 45000);
    assert.equal(event.params.traffic_source, "yandex");
    assert.equal(event.params.campaign, "direct_search_cpa");
  });

  test("buildGa4Payload handles missing / undefined optional parameters safely", () => {
    const payload = buildGa4Payload({
      clientId: null,
      eventName: "surfai_real_lead",
    });

    assert.equal(payload.client_id, "anonymous_visitor");
    assert.equal(payload.events[0].name, "surfai_real_lead");
    assert.equal(payload.events[0].params.engagement_time_msec, 1000);
    assert.equal(payload.events[0].params.score, undefined);
  });

  test("uses default predicted threshold of 0.7", () => {
    assert.equal(DEFAULT_PREDICTED_THRESHOLD, 0.7);
  });
});
