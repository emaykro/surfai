# ADR (provisional): SURFAI as an antifraud-scoring platform — future direction

**Status:** Parked. Created 2026-04-19. Revisit after Phase 7–8 have proven the prediction mechanic on live traffic (realistic ETA: Q3–Q4 2026).

**Purpose of this note:** capture the idea and the open questions so we can pick it up later without re-deriving the thinking. This is *not* a plan or a commitment.

## The idea in one sentence

Use the exact same behavioural-signal pipeline we're already building for conversion prediction to also score "is this visitor / visit fraudulent?" — and sell that score either as a lead-quality layer for performance advertisers or as on-site fraud prevention.

## Why it's a natural extension of what we already do

- The features we collect are almost exactly the ones commercial antifraud products base their scores on:
  - Bot fingerprint (`bot_signals` event: webdriver, phantom, nightmare, selenium, CDP, plugin count, language count, hardware concurrency, touch support, screen colour depth, notification permission).
  - Hard-rule bot detection (committed 2026-04-15) for unambiguous automation markers.
  - GeoIP layer with `is_datacenter`, `is_mobile_carrier`, ASN.
  - UA Client Hints for structured device identity (platform, model, arch).
  - Behavioural biometrics: mouse velocity distributions per window, scroll speed, micro-scroll counts, click timing, form-fill duration, readthrough ratio.
  - Cross-session signal via `visitorId`: visit number, returns-within-24h, returns-within-7d.
  - Full `session_features` row per session, ~103 columns, CatBoost-ready.
- The ML pipeline we're building for "predict conversion" trains on label=converted; swapping the label to "fraud / not fraud" is a config change, not a rewrite. Two CatBoost models can live side by side on the same feature store.
- Phase 8 (predictive export to Yandex Direct / GA4 via Measurement Protocol) already describes the "push predictions back to ad platforms as audiences" loop. Ad-fraud export is the same loop with a different target variable — instead of "likely to convert → add to positive audience", we push "likely fraud → add to exclusion audience".

## Two distinct plays (different buyers, different build cost)

### Play A — Lead-quality / ad-fraud for Russian direct-response advertisers

- Sell alongside (or as part of) the conversion-prediction story.
- Build cost is low: feature store unchanged, add a second CatBoost model head, add an exclusion-audience export path parallel to the Phase 8 "include" export.
- Label source is the bottleneck (see open questions).
- Natural channel overlap with the user's Borzo-style audit work — performance teams already trust us if we ship Phase 7–8.

### Play B — On-site fraud (payments, ATO, fake registrations)

- Different beast. Requires:
  - Sync decisioning API (sub-second block / challenge / allow at the moment of checkout or login, not batched ingest).
  - Integration with the client's auth/checkout flow, not just a passive GTM tag.
  - Stricter adversarial robustness — motivated attackers probe and evolve; our current bot score is good for drive-by automation but would need retraining discipline against evasion.
  - Stronger compliance posture: any automated block decision on personal-data-derived signals triggers GDPR Art. 22 / 152-FZ "automated decision-making" rules with a right to human review.
- Big lift. Effectively a separate product on the same data foundation.

## Open questions to answer before committing

1. **Label source for Play A.** Where do fraud labels come from? Chargebacks are too downstream and slow. Candidates: (a) ingest client-reported "this lead was junk" flags via a dedicated endpoint; (b) label sessions with `bot_risk_level=high` as synthetic positives for bootstrap training; (c) partner with a performance agency to stream back their manual lead-quality reviews. All three have issues; we likely need a mix.
2. **How much of fraud signal is already captured by `bot_score`?** Before building a new model, run an offline experiment: take the next ~30 days of labelled-by-client "junk leads" (manual), check how well `bot_score` alone already separates them. If AUC is already >0.8 on bot-score, the fraud model is a narrow uplift problem, not a new capability.
3. **Do we need Play B at all?** The ad-fraud market in RU/CIS has meaningful TAM; on-site fraud competes with established products (Cloudflare Turnstile, Sift, Kount) and requires enterprise-grade SLA we don't have. Play A can probably stand alone.
4. **Positioning tension.** Marketing SURFAI as "behavioural analytics for conversion prediction" and "fraud scoring for performance advertisers" simultaneously will confuse the first 20 customers. We'd need to decide whether fraud is (i) a feature of the main product, (ii) a separate SKU on the same platform, or (iii) a sister product with its own brand / landing page. This is a marketing decision that should wait until we actually have both signals working, not be pre-debated.
5. **Adversarial-robustness investment.** Today we ship features when we think of them. Antifraud requires a release discipline where models are periodically retrained on recent data because attackers adapt. That's ops overhead we don't currently have. Do we want it?
6. **Pricing.** Antifraud products are typically priced per-decision or per-cleaned-lead, not per-session like analytics. The billing model change is non-trivial (the whole billing story doesn't exist yet, but when it does, antifraud tilts the design differently from analytics).

## What would trigger "start now" vs "keep parked"

Keep parked unless:
- Phase 7 (hierarchical ML) is live and delivering measurable uplift on conversion prediction — proves the foundation.
- Phase 8 (predictive export to Yandex Direct / GA4) is shipping — proves we can push predictions back to ad platforms mechanically.
- A concrete commercial pull exists: a specific performance-ad buyer or agency who explicitly asks "can you tell me which of my leads are junk" and would pay for it.

Without the third, we'd be building a product in search of a customer.

## Not now, not no

Writing this ADR now so that (a) we don't forget it, (b) when we design the Phase 7–8 feature store and export mechanisms, we don't accidentally preclude antifraud use (e.g. keep the "label column" extensible, keep the ad-platform push mechanism generic enough to take exclude-lists as well as include-lists), (c) if a lead agency approaches us with a lead-quality pain in the meantime, we know the conversation is in scope and we already have most of the pieces.
