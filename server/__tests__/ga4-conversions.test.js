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

describe("GA4 payload honesty and event dating", () => {
  const { buildGa4Payload, GA4_MAX_EVENT_AGE_HOURS } = require("../jobs/ga4-conversions");

  test("omits value and currency when no lead value is configured", () => {
    const p = buildGa4Payload({ clientId: "c1", eventName: "surfai_predicted_lead", score: 0.72 });
    // A model probability is not revenue; sending it would steer value-based bidding.
    assert.equal("value" in p.events[0].params, false);
    assert.equal("currency" in p.events[0].params, false);
    assert.equal(p.events[0].params.score, 0.72);
  });

  test("sends value with currency when one is explicitly supplied", () => {
    const p = buildGa4Payload({ clientId: "c1", eventName: "e", score: 0.72, value: 1500 });
    assert.equal(p.events[0].params.value, 1500);
    assert.equal(p.events[0].params.currency, "RUB");
  });

  test("stamps the session's own time so a backfill is not dated today", () => {
    const occurredAt = new Date(Date.now() - 6 * 3600_000);
    const p = buildGa4Payload({ clientId: "c1", eventName: "e", occurredAt });
    assert.equal(p.timestamp_micros, String(occurredAt.getTime() * 1000));
  });

  test("omits a timestamp GA4 would reject rather than sending a wrong one", () => {
    const tooOld = new Date(Date.now() - (GA4_MAX_EVENT_AGE_HOURS + 5) * 3600_000);
    const p = buildGa4Payload({ clientId: "c1", eventName: "e", occurredAt: tooOld });
    assert.equal("timestamp_micros" in p, false);

    const future = new Date(Date.now() + 3600_000);
    assert.equal("timestamp_micros" in buildGa4Payload({ clientId: "c1", eventName: "e", occurredAt: future }), false);

    assert.equal("timestamp_micros" in buildGa4Payload({ clientId: "c1", eventName: "e", occurredAt: "not-a-date" }), false);
  });
});
