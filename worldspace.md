# SURFAI — Predictive Behavioral Analytics Platform

> Last updated: 2026-04-10 (evening). This file is a quick-reference map of the project for humans and AI agents. Authoritative details live in `CLAUDE.md`, `vault/decisions/`, and the per-package `client/CLAUDE.md` / `server/CLAUDE.md`.

## Vision

Operator-managed predictive analytics for paid-traffic SaaS. We collect behavioral signals on client sites, train per-site ML models to predict conversion intent, and export *synthetic* predictive conversions back to GA4 / Yandex Metrika so ad platforms can optimize on the expanded signal. Expected impact: 20–30% CPA drop.

**Secondary vision:** the dashboard is evolving from a debug tool into a full-featured analytics product — a GA-alternative that clients can look into and see conversion rate by country / city / UTM / device quality / page speed / bot share, with ML-powered scoring on top. Not there yet, but every data-enrichment decision should be made with this end state in mind.

**Operating model:** internal team runs all projects. No client self-serve yet; onboarding is manual via GTM.

## Platform Status (2026-04-10)

| Layer | Status |
|---|---|
| **Phase 1 — Persistence & SDK hardening** | ✅ Complete |
| **Phase 2 — Expanded event taxonomy** (click, form, engagement, session, context, cross_session, bot_signals, performance) | ✅ Complete |
| **Phase 3 — Feature engineering pipeline** (`server/features/`) | ✅ Complete |
| **Phase 4 — Goals & conversions** (page rules, dataLayer, Metrika reachGoal, server-side) | ✅ Complete |
| **Phase 5 — ML training pipeline** (CatBoost, first real training done 2026-04-08, AUC 0.91) | ✅ Complete |
| **Phase 6 — Multi-project data model & operator cabinet** | ✅ Complete |
| **Phase 6.5 — Data enrichment sprint** (bot detection, extended context, GeoIP, Web Vitals, UA Client Hints) | ✅ Done 2026-04-10 |
| **Phase 7 — Hierarchical ML + retrain on enriched features** | 🟡 Waiting on more conversions (~28 so far, need ~50+) |
| **Phase 8 — Predictive export to GA4/Metrika** | ⏳ Not started |
| **Phase 9 — Hardening** | ⏳ Not started |
| **Phase 10 — Public SaaS** | ⏳ Not started |

Master roadmap: `vault/decisions/2026-04-02_long_term_development_roadmap.md`.

## Production Deployment

- Server: `72.56.68.138` (Timeweb VPS, "Kukuruza"), domain `surfai.ru`
- Service: `systemd` unit `surfai`, Fastify on port `3100`, Nginx reverse proxy with TLS
- Database: PostgreSQL (`surfai` DB, `surfai_user`)
- Repo: `github.com/emaykro/surfai` (public, MIT)
- Deploy: `cd /opt/surfai && git pull origin main && npm run build && systemctl restart surfai`
- Migrations: `npm run migrate` (reads `server/migrations/NNN_*.sql`)
- SDK cache: nginx serves `/dist/tracker.js` with `Cache-Control: public, max-age=300, must-revalidate` so SDK fixes propagate within 5 minutes

## Connected Sites (project "Luch", services vertical)

| Domain | Conversion trigger |
|---|---|
| sequoiamusic.ru | page rule `/thx` |
| sluhnn.ru | page rule `?thankyou` (primary) |
| stefcom.ru | Metrika `reachGoal` (no thank-you page) |
| дома-из-теплостен.рф | page rule `/thank-you` |
| химчистка-луч.рф | page rule `/thank-you` |

**Data volume (as of 2026-04-10 evening):**
- ~450–500 sessions/day, >730k events total
- ~2,800 sessions in `session_features`
- 28 real conversions (need ~50+ for a robust retrain on the enlarged feature set)
- Historical sessions before 2026-04-10 keep NULL for `ctx_*` extended fields, `geo_*`, `perf_*`, and `uah_*` — no backfill possible. CatBoost handles NaN natively.

## Tech Stack

| Layer | Tech | Notes |
|---|---|---|
| Browser SDK | Vanilla TypeScript ES6, zero runtime deps | `client/` — 8 collectors, compiled via `tsc` + bundled via `esbuild` (IIFE), ~47 kb gzipped |
| Ingest server | Node.js + Fastify (CommonJS) | `server/` — JSON Schema on every route, `pg.Pool`, Pino logs, `trustProxy: "127.0.0.1"` |
| Feature store | PostgreSQL `session_features` table | ~103 ML features across behavioral / context / geo / perf / ua-ch dimensions |
| GeoIP | `maxmind@5` + `@ip-location-db/dbip-city-mmdb` + `@ip-location-db/asn-mmdb` (~150 MB) | Server-side lookup at ingest; raw IP never stored |
| ML training | Python 3 + CatBoost | `ml/` — CLI entry `python3 -m ml train`, AUC 0.91 on first real-data run 2026-04-08 |
| Dashboard | Vanilla JS, zero deps | `dashboard/` — session list, live SSE feed, replay |
| Operator cabinet | Vanilla JS SPA | `cabinet/` — project CRUD, site onboarding, snippet copy, goals |

Full details: `CLAUDE.md` at repo root.

## Feature Set (~103 total)

| Group | Count | Source | Examples |
|---|---|---|---|
| **Behavioral** | ~50 | Client collectors → server extractors | mouse velocity/jitter/curvature, scroll depth/speed, click rage, form hesitation, engagement readthrough, sliding-window JSONB |
| **Extended Context** | 23 | Client `ContextCollector` → `ctx_*` columns | trafficSource, device, browser, os, timezone, viewport, dpr, languages, colorScheme, hardware, utm_*, referrerHost, connectionType |
| **GeoIP** | 10 | Server IP lookup at ingest → `geo_*` columns | country, region, city, latitude, longitude, asn, asn_org, is_datacenter, is_mobile_carrier |
| **Performance / Web Vitals** | 12 | Client `PerformanceCollector` (two early snapshots + beforeFlush) → `perf_*` columns | LCP, FCP, FID, INP, CLS (session-window), TTFB, domInteractive, domContentLoaded, loadEvent, transferSize, longTaskCount, longTaskTotalMs |
| **UA Client Hints** | 8 | Server header parser at ingest → `uah_*` columns | brand, brand_version, mobile, platform, platform_version, model, arch, bitness |
| **Bot detection** | 4 | SDK fingerprint + behavioral scoring | bot_score, bot_risk_level, bot_signals JSONB, is_bot |

## Production Cache & Delivery

- `GET /dist/tracker.js` → `Cache-Control: public, max-age=300, must-revalidate` (lowered from 24h on 2026-04-10 after a painful debugging incident — SDK fixes now propagate within 5 minutes)
- `Accept-CH: Sec-CH-UA-Platform-Version, Sec-CH-UA-Arch, Sec-CH-UA-Bitness, Sec-CH-UA-Model, Sec-CH-UA-Full-Version-List` set globally via `onSend` hook to opt in for high-entropy UA hints (best-effort; cross-origin delivery depends on client-site Permission-Policy)
- DO NOT raise the `/dist/` cache TTL again without introducing content-hash filenames (`tracker.<sha>.js`) + immutable cache.

## Agents Working on This Project

1. **Claude Code (CLI, Opus 4.6)** — architecture, backend, SDK, ML pipeline, operations
2. **Cursor (IDE)** — real-time edits, UI polish
3. **Human operator (Artur)** — direction, priorities, prod access

Both agents are bound by the **Meta-Sync Protocol** in `CLAUDE.md` and `.cursor/rules/meta-sync.mdc`: any schema, dependency, or build-step change must be mirrored between `CLAUDE.md` (for Claude Code) and `.cursor/rules/*.mdc` (for Cursor) in the same commit.

## Persistent Memory Layers

1. **Constitution layer** — `CLAUDE.md` files (root, `client/`, `server/`). Committed to git. Source of truth.
2. **Vault layer** — `vault/decisions/`, `vault/sessions/`, `vault/bugs/`. Committed to git. Survives context resets.
3. **Auto-memory layer** — `~/.claude/projects/.../memory/`. Per-developer, not in git. Lessons learned, feedback, per-user preferences.

When starting a new session, always read:
1. `CLAUDE.md` (root) — conventions and current phase
2. The latest file in `vault/sessions/` — what was done last time
3. `vault/decisions/2026-04-02_long_term_development_roadmap.md` — where we are in the master plan
