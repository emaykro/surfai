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

  test("a suggestion without a state block does not invent a legal status", () => {
    // The dashboard renders this verbatim as "Статус ФНС". Defaulting an absent
    // state to ACTIVE claims a registry fact about a real company that DaData
    // never returned.
    const parsed = parseDaDataSuggestion(
      { value: "ООО РОМАШКА", data: { inn: "7701234567" } },
      "Romashka LLC"
    );

    assert.equal(parsed.inn, "7701234567");
    assert.equal(parsed.status, "UNKNOWN");
  });
});

describe("B2B unresolved company records", () => {
  const { emptyCompanyRecord, UPSERT_COMPANY_SQL } = require("../features/b2b-enrichment");

  test("an org that was never looked up carries no legal status", () => {
    // Reached when DADATA_API_KEY is unset or the lookup returned nothing at all.
    const record = emptyCompanyRecord("Yandex LLC");

    assert.equal(record.raw_org, "Yandex LLC");
    assert.equal(record.inn, null);
    assert.equal(record.raw_dadata, null);
    assert.equal(record.status, "UNKNOWN");
  });

  test("the empty record matches the parser's own empty branch", () => {
    // Two hand-maintained copies of this shape are how ACTIVE crept into one of
    // them while the other said UNKNOWN.
    assert.deepEqual(emptyCompanyRecord("Yandex LLC"), parseDaDataSuggestion(null, "Yandex LLC"));
  });

  test("a failed re-enrichment does not overwrite a known status", () => {
    // A company already resolved as LIQUIDATED must not silently become UNKNOWN
    // because a later lookup failed — every other field is COALESCE-guarded.
    assert.match(
      UPSERT_COMPANY_SQL,
      /status = CASE WHEN EXCLUDED\.status = 'UNKNOWN' THEN b2b_companies\.status ELSE EXCLUDED\.status END/
    );
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
