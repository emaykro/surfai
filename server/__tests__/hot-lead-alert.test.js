"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { constructAlertMessage } = require("../jobs/hot-lead-alert");

describe("hot-lead-alert message builder", () => {
  test("formats hot session with CatBoost score and geo/utm info", () => {
    const fakeSession = {
      session_id: "test-sess-12345",
      site_domain: "luch-cleaning.ru",
      project_name: "Luch",
      score: 0.88,
      session_duration_ms: 195000,
      engagement_active_ratio: 0.85,
      scroll_max_depth: 92,
      copy_count: 2,
      form_total_interactions: 3,
      form_submit_count: 0,
      cross_visit_number: 2,
      geo_city: "Москва",
      geo_country: "RU",
      geo_asn_org: "ПАО Ростелеком",
      ctx_utm_source: "yandex",
      ctx_utm_medium: "cpc",
      ctx_utm_campaign: "b2b_cleaning",
      ctx_referrer_host: "yandex.ru",
    };

    const msg = constructAlertMessage(fakeSession);

    assert.match(msg, /ГОРЯЧИЙ B2B-ПОСЕТИТЕЛЬ НА САЙТЕ/);
    assert.match(msg, /88%/);
    assert.match(msg, /Luch \(luch-cleaning\.ru\)/);
    assert.match(msg, /Москва/);
    assert.match(msg, /ПАО Ростелеком/);
    assert.match(msg, /3 мин 15 сек/);
    assert.match(msg, /Скопировал текст\/контакты: \*2 раз\(а\)\*/);
    assert.match(msg, /Повторный визит \(\*№2\*\)/);
    assert.match(msg, /b2b\\_cleaning/);
    assert.match(msg, /test-sess-12345/);
  });

  test("handles empty / missing optional fields safely", () => {
    const minSession = {
      session_id: "min-sess-999",
      site_domain: null,
      project_name: null,
      score: null,
      session_duration_ms: 12000,
      engagement_active_ratio: null,
      scroll_max_depth: 50,
      copy_count: 1,
      form_total_interactions: 0,
      form_submit_count: 0,
      cross_visit_number: 1,
      geo_city: null,
      geo_country: null,
      geo_asn_org: null,
      ctx_utm_source: null,
      ctx_utm_medium: null,
      ctx_utm_campaign: null,
      ctx_referrer_host: null,
    };

    const msg = constructAlertMessage(minSession);
    assert.match(msg, /min-sess-999/);
    assert.match(msg, /Гео не определено/);
    assert.match(msg, /Прямой \/ Органический заход/);
  });
});
