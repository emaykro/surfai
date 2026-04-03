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
{ sessionId: string, sentAt: number, events: TrackingEvent[] }
```

Allowed `TrackingEvent` types: `mouse`, `scroll`, `idle`. See root `CLAUDE.md` for the full schema. Any field change here must be mirrored in backend validation in the same commit.

## TypeScript

- `strict: true` is non-negotiable.
- Target: ES6. Module: ESNext.
- Exported API surface: `SurfaiTracker` class, `TrackingEvent` type, `TrackerOptions` interface.
