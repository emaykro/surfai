# SURFAI — Behavioral Analytics Platform

## What This Is

Browser SDK (`client/`) collects mouse, scroll, and idle events.
Fastify server (`server/`) ingests batched JSON payloads via `POST /api/events` and persists them to PostgreSQL.
Python ML pipeline (`ml/`) trains CatBoost models on session features to predict conversion intent.

## Directory Layout

```
client/            Vanilla TypeScript SDK (zero runtime deps)
  src/tracker.ts     Core tracker: listeners, batching, flush, lifecycle hooks
  src/types.ts       TrackingEvent discriminated union + Collector interface
  src/helpers.ts     Cheap extractors: device/browser/os/traffic-source/timezone/utm/...
  src/collectors/    Modular collectors:
    click.ts, form.ts, engagement.ts, session.ts, context.ts,
    cross-session.ts, bot-signals.ts, performance.ts
  src/bundle.ts      Bundle entry — registers every collector on SurfaiTracker
  dist/              Compiled output (ES6, IIFE, source maps) — gitignored
  index.html         E2E test page (loads SDK in browser)
server/            Node.js ingest server
  server.js          Fastify HTTP entry point, routes, schemas, static file serving
  db.js              pg.Pool connection
  migrate.js         Migration runner for server/migrations/*.sql
  features/          Feature engineering + enrichment pipeline
    extractors.js      Per-event extractors (mouse, scroll, click, form,
                       engagement, session, context, cross_session, performance)
    store.js           computeAndStore() — fetches events, extracts features,
                       runs bot scoring, merges GeoIP + UA-CH, upserts into
                       session_features
    bot-scoring.js     Fingerprint + behavioral bot score
    geoip.js           MMDB reader singleton (dbip-city + asn), lookup(ip)
    ua-client-hints.js parseUaClientHints(headers) — Sec-CH-UA-* parser
    backfill.js        Batch backfill script for existing sessions
  migrations/        Numbered SQL migrations (001–013+); see Migrations section below
dashboard/         Analytics dashboard (vanilla JS, zero deps)
  index.html         Main dashboard page — session list, live feed, replay
cabinet/           Operator cabinet (vanilla JS, zero deps)
  index.html         SPA shell — project list, site setup, snippet copy
  js/app.js          Hash router, API calls, views
  css/style.css      Dark theme styling
ml/                Python CatBoost training pipeline
  config.py          Feature lists, CatBoost params, DB config, MIN_SITE_CONVERSIONS
  cli.py             CLI: train | evaluate | score | generate-synthetic
  data/              Data loading (joins projects for vertical), preprocessing, synthetic generator
  training/          CatBoost trainer, evaluation + calibration (isotonic regression), artifact saving
  score.py           Batch scorer: applies calibrator, logs cold-start sites
  artifacts/         Trained models (.cbm), calibrators (.pkl), metrics, importance (gitignored)
.cursor/rules/     Cursor IDE rule files (synced with CLAUDE.md via meta-sync protocol)
.cursor/mcp.json   Cursor MCP server config (fetch, puppeteer, memory)
.mcp.json          Claude Code MCP server config (postgres, puppeteer, memory)
vault/             Persistent context store (survives context loss)
  decisions/         Architectural decisions (ADR-like records)
  sessions/          End-of-day session summaries
  bugs/              Bug investigations and post-mortems
```

## Build & Run

```bash
# SDK — compile TypeScript
cd client && npx tsc

# Server — start locally on :3000 (also serves client/ as static files)
cd server && node server.js

# One-liner from repo root
npm run build && npm start

# E2E test page: http://localhost:3000/index.html
# Dashboard: http://localhost:3000/dashboard/

# Postgres (must be running for persistence features)
# Connection: postgresql://localhost:5432/surfai

# Run database migrations
npm run migrate          # or: cd server && npm run migrate

# Backfill feature vectors for existing sessions
cd server && npm run backfill

# Reconcile Yandex Metrica daily totals against our own (Slice 1)
cd server && npm run metrica:reconcile -- --date=2026-04-18 --dry-run
cd server && npm run metrica:reconcile             # yesterday, all sites, writes DB

# Forward lead messages: polls @Surfaiask_bot, auto-replies, forwards to admin via @SurfaiOps_bot
# (one-shot; surfai-contact-forward.timer runs it every 60s on prod)
cd server && npm run contact:forward

# Run all tests (client + server)
npm test                 # client: vitest, server: node --test

# ML pipeline
pip3 install -r ml/requirements.txt   # one-time setup
python3 -m ml train --synthetic       # smoke test on fake data
python3 -m ml train                   # train on real DB data (also fits + saves calibrator)
python3 -m ml evaluate --model ml/artifacts/latest_model.cbm
python3 -m ml generate-synthetic --n 1000 --output data.csv
# train outputs: latest_model.cbm + latest_calibrator.pkl (isotonic regression)
# score.py applies calibrator automatically if present
```

## Event Data Contract (single source of truth)

Every `POST /api/events` body must be:

```json
{
  "sessionId": "<uuid>",
  "siteKey": "<optional, hex string from sites table>",
  "sentAt": 1710000000000,
  "events": [
    { "type": "mouse",  "data": { "x": 120, "y": 480, "ts": 1710000000000 } },
    { "type": "scroll", "data": { "percent": 42, "ts": 1710000000000 } },
    { "type": "idle",   "data": { "idleMs": 12000, "ts": 1710000000000 } }
  ]
}
```

### Allowed event types

| Type | Data fields | Description |
|------|------------|-------------|
| `mouse` | `x`, `y`, `ts` | Mouse position (raw coords) |
| `scroll` | `percent` (0..100), `ts` | Scroll depth |
| `idle` | `idleMs`, `ts` | Idle detection |
| `click` | `x`, `y`, `elType`, `elTagHash`, `isCta`, `isExternal`, `timeSinceStart`, `ts` | Click tracking (10px grid coords) |
| `form` | `action` (focus/blur/submit/abandon), `formHash`, `fieldIndex`, `fieldType`, `fillDurationMs`, `ts` | Form interaction (no values) |
| `engagement` | `activeMs`, `idleMs`, `maxScrollPercent`, `scrollSpeed`, `microScrolls`, `readthrough`, `ts` | Page engagement snapshot |
| `session` | `pageCount`, `avgNavSpeedMs`, `isBounce`, `isHyperEngaged`, `timeBucket`, `ts` | Session-level signals |
| `context` | `trafficSource`, `deviceType`, `browser`, `os`, `screenW`, `screenH`, `language`, `connectionType`, `ts` + extended optional: `timezone`, `timezoneOffset`, `languages[]`, `viewportW`, `viewportH`, `devicePixelRatio`, `colorScheme`, `reducedMotion`, `hardwareConcurrency`, `deviceMemory`, `referrerHost`, `utmSource`, `utmMedium`, `utmCampaign`, `utmTerm`, `utmContent`, `metricaClientId` | Device/traffic context. Emitted once per session on start. All extended fields are optional on server validation so older cached bundles still pass; the current SDK always populates them. `metricaClientId` is the `_ym_uid` cookie value for cross-system Metrica matching (null if Metrica not installed). |
| `cross_session` | `visitorId`, `visitNumber`, `returnWithin24h`, `returnWithin7d`, `ts` | Cross-session tracking |
| `goal` | `goalId`, `value?`, `metadata?`, `ts` | Conversion goal event |
| `bot_signals` | `webdriver`, `phantom`, `nightmare`, `selenium`, `cdp`, `pluginCount`, `languageCount`, `hasChrome`, `notificationPermission`, `hardwareConcurrency`, `deviceMemory`, `touchSupport`, `screenColorDepth`, `ts` | Bot/automation fingerprint signals |
| `performance` | `lcp`, `fcp`, `fid`, `inp`, `cls`, `ttfb`, `domInteractive`, `domContentLoaded`, `loadEvent`, `transferSize`, `longTaskCount`, `longTaskTotalMs`, `ts` | Core Web Vitals + Navigation Timing + Long Tasks. Collected via `PerformanceObserver` throughout the session and emitted **once** via `PerformanceCollector.beforeFlush()` on page unload. All numeric fields nullable (may be missing on short bounces or unsupported browsers). CLS uses the session-window algorithm. INP is a simplified max interaction duration. |

### Dashboard & Management API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/sessions?limit=50&offset=0&project_id=X` | List sessions (filterable by project) |
| `GET` | `/api/sessions/:sessionId?type=mouse` | Session detail with events (optional type filter, max 5000) |
| `GET` | `/api/events/live` | SSE stream — broadcasts batches as they arrive |
| `GET` | `/api/sessions/:sessionId/features` | Computed ML feature vector for a session |
| `GET` | `/api/sessions/:sessionId/conversions` | Conversion events for a session |
| `GET` | `/api/reconciliation/daily?days=30&site_id=X` | Metrica vs SURFAI daily counts from `metrica_daily_reconciliation`. Populated by `npm run metrica:reconcile` on the server. |
| `GET` | `/api/sites/health` | Per-site health last 48h; detects the "passive-only event mix" fingerprint plus session-drop / install-verified / missing-interaction-types flags. Consumed by `/dashboard/sites.html`. |
| `GET` | `/api/ml/readiness` | Enriched conversions vs target + 14-day-trailing daily rate + ETA. Drives the header widget on `/dashboard/`. |
| `GET` | `/api/health` | Aggregate system health: DB, disk, memory, ingest liveness, reconcile-timer age, Metrica-token expiry. Returns HTTP 503 when any check is critical. |
| `POST` | `/api/projects` | Create project (name, vertical) |
| `GET` | `/api/projects` | List projects with 24h stats |
| `GET` | `/api/projects/:projectId` | Project detail |
| `PUT` | `/api/projects/:projectId` | Update project |
| `POST` | `/api/projects/:projectId/sites` | Add site (domain, origins, install method) → generates siteKey |
| `GET` | `/api/projects/:projectId/sites` | List sites for project |
| `GET` | `/api/sites/:siteId/verify` | Check install status (events in last 5 min) |
| `GET` | `/api/sites/:siteId/snippet` | Get install snippets (direct + GTM) |
| `POST` | `/api/goals` | Create a goal (name, type, rules, project_id) |
| `GET` | `/api/goals?project_id=X` | List goals (filterable by project) |
| `PUT` | `/api/goals/:goalId` | Update goal |
| `DELETE` | `/api/goals/:goalId` | Soft-delete goal |
| `POST` | `/api/conversions` | Server-side conversion registration |

Dashboard UI (three pages, shared nav):
- `http://localhost:3000/dashboard/` — Sessions list, live SSE feed, session detail + replay. Header shows ML retrain readiness widget.
- `http://localhost:3000/dashboard/reconciliation.html` — Metrica vs SURFAI daily totals, pivot grid tinted by per-site baseline drift.
- `http://localhost:3000/dashboard/sites.html` — Per-site health last 48h; detects "passive-only event mix" (tag removed fingerprint), session drops, missing interaction types.

Operator Cabinet: `http://localhost:3000/cabinet/`

### Rules

- `sessionId` — non-empty string, one per browser tab via `sessionStorage`.
- `sentAt` — integer unix ms, stamped by SDK at send time.
- `events` — non-empty array.
- All numeric fields must be numbers, never strings.
- `percent` / `maxScrollPercent` must be in range `0..100`.
- Element text and CSS selectors are hashed with MurmurHash3 (truncated to 120 chars) — never raw.
- Never add, rename, or remove fields without updating **both** SDK types and backend schema in the same commit.

## Current Strategy

**Active Phase:** Phase 6.5 — Data Enrichment Sprint (informal interim phase between Phase 6 and Phase 7).
Phases 1–6 complete. Bot detection layer deployed 2026-04-08. Telemetry reliability incident resolved 2026-04-10. Significant data enrichment happened 2026-04-10: extended context, GeoIP, Web Vitals, UA Client Hints. Feature count grew from ~57 to ~103.

**Operating model:** Operator-managed platform. Internal team connects tracker to client sites via GTM, manages projects through operator cabinet. No client-facing self-serve yet.

**Focus right now:**
- Accumulate data on the new feature set (currently ~500 sessions/day, need ~50+ real conversions for robust retrain on the enlarged feature space)
- Dashboard segmentation by the new dimensions (country/city/UTM/device/browser/LCP/bot score)
- Page classification + first-touch attribution + scroll milestones (planned next)
- Then retrain CatBoost and move into real Phase 7 (hierarchical ML)

**Revised phase order:** 6=Multi-Project → **6.5=Data Enrichment (current)** → 7=Hierarchical ML → 8=Predictive Export to GA4/Metrika → 9=Hardening → 10=Public SaaS

**Master Roadmap:** `vault/decisions/2026-04-02_long_term_development_roadmap.md`

## Migrations (server/migrations/)

| # | File | Adds |
|---|---|---|
| 001 | `initial_schema.sql` | `sessions`, `raw_batches`, `events` |
| 002 | `expanded_event_types.sql` | `events_type_check` with click/form/engagement/session/context/cross_session |
| 003 | `dashboard_indexes.sql` | Query indexes for session list / detail |
| 004 | `feature_store.sql` | `session_features` table |
| 005 | `goals_and_conversions.sql` | `goals`, `conversions`, primary-goal column |
| 006 | `goal_event_type.sql` | `goal` in `events_type_check` |
| 007 | `multi_project.sql` | `projects`, `sites`, `site_key`, `project_id`/`site_id` on everything |
| 008 | `bot_detection.sql` | `bot_score`, `bot_risk_level`, `bot_signals`, `is_bot` on `session_features` |
| 009 | `bot_signals_event_type.sql` | `bot_signals` in `events_type_check` (missed in 008) |
| 010 | `extended_context_fields.sql` | 16 `ctx_*` extended columns (timezone, viewport, dpr, utm, hardware, ...) |
| 011 | `geoip_enrichment.sql` | 10 `geo_*` columns (country, region, city, ASN, org, is_datacenter, ...) |
| 012 | `performance_event_type.sql` | `performance` in `events_type_check` + 12 `perf_*` columns (LCP, CLS, ...) |
| 013 | `ua_client_hints.sql` | 8 `uah_*` columns (brand, mobile, platform, model, arch, ...) |
| 014 | `yandex_metrica.sql` | `sites.yandex_counter_id` (nullable BIGINT) + `metrica_daily_reconciliation` table. Pre-populates counter IDs for the 5 prod sites. Slice 1 of the Metrica enrichment plan (see `vault/decisions/2026-04-19_yandex_metrica_enrichment.md`). |
| 015 | `model_scoring.sql` | `model_prediction_score` (DOUBLE PRECISION) + `model_scored_at` (TIMESTAMPTZ) on `session_features`. Populated by `python3 -m ml score` (systemd timer every 5 min). |
| 016 | `metrica_client_id.sql` | `metrica_client_id` TEXT on `session_features`. Populated from `context` event's `metricaClientId` field (`_ym_uid` cookie). For cross-system Metrica matching. |
| 017 | `metrica_conversions_sync.sql` | `metrica_synced_at` TIMESTAMPTZ on `conversions`. NULL = not yet pushed to Metrica Offline Conversions API. Populated by `npm run metrica:conversions`. |

**Critical rule:** any new `events.type` value requires updating `events_type_check` in a migration in the SAME commit as the SDK change. Otherwise atomic `persistBatch` will reject every batch containing the new type. Learned from the 2026-04-08 incident — see `vault/bugs/2026-04-10 context and session event loss.md`.

## Conventions

- SDK: zero runtime dependencies; `strict: true` TypeScript; target ES6.
- Server: CommonJS; Fastify with built-in JSON Schema validation on routes.
- Logging: structured via Fastify/Pino; no `console.log` in production paths.
- CORS must be explicit — never leave ingest open to `*` in production.
- All network calls from SDK must be non-blocking (`fetch keepalive` or `sendBeacon`).
- SDK must silently drop on failure; never throw into the host page.

## ML Architecture

### Multi-niche, fast cold-start design

The platform is designed to serve businesses across different verticals (services, e-commerce, SaaS, media, real estate, etc.) including new sites with zero historical conversions.

**`vertical` feature** — derived at load/score time via JOIN on `projects.vertical`. Lets the global model carry patterns from already-seen niches to a new site in the same niche from day one. Never add `vertical` as a denormalized column to `session_features` — always JOIN.

**Cold-start threshold** — `MIN_SITE_CONVERSIONS = 30` (in `config.py`). Below this, score.py uses the global model (trained on all sites). Above this, the site has enough data for a site-specific fine-tuning pass. Logged at score time so operators can track graduation.

**Two-tier scoring (current → future)**:
- Tier 1 (now): one global CatBoost model, `site_id` + `vertical` as categorical features, trained on all sites. CatBoost handles NaN natively (sparse enrichment columns fine).
- Tier 2 (future): per-site fine-tuned model loaded by site-specific path; score.py checks conversion count and picks the right model.

### Calibration

Raw CatBoost probabilities are well-ranked (high AUC) but not guaranteed to be well-calibrated — `predict_proba=0.7` may not correspond to 70% actual conversions. This matters critically for synthetic conversions: if we report inflated probabilities to GA4/Metrika, the ad platform optimizes toward a signal that doesn't represent real intent.

`training/evaluation.py:calibrate_model()` fits an isotonic regression on the validation set and saves it as `latest_calibrator.pkl`. `score.py` applies it automatically if present. `calibration_metrics()` reports ECE (Expected Calibration Error) before and after — lower is better, 0 = perfect.

**Rule:** always retrain the calibrator together with the model. A stale calibrator fitted on old validation data is worse than no calibrator.

### Feature columns

`FEATURE_COLUMNS` in `config.py` is append-only. Removing a column name invalidates existing `.cbm` artifacts. Leave a comment if retiring a feature; drop the column only after a new model is trained and deployed.

## Engineering Discipline

These principles are adapted from Karpathy's observations about AI-assisted coding and grounded in SURFAI's own incidents. Both Claude Code and Cursor must follow them.

### Think Before Coding

**For any non-trivial request, state your interpretation before writing code.**
If a feature can be implemented at multiple layers, name the layer you chose and why — don't pick silently. If two valid approaches exist, present the tradeoff in 2–3 sentences and wait for confirmation.

SURFAI layer preference (cheapest/safest first):
1. Derive from data already in the DB — no code change at all
2. Server-side enrichment from existing events — no SDK change
3. Add an optional field to an existing event type
4. New SDK collector + new event type — most expensive (triggers schema rule below)

If a decision affects architecture, schema, or deployment, create `vault/decisions/YYYY-MM-DD-<title>.md` **before** implementation, not after. This converts the vault from a retrospective log into a genuine thinking tool.

**Before touching the event schema:**
- New `events.type`? → migration (`events_type_check` update) + SDK (`types.ts`) must land in **one commit**. Skipping this breaks every batch in production that contains the new type. Root cause of 2026-04-08 incident.
- New fields on an existing type? → make them **optional** on the server JSON Schema so older cached SDK builds (TTL ~1 h) still pass validation.
- New `session_features` column? → answer before proceeding: (1) expected fill rate; (2) will it enter `FEATURE_COLUMNS`? (3) if fill rate < 20 %, is sparsity acceptable for training?

**Before adding a collector:**
- Can this signal be derived server-side from data already in the DB (timestamps, UA string, IP)? Server-side = zero client delivery risk.
- Does it need a new event type? If yes, follow the schema rule above.
- One-shot critical events (`context`, `bot_signals`, `performance`) must not use `requestIdleCallback` — use `beforeFlush()` for guaranteed delivery.

**Before touching the ML pipeline:**
- State the current AUC baseline before any change (v3 site-aware reference: 0.9785). Changes that drop AUC must be explicitly justified.
- Adding / removing / renaming a feature? → `server/features/extractors.js` and `ml/config.py:FEATURE_COLUMNS` in the **same commit**.
- Retrain required? Check first: `SELECT COUNT(*) FROM conversions c JOIN session_features sf USING(session_id) WHERE sf.new_column IS NOT NULL` — need ≥ 50 real conversions on the new feature set.

### Simplicity First

- If a signal can be computed server-side from data already in the DB, don't add a new SDK collector for it.
- New collectors should stay under ~80 lines. Exceeding that is a scope signal.
- A `session_features` column with no corresponding `FEATURE_COLUMNS` entry is schema bloat — add the column only when the ML side is ready to consume it.
- Don't introduce server-side enrichment that is O(sessions × events) per ingest request without benchmarking the cost on the current 500 sessions/day load.

### Surgical Changes

Three things in this project are **append-only** — never modify in place:

1. **Migration files** (`server/migrations/*.sql`) — add a new numbered file; never edit an existing one.
2. **`events_type_check` constraint** — only add values; never remove or rename (would break replay of historical raw batches).
3. **`FEATURE_COLUMNS` in `ml/config.py`** — removing a column name invalidates existing `.cbm` artifacts; leave a comment if removing.

When fixing a bug in one extractor or collector:
- Don't "clean up" adjacent code in the same commit unless it directly caused the bug.
- Don't rename event fields or DB columns as a side-effect — that's a migration + SDK change, not a bugfix.

**Universal test for any code change:** every line you touch in the diff must trace directly to the stated request. If you notice unrelated dead code, a naming inconsistency, or a refactoring opportunity — mention it in your response, don't silently fix it. Don't add new `require()`/`import` statements as a side-effect of a bugfix.

### Goal-Driven Verification

"Deployed" means nothing until verified against concrete criteria. Run the matching check after every change:

**SDK / collector change:**
```bash
# Collector and new field present in bundle
grep -c 'NewCollectorClass\|newFieldName' client/dist/tracker.js
# Bundle size still sane (expect 20–30 KB for current collector set)
wc -c client/dist/tracker.js
```

**Migration applied:**
```sql
-- Column present
SELECT column_name FROM information_schema.columns
WHERE table_name = 'session_features' AND column_name = 'new_col';
```

**New feature column fill rate (run 24 h after deploy):**
```sql
SELECT
  COUNT(*) FILTER (WHERE new_col IS NOT NULL)::float / NULLIF(COUNT(*), 0) AS fill_rate
FROM session_features
WHERE created_at > NOW() - INTERVAL '24 hours';
-- Expect: > 0.5 for behavioral signals; > 0.2 for optional context fields
```

**ML scoring live:**
```bash
journalctl -u surfai-ml-score.timer --since "10 min ago" | grep -c 'scored'
# and
psql surfai -c "SELECT COUNT(*) FROM session_features WHERE model_scored_at > NOW() - INTERVAL '10 minutes';"
```

## Meta-Sync Protocol (Claude Code ↔ Cursor)

This project is co-maintained by two AI agents: **Claude Code** (CLI) and **Cursor** (IDE).
If you (Claude Code) make an architectural decision, change the data schema, add a dependency,
or alter build steps, you **MUST** update the corresponding `.mdc` files inside `.cursor/rules/`:

- `data-contract.mdc` — if the event schema changed.
- `sdk-constraints.mdc` — if SDK behavior, batch limits, or security rules changed.
- `backend-fastify.mdc` — if server routes, validation, logging, or CORS config changed.
- `engineering-discipline.mdc` — if the Engineering Discipline section changed (pre-flight checklists, verification criteria, surgical rules).
- `meta-sync.mdc` — if the sync protocol itself needs amendment.

Cursor has the reciprocal obligation: any change it makes must be reflected back into
`CLAUDE.md` (root and sub-packages). See `.cursor/rules/meta-sync.mdc` for the full protocol.

**Surgical update rule:** when updating `.mdc` files, edit only the sections that changed — don't rewrite the whole file. The resulting diff must be readable in 30 seconds. The same Engineering Discipline rules (surgical changes, think before coding, goal-driven verification) apply to Cursor's own code edits, not only to metadata sync.

## Vault Workflow (persistent context layer)

The `vault/` directory is a **persistent knowledge store** that survives context window resets,
session restarts, and compaction. It is the second layer of our 3-layer memory system
(Constitution → **Vault** → Memory MCP).

### Session Summaries (`vault/sessions/`)

When the user writes **"сохрани сессию"** (or equivalent), the agent **MUST**:

1. Analyze everything accomplished in the current session.
2. Create a file in `vault/sessions/` with the naming convention:
   `YYYY-MM-DD <descriptive statement>.md`
   - The filename must be a **long, descriptive sentence** summarizing the session.
   - Example: `2026-04-02 создали базовый fastify ingest сервер и SDK трекер с батчингом.md`
3. The file must contain:
   - **What was done** — list of concrete changes (files created/modified, features added).
   - **Key decisions** — why we chose approach X over Y.
   - **Current state** — what works, what doesn't yet.
   - **Next steps** — what to do in the next session.
   - **Open questions** — unresolved issues or unknowns.

### Architectural Decisions (`vault/decisions/`)

When the team makes a significant architectural choice, create a file:
`YYYY-MM-DD <decision summary>.md` with context, alternatives considered, and rationale.

### Bug Investigations (`vault/bugs/`)

When debugging a non-trivial issue, record the investigation:
`YYYY-MM-DD <bug summary>.md` with symptoms, root cause, fix, and prevention notes.

### Rules

- **Always read `vault/sessions/` at session start** to recover context from prior sessions.
- Vault files are append-only by default — update existing files only to correct errors.
- Keep files concise but complete enough for a cold-start agent to understand the full picture.
- Both Claude Code and Cursor must respect and contribute to the Vault.

## MCP Servers

Two config files manage MCP servers for the two agents:

| File | Agent | Servers |
|------|-------|---------|
| `.mcp.json` | Claude Code CLI | `postgres`, `puppeteer`, `memory` |
| `.cursor/mcp.json` | Cursor IDE | `fetch`, `puppeteer`, `memory` |

- **fetch** — web content fetching, converts pages to markdown (Python, via `uvx mcp-server-fetch`).
- **puppeteer** — headless browser automation for E2E testing (`npx @modelcontextprotocol/server-puppeteer`).
- **memory** — persistent key-value knowledge graph across sessions (`npx @modelcontextprotocol/server-memory`).
- **postgres** — direct SQL access to the surfai database (Claude Code only).

When adding or removing MCP servers, update **both** config files if the server is shared.

## UA Client Hints

In addition to parsing `navigator.userAgent` on the client, the server reads `Sec-CH-UA-*` HTTP headers from every ingest request and writes derived `uah_*` columns to `session_features` (`uah_brand`, `uah_brand_version`, `uah_mobile`, `uah_platform`, `uah_platform_version`, `uah_model`, `uah_arch`, `uah_bitness`). This gives structured, reliable device identification without regex-parsing the raw UA string. Firefox and Safari do not send these headers — those sessions get NULL `uah_*` fields.

Module: `server/features/ua-client-hints.js` — `parseUaClientHints(headers)`. Called once per batch in the ingest handler, result passed to `computeAndStore(sessionId, projectId, siteId, clientIp, uaHints)`.

Low-entropy hints (`Sec-CH-UA`, `Sec-CH-UA-Mobile`, `Sec-CH-UA-Platform`) arrive automatically on every Chromium request. High-entropy hints (`Sec-CH-UA-Platform-Version`, `Sec-CH-UA-Model`, `Sec-CH-UA-Arch`, `Sec-CH-UA-Bitness`) require the browser to have seen an `Accept-CH` header from our origin — we set one globally via the `onSend` hook as a best-effort opt-in. Cross-origin delivery also depends on the client site's `Permission-Policy`, which we don't control, so high-entropy hints are best-effort.

## GeoIP Enrichment

Starting 2026-04-10, the ingest path looks up the client IP against local MMDB files at `session_features` UPSERT time and writes the derived `geo_*` columns (country, region, city, timezone, lat/long, ASN, ASN org, `is_datacenter`, `is_mobile_carrier`). The raw IP is **never stored** — it lives only in `request.ip` for the duration of the ingest handler.

- Module: `server/features/geoip.js` — singleton, initialized once in `server.js` startup via `geoip.init(fastify.log)`.
- Data: `@ip-location-db/dbip-city-mmdb` (CC BY 4.0 by DB-IP, monthly) + `@ip-location-db/asn-mmdb` (CC BY 4.0 by RouteViews + DB-IP, daily). Read via `maxmind` npm package.
- Attribution requirement (CC BY 4.0): when the dashboard or cabinet renders geo data, it must include a visible link to `https://db-ip.com/` (TODO — not yet wired).
- `trustProxy: "127.0.0.1"` is set on the Fastify instance so `request.ip` resolves to the real client IP via `X-Forwarded-For` from nginx.
- Graceful degradation: if the MMDB packages are not installed or files are missing, `geoip.init()` logs a warning and `lookup()` returns all-null objects. Ingest keeps working.

## Security Rules

- Never commit `.env`, credentials, or API keys.
- SDK must skip events from `INPUT`, `TEXTAREA`, and `contenteditable` elements.
- Never capture text content, field values, or anything that could contain PII.
- Backend must reject malformed payloads via schema; never coerce bad input.
- Sanitize all values before SQL insertion; use parameterized queries only.
- All operator/dashboard API endpoints require `Authorization: Bearer <OPERATOR_API_TOKEN>`. Ingest `POST /api/events` is public.
- Ingest requires `siteKey` by default. Set `ALLOW_INGEST_WITHOUT_SITEKEY=true` for local dev only.
- Origin validation uses strict `new URL().origin` comparison — never `startsWith`.
- Dashboard and cabinet must use `textContent` or `esc()` for dynamic data — never raw `innerHTML` with API/DB content.
- Body size limit: 256 KB (Fastify `bodyLimit`).
- Security headers: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`.
- Logs must never contain raw tokens or full siteKeys; use Pino `redact` for `authorization` header.

### Environment Variables (Security)

| Variable | Default | Purpose |
|----------|---------|---------|
| `OPERATOR_API_TOKEN` | (empty — returns 401) | Bearer token for operator/dashboard API |
| `ALLOW_INGEST_WITHOUT_SITEKEY` | `false` | Allow ingest without siteKey (dev only) |
| `LOG_LEVEL` | `info` | Pino log level |
| `YANDEX_METRICA_TOKEN` | (empty — reconcile worker aborts) | OAuth access token, `metrika:read` scope. TTL ~1 year. |
| `YANDEX_METRICA_REFRESH_TOKEN` | (empty) | Refresh token; consumed by `refreshAccessToken()` helper when the access token expires. |
| `YANDEX_OAUTH_CLIENT_ID` / `_CLIENT_SECRET` | (empty) | OAuth app credentials, used only for refresh flow. |
| `YANDEX_METRICA_ENABLED` | `false` | Gate for the *scheduled* reconcile worker (cron/systemd). Manual `npm run metrica:reconcile` ignores it. |
| `YANDEX_METRICA_TOKEN_ISSUED_AT` | (empty → health endpoint warns) | Date the current access token was issued, YYYY-MM-DD. Used by `/api/health` only as a fallback when `EXPIRES_AT` is missing. |
| `YANDEX_METRICA_TOKEN_EXPIRES_AT` | (empty → health falls back to ISSUED_AT) | Date the current access token expires, YYYY-MM-DD. Written by `npm run metrica:refresh` from Yandex's `expires_in`. Authoritative source of truth — Yandex returns variable TTLs (observed 174 days, not always 365), so `ISSUED_AT + 365` is unreliable. |
| `TELEGRAM_BOT_TOKEN` | (empty → alerter aborts) | Bot token from @BotFather for the Telegram alert channel. Consumed by `npm run health:alert`. |
| `TELEGRAM_ALERT_CHAT_ID` | (empty → alerter aborts) | Destination chat id for alerts (integer, private or group). Obtained via `getUpdates` after the user sends any message to the bot. |
| `METRICA_CONVERSION_TARGET` | `lead` | Fallback Metrica goal name used when a SURFAI conversion has no matching goal name. Must match a goal configured in the Metrica counter. Consumed by `npm run metrica:conversions`. |
| `CONTACT_BOT_TOKEN` | (empty → contact:forward aborts) | @Surfaiask_bot token. The forwarder uses it to poll incoming lead messages and send auto-replies. Separate from `TELEGRAM_BOT_TOKEN` (@SurfaiOps_bot) per the two-channel convention. |
| `API_BASE_URL` | `https://surfai.ru` | Base URL of the prod server. Not used by `server.js` directly; consumed by job scripts that need to construct self-referencing URLs. |
