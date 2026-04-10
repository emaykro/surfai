# SURFAI — Behavioral Analytics Platform

## What This Is

Browser SDK (`client/`) collects mouse, scroll, and idle events.
Fastify server (`server/`) ingests batched JSON payloads via `POST /api/events` and persists them to PostgreSQL.
Python ML pipeline (`ml/`) trains CatBoost models on session features to predict conversion intent.

## Directory Layout

```
client/            Vanilla TypeScript SDK (zero runtime deps)
  src/tracker.ts     Core tracker: listeners, batching, flush
  dist/              Compiled output (ES6, declarations, source maps)
  index.html         E2E test page (loads SDK in browser)
server/            Node.js ingest server
  server.js          Fastify HTTP entry point + static file serving for dev
  features/          Feature engineering pipeline
    extractors.js      Mouse, scroll, click, form, engagement extractors
    store.js           Compute & upsert features into session_features table
    backfill.js        Backfill script for existing sessions
dashboard/         Analytics dashboard (vanilla JS, zero deps)
  index.html         Main dashboard page — session list, live feed, replay
cabinet/           Operator cabinet (vanilla JS, zero deps)
  index.html         SPA shell — project list, site setup, snippet copy
  js/app.js          Hash router, API calls, views
  css/style.css      Dark theme styling
ml/                Python CatBoost training pipeline
  config.py          Feature lists, CatBoost params, DB config
  cli.py             CLI: train | evaluate | generate-synthetic
  data/              Data loading, preprocessing, synthetic generator
  training/          CatBoost trainer, evaluation, artifact saving
  artifacts/         Trained models (.cbm), metrics, importance (gitignored)
.cursor/rules/     Cursor IDE rule files (synced with CLAUDE.md via meta-sync protocol)
.cursor/mcp.json   Cursor MCP server config (fetch, puppeteer, memory)
.mcp.json          Claude Code MCP server config (postgres, puppeteer, memory)
vault/             Persistent context store (survives context loss)
  decisions/         Architectural decisions (ADR-like records)
  sessions/          End-of-day session summaries
  bugs/              Bug investigations and resolutions
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

# Run all tests (client + server)
npm test                 # client: vitest, server: node --test

# ML pipeline
pip3 install -r ml/requirements.txt   # one-time setup
python3 -m ml train --synthetic       # smoke test on fake data
python3 -m ml train                   # train on real DB data
python3 -m ml evaluate --model ml/artifacts/latest_model.cbm
python3 -m ml generate-synthetic --n 1000 --output data.csv
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
| `context` | `trafficSource`, `deviceType`, `browser`, `os`, `screenW`, `screenH`, `language`, `connectionType`, `ts` + extended optional: `timezone`, `timezoneOffset`, `languages[]`, `viewportW`, `viewportH`, `devicePixelRatio`, `colorScheme`, `reducedMotion`, `hardwareConcurrency`, `deviceMemory`, `referrerHost`, `utmSource`, `utmMedium`, `utmCampaign`, `utmTerm`, `utmContent` | Device/traffic context. Emitted once per session on start. The 16 extended fields are optional on server validation so older cached bundles still pass; the current SDK always populates them. |
| `cross_session` | `visitorId`, `visitNumber`, `returnWithin24h`, `returnWithin7d`, `ts` | Cross-session tracking |
| `goal` | `goalId`, `value?`, `metadata?`, `ts` | Conversion goal event |
| `bot_signals` | `webdriver`, `phantom`, `nightmare`, `selenium`, `cdp`, `pluginCount`, `languageCount`, `hasChrome`, `notificationPermission`, `hardwareConcurrency`, `deviceMemory`, `touchSupport`, `screenColorDepth`, `ts` | Bot/automation fingerprint signals |

### Dashboard & Management API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/sessions?limit=50&offset=0&project_id=X` | List sessions (filterable by project) |
| `GET` | `/api/sessions/:sessionId?type=mouse` | Session detail with events (optional type filter, max 5000) |
| `GET` | `/api/events/live` | SSE stream — broadcasts batches as they arrive |
| `GET` | `/api/sessions/:sessionId/features` | Computed ML feature vector for a session |
| `GET` | `/api/sessions/:sessionId/conversions` | Conversion events for a session |
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

Dashboard UI: `http://localhost:3000/dashboard/`
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

**Active Phase:** Phase 6 — Multi-Project Data Model & Operator Cabinet.
Phases 1–5 complete. CatBoost training pipeline (`ml/`) built and smoke-tested.

**Operating model:** Operator-managed platform. Internal team connects tracker to client sites via GTM, manages projects through operator cabinet. No client-facing self-serve yet.

**Focus:**
- Multi-project isolation: `projects`, `sites`, `siteKey` auth
- Extend existing tables with `project_id` / `site_id`
- Operator cabinet: project CRUD, site onboarding, GTM snippet generator
- SDK: `siteKey` in every batch, server-side origin validation

**Revised phase order:** 6=Multi-Project → 7=Hierarchical ML → 8=Predictive Export to GA4/Metrika → 9=Hardening → 10=Public SaaS

**Master Roadmap:** `vault/decisions/2026-04-02_long_term_development_roadmap.md`

## Conventions

- SDK: zero runtime dependencies; `strict: true` TypeScript; target ES6.
- Server: CommonJS; Fastify with built-in JSON Schema validation on routes.
- Logging: structured via Fastify/Pino; no `console.log` in production paths.
- CORS must be explicit — never leave ingest open to `*` in production.
- All network calls from SDK must be non-blocking (`fetch keepalive` or `sendBeacon`).
- SDK must silently drop on failure; never throw into the host page.

## Meta-Sync Protocol (Claude Code ↔ Cursor)

This project is co-maintained by two AI agents: **Claude Code** (CLI) and **Cursor** (IDE).
If you (Claude Code) make an architectural decision, change the data schema, add a dependency,
or alter build steps, you **MUST** update the corresponding `.mdc` files inside `.cursor/rules/`:

- `data-contract.mdc` — if the event schema changed.
- `sdk-constraints.mdc` — if SDK behavior, batch limits, or security rules changed.
- `backend-fastify.mdc` — if server routes, validation, logging, or CORS config changed.
- `meta-sync.mdc` — if the sync protocol itself needs amendment.

Cursor has the reciprocal obligation: any change it makes must be reflected back into
`CLAUDE.md` (root and sub-packages). See `.cursor/rules/meta-sync.mdc` for the full protocol.

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
