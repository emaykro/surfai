# 2026-09-01 — Session expiry: 30-minute inactivity + 24-hour cap

## Context

`session_duration_ms` on prod: median 54 s, p95 77 min, **maximum 148 days**.
Over the last 7 days, 266 of 3585 sessions (7.4 %) exceed 30 minutes and 42
exceed 24 hours.

The value is not miscalculated. `extractSession()` computes
`max(client ts) − min(client ts)`, events are fetched `ORDER BY ts ASC`, and
the server-side receipt times agree with the client ones: session
`8c9193a7-34a6-4d89-be17-c16cddc81a0d` genuinely received 2913 events between
2026-04-06 and 2026-09-01. The arithmetic is right; the concept is wrong.

**Root cause.** `getSessionId()` reads `surfai_session_id` from `sessionStorage`
and mints a new UUID only when the key is absent. `sessionStorage` survives
browser tab restore, so a tab the user never closes — or one the browser
reopens via "continue where you left off" — keeps the same `sessionId` for
months. The platform has no session expiry of any kind.

## Why it matters beyond one ugly number

- **Per-session features are cumulative over the whole lifetime.** Clicks,
  scroll depth, copy counts and engagement for a 148-day "session" are sums
  over months, not over a visit. These are ML feature inputs.
- **Attribution is wrong.** A UTM captured in April is attached to a September
  conversion on the same `sessionId`.
- **It explains the Metrica reconciliation drift we have been tracking.**
  Metrica ends a visit after 30 minutes of inactivity; we never do. So one
  SURFAI session maps to several Metrica visits, and Metrica must report more.
  Observed `divergence_ratio` (metrica_visits / surfai_sessions) over the last
  8 days: 1.026 – 1.169, i.e. Metrica counts 3–17 % more visits. The dashboard
  built to catch drift was reporting our own sessionization defect.
- **Downstream consumers inherit it.** `durationPenalty` in the traffic-quality
  waste score, `avg_duration_sec` on the B2B dashboard, and the hot-lead
  trigger `session_duration_ms >= 30000` all read this column.

## Decision

Adopt the Metrica/GA4 convention.

1. **SDK** — `getSessionId()` rotates the id when either bound is crossed:
   - **30 minutes** since the last recorded activity (inactivity timeout), or
   - **24 hours** since the session started (hard cap).
   Activity is stamped on every buffered event. All `sessionStorage` access is
   wrapped: it throws in some privacy modes, and the SDK must never throw into
   the host page.

2. **Server** — a defensive guard in `extractSession()`. A duration that is
   negative, or longer than the SDK cap plus slack, is recorded as `NULL`
   rather than a number. NULL is the honest answer ("we do not know"), CatBoost
   handles it natively, and SQL `AVG` skips it — a clamp would instead pile a
   fake spike at the ceiling. The guard also covers rows produced by older
   cached SDK bundles, which keep arriving for roughly an hour after deploy.

3. **Legacy rows** — one targeted `UPDATE` nulls the impossible values already
   stored, so dashboards and the next training set are not poisoned by them.

## Alternatives rejected

- **Server-side splitting of stored sessions by activity gap.** `session_id` is
  a foreign key across `events`, `session_features` and `conversions`; splitting
  retroactively means rewriting identity across the schema. Large blast radius
  for a problem the SDK can prevent at the source.
- **Only clamping the feature.** Cheapest, but treats the symptom: session
  counts stay wrong, attribution stays wrong, and the Metrica divergence stays
  unexplained.

## Consequences

- **Session counts will rise** — roughly in line with the current 3–17 %
  Metrica gap. This is a measurement correction, not a traffic increase. Expect
  the reconciliation dashboard's `divergence_ratio` to move toward 1.0; that is
  the success criterion.
- **ML feature distributions shift.** Model v5 was trained on unsegmented
  sessions. Decision: **do not retrain immediately** — the current model keeps
  scoring, and the retrain waits until 2–3 weeks of data under the new
  sessionization have accumulated. Retraining today would only re-fit the old,
  unsegmented history. Revisit after 2026-09-22.
- `session_duration_ms` gains NULLs where it previously held nonsense. Any
  consumer that treats NULL as zero will now be visibly wrong instead of
  quietly wrong — `traffic-quality-audit.js` was already corrected for exactly
  this pattern on the intent score.

## Verification

```sql
-- No session may exceed the cap once old bundles have cycled out (~1 h TTL).
SELECT count(*) FROM session_features
WHERE session_duration_ms > 26 * 3600 * 1000
  AND computed_at > NOW() - INTERVAL '2 hours';   -- expect 0

-- Divergence should trend toward 1.0 over the following days.
SELECT date, round(avg(divergence_ratio), 3)
FROM metrica_daily_reconciliation
WHERE date > CURRENT_DATE - 14 GROUP BY date ORDER BY date DESC;
```
