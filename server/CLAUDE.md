# Backend Ingest Server Rules

## Run

```bash
node server.js                       # starts Fastify on :3000
PORT=8080 node server.js             # override port via env
DATABASE_URL=postgresql://… node server.js  # Postgres connection
```

## Fastify Conventions

- Every ingest route **must** declare a JSON Schema in the route options using Fastify's built-in `schema: { body: { ... } }` property. Never accept `request.body` without schema validation.
- Invalid payloads are rejected automatically by Fastify with `400`; do not add manual `if (!body.sessionId)` guards on top of schema.
- Respond to valid requests immediately: `return { ok: true }` with HTTP 200. Never hold the connection open for database writes or downstream processing.

## Data Contract

`POST /api/events` body schema:

| Field | Type | Constraint |
|-------|------|-----------|
| `sessionId` | string | non-empty, required |
| `siteKey` | string | optional; required in production by default (`ALLOW_INGEST_WITHOUT_SITEKEY=false`) |
| `sentAt` | integer | unix ms, required |
| `events` | array | min 1 item, required |
| `events[].type` | enum | `mouse` / `scroll` / `idle` / `click` / `form` / `engagement` / `session` / `context` / `cross_session` / `goal` / `bot_signals` / `performance` |
| `events[].data` | object | shape depends on type; each has its own strict JSON Schema with `additionalProperties: false` |

See root `CLAUDE.md` for per-type data shapes and field rules.

### Atomicity of ingest

`persistBatch()` writes all events from a single request inside one Postgres `BEGIN` / `COMMIT`. If **any** row fails DB constraints (e.g. a new event `type` that isn't in the `events_type_check` CHECK constraint), the entire batch is rolled back — including every other valid event in the same payload. This was the root cause of a 3-day data loss incident on 2026-04-08–10 when migration 008 added bot detection columns without updating `events_type_check`. See `vault/bugs/2026-04-10 context and session event loss.md`.

Any schema change — adding a field, adding a new event `type`, changing an enum — must be mirrored in **the same commit** across:
- `client/src/types.ts`
- `server/server.js` route schema + `ALL_EVENT_TYPES` const
- `server/migrations/` — a new migration updating `events_type_check` if the `type` enum changed
- `server/features/extractors.js` if the new shape feeds features
- Root `CLAUDE.md` + `.cursor/rules/data-contract.mdc`

## Persistence

- When writing to Postgres, use parameterized queries exclusively (`$1`, `$2`). Never build SQL by string concatenation.
- Database writes must not block the HTTP response. Enqueue or fire-and-forget after reply.
- Connection pooling is required for production; use `pg.Pool`, not `pg.Client` per request.

## Logging

- Use Fastify's built-in Pino logger (`fastify.log.info(...)`) for structured output.
- Remove or replace `console.log` calls; they bypass Pino and produce unstructured output.
- Never log full event payloads at info level — they may contain screen coordinates that correlate with user behavior. Use debug level for detailed dumps.

## CORS

- CORS must be registered with an explicit `origin` list, not open `*`.
- For local development, allow `http://localhost:*` patterns explicitly.

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | Server listen port |
| `CORS_ORIGIN` | `http://localhost:3000` | Allowed origins (comma-separated) |
| `DATABASE_URL` | — | Postgres connection string |
| `OPERATOR_API_TOKEN` | — (empty = all operator endpoints return 401) | Bearer token for operator/dashboard API |
| `ALLOW_INGEST_WITHOUT_SITEKEY` | `false` | Set `true` for local dev without siteKey setup |
| `LOG_LEVEL` | `info` | Pino log level |

## GeoIP enrichment

`server/features/geoip.js` is a singleton initialized at startup via `geoip.init(fastify.log)`. It loads MMDB files from `@ip-location-db/dbip-city-mmdb` and `@ip-location-db/asn-mmdb` once and exposes a sync `lookup(ip)` method. The ingest route captures `request.ip` and passes it to `computeAndStore(sessionId, projectId, siteId, clientIp)`, which merges the lookup result (country/region/city/timezone/lat-long/ASN/org/is_datacenter/is_mobile_carrier) into `session_features` in the same UPSERT as behavioral features.

**Privacy:** the raw IP is read once from `request.ip` and discarded when the handler returns. It is never written to `events`, `raw_batches`, or anywhere else. Only the derived `geo_*` columns persist.

**`trustProxy: "127.0.0.1"`** is set on the Fastify instance so `request.ip` resolves via `X-Forwarded-For` from the local nginx rather than returning `127.0.0.1`. Do not widen `trustProxy` to accept arbitrary proxies — IP spoofing risk.

**Graceful degradation:** if the MMDB packages are not installed (e.g. during local dev), `init()` logs a warning and `lookup()` returns an object of nulls. Ingest keeps working.

## Security

- **Operator auth**: All operator/dashboard API routes require `Authorization: Bearer <OPERATOR_API_TOKEN>`. SSE endpoint also accepts `?token=` query param (EventSource limitation). Ingest `POST /api/events` remains public.
- **siteKey**: Required by default in ingest. Without a valid siteKey the server returns 400. Set `ALLOW_INGEST_WITHOUT_SITEKEY=true` for local dev only.
- **Origin validation**: Uses `new URL(origin).origin` for strict comparison (not `startsWith`). Only checks browser requests with `Origin` header; server-to-server requests without Origin are allowed through (siteKey serves as credential).
- **Body limit**: 256 KB per request (Fastify `bodyLimit`).
- **Security headers**: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` on all responses.
- **Log redaction**: `authorization` header is redacted from Pino logs. siteKey is truncated in warn-level origin mismatch logs.
- **XSS**: Dashboard and cabinet use `textContent` / `esc()` for all dynamic data. No raw `innerHTML` with user/API data.

## Deployment Target

Production server: Linux VPS ("Kukuruza"). Process manager: systemd or Docker. Reverse proxy: Nginx or Caddy with TLS termination.
