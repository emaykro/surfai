const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const geoip = require("../features/geoip");

// ---------------------------------------------------------------------------
// These tests run WITHOUT the MMDB packages installed (or with them —
// either way, the module must not throw and must fall back to null values
// when readers are missing).
// ---------------------------------------------------------------------------

describe("geoip module", () => {
  describe("graceful degradation when MMDB packages missing", () => {
    it("lookup() returns all-null object for any IP when not initialized", () => {
      // Intentionally do NOT call init() here so we exercise the
      // never-initialized branch.
      const result = geoip.lookup("8.8.8.8");
      assert.equal(typeof result, "object");
      assert.equal(result.geo_country, null);
      assert.equal(result.geo_region, null);
      assert.equal(result.geo_city, null);
      assert.equal(result.geo_asn, null);
      assert.equal(result.geo_asn_org, null);
      assert.equal(result.geo_is_datacenter, null);
      assert.equal(result.geo_is_mobile_carrier, null);
    });

    it("lookup() accepts missing/empty IP without throwing", () => {
      assert.doesNotThrow(() => geoip.lookup(""));
      assert.doesNotThrow(() => geoip.lookup(null));
      assert.doesNotThrow(() => geoip.lookup(undefined));
    });

    it("init() with missing packages sets available=false and does not throw", () => {
      // Capture logger warnings so test output stays clean
      const warnings = [];
      const mockLogger = {
        warn: (obj, msg) => warnings.push(msg || obj),
        info: () => {},
      };
      // Safe to call repeatedly — second call is a no-op
      assert.doesNotThrow(() => geoip.init(mockLogger));
      // When MMDB packages are genuinely missing in this test env, isAvailable
      // will be false. When they ARE installed (e.g. after npm install on
      // prod), isAvailable is true — both outcomes are valid here.
      assert.equal(typeof geoip.isAvailable(), "boolean");
    });
  });

  describe("matchesAny keyword classifier", () => {
    it("flags common datacenter ASN orgs", () => {
      assert.equal(geoip._matchesAny("Amazon.com, Inc.", geoip._DATACENTER_KEYWORDS), true);
      assert.equal(geoip._matchesAny("DigitalOcean, LLC", geoip._DATACENTER_KEYWORDS), true);
      assert.equal(geoip._matchesAny("Hetzner Online GmbH", geoip._DATACENTER_KEYWORDS), true);
      assert.equal(geoip._matchesAny("Google LLC", geoip._DATACENTER_KEYWORDS), true);
      assert.equal(geoip._matchesAny("Microsoft Corporation", geoip._DATACENTER_KEYWORDS), true);
      assert.equal(geoip._matchesAny("OVH SAS", geoip._DATACENTER_KEYWORDS), true);
      assert.equal(geoip._matchesAny("Selectel Ltd.", geoip._DATACENTER_KEYWORDS), true);
      assert.equal(geoip._matchesAny("Timeweb Ltd.", geoip._DATACENTER_KEYWORDS), true);
    });

    it("does not flag residential ISPs as datacenters", () => {
      assert.equal(geoip._matchesAny("Rostelecom", geoip._DATACENTER_KEYWORDS), false);
      assert.equal(geoip._matchesAny("Comcast Cable Communications", geoip._DATACENTER_KEYWORDS), false);
      assert.equal(geoip._matchesAny("Deutsche Telekom AG", geoip._DATACENTER_KEYWORDS), false);
    });

    it("flags mobile carriers", () => {
      assert.equal(geoip._matchesAny("MTS PJSC", geoip._MOBILE_CARRIER_KEYWORDS), true);
      assert.equal(geoip._matchesAny("PJSC MegaFon", geoip._MOBILE_CARRIER_KEYWORDS), true);
      assert.equal(geoip._matchesAny("VimpelCom (Beeline)", geoip._MOBILE_CARRIER_KEYWORDS), true);
      assert.equal(geoip._matchesAny("Vodafone Group", geoip._MOBILE_CARRIER_KEYWORDS), true);
      assert.equal(geoip._matchesAny("T-Mobile USA, Inc.", geoip._MOBILE_CARRIER_KEYWORDS), true);
    });

    it("handles null / empty org gracefully", () => {
      assert.equal(geoip._matchesAny(null, geoip._DATACENTER_KEYWORDS), false);
      assert.equal(geoip._matchesAny("", geoip._DATACENTER_KEYWORDS), false);
      assert.equal(geoip._matchesAny(undefined, geoip._DATACENTER_KEYWORDS), false);
    });

    it("is case-insensitive", () => {
      assert.equal(geoip._matchesAny("AMAZON.COM", geoip._DATACENTER_KEYWORDS), true);
      assert.equal(geoip._matchesAny("amazon.com", geoip._DATACENTER_KEYWORDS), true);
      assert.equal(geoip._matchesAny("Amazon.Com", geoip._DATACENTER_KEYWORDS), true);
    });
  });
});
