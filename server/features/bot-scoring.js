"use strict";

/**
 * Bot detection scoring engine.
 *
 * Pure function that combines client-side fingerprint signals with
 * behavioral anomaly detection from extracted session features.
 * Returns a 0.0–1.0 bot score, risk level, and detailed signal breakdown.
 */

/**
 * @param {object} features - output of extractAllFeatures()
 * @param {Array<{type: string, data: object}>} botSignalEvents - bot_signals events from session
 * @returns {{ bot_score: number, bot_risk_level: string, bot_signals: object, is_bot: boolean }}
 */
function calculateBotScore(features, botSignalEvents) {
  let fingerprintScore = 0;
  let behavioralScore = 0;
  const signalDetails = {};

  // -------------------------------------------------------------------------
  // Category A: Fingerprint signals (max ~0.70)
  // -------------------------------------------------------------------------
  const bs =
    botSignalEvents && botSignalEvents.length > 0
      ? botSignalEvents[0].data
      : null;

  if (bs) {
    signalDetails.webdriver = bs.webdriver;
    signalDetails.phantom = bs.phantom;
    signalDetails.nightmare = bs.nightmare;
    signalDetails.selenium = bs.selenium;
    signalDetails.cdp = bs.cdp;
    signalDetails.pluginCount = bs.pluginCount;
    signalDetails.languageCount = bs.languageCount;
    signalDetails.hardwareConcurrency = bs.hardwareConcurrency;
    signalDetails.screenColorDepth = bs.screenColorDepth;

    if (bs.webdriver) fingerprintScore += 0.15;
    if (bs.phantom) fingerprintScore += 0.10;
    if (bs.nightmare) fingerprintScore += 0.10;
    if (bs.selenium) fingerprintScore += 0.10;
    if (bs.cdp) fingerprintScore += 0.10;

    // Zero plugins on desktop (mobile legitimately has 0)
    if (bs.pluginCount === 0 && !bs.touchSupport) fingerprintScore += 0.05;

    // No languages array
    if (bs.languageCount === 0) fingerprintScore += 0.03;

    // Single-core on desktop (VMs / headless)
    if (bs.hardwareConcurrency <= 1 && !bs.touchSupport) fingerprintScore += 0.03;

    // Zero color depth (headless)
    if (bs.screenColorDepth === 0) fingerprintScore += 0.04;
  }

  // -------------------------------------------------------------------------
  // Category B: Behavioral anomalies (max 0.30)
  // -------------------------------------------------------------------------
  const f = features;
  const mc = f.mouse_event_count || 0;

  // Zero jitter with significant mouse data
  const zeroJitter =
    (f.mouse_avg_jitter === 0 || f.mouse_avg_jitter == null) && mc > 20;
  if (zeroJitter) behavioralScore += 0.06;
  signalDetails.zero_jitter = zeroJitter;

  // Mechanical velocity — coefficient of variation < 0.05
  let mechanicalVelocity = false;
  if (
    f.mouse_velocity_1s &&
    Array.isArray(f.mouse_velocity_1s) &&
    f.mouse_velocity_1s.length > 2
  ) {
    const avgs = f.mouse_velocity_1s
      .map((w) => (typeof w === "object" && w !== null ? w.avg : w))
      .filter((v) => typeof v === "number" && !isNaN(v));
    if (avgs.length > 2) {
      const mean = avgs.reduce((a, b) => a + b, 0) / avgs.length;
      if (mean > 0) {
        const variance =
          avgs.reduce((s, v) => s + (v - mean) ** 2, 0) / avgs.length;
        const cv = Math.sqrt(variance) / mean;
        mechanicalVelocity = cv < 0.05;
      }
    }
  }
  if (mechanicalVelocity) behavioralScore += 0.05;
  signalDetails.mechanical_velocity = mechanicalVelocity;

  // Perfect click rhythm (stddev near 0)
  const perfectRhythm =
    f.click_rhythm_std != null &&
    f.click_rhythm_std < 5 &&
    (f.click_total || 0) >= 5;
  if (perfectRhythm) behavioralScore += 0.05;
  signalDetails.perfect_click_rhythm = perfectRhythm;

  // Instant form fills (<50ms average)
  const instantFill =
    f.form_avg_fill_ms != null &&
    f.form_avg_fill_ms < 50 &&
    (f.form_total_interactions || 0) >= 3;
  if (instantFill) behavioralScore += 0.05;
  signalDetails.instant_form_fill = instantFill;

  // Zero idle with long session
  const zeroIdle =
    f.engagement_idle_ms === 0 && (f.session_duration_ms || 0) > 10000;
  if (zeroIdle) behavioralScore += 0.04;
  signalDetails.zero_idle = zeroIdle;

  // Perfectly straight mouse paths (curvature ~1.0)
  const straightPaths =
    f.mouse_avg_curvature != null &&
    f.mouse_avg_curvature < 1.01 &&
    mc > 20;
  if (straightPaths) behavioralScore += 0.03;
  signalDetails.straight_mouse_paths = straightPaths;

  // No scroll direction changes with significant scrolling
  const noScrollVariation =
    f.scroll_direction_changes === 0 && (f.scroll_event_count || 0) > 10;
  if (noScrollVariation) behavioralScore += 0.02;
  signalDetails.no_scroll_variation = noScrollVariation;

  // -------------------------------------------------------------------------
  // Hard rules: unambiguous automation markers
  //
  // navigator.webdriver, window.callPhantom, _phantom, __nightmare, and
  // Selenium-injected globals are never present in real browsers. Treat any
  // one of them as ground truth — bypass the numeric score so ML labels are
  // deterministic instead of borderline.
  // -------------------------------------------------------------------------
  const hardBot = !!(
    bs &&
    (bs.webdriver || bs.phantom || bs.nightmare || bs.selenium)
  );
  signalDetails.hard_rule_triggered = hardBot;

  if (hardBot) {
    return {
      bot_score: 1.0,
      bot_risk_level: "high",
      bot_signals: signalDetails,
      is_bot: true,
    };
  }

  // -------------------------------------------------------------------------
  // Combine
  // -------------------------------------------------------------------------
  const rawScore = Math.min(fingerprintScore + behavioralScore, 1.0);
  const botScore = Math.round(rawScore * 10000) / 10000;

  let botRiskLevel;
  if (botScore >= 0.5) botRiskLevel = "high";
  else if (botScore >= 0.2) botRiskLevel = "medium";
  else botRiskLevel = "low";

  const isBot = botScore >= 0.5;

  return {
    bot_score: botScore,
    bot_risk_level: botRiskLevel,
    bot_signals: signalDetails,
    is_bot: isBot,
  };
}

module.exports = { calculateBotScore };
