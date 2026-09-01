"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildLeadPayload,
  formatLeadTitle,
  buildPendingSessionsQuery,
} = require("../jobs/crm-sync");

describe("CRM Lead Dispatcher", () => {
  test("formatLeadTitle creates human-readable title with score", () => {
    const title = formatLeadTitle("ПАО Сбербанк", "luch-clean.ru", 0.85);
    assert.equal(title, "[SURFAI Lead] ПАО Сбербанк (85% интент) — luch-clean.ru");
  });

  test("buildLeadPayload constructs comprehensive CRM lead structure", () => {
    const company = {
      clean_name: "ПАО Северсталь",
      inn: "3528000597",
      kpp: "352801001",
      ogrn: "1023501236901",
      address: "г Череповец, ул Мира, д 30",
      management_name: "Шевелев Александр Анатольевич",
      status: "ACTIVE",
    };

    const session = {
      session_id: "sess_test_123",
      site_id: "site_456",
      geo_asn_org: "Severstal Mining Company JSC",
      geo_asn: 12345,
      geo_city: "Cherepovets",
      geo_country: "RU",
      model_prediction_score: 0.82,
      session_duration_ms: 180000,
      scroll_max_depth: 95,
      copy_count: 2,
      form_total_interactions: 3,
      ctx_utm_source: "yandex",
      ctx_utm_medium: "cpc",
      ctx_utm_campaign: "b2b_enterprise",
    };

    const payload = buildLeadPayload({ company, session, site: { domain: "surfai.ru" } });

    assert.equal(payload.source, "SURFAI B2B Intent Engine");
    assert.equal(payload.company.name, "ПАО Северсталь");
    assert.equal(payload.company.inn, "3528000597");
    assert.equal(payload.company.management_name, "Шевелев Александр Анатольевич");

    assert.equal(payload.intent.score, 0.82);
    assert.equal(payload.intent.score_percent, 82);
    assert.equal(payload.intent.level, "HOT");
    assert.equal(payload.intent.copied_contacts, true);
    assert.equal(payload.intent.duration_seconds, 180);
    assert.equal(payload.intent.max_scroll_depth, 95);

    assert.equal(payload.traffic.utm_source, "yandex");
    assert.equal(payload.traffic.utm_campaign, "b2b_enterprise");
    assert.equal(payload.traffic.site_domain, "surfai.ru");
  });
});

describe("CRM pending-session selection", () => {
  test("bounds the candidate window instead of scanning all history", () => {
    const { text, params } = buildPendingSessionsQuery({ lookbackHours: 48 });
    assert.match(text, /sf\.computed_at >= NOW\(\) - \(\$1 \|\| ' hours'\)::interval/);
    assert.equal(params[0], "48");
  });

  test("retires a session on success but keeps retrying after an error", () => {
    const { text, params } = buildPendingSessionsQuery({ maxAttempts: 3 });
    // Only a successful dispatch may suppress the lead...
    assert.match(text, /NOT EXISTS[\s\S]*csl\.status = 'success'/);
    // ...and error rows are bounded, not terminal.
    assert.match(text, /csl2\.status = 'error'[\s\S]*\) < \$2/);
    assert.equal(params[1], 3);
  });

  test("scopes candidates to the requested site", () => {
    const scoped = buildPendingSessionsQuery({ siteId: "site_abc" });
    assert.match(scoped.text, /AND sf\.site_id = \$3/);
    assert.equal(scoped.params[2], "site_abc");

    const unscoped = buildPendingSessionsQuery({});
    assert.ok(!unscoped.text.includes("sf.site_id = $"));
    assert.equal(unscoped.params.length, 2);
  });
});
