"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { parseDaDataSuggestion, cleanCompanyName } = require("../features/b2b-enrichment");

describe("B2B Company Enrichment", () => {
  test("parseDaDataSuggestion extracts INN, KPP, OGRN and Address correctly", () => {
    const rawSuggestion = {
      value: "ПАО СБЕРБАНК",
      unrestricted_value: "ПАО СБЕРБАНК",
      data: {
        inn: "7707083893",
        kpp: "773601001",
        ogrn: "1027700132195",
        address: {
          value: "г Москва, ул Вавилова, д 19",
        },
        management: {
          name: "Греф Герман Оскарович",
          post: "Президент, Председатель Правления",
        },
        state: {
          status: "ACTIVE",
        },
        branch_type: "MAIN",
      },
    };

    const parsed = parseDaDataSuggestion(rawSuggestion, "Sberbank of Russia PJSC");

    assert.equal(parsed.clean_name, "ПАО СБЕРБАНК");
    assert.equal(parsed.inn, "7707083893");
    assert.equal(parsed.kpp, "773601001");
    assert.equal(parsed.ogrn, "1027700132195");
    assert.equal(parsed.address, "г Москва, ул Вавилова, д 19");
    assert.equal(parsed.management_name, "Греф Герман Оскарович");
    assert.equal(parsed.status, "ACTIVE");
    assert.equal(parsed.branch_type, "MAIN");
  });

  test("parseDaDataSuggestion handles null or empty response gracefully", () => {
    const parsed = parseDaDataSuggestion(null, "PJSC Gazprom Neft");

    assert.equal(parsed.raw_org, "PJSC Gazprom Neft");
    assert.equal(parsed.clean_name, "Gazprom Neft");
    assert.equal(parsed.inn, null);
    assert.equal(parsed.status, "UNKNOWN");
  });
});

describe("B2B enrichment retry backoff", () => {
  const { isRecentlyAttempted, ENRICH_RETRY_HOURS } = require("../features/b2b-enrichment");

  test("a recent unresolved attempt is not retried", () => {
    // Otherwise every org DaData cannot resolve is re-queried on every call,
    // once per candidate session, burning the daily quota on the same names.
    assert.equal(isRecentlyAttempted(new Date(Date.now() - 3600_000)), true);
  });

  test("an attempt older than the backoff window is retried", () => {
    const stale = new Date(Date.now() - (ENRICH_RETRY_HOURS + 1) * 3600_000);
    assert.equal(isRecentlyAttempted(stale), false);
  });

  test("a never-attempted or unparseable timestamp is retried", () => {
    assert.equal(isRecentlyAttempted(null), false);
    assert.equal(isRecentlyAttempted(undefined), false);
    assert.equal(isRecentlyAttempted("not-a-date"), false);
  });
});
