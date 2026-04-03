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
| `sentAt` | integer | unix ms, required |
| `events` | array | min 1 item, required |
| `events[].type` | enum | `mouse` / `scroll` / `idle` |
| `events[].data` | object | shape depends on type |

See root `CLAUDE.md` for per-type data shapes. Any schema change must be mirrored in the SDK types in the same commit.

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
