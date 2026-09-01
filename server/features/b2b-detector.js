"use strict";

/**
 * B2B Corporate Identity Detector — classifies ASN organizations and
 * extracts verified enterprise/company accounts visiting the site,
 * filtering out consumer ISPs and public hosting datacenters.
 */

// Common consumer ISP and mobile carrier keywords (RU & Global)
const CONSUMER_ISP_PATTERNS = [
  /rostelecom/i,
  /mts/i,
  /mobile telesystems/i,
  /megafon/i,
  /beeline/i,
  /vimpelcom/i,
  /tele2/i,
  /t2 mobile/i,
  /er-telecom/i,
  /dom\.ru/i,
  /netbynet/i,
  /mgts/i,
  /yota/i,
  /akado/i,
  /comcast/i,
  /verizon/i,
  /at&t/i,
  /vodafone/i,
  /t-mobile/i,
  /orange/i,
  /telefonica/i,
  /bt broadband/i,
  /virgin media/i,
  /charter/i,
  /century link/i,
  /cox communications/i,
  /kcell/i,
  /kazakhtelecom/i,
  /beeline kz/i,
  /kyivstar/i,
  /lifecell/i,
  /beltelecom/i,
  /a1 by/i,
];

// Common datacenter / cloud / proxy providers
const DATACENTER_PATTERNS = [
  /hetzner/i,
  /selectel/i,
  /ovh/i,
  /digitalocean/i,
  /amazon/i,
  /aws/i,
  /google llc/i,
  /microsoft corporation/i,
  /azure/i,
  /cloudflare/i,
  /linode/i,
  /leaseweb/i,
  /yandex enterprise network/i,
  /yandexcloud/i,
  /timeweb/i,
  /beget/i,
  /reg\.ru/i,
  /ru-center/i,
  /hostinger/i,
  /vultr/i,
  /fastly/i,
  /akamai/i,
  /mail\.ru cloud/i,
  /vk cloud/i,
  /sbercloud/i,
];

// Generic network-operator vocabulary. A named-ISP list can never cover the
// long tail of regional providers, so this catches the ones we do not know by
// name. It runs before the corporate check on purpose: most small ISPs are
// registered as ООО/LLC and would otherwise read as corporate.
const NETWORK_OPERATOR_PATTERNS = [
  /telecom/i, /telekom/i, /телеком/i,
  /broadband/i, /communications?/i, /коммуникац/i,
  /\bisp\b/i, /provider/i, /провайдер/i,
  /\binternet\b/i, /интернет/i,
  /\bnetworks?\b/i,
  // \b is ASCII-only, so Cyrillic needs an explicit letter boundary.
  /(^|[^\p{L}])сет[ьи]([^\p{L}]|$)/iu,
  /св[яя]з[ьи]/i, /svyaz/i,
  /\bcable\b/i, /wireless/i, /\bfiber\b/i, /\boptic/i,
  /data ?transmission/i, /передач[аи] данных/i,
];

// Legal-entity and organisation markers that constitute positive evidence of a
// registered company rather than a residential connection.
const CORPORATE_MARKER_TOKENS = [
  // Latin legal forms
  "LLC", "L.L.C.", "LTD", "LIMITED", "INC", "CORP", "CORPORATION",
  "GMBH", "AG", "BV", "N.V.", "PLC", "S.A.", "SA", "SPA", "OY", "AB", "A/S",
  "JSC", "PJSC", "CJSC", "OJSC",
  // Latin entity words
  "GROUP", "HOLDING", "BANK", "COMPANY", "INDUSTRIES", "INSTITUTE",
  "UNIVERSITY", "FACTORY", "PLANT",
  // Cyrillic legal forms
  "ООО", "ОАО", "ЗАО", "ПАО", "АО", "НКО", "ФГУП", "ГУП", "МУП", "НПО", "НИИ",
  // Cyrillic entity words
  "ГК", "КОНЦЕРН", "ХОЛДИНГ", "БАНК", "ЗАВОД", "КОМБИНАТ", "ГРУППА",
  "КОРПОРАЦИЯ", "УНИВЕРСИТЕТ", "ИНСТИТУТ",
];

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-token match that works for Cyrillic too (\b only knows ASCII \w). */
function hasToken(haystack, token) {
  const re = new RegExp(
    `(^|[^\\p{L}\\p{N}])${escapeRegExp(token)}([^\\p{L}\\p{N}]|$)`,
    "iu"
  );
  return re.test(haystack);
}

/**
 * Classify an ASN organization string.
 *
 * "b2b_corporate" requires positive evidence. Returning it as the fallback for
 * anything unrecognised makes the classifier's default answer its most
 * consequential one: unknown orgs would be counted as corporate accounts,
 * enriched against DaData, and dispatched to the customer's CRM as B2B leads.
 * Unrecognised orgs are "unknown" instead — a missed account is far cheaper
 * than a residential visitor presented to sales as a company.
 *
 * @param {string|null} asnOrg
 * @param {boolean} isDatacenter
 * @param {boolean} isMobile
 * @returns {'b2b_corporate' | 'consumer_isp' | 'datacenter' | 'unknown'}
 */
function classifyAsnOrg(asnOrg, isDatacenter = false, isMobile = false) {
  if (!asnOrg || typeof asnOrg !== "string" || asnOrg.trim().length < 3) {
    return "unknown";
  }

  const s = asnOrg.trim();

  if (isDatacenter || DATACENTER_PATTERNS.some((p) => p.test(s))) {
    return "datacenter";
  }

  if (isMobile || CONSUMER_ISP_PATTERNS.some((p) => p.test(s))) {
    return "consumer_isp";
  }

  if (NETWORK_OPERATOR_PATTERNS.some((p) => p.test(s))) {
    return "consumer_isp";
  }

  if (CORPORATE_MARKER_TOKENS.some((t) => hasToken(s, t))) {
    return "b2b_corporate";
  }

  return "unknown";
}

/**
 * Clean up company name by removing legal entity suffixes/prefixes.
 * @param {string} rawOrg
 * @returns {string}
 */
function cleanCompanyName(rawOrg) {
  if (!rawOrg) return "";
  let name = rawOrg
    .replace(/\b(PJSC|JSC|LLC|CJSC|OJSC|INC|LTD|CORP|GMBH|BV|PLC|SA|SPA)\b/gi, "")
    .replace(/(^|[^а-яёА-ЯЁ0-9a-zA-Z])(ПАО|ОАО|ЗАО|ООО|АО|НКО|ФГУП|МУП|НПО|НИИ)($|[^а-яёА-ЯЁ0-9a-zA-Z])/gi, " ")
    .replace(/["'«»]/g, "")
    .replace(/[-–—]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return name || rawOrg;
}

module.exports = {
  classifyAsnOrg,
  cleanCompanyName,
  CONSUMER_ISP_PATTERNS,
  DATACENTER_PATTERNS,
  NETWORK_OPERATOR_PATTERNS,
  CORPORATE_MARKER_TOKENS,
};
