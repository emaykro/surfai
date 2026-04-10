const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { parseUaClientHints, _parseBoolean, _parseString, _parseBrandList } = require("../features/ua-client-hints");

describe("UA Client Hints parser", () => {
  describe("structured field primitives", () => {
    it("parseBoolean recognizes ?1 and ?0", () => {
      assert.equal(_parseBoolean("?1"), true);
      assert.equal(_parseBoolean("?0"), false);
      assert.equal(_parseBoolean(null), null);
      assert.equal(_parseBoolean(undefined), null);
      assert.equal(_parseBoolean(""), null);
      assert.equal(_parseBoolean("garbage"), null);
    });

    it("parseString unwraps double-quoted values", () => {
      assert.equal(_parseString('"Windows"'), "Windows");
      assert.equal(_parseString('"macOS"'), "macOS");
      assert.equal(_parseString('"Samsung SM-G998B"'), "Samsung SM-G998B");
      assert.equal(_parseString(null), null);
      assert.equal(_parseString(""), null);
    });
  });

  describe("brand list parsing", () => {
    it("picks Chrome over generic Chromium and skips Not-A-Brand GREASE", () => {
      const result = _parseBrandList(
        '"Chromium";v="120", "Google Chrome";v="120", "Not A;Brand";v="99"'
      );
      assert.equal(result.brand, "Google Chrome");
      assert.equal(result.version, "120");
    });

    it("picks Edge over Chromium", () => {
      const result = _parseBrandList(
        '"Chromium";v="120", "Not A(Brand";v="99", "Microsoft Edge";v="120"'
      );
      assert.equal(result.brand, "Microsoft Edge");
      assert.equal(result.version, "120");
    });

    it("picks YandexBrowser correctly", () => {
      const result = _parseBrandList(
        '"YaBrowser";v="24.4", "Chromium";v="122", "Not)A:Brand";v="24"'
      );
      assert.equal(result.brand, "Chromium");
      assert.equal(result.version, "122");
    });

    it("handles single-entry brand list", () => {
      const result = _parseBrandList('"Brave";v="1.60"');
      assert.equal(result.brand, "Brave");
      assert.equal(result.version, "1.60");
    });

    it("returns nulls for missing or empty header", () => {
      assert.deepEqual(_parseBrandList(null), { brand: null, version: null });
      assert.deepEqual(_parseBrandList(""), { brand: null, version: null });
    });
  });

  describe("parseUaClientHints integration", () => {
    it("parses a full set of Chromium desktop headers", () => {
      const headers = {
        "sec-ch-ua": '"Chromium";v="120", "Google Chrome";v="120", "Not A;Brand";v="99"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-ch-ua-platform-version": '"15.0.0"',
        "sec-ch-ua-arch": '"x86"',
        "sec-ch-ua-bitness": '"64"',
        "sec-ch-ua-model": '""',
      };
      const result = parseUaClientHints(headers);
      assert.equal(result.uah_brand, "Google Chrome");
      assert.equal(result.uah_brand_version, "120");
      assert.equal(result.uah_mobile, false);
      assert.equal(result.uah_platform, "Windows");
      assert.equal(result.uah_platform_version, "15.0.0");
      assert.equal(result.uah_arch, "x86");
      assert.equal(result.uah_bitness, "64");
      assert.equal(result.uah_model, null);
    });

    it("parses an Android mobile Chromium request", () => {
      const headers = {
        "sec-ch-ua": '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
        "sec-ch-ua-mobile": "?1",
        "sec-ch-ua-platform": '"Android"',
        "sec-ch-ua-model": '"SM-G998B"',
      };
      const result = parseUaClientHints(headers);
      assert.equal(result.uah_brand, "Google Chrome");
      assert.equal(result.uah_mobile, true);
      assert.equal(result.uah_platform, "Android");
      assert.equal(result.uah_model, "SM-G998B");
    });

    it("returns all-null for Firefox-like request with no Sec-CH-UA-* headers", () => {
      const headers = {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; rv:120.0) Gecko/20100101 Firefox/120.0",
        host: "surfai.ru",
      };
      const result = parseUaClientHints(headers);
      assert.equal(result.uah_brand, null);
      assert.equal(result.uah_brand_version, null);
      assert.equal(result.uah_mobile, null);
      assert.equal(result.uah_platform, null);
      assert.equal(result.uah_platform_version, null);
      assert.equal(result.uah_model, null);
      assert.equal(result.uah_arch, null);
      assert.equal(result.uah_bitness, null);
    });

    it("accepts empty / missing headers object without throwing", () => {
      assert.doesNotThrow(() => parseUaClientHints({}));
      assert.doesNotThrow(() => parseUaClientHints(null));
      assert.doesNotThrow(() => parseUaClientHints(undefined));
    });
  });
});
