# 2026-09-01 — ML scoring timer silently killed by the weekly retrain for 37 days

## Symptoms

`/api/health` reported `ml_scoring_recent: critical`, `last_scored_at` ~2.75 days stale.
`surfai-score-predicted` had been logging `No new high-score settled sessions
(threshold=0.3) / generated=0` on every 10-minute tick, and **zero**
`lead_predicted` conversions had been created in at least 9 days — the whole
Phase-8 predictive signal to Yandex Metrica was dead.

`systemctl list-timers` showed 11 surfai timers instead of 12.
`surfai-ml-score.timer` was `enabled` but `Active: inactive (dead)`.

## The misleading part

Daily scoring coverage looked healthy right up to 2026-08-29:

```
2026-08-28 |  546 sessions |  444 scored
2026-08-29 |  512          |  394
2026-08-30 |  546          |   34
2026-08-31 |  487          |    5
```

This reads as "broke on Aug 30". It is an artifact. `surfai-ml-retrain.timer`
runs `ml-retrain.sh` every Sunday, and its last step is `python3 -m ml score --all`,
which rescores the **entire** table. Every Sunday it retroactively filled in the
preceding week, so the daily numbers only ever look bad for the days *after* the
most recent Sunday.

`systemctl start` on the timer revealed the truth in its `LAST` column:
**Sun 2026-07-26 02:32** — the first Sunday after the weekly retrain was
deployed on 2026-07-22. Real-time scoring had been dead for 37 days, and the
weekly full rescore had been papering over it the whole time.

## Root cause

`surfai-ml-retrain.service`:

```ini
# Don't collide with the 5-minute scoring pass while artifacts are rewritten.
Conflicts=surfai-ml-score.service
```

`surfai-ml-score.timer`:

```ini
[Unit]
Requires=surfai-ml-score.service
```

The intent behind `Conflicts=` is correct — the retrain rewrites `.cbm`
artifacts and a concurrent scoring pass would read a half-written model. But
`Conflicts=` makes systemd **stop** `surfai-ml-score.service` when the retrain
starts, and `Requires=` propagates that stop *upward* to the timer that
requires it. The timer goes inactive and never comes back on its own.
`enabled` only means "start at boot", so it stayed dead until the next reboot —
and the box had been up 5 days.

One weekly retrain permanently disables the 5-minute scoring timer. It fired on
the very first run and nobody noticed for five weeks.

## Why the alerter didn't catch it

It did fire — and was ignored, because it had been crying wolf. `ingest_recent`
used a 120-second warn threshold; at ~500 sessions/day, night-time gaps cross
that constantly. Every `ok→warn` crossing counted as "got worse" and paged.
Eight Telegram alerts went out on 2026-09-01 alone, and the one real critical
was indistinguishable from the noise.

A partial fix in the working tree made it worse rather than better:

```js
const suppressIngestWarn = process.env.SUPPRESS_INGEST_WARN_ALERTS === "true" || true;
```

`|| true` makes the env var dead, and the suppression was additionally gated on
`current.status !== "unhealthy"` — so it could never suppress anything while a
real critical was active, which is exactly when the noise hurts most.

## Fix

1. Started the timer and ran a catch-up pass: **1052 sessions scored**, health
   back to `healthy`.
2. Removed `Requires=<service>` from all 12 `surfai-*.timer` units. A timer
   already triggers its same-named service by default (`[Timer] Unit=`), so the
   directive bought nothing and cost the outage. `Conflicts=` still prevents the
   concurrent run it was meant to prevent.
3. Replaced the suppression hack in `health-alert.js` with level confirmation:
   a check must report the same non-ok level on `ALERT_CONFIRM_TICKS` (default 2)
   consecutive polls before it pages; recovery to `ok` is reported immediately.
   Thresholds were tightened back to 900 s / 3600 s rather than widened to
   3600 s / 14400 s, since a 4-hour silence window is a lost day of traffic.
   Covered by `server/__tests__/health-alert.test.js`, including a regression
   test that a real outage is not drowned by an unrelated flapping check.

## Prevention

- **A `Conflicts=` pointing at a timer-driven oneshot is a trap.** If any unit
  declares `Conflicts=X.service`, no timer may declare `Requires=X.service`.
- **Beware of a repair job that hides the thing it repairs.** The weekly
  `score --all` made a dead 5-minute timer invisible in every daily metric.
  Freshness checks must measure the *fast* path's own recency
  (`max(model_scored_at)` age in minutes), which `/api/health` does correctly —
  the check worked, the alerting channel is what failed.
- **Alert thresholds and alert noise are separate problems.** Damp flapping with
  confirmation over consecutive observations; never widen a detection threshold
  to buy quiet.
- **`enabled` is not `active`.** Add a health check that the expected set of
  systemd timers is actually running, not merely installed.
