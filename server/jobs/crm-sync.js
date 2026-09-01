"use strict";

/**
 * CRM Lead Dispatcher & Sync Worker — pushes high-intent B2B corporate visits
 * to configured CRMs (AmoCRM, Bitrix24, Custom Webhooks, Slack/Telegram).
 *
 * Usage:
 *   node server/jobs/crm-sync.js
 *   node server/jobs/crm-sync.js --dry-run
 *   node server/jobs/crm-sync.js --site=<site_id>
 */

require("dotenv").config({ path: require("path").join(__dirname, "../../.env") });

const { pool } = require("../db.js");
const { classifyAsnOrg, cleanCompanyName } = require("../features/b2b-detector.js");
const { getOrEnrichCompany } = require("../features/b2b-enrichment.js");

function formatLeadTitle(companyName, siteDomain, intentScore) {
  const scorePct = Math.round((intentScore || 0.5) * 100);
  return `[SURFAI Lead] ${companyName} (${scorePct}% интент) — ${siteDomain || "Сайт"}`;
}

function buildLeadPayload({ company, session, site }) {
  const score = session.model_prediction_score != null ? Number(session.model_prediction_score) : 0.5;
  const companyName = company?.clean_name || cleanCompanyName(session.geo_asn_org) || "B2B Организация";

  return {
    source: "SURFAI B2B Intent Engine",
    lead_title: formatLeadTitle(companyName, site?.domain, score),
    company: {
      name: companyName,
      raw_asn_org: session.geo_asn_org,
      inn: company?.inn || null,
      kpp: company?.kpp || null,
      ogrn: company?.ogrn || null,
      address: company?.address || null,
      management_name: company?.management_name || null,
      status: company?.status || "ACTIVE",
    },
    intent: {
      score: score,
      score_percent: Math.round(score * 100),
      level: score >= 0.7 ? "HOT" : score >= 0.4 ? "WARM" : "INTERESTED",
      copied_contacts: Boolean(session.copy_count > 0),
      duration_seconds: Math.round((session.session_duration_ms || 0) / 1000),
      max_scroll_depth: session.scroll_max_depth || 0,
      form_interactions: session.form_total_interactions || 0,
    },
    traffic: {
      site_domain: site?.domain || "Unknown",
      site_id: session.site_id,
      utm_source: session.ctx_utm_source || "direct",
      utm_medium: session.ctx_utm_medium || "none",
      utm_campaign: session.ctx_utm_campaign || null,
      location: [session.geo_city, session.geo_country].filter(Boolean).join(", "),
      ip_asn: session.geo_asn,
    },
    session_id: session.session_id,
    timestamp: new Date().toISOString(),
  };
}

async function sendToWebhook(webhookUrl, payload, dryRun = false) {
  if (dryRun) {
    console.log(`[dry-run] Webhook POST to ${webhookUrl}:\n`, JSON.stringify(payload, null, 2));
    return { ok: true, id: "dry-run-webhook-id" };
  }

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Webhook error HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  return { ok: true, status: res.status };
}

async function sendToBitrix24(webhookUrl, payload, dryRun = false) {
  if (dryRun) {
    console.log(`[dry-run] Bitrix24 lead add to ${webhookUrl}`);
    return { ok: true, id: "dry-run-bitrix-id" };
  }

  // Bitrix24 crm.lead.add endpoint
  const url = webhookUrl.includes("crm.lead.add") ? webhookUrl : `${webhookUrl.replace(/\/$/, "")}/crm.lead.add.json`;

  const bitrixBody = {
    fields: {
      TITLE: payload.lead_title,
      COMPANY_TITLE: payload.company.name,
      COMMENTS: `
        Организация: ${payload.company.name}
        ИНН: ${payload.company.inn || "не определен"}
        Адрес: ${payload.company.address || "не определен"}
        Руководитель: ${payload.company.management_name || "-"}
        Интент готовности: ${payload.intent.score_percent}%
        Время на сайте: ${payload.intent.duration_seconds} сек
        Копировал контакты: ${payload.intent.copied_contacts ? "ДА" : "НЕТ"}
        Источник: ${payload.traffic.utm_source} / ${payload.traffic.utm_campaign || "-"}
        Город: ${payload.traffic.location}
      `.trim(),
      SOURCE_DESCRIPTION: "SURFAI B2B Intent Engine",
      OPPORTUNITY: Math.round(payload.intent.score * 50000),
      CURRENCY_ID: "RUB",
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bitrixBody),
  });

  const json = await res.json();
  if (!res.ok || json.error) {
    throw new Error(`Bitrix24 error: ${json.error_description || json.error || res.status}`);
  }

  return { ok: true, external_id: json.result };
}

async function dispatchLead(integration, leadData, dryRun = false) {
  const type = integration.crm_type;
  if (type === "webhook" || type === "telegram") {
    return sendToWebhook(integration.webhook_url, leadData, dryRun);
  }
  if (type === "bitrix24") {
    return sendToBitrix24(integration.webhook_url, leadData, dryRun);
  }
  // Default to webhook
  return sendToWebhook(integration.webhook_url, leadData, dryRun);
}

async function syncPendingB2BLeads({ siteId = null, dryRun = false } = {}) {
  // Fetch active CRM integrations
  const params = [];
  let where = "WHERE enabled = true";
  if (siteId) {
    params.push(siteId);
    where += " AND site_id = $1";
  }

  const { rows: integrations } = await pool.query(
    `SELECT * FROM crm_integrations ${where}`,
    params
  );

  if (!integrations.length) {
    console.log("No active CRM integrations configured.");
    return { synced: 0, results: [] };
  }

  // Fetch recent high-intent B2B sessions (last 48 hours)
  const sessionQuery = `
    SELECT
      sf.session_id,
      sf.site_id,
      sf.project_id,
      sf.geo_asn_org,
      sf.geo_asn,
      sf.geo_city,
      sf.geo_country,
      sf.geo_is_datacenter,
      sf.geo_is_mobile_carrier,
      sf.model_prediction_score,
      sf.session_duration_ms,
      sf.scroll_max_depth,
      sf.copy_count,
      sf.form_total_interactions,
      sf.ctx_utm_source,
      sf.ctx_utm_medium,
      sf.ctx_utm_campaign,
      s.domain AS site_domain
    FROM session_features sf
    JOIN sites s ON s.site_id = sf.site_id
    WHERE sf.geo_asn_org IS NOT NULL
      AND (
        sf.model_prediction_score >= 0.45
        OR sf.copy_count > 0
        OR sf.converted = true
      )
      AND NOT EXISTS (
        SELECT 1 FROM crm_synced_leads csl
        WHERE csl.session_id = sf.session_id
      )
    ORDER BY sf.computed_at DESC
    LIMIT 50;
  `;

  const { rows: sessions } = await pool.query(sessionQuery);

  const b2bSessions = sessions.filter(
    (s) => classifyAsnOrg(s.geo_asn_org, s.geo_is_datacenter, s.geo_is_mobile_carrier) === "b2b_corporate"
  );

  console.log(`Found ${b2bSessions.length} pending B2B sessions to sync to CRM.`);

  let syncedCount = 0;
  const results = [];

  for (const session of b2bSessions) {
    const matchingIntegrations = integrations.filter(
      (i) => !i.site_id || i.site_id === session.site_id
    );

    if (!matchingIntegrations.length) continue;

    // Enrich company
    let company = null;
    try {
      company = await getOrEnrichCompany(session.geo_asn_org);
    } catch (e) {
      console.warn("Enrichment skipped:", e.message);
    }

    const payload = buildLeadPayload({
      company,
      session,
      site: { domain: session.site_domain },
    });

    for (const integ of matchingIntegrations) {
      try {
        const res = await dispatchLead(integ, payload, dryRun);
        if (!dryRun) {
          await pool.query(
            `INSERT INTO crm_synced_leads
               (session_id, company_id, crm_type, external_lead_id, payload, status)
             VALUES ($1, $2, $3, $4, $5, 'success')`,
            [
              session.session_id,
              company?.id || null,
              integ.crm_type,
              res.external_id || res.id || null,
              JSON.stringify(payload),
            ]
          );
        }
        syncedCount++;
        results.push({ session_id: session.session_id, company: payload.company.name, status: "synced" });
      } catch (err) {
        console.error(`CRM sync error for session ${session.session_id}:`, err.message);
        if (!dryRun) {
          await pool.query(
            `INSERT INTO crm_synced_leads
               (session_id, company_id, crm_type, payload, status, error_message)
             VALUES ($1, $2, $3, $4, 'error', $5)`,
            [
              session.session_id,
              company?.id || null,
              integ.crm_type,
              JSON.stringify(payload),
              err.message,
            ]
          );
        }
      }
    }
  }

  return { synced: syncedCount, results };
}

// ---------------------------------------------------------------------------
// CLI Execution
// ---------------------------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const siteArg = args.find((a) => a.startsWith("--site="));
  const siteId = siteArg ? siteArg.replace("--site=", "") : null;

  syncPendingB2BLeads({ siteId, dryRun })
    .then((res) => {
      console.log("\nCRM Sync complete:", JSON.stringify(res, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error("Fatal CRM sync error:", err.message);
      process.exit(1);
    })
    .finally(() => pool.end());
}

module.exports = {
  buildLeadPayload,
  formatLeadTitle,
  sendToWebhook,
  sendToBitrix24,
  dispatchLead,
  syncPendingB2BLeads,
};
