# Client SDK Rules

## Build

```bash
npx tsc          # compiles src/ -> dist/
```

## Zero-Dependency Constraint

This package must have zero runtime dependencies. Only `typescript` is allowed as a devDependency. Do not add libraries, polyfills, bundlers, or analytics SDKs.

## Runtime Behavior

- All delivery must use `fetch(..., { keepalive: true })` or `navigator.sendBeacon()`. Never use synchronous XHR.
- If a network request fails, swallow the error silently. The SDK must never throw into the host application.
- Event listeners must use `{ passive: true }` where applicable (scroll).
- High-frequency events (`mousemove`) must be throttled; default sample rate is 150ms.
- `start()` / `stop()` must be safe to call multiple times without stacking duplicate listeners or timers.
- **Never use `requestIdleCallback` for one-shot critical telemetry.** It never fires on bounce sessions before unload. Cheap synchronous reads (navigator/screen/document.referrer/Intl) must emit directly in `start()`, wrapped in try/catch.
- **Unload-dependent collectors must have an early snapshot fallback.** The lifecycle events (`pagehide`, `visibilitychange`, `beforeunload`) are unreliable in real browsers, especially mobile. Any collector that emits a summary via `beforeFlush()` MUST also schedule a `setTimeout(N)` early snapshot in `start()` so the event rides out through the regular fetch flushInterval, not sendBeacon at unload. SessionCollector does this at 3s; PerformanceCollector does it at 5s + 20s. Both were broken in production for hours before the fallback was added — do not repeat this mistake for new collectors.

## Collector Inventory (src/collectors/)

| File | Emits event type(s) | Strategy |
|---|---|---|
| `click.ts` | `click` | Listener on `click`, 10px grid coords, hashed selectors |
| `form.ts` | `form` | Listeners on `focus` / `blur` / `submit` / `pagehide`, no field values |
| `engagement.ts` | `engagement` | Periodic snapshot via `setInterval` |
| `session.ts` | `session` | Early snapshot at 3s + final via `beforeFlush`, idempotent |
| `context.ts` | `context` | Single synchronous emit in `start()` |
| `cross-session.ts` | `cross_session` | Single emit from localStorage visitorId |
| `bot-signals.ts` | `bot_signals` | Single synchronous emit in `start()` |
| `performance.ts` | `performance` | `PerformanceObserver` accumulates + two early snapshots (5s / 20s) + `beforeFlush`; extractor takes latest |

## Batch Limits

- Maximum 100 events per flush.
- Maximum 64 KB serialized JSON per flush.
- If the buffer exceeds either limit, flush immediately with the capped portion.

## Security

- `isInputElement()` gate is mandatory: skip any event where the target is `INPUT`, `TEXTAREA`, or `contenteditable`.
- Never capture text content, innerHTML, field values, clipboard data, or any string that could contain PII.
- `sessionId` comes from `sessionStorage` only — never read cookies, localStorage auth tokens, or fingerprint data.

## Data Contract

The flush payload sent to the backend must match this shape exactly:

```
{ sessionId: string, siteKey?: string, sentAt: number, events: TrackingEvent[] }
```

Allowed `TrackingEvent.type` values: `mouse`, `scroll`, `idle`, `click`, `form`, `engagement`, `session`, `context`, `cross_session`, `goal`, `bot_signals`, `performance`. The canonical per-type data shape lives in the `TrackingEvent` discriminated union in `src/types.ts` and mirrored in the root `CLAUDE.md` "Allowed event types" table.

Any field change here must be mirrored in **all** of:
- `src/types.ts` (SDK union + collectors that emit it)
- `server/server.js` ingest route schema
- `server/migrations/` — a new migration for `events_type_check` if adding a new `type` value
- `server/features/extractors.js` if the new data is a feature input
- Root `CLAUDE.md` + `.cursor/rules/data-contract.mdc` per the Meta-Sync Protocol

All of the above belong in **one commit**. A mismatch between SDK and DB constraint atomically rejects the entire ingest batch and loses collateral events in the same POST — learned the hard way on 2026-04-08–10 (`vault/bugs/` has the post-mortem).

## TypeScript

- `strict: true` is non-negotiable.
- Target: ES6. Module: ESNext.
- Exported API surface: `SurfaiTracker` class, `TrackingEvent` type, `TrackerOptions` interface.
