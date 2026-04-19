# ADR: Yandex Metrica enrichment — staged integration

**Status:** Accepted. Created 2026-04-19.

**Decision-makers:** Artur (product), Claude Code (implementation).

## Context

Phase 6.5 closed with ~103 features per session and ~2 550 sessions in the fully-enriched window since 2026-04-11. The enrichment layer we built (GeoIP, UA Client Hints, Web Vitals) is strong on *what the device and network looked like* but weak on *where the user came from*. Specifically:

- Our only traffic-attribution fields today are `ctx_traffic_source` (coarse category), `ctx_referrer_host`, and the five `ctx_utm_*` fields captured client-side from `document.location.search`.
- UTM-tagged paid traffic is the only case where we see the real campaign; untagged Direct clicks, organic Yandex, auto-tagged campaigns that drop UTMs on redirects, and anything passing through ad-platform trackers all collapse into `ctx_traffic_source='organic'` or `'direct'`.
- This is exactly the signal Phase 8 (predictive export to Yandex Direct / GA4 Measurement Protocol) will need to pay off — you can't optimise a campaign you can't identify.

Yandex Metrica stores this attribution natively: every visit has `LastTrafficSource`, `LastAdvEngine`, `LastDirectClickOrder` (campaign/ad/keyword for auto-resolved Yandex Direct clicks), `LastSearchPhrase`, `UTMSource/Medium/Campaign/Content/Term`, and per-visit `Goals[]` hits. All 5 production test sites (sequoiamusic.ru, sluhnn.ru, stefcom.ru, дома-из-теплостен.рф, химчистка-луч.рф) are on a single Yandex account, so one OAuth token with `metrika:read` scope covers the whole dataset.

## Decision

We will integrate Yandex Metrica as an enrichment source for `session_features`, in **three staged shippable slices**, rather than as one big bang. Each slice is independently useful and unlocks the next without locking us into anything irreversible.

### Slice 1 — API sanity check & daily reconciliation (no SDK changes)

**Goal:** Prove the API connection works, validate the counter_id mapping, and get first numbers on how Metrica and SURFAI see the same sites.

**Changes:**
1. New migration `014_yandex_counter_id.sql`: add `sites.yandex_counter_id BIGINT NULL`.
2. Fill `yandex_counter_id` for the 5 test sites manually (either via `UPDATE sites ...` or by reading the counter list from Management API `GET /management/v1/counters` using the OAuth token).
3. New env vars: `YANDEX_METRICA_TOKEN` (OAuth token, `metrika:read` scope), `YANDEX_METRICA_ENABLED` (default `false`).
4. New module `server/features/yandex-metrica.js`:
   - `fetchDailyStats(counterId, dateFrom, dateTo)` — Reports API wrapper for `ym:s:visits`, `ym:s:users`, `ym:s:pageviews`, `ym:s:goal<id>reaches` for the site's primary goals.
   - `fetchVisitLogs(counterId, dateFrom, dateTo, fields[])` — Logs API async flow (create request → poll status → download parts → parse TSV). Used only in Slice 3 but scaffolded here.
5. New table `metrica_daily_reconciliation`:
   - `(site_id, date, metrica_visits, metrica_users, metrica_goals_total, surfai_sessions, surfai_conversions, created_at)`.
   - Unique constraint on `(site_id, date)` so re-runs are idempotent.
6. New worker `server/jobs/metrica-reconcile.js`:
   - Cron-style: runs once/day at 04:00 MSK for yesterday's data.
   - For each site with non-null `yandex_counter_id`, pulls Metrica totals and SURFAI totals, writes to `metrica_daily_reconciliation`.
   - Logs and alerts if Metrica/SURFAI visit counts diverge by more than 20% (ratio threshold to be tuned after first week of data).
7. New dashboard API endpoint `GET /api/reconciliation/daily?days=30` — returns reconciliation rows for the operator cabinet to visualise.

**Success criteria:**
- 7 consecutive days of reconciliation data without API errors.
- We can explain every case where Metrica > SURFAI sessions (typically: users with adblock blocking our endpoint but not Metrica, or our tracker loading late).
- We can explain every case where SURFAI > Metrica (typically: Metrica itself blocked, or counter not installed on all pages).
- No changes to SDK, DB schema of `session_features`, or ML pipeline. Fully reversible by setting `YANDEX_METRICA_ENABLED=false`.

### Slice 2 — capture the join key in the SDK

**Goal:** Start capturing `ym_uid` per session so we can later match our sessions to Metrica visits on a one-to-one basis.

**Changes:**
1. `client/src/collectors/context.ts`: call `window.ym(counterId, 'getClientID', cb)` **if** `window.ym` exists, with a short timeout (~500 ms) and fallback to `null`. Read the counter_id from a new SDK init option (`metrica_counter` — optional) or by scraping the GTM-injected `ym()` call. Put the result into `ctx_ym_client_id` on the context event.
2. `client/src/types.ts`: add `ymClientId?: string` to the `context` event's data type.
3. `server/server.js`: JSON Schema — add optional `ymClientId: { type: 'string', maxLength: 64 }` to the `context` event.
4. Migration `015_ym_client_id.sql`: add `session_features.ctx_ym_client_id TEXT NULL`.
5. `server/features/extractors.js`: propagate `ymClientId` from the context event into `session_features` at computeAndStore time. No enrichment computation yet — just store the raw value.
6. Update `CLAUDE.md` "Allowed event types" table, `.cursor/rules/data-contract.mdc`, and the client-side `client/CLAUDE.md` context-event schema.
7. Tests: add a unit test covering the `ym.getClientID` timeout fallback (must not throw, must not block emit).

**Lesson-4 compliance:** this is a "new field on existing event type" change, not a new event type, so no `events_type_check` migration is needed. SDK + server schema + DB column go in one commit per SDK telemetry lesson 2.

**Lesson-0 compliance:** `ym.getClientID` is async and can race unload. We treat it as a nice-to-have, not a blocker — if the callback doesn't fire in 500 ms we emit the `context` event without `ymClientId`. Never delay the primary context emit waiting for Metrica.

**Success criteria:**
- After 7 days of deploy, ≥85% of new `session_features` rows have `ctx_ym_client_id` populated for sites that have Metrica installed (химчистка-луч.рф excluded until its tag is also verified).
- Zero JS errors attributable to the new code in browser telemetry.
- Old bundle cached on client sites continues to pass server validation (field is optional).

### Slice 3 — Metrica attribution features in `session_features`

**Goal:** Make the Metrica attribution fields available as ML features for the next CatBoost retrain.

**Changes:**
1. Migration `016_metrica_attribution.sql`: add to `session_features`:
   - `ym_last_source TEXT` (e.g. `yandex-direct`, `google`, `social-vk`, `internal`)
   - `ym_last_medium TEXT` (cpc, organic, referral, direct, ...)
   - `ym_last_adv_engine TEXT` (`ya_direct_performance`, `ya_direct_display`, `google_ads`, ...)
   - `ym_direct_campaign_id BIGINT`
   - `ym_direct_ad_id BIGINT`
   - `ym_direct_phrase_id BIGINT`
   - `ym_last_search_phrase TEXT`
   - `ym_visit_duration INTEGER` (seconds, as Metrica measures it)
   - `ym_page_views INTEGER`
   - `ym_is_bounce BOOLEAN`
   - `ym_goals_reached INTEGER` (count of Metrica-side goal hits in that visit)
2. Extend `server/features/yandex-metrica.js` with `enrichSessionFeatures(sessionIds[])`:
   - Takes our session IDs, pulls matching Metrica visits from Logs API via `ym:s:clientID` match.
   - Writes back to `session_features`.
3. New worker `server/jobs/metrica-enrich.js`: runs daily at 05:00 MSK for yesterday's sessions. Logs API is asynchronous (~minutes to hours), so the worker polls and retries.
4. Update `ml/config.py`: add the new `ym_*` columns to `CATEGORICAL_FEATURES` (for source/medium/adv_engine/search_phrase) and `NUMERIC_FEATURES` (for the numerics). CatBoost handles NaN natively, so sessions without a ym_uid match will still train.
5. Backfill: for sessions between Slice-2 deploy date and Slice-3 deploy date, run a one-shot backfill via the same enrichment function. Sessions before Slice-2 deploy have NULL `ctx_ym_client_id` and are unrecoverable.

**Success criteria:**
- ≥70% of post-Slice-2 sessions match to a Metrica visit (match_rate = rows with non-null `ym_last_source` / rows with non-null `ctx_ym_client_id`).
- Retrained CatBoost shows at least one `ym_*` feature in the top-20 importance list (strong expectation: `ym_last_adv_engine`, `ym_last_source`, `ym_direct_campaign_id`).
- No regression in AUC vs the 103-feature baseline.

## Alternatives considered

**A. Skip Metrica, build Direct/GA4 API integrations from scratch.** Rejected for now. Metrica already does the hard attribution work on the client side; it would be wasteful to recreate that pipeline. We can still add direct-to-ad-platform APIs later for Phase 8 *output* without changing the Metrica *input*.

**B. Do all three slices in one release.** Rejected. Slice 1 is zero-SDK-risk and tells us within a week whether the API/counter mapping is sane. Slice 2 is a 1-line SDK change but requires rollout and bundle-cache window. Slice 3 depends on Slice 2 having accumulated data. Staging avoids a "works on my machine → broken on 1700 live sessions/day" incident.

**C. Wait until the Metrica self-serve OAuth UI is built in cabinet.** Rejected. We have one Yandex account covering 5 sites today; building a UI before we even know the attribution layer is valuable would be premature. The self-serve OAuth flow becomes a Phase 10 item if and when we go public SaaS.

**D. Use Metrica's first-party `_ym_uid` cookie directly without calling `getClientID`.** Rejected. The cookie is accessible as `document.cookie` but reading it bypasses Metrica's API and breaks if they rename/rotate cookies. `ym(counterId, 'getClientID', cb)` is the documented, version-stable API.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| OAuth token expiry kills the whole enrichment pipeline silently. | Daily reconciliation worker logs token validation error distinctly; alert at first 401. Token TTL (1 year default for Yandex) tracked in ops-calendar. |
| Metrica Logs API quota exhaustion (10 GB/day free tier). | 5 sites × ~1700 sessions/day × ~20 fields ≈ well under quota. Monitor in reconciliation worker. If we scale past 50 sites, revisit. |
| `ym(counterId, 'getClientID')` returns a different value than Metrica's server-side visit ClientID. | Cross-check in Slice 1: pick 10 known visits from Metrica API, find our matching sessions by timestamp + IP + UA, verify ClientID equality. Do this before committing to the join key. |
| Privacy / GDPR: Metrica ClientID is a pseudo-identifier. | Document in CLAUDE.md Security Rules that `ctx_ym_client_id` is a pseudonymous identifier bound to Metrica's own cookie consent flow — if a user blocks Metrica, we don't get a ClientID, so consent is inherited. No extra consent banner required for us. |
| SDK init has no Metrica counter_id at the time `context` event fires (counter loaded async by GTM). | `ym.getClientID` internally waits for Metrica init, so even if our context event fires first, the callback eventually fires — but possibly after we already flushed. Acceptable: those sessions get NULL `ctx_ym_client_id`. Measure rate in Slice 2. |

## Open questions (defer to Slice 2 / 3)

- **Server-side counter_id discovery.** Can we reliably extract `yandex_counter_id` from the client site without the client telling us, e.g. by scraping the GTM container or the live page? Would make onboarding zero-touch. Not needed for the 5 test sites (manual entry is fine).
- **Multi-counter sites.** What if a client runs two Metrica counters on the same page? Pick the first non-debug one. Out of scope for now, all 5 test sites have a single counter.
- **Visit-vs-session boundary mismatch.** Metrica closes a visit after 30 min idle, we use `sessionStorage` scoped to the tab. Some of our sessions may span 2+ Metrica visits (rare); we'll map by ClientID and take the most recent Metrica visit whose timestamp overlaps ours.

## Next action

- User generates OAuth token with `metrika:read` scope and delivers it via secure channel. Stored in `.env` as `YANDEX_METRICA_TOKEN`.
- Claude Code begins Slice 1 implementation in a dedicated branch. First deliverable: migration `014` + reconciliation worker running against local DB with a single hard-coded counter for smoke test.
