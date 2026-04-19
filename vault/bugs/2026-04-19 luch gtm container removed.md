# Bug Post-Mortem: GTM container (and our tag) missing on химчистка-луч.рф for ~8 days

**Detected:** 2026-04-19 ~14:45 MSK while checking 30-day conversion accumulation across all 5 production sites ahead of a planned ML retrain.

**Active period:** 2026-04-10 evening → 2026-04-19 ~14:20 (~8 days of effectively-zero data).

**Severity:** Medium. No code regression on our side — traffic was invisible to us because the tag was removed client-side. But dashboard showed the site as `install_status='verified'` throughout, so nothing alerted on silent data loss. One of 5 sites in project "Luch" stopped producing conversions for 8 days without anyone noticing.

## Symptoms

1. химчистка-луч.рф 30-day totals looked abnormal vs peers:
   - 854 sessions, **9 conversions — all before 2026-04-11**, 0 conversions in the enrichment window.
   - Other 4 sites of the same project kept accumulating conversions normally (дома-из-теплостен.рф 13, sequoiamusic.ru 11, sluhnn.ru 4, stefcom.ru 3 in the same window).
2. Daily session count on that site fell off a cliff exactly at the Apr 10 → Apr 11 boundary:
   - 2026-04-09: 163 sessions, full event mix (5 189 engagement, 171 click, 128 form, 1 goal)
   - 2026-04-10: 118 sessions, still all event types but ~3× smaller volume
   - **2026-04-11: 12 sessions. Last day with click/form/scroll/performance events.**
   - 2026-04-12 → 2026-04-15: 2–3 sessions/day, **only** passive timer events (engagement, idle, cross_session, context, bot_signals, session) — no click, no form, no scroll, no mouse, no performance.
   - 2026-04-17: 1 cross_session event (cached page).
   - 2026-04-18 → 2026-04-19 morning: silence.
3. `sites.install_status` stayed `verified` the whole time; `sites.last_event_at` kept creeping forward from cached sessions so no "stale" flag ever fired.

## Root cause

The GTM container (`GTM-T4FFSVG`) was removed from the live site (likely a WordPress / Elementor redeploy that lost the GTM injection, or a manual cleanup by the client's dev). Verified by `curl`-ing the homepage on 2026-04-19: HTML had zero hits for `gtm` / `googletagmanager` / `tracker` / `surfai`; only reCAPTCHA + Elementor + jQuery scripts remained, Yandex Metrika string present but nothing else.

Because install_method was `gtm`, our tracker never loaded directly from the origin — it came in only via the GTM container. No container → no tracker → no events (beyond cached sessions still firing passive timers from open tabs).

## Why it looked confusing for a minute

The passive events (`engagement`, `idle`, `cross_session`, `context`, `bot_signals`, `session`) kept dribbling in until Apr 17. That's because these are emitted on timers or lifecycle hooks from **already-loaded** tracker instances in users' open tabs; they outlived the tag removal. The absence of user-interaction events (`click`, `form`, `scroll`, `mouse`, `performance`) after Apr 11 was the real signal: **no new sessions were starting with the tracker loaded**.

Key diagnostic insight: *"passive-only event mix with no interaction events, against a backdrop of falling daily session count"* is a near-certain fingerprint of a removed tag/container on a site that previously worked.

## Fix

The client (on our request) re-added the GTM container. Verified at ~15:00 MSK on 2026-04-19:

- `https://xn----7sbxakic5bjom0ai.xn--p1ai/` HTML contains the `GTM-T4FFSVG` loader again.
- `https://www.googletagmanager.com/gtm.js?id=GTM-T4FFSVG` container payload includes both `surfai.ru/dist/tracker.js` and `surfai.ru/api/events` strings.
- From 14:27 MSK onward: 3 fresh sessions with the full passive mix (context, cross_session, bot_signals, session, scroll, engagement, performance, idle). click/form absent but expected — 3 visitors in an hour with no CTA clicks is not a bug signal.

## Prevention

**Product gap (most important takeaway):** our operator cabinet reports `install_status='verified'` based on "have we seen events recently" — but it doesn't distinguish between passive-only event streams (tracker removed, cached tabs still flushing) and healthy full-signal streams. For 8 days, a completely broken site looked "verified" in the UI.

**Proposed health-check rule:** if a `verified` site has produced engagement/idle events but **zero** click/form/scroll/mouse events for ≥48h during hours when daily session count > 30 on the same weekday historically, flag `install_status = 'stale'` and alert the operator. This specifically catches tag-removal incidents while avoiding false positives for genuinely low-traffic sites.

**Other mitigations:**

1. Weekly per-site dashboard segment: `sessions` vs `sessions_with_click_or_form` ratio. A sudden drop in the ratio is the same fingerprint.
2. When new conversions stop for a site that was converting regularly — auto-ping the operator. Conversion-count regression is our strongest business-level signal.
3. Document in operator onboarding: "if you redeploy a WordPress/Elementor site, re-verify GTM injection manually — it tends to get lost in theme migrations."

## Data impact

- 9 conversions on луч all pre-Apr 11 — they sit on the old ~57-feature schema (no geo/perf/uah). They will not contribute to the upcoming ~103-feature retrain anyway, so the incident does not shift ML training plans.
- Other 4 sites have 31 conversions on the enriched schema; the 50+ retrain threshold is still ~1 week out at current rate, unchanged by this incident.
- No data corruption: the absent events are genuinely absent, not malformed.
