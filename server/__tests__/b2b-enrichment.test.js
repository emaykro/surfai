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
