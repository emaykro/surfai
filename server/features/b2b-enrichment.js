"use strict";

/**
 * B2B Company Enrichment Engine — enriches ASN organizations with official
 * legal company registry details (INN, KPP, OGRN, Address, CEO, Status) via DaData API.
 */

require("dotenv").config({ path: require("path").join(__dirname, "../../.env") });

const { pool } = require("../db.js");
const { cleanCompanyName } = require("./b2b-detector.js");

const DADATA_SUGGEST_URL = "https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/party";

function getDaDataKey() {
  return process.env.DADATA_API_KEY || null;
}

/**
 * Parse raw DaData response suggestion into a normalized company object.
 * @param {Object} suggestion
 * @param {string} rawOrg
 * @returns {Object}
 */
function parseDaDataSuggestion(suggestion, rawOrg) {
  if (!suggestion || !suggestion.data) {
    return {
      raw_org: rawOrg,
      clean_name: cleanCompanyName(rawOrg),
      inn: null,
      kpp: null,
      ogrn: null,
      address: null,
      management_name: null,
      branch_type: null,
      status: "UNKNOWN",
      raw_dadata: null,
    };
  }

  const d = suggestion.data;
  return {
    raw_org: rawOrg,
    clean_name: suggestion.value || cleanCompanyName(rawOrg),
    inn: d.inn || null,
    kpp: d.kpp || null,
    ogrn: d.ogrn || null,
    address: d.address?.value || null,
    management_name: d.management?.name || null,
    branch_type: d.branch_type || "MAIN",
    status: d.state?.status || "ACTIVE",
    raw_dadata: suggestion,
  };
}

/**
 * Query DaData API for party suggestions by query string (name or INN).
 * @param {string} query
 * @param {string} apiKey
 * @returns {Promise<Object|null>}
 */
async function queryDaDataParty(query, apiKey = getDaDataKey()) {
  if (!apiKey || !query) return null;

  try {
    const res = await fetch(DADATA_SUGGEST_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": `Token ${apiKey}`,
      },
      body: JSON.stringify({ query, count: 1 }),
    });

    if (!res.ok) {
      console.warn(`DaData API returned HTTP ${res.status}`);
      return null;
    }

    const json = await res.json();
    if (json.suggestions && json.suggestions.length > 0) {
      return json.suggestions[0];
    }
    return null;
  } catch (err) {
    console.warn("DaData lookup error:", err.message);
    return null;
  }
}

/**
 * Get or enrich company details in database.
 * @param {string} rawOrg
 * @param {boolean} forceRefresh
 * @returns {Promise<Object>}
 */
async function getOrEnrichCompany(rawOrg, forceRefresh = false) {
  if (!rawOrg) return null;

  const cleanName = cleanCompanyName(rawOrg);

  // Check DB cache first
  const { rows } = await pool.query(
    `SELECT * FROM b2b_companies WHERE raw_org = $1`,
    [rawOrg]
  );

  if (rows.length > 0 && !forceRefresh && rows[0].inn) {
    return rows[0];
  }

  const existing = rows[0] || null;
  const apiKey = getDaDataKey();

  let enrichedData = {
    raw_org: rawOrg,
    clean_name: cleanName,
    inn: null,
    kpp: null,
    ogrn: null,
    address: null,
    management_name: null,
    branch_type: null,
    status: "ACTIVE",
    raw_dadata: null,
  };

  if (apiKey) {
    const suggestion = await queryDaDataParty(cleanName, apiKey);
    if (suggestion) {
      enrichedData = parseDaDataSuggestion(suggestion, rawOrg);
    }
  }

  const upsertQuery = `
    INSERT INTO b2b_companies
      (raw_org, clean_name, inn, kpp, ogrn, address, management_name, branch_type, status, raw_dadata, enriched_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
    ON CONFLICT (raw_org) DO UPDATE SET
      clean_name = EXCLUDED.clean_name,
      inn = COALESCE(EXCLUDED.inn, b2b_companies.inn),
      kpp = COALESCE(EXCLUDED.kpp, b2b_companies.kpp),
      ogrn = COALESCE(EXCLUDED.ogrn, b2b_companies.ogrn),
      address = COALESCE(EXCLUDED.address, b2b_companies.address),
      management_name = COALESCE(EXCLUDED.management_name, b2b_companies.management_name),
      branch_type = COALESCE(EXCLUDED.branch_type, b2b_companies.branch_type),
      status = EXCLUDED.status,
      raw_dadata = COALESCE(EXCLUDED.raw_dadata, b2b_companies.raw_dadata),
      enriched_at = NOW(),
      updated_at = NOW()
    RETURNING *;
  `;

  const { rows: savedRows } = await pool.query(upsertQuery, [
    enrichedData.raw_org,
    enrichedData.clean_name,
    enrichedData.inn,
    enrichedData.kpp,
    enrichedData.ogrn,
    enrichedData.address,
    enrichedData.management_name,
    enrichedData.branch_type,
    enrichedData.status,
    enrichedData.raw_dadata ? JSON.stringify(enrichedData.raw_dadata) : null,
  ]);

  return savedRows[0];
}

module.exports = {
  getOrEnrichCompany,
  queryDaDataParty,
  parseDaDataSuggestion,
  cleanCompanyName,
};
