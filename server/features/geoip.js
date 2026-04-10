"use strict";

/**
 * GeoIP enrichment module.
 *
 * Looks up country / region / city / ASN / ASN organization for a client IP
 * using MMDB files from the ip-location-db project (DB-IP Lite + RouteViews,
 * CC BY 4.0 — see attribution requirement in CLAUDE.md).
 *
 * Design:
 *   - Singleton: the MMDB readers are loaded once at server startup.
 *   - Fail-safe: if the MMDB packages are not installed or the files are
 *     missing, lookup() returns null and the server keeps working. This
 *     lets the SDK ingest path be unaffected if geoip setup is incomplete.
 *   - Synchronous: `maxmind.openSync()` loads the file once; subsequent
 *     `.get()` calls are in-memory and take <1ms.
 *   - Privacy: the caller (persistBatch) is responsible for NOT storing
 *     the raw IP anywhere. This module only returns derived fields.
 *
 * Data providers:
 *   - @ip-location-db/dbip-city-mmdb (CC BY 4.0 by DB-IP.com)
 *     Fields: country, region, city, latitude, longitude, timezone
 *   - @ip-location-db/asn-mmdb (CC BY 4.0 by RouteViews + DB-IP)
 *     Fields: autonomous_system_number, autonomous_system_organization
 */

let cityReaderV4 = null;
let cityReaderV6 = null;
let asnReaderV4 = null;
let asnReaderV6 = null;
let initialized = false;
let available = false;

// Heuristic keyword lists for ASN classification. These are checked against
// the `autonomous_system_organization` string (case-insensitive) to derive
// boolean features useful for bot detection. Not exhaustive — the goal is
// high-precision hits on common datacenters and mobile carriers, not full
// coverage.
const DATACENTER_KEYWORDS = [
  "amazon", "aws", "google", "microsoft", "azure", "digitalocean",
  "linode", "ovh", "hetzner", "scaleway", "vultr", "hostinger",
  "godaddy", "namecheap", "cloudflare", "fastly", "akamai",
  "alibaba", "tencent", "oracle", "ibm", "rackspace", "leaseweb",
  "contabo", "datacamp", "choopa", "m247", "timeweb", "selectel",
  "reg.ru", "beget", "masterhost", "ruvds", "firstvds", "serverel",
  "hosting", "datacenter", "data center", "cloud", "vps", "dedicated",
];

const MOBILE_CARRIER_KEYWORDS = [
  "mts", "mobile tele", "beeline", "vimpelcom", "megafon",
  "tele2", "yota",
  "mobile", "cellular", "wireless", "telecom", "vodafone",
  "t-mobile", "verizon", "at&t", "orange", "telefonica",
  "kddi", "ntt", "softbank", "docomo",
];

/**
 * Load the MMDB readers. Called once at startup. Safe to call multiple times.
 * Never throws — logs a warning and leaves the module in a disabled state
 * if the packages or files are unavailable.
 *
 * Async because maxmind v5 dropped `openSync()`; `open()` returns a Promise.
 * The returned Reader instances still expose a synchronous `.get(ip)`, so
 * the `lookup()` method below stays sync.
 *
 * @param {object} [logger] - Optional Pino-compatible logger for startup messages
 * @returns {Promise<boolean>} true if all four readers loaded successfully
 */
async function init(logger) {
  if (initialized) return available;
  initialized = true;

  const log = logger || console;

  let maxmind;
  try {
    maxmind = require("maxmind");
  } catch (_err) {
    log.warn("geoip: maxmind package not installed — enrichment disabled");
    return false;
  }

  // Resolve package paths without crashing if they're not installed.
  let cityV4Path, cityV6Path, asnV4Path, asnV6Path;
  try {
    cityV4Path = require.resolve("@ip-location-db/dbip-city-mmdb/dbip-city-ipv4.mmdb");
    cityV6Path = require.resolve("@ip-location-db/dbip-city-mmdb/dbip-city-ipv6.mmdb");
  } catch (_err) {
    log.warn("geoip: @ip-location-db/dbip-city-mmdb not installed — city enrichment disabled");
    return false;
  }
  try {
    asnV4Path = require.resolve("@ip-location-db/asn-mmdb/asn-ipv4.mmdb");
    asnV6Path = require.resolve("@ip-location-db/asn-mmdb/asn-ipv6.mmdb");
  } catch (_err) {
    log.warn("geoip: @ip-location-db/asn-mmdb not installed — ASN enrichment disabled");
    return false;
  }

  try {
    // maxmind@5 returns Promise<Reader>; Reader.get(ip) itself is sync.
    [cityReaderV4, cityReaderV6, asnReaderV4, asnReaderV6] = await Promise.all([
      maxmind.open(cityV4Path),
      maxmind.open(cityV6Path),
      maxmind.open(asnV4Path),
      maxmind.open(asnV6Path),
    ]);
  } catch (err) {
    log.warn({ err }, "geoip: failed to open MMDB files — enrichment disabled");
    cityReaderV4 = cityReaderV6 = asnReaderV4 = asnReaderV6 = null;
    return false;
  }

  available = true;
  log.info("geoip: MMDB readers initialized (dbip-city + asn)");
  return true;
}

/** True if init() succeeded and lookup() can return real data. */
function isAvailable() {
  return available;
}

/**
 * Check whether an ASN organization name matches any of the given keywords
 * (case-insensitive substring match).
 */
function matchesAny(orgName, keywords) {
  if (!orgName) return false;
  const lower = orgName.toLowerCase();
  for (const kw of keywords) {
    if (lower.includes(kw)) return true;
  }
  return false;
}

/**
 * Decide whether to use the IPv4 or IPv6 reader for a given IP string.
 * Returns the appropriate reader pair or nulls.
 */
function pickReaders(ip) {
  if (!ip || typeof ip !== "string") return { city: null, asn: null };
  const isIpv6 = ip.includes(":");
  return {
    city: isIpv6 ? cityReaderV6 : cityReaderV4,
    asn: isIpv6 ? asnReaderV6 : asnReaderV4,
  };
}

/**
 * Look up geo/ASN data for a client IP. Returns a flat object with all
 * fields nullable, or an object of nulls if the lookup fails.
 *
 * Never throws — callers can safely merge the result into a features object.
 *
 * @param {string} ip - Client IPv4 or IPv6 address (as returned by request.ip)
 * @returns {{
 *   geo_country: string|null,
 *   geo_region: string|null,
 *   geo_city: string|null,
 *   geo_timezone: string|null,
 *   geo_latitude: number|null,
 *   geo_longitude: number|null,
 *   geo_asn: number|null,
 *   geo_asn_org: string|null,
 *   geo_is_datacenter: boolean|null,
 *   geo_is_mobile_carrier: boolean|null
 * }}
 */
function lookup(ip) {
  const empty = {
    geo_country: null,
    geo_region: null,
    geo_city: null,
    geo_timezone: null,
    geo_latitude: null,
    geo_longitude: null,
    geo_asn: null,
    geo_asn_org: null,
    geo_is_datacenter: null,
    geo_is_mobile_carrier: null,
  };

  if (!available || !ip) return empty;

  const { city, asn } = pickReaders(ip);

  let cityRow = null;
  let asnRow = null;
  try {
    if (city) cityRow = city.get(ip);
  } catch (_err) {
    cityRow = null;
  }
  try {
    if (asn) asnRow = asn.get(ip);
  } catch (_err) {
    asnRow = null;
  }

  // Field names from the ip-location-db MMDB binary shape (verified on prod):
  //   city reader: { country_code, state1, state2, city, postcode, latitude, longitude, timezone }
  //   asn  reader: { autonomous_system_number, autonomous_system_organization }
  // Note: `timezone` from dbip-city is usually empty — we have ctx_timezone
  // from the client for that. Empty strings are normalized to null so
  // dashboard queries don't need to handle two flavors of "missing".
  const orgName = nonEmptyOrNull(asnRow?.autonomous_system_organization);
  return {
    geo_country: nonEmptyOrNull(cityRow?.country_code),
    geo_region: nonEmptyOrNull(cityRow?.state1),
    geo_city: nonEmptyOrNull(cityRow?.city),
    geo_timezone: nonEmptyOrNull(cityRow?.timezone),
    geo_latitude: typeof cityRow?.latitude === "number" ? cityRow.latitude : null,
    geo_longitude: typeof cityRow?.longitude === "number" ? cityRow.longitude : null,
    geo_asn: typeof asnRow?.autonomous_system_number === "number"
      ? asnRow.autonomous_system_number
      : null,
    geo_asn_org: orgName,
    geo_is_datacenter: orgName ? matchesAny(orgName, DATACENTER_KEYWORDS) : null,
    geo_is_mobile_carrier: orgName ? matchesAny(orgName, MOBILE_CARRIER_KEYWORDS) : null,
  };
}

/** Return null for nullish or empty-string values, otherwise the value itself. */
function nonEmptyOrNull(v) {
  if (v == null) return null;
  if (typeof v === "string" && v.length === 0) return null;
  return v;
}

module.exports = {
  init,
  isAvailable,
  lookup,
  // Exported for tests
  _matchesAny: matchesAny,
  _DATACENTER_KEYWORDS: DATACENTER_KEYWORDS,
  _MOBILE_CARRIER_KEYWORDS: MOBILE_CARRIER_KEYWORDS,
};
