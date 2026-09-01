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

/**
 * Classify an ASN organization string.
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

  // If it's not a generic consumer ISP and not a datacenter, it's likely a direct enterprise network
  return "b2b_corporate";
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
};
