"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { buildLeadPayload, formatLeadTitle } = require("../jobs/crm-sync");

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
