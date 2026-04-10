# Bug Post-Mortem: Silent loss of context / bot_signals / session events

**Detected:** 2026-04-10 during an unrelated conversation about "we don't have enough user data — device, OS, browser".

**Active period:** 2026-04-08 → 2026-04-10 (three days of degraded data).

**Severity:** High. Production behavioral data was incomplete in a way that was invisible to the dashboard (which doesn't surface event-type coverage).

## Symptoms

1. `ctx_device_type`, `ctx_browser`, `ctx_os`, `ctx_traffic_source`, `ctx_connection_type` on `session_features` were NULL for ~66% of all historical sessions (1,834 of 2,758 rows).
2. Over the last 3 days the daily `context` event coverage dropped off a cliff:
   - 2026-04-07: 464 / 498 sessions = 93%
   - 2026-04-08: 197 / 506 sessions = 39%
   - 2026-04-09: 10 / 450 sessions = 2%
   - 2026-04-10: 0 / 167 sessions = **0%**
3. `bot_signals` events: **zero** in the entire database despite the SDK deploy on 2026-04-08.
4. `session` events: ~11% of sessions (always low, nobody noticed).

## Root causes (four distinct bugs stacked on top of each other)

### RC1 — `requestIdleCallback` races against bounce-session unload

Both `ContextCollector.start()` and `BotSignalCollector.start()` wrapped their single `pushEvent` in `requestIdleCallback(emit)`. On fast bounce sessions the page unloads before the browser's idle queue ever runs the callback. The event is never pushed to the buffer, so `sendBeacon` on `pagehide` has nothing to send.

Masking effect: on slow sessions (real engagement, long reads) `requestIdleCallback` *did* fire within a few hundred ms, so coverage was ~93% on engaged days and much lower on bounce-heavy days.

**Fix:** emit synchronously in `start()`, wrapped in `try/catch`. Commit `36f7a69`.

### RC2 — `events_type_check` constraint missed `bot_signals`

Migration `008_bot_detection.sql` added bot detection columns to `session_features` but did NOT update the `CHECK` constraint on `events.type`. So every time an ingest batch contained a `bot_signals` event, Postgres rejected the row — and because `persistBatch()` wraps the whole batch in a single `BEGIN`/`COMMIT`, **the entire batch was rolled back**, taking along every valid `mouse` / `scroll` / `context` / etc event in the same POST.

Masking effect: RC1 ensured most batches never actually contained a `bot_signals` event, so most batches survived. The visible damage was low until RC1 was fixed — then every batch started failing.

**Fix:** `server/migrations/009_bot_signals_event_type.sql`, mirroring the pattern in `002_expanded_event_types.sql`. Commit `16527e9`.

### RC3 — 24-hour browser cache on `/dist/tracker.js`

nginx `/etc/nginx/sites-enabled/surfai.conf` had `add_header Cache-Control "public, max-age=86400"` on `location /dist/`. Client sites load `tracker.js` via GTM, so the browser cached the old broken bundle for 24 hours. Any SDK fix had a 24h rollout tail — plenty of time to assume the fix "didn't work" and go chasing ghosts.

There was also a subtle duplicate-header issue: Fastify emitted its own `Cache-Control: public, max-age=0` from the static file plugin, and nginx appended `max-age=86400`. Both headers arrived at the browser, with undefined precedence.

**Fix:** nginx location block now uses `proxy_hide_header Cache-Control` + explicit `add_header Cache-Control "public, max-age=300, must-revalidate" always`. 5-minute cache, ETag-based revalidation. Edited in place on prod (config is not in git). Backup at `/root/surfai.conf.bak.20260410-143837`.

### RC4 — `SessionCollector` summary never reached the wire

Three sub-issues compounded here:

**RC4a — listener registration order.** `tracker.start()` registered `window.addEventListener("beforeunload", this.onBeforeUnload)` BEFORE the collector start loop. `SessionCollector.start()` then registered its own `beforeunload` listener. On unload: tracker's listener ran first (`flushBeacon()` drained the buffer), then SessionCollector's listener pushed the `session` event into the now-empty buffer — which was never flushed.

**Fix:** introduced optional `beforeFlush?()` method on the `Collector` interface. Tracker calls `c.beforeFlush()` for all collectors synchronously immediately before `flushBeacon()` in all lifecycle handlers. SessionCollector implements `beforeFlush()` instead of its own listener. Commit `cf358db`.

**RC4b — `flushBeacon` drained only one chunk + `pushEvent` auto-flush race.** On busy sessions the buffer exceeded 100 events by the time unload fired. `flushBeacon` did a single `splice(0, 100)` + single `sendBeacon`, losing everything after the first 100 — and the `session` event was often in that lost tail. Separately, `pushEvent` from `SessionCollector.beforeFlush()` would trigger `this.flush()` (async `fetch`) when the buffer hit 100, racing against page unload.

**Fix:** added `this.unloading` flag, set in all three lifecycle handlers before `runBeforeFlushHooks`. `pushEvent` skips the async auto-flush path when unloading. `flushBeacon` rewritten as a while-loop that drains the entire buffer across up to 10 successive `sendBeacon` calls, respecting both `MAX_EVENTS_PER_FLUSH` and `MAX_PAYLOAD_BYTES` per beacon. Commit `f821009`.

**RC4c — `beforeunload` / `visibilitychange` unreliable on mobile.** Even after RC4a + RC4b the production `session` event coverage stayed at 0%. The dominant SURFAI traffic is mobile Yandex Browser / Safari iOS, where `beforeunload` often never fires, and `visibilitychange→hidden` can fire too late for `sendBeacon` to be useful.

**Fix:** added `pagehide` as a third lifecycle listener (the one MDN and web.dev actually recommend as primary for browser telemetry). All three listeners funnel through a shared `finalFlush()` path guarded by `this.unloading` for idempotence. Additionally, `SessionCollector.start()` now schedules an early snapshot via `setTimeout(3000)` — on bounce sessions that close before any lifecycle event fires, this early snapshot still has time to ride out on the regular 5-second `flushInterval` through the normal `fetch` path. `emitSnapshot()` is idempotent so `beforeFlush()` doesn't double-emit. Commit `352b7d2`.

## Post-fix verification

Sessions started after the final deploy at 2026-04-10 16:33:32:

| Start | Duration | Events | `context` | `bot_signals` | `session` |
|---|---|---|---|---|---|
| 16:33 | 4 min | 141 | ✅ | ✅ | ✅ |
| 16:39 | 2 min | 145 | ✅ | ✅ | ✅ |

100% on fresh bundles. Historical sessions with no `context` event remain NULL forever (no way to backfill) but new traffic is clean.

## Prevention

1. **When adding a new event `type`**: SDK types + Fastify schema + DB migration for `events_type_check` + extractor + root `CLAUDE.md` + `.cursor/rules/data-contract.mdc` — all in ONE commit. Now explicitly called out in `client/CLAUDE.md` and `server/CLAUDE.md` Data Contract sections.
2. **Never use `requestIdleCallback` for one-shot critical telemetry in a browser SDK.** Cheap synchronous reads (`navigator.*`, `screen.*`, `document.referrer`) should emit directly in `start()`.
3. **SDK cache TTL stays short** (current: 300s). Do not raise without content-hash in filename.
4. **`pagehide` is the primary unload event** for browser telemetry, not `beforeunload`. Keep the other two as belt-and-suspenders.
5. **TODO: alerting.** A simple cron-triggered query "context event coverage over the last hour" emitting to a webhook would have caught this within an hour of the 2026-04-08 deploy instead of two days later.

## References

- Commits: `36f7a69`, `16527e9`, `cf358db`, `f821009`, `352b7d2`
- Session summary: `vault/sessions/2026-04-10 telemetry recovery context bot_signals session event pipeline fix.md`
- Master roadmap (unchanged): `vault/decisions/2026-04-02_long_term_development_roadmap.md`
