"use strict";

/**
 * Feature extractors for each event type.
 * Each extractor receives an array of events (sorted by ts ASC)
 * and returns a flat object of feature key-value pairs.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stddev(arr) {
  if (arr.length < 2) return null;
  const m = mean(arr);
  const variance = arr.reduce((sum, v) => sum + (v - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

function distance(p1, p2) {
  return Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2);
}

// ---------------------------------------------------------------------------
// Sliding-window aggregation
// ---------------------------------------------------------------------------

/**
 * Compute windowed stats over a time-series of values.
 * @param {Array<{ts: number, value: number}>} series - sorted by ts
 * @param {number} windowMs - window size in ms
 * @returns {Array<{ts: number, avg: number, max: number, min: number, count: number}>}
 */
function slidingWindow(series, windowMs) {
  if (!series.length) return [];

  const results = [];
  const startTs = series[0].ts;
  const endTs = series[series.length - 1].ts;

  // Step = half window size for overlapping windows (or at least 100ms)
  const step = Math.max(windowMs / 2, 100);

  for (let wStart = startTs; wStart <= endTs; wStart += step) {
    const wEnd = wStart + windowMs;
    const windowValues = [];

    for (const item of series) {
      if (item.ts >= wStart && item.ts < wEnd) {
        windowValues.push(item.value);
      }
      if (item.ts >= wEnd) break;
    }

    if (windowValues.length > 0) {
      results.push({
        ts: Math.round(wStart),
        avg: mean(windowValues),
        max: Math.max(...windowValues),
        min: Math.min(...windowValues),
        count: windowValues.length,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Mouse dynamics
// ---------------------------------------------------------------------------

function extractMouse(events) {
  if (!events.length) return { mouse_event_count: 0 };

  const velocities = [];
  const accelerations = [];
  const jitters = [];
  const curvatures = [];
  let totalDistance = 0;

  const velocitySeries = []; // for sliding windows

  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1].data;
    const curr = events[i].data;
    const dt = curr.ts - prev.ts;

    if (dt <= 0) continue;

    const dist = distance(prev, curr);
    totalDistance += dist;

    const vel = dist / dt; // px/ms
    velocities.push(vel);
    velocitySeries.push({ ts: curr.ts, value: vel });

    // Acceleration (change in velocity over time)
    if (velocities.length >= 2) {
      const prevVel = velocities[velocities.length - 2];
      const acc = Math.abs(vel - prevVel) / dt;
      accelerations.push(acc);
    }

    // Jitter — angle change between consecutive segments
    if (i >= 2) {
      const pp = events[i - 2].data;
      const angle1 = Math.atan2(prev.y - pp.y, prev.x - pp.x);
      const angle2 = Math.atan2(curr.y - prev.y, curr.x - prev.x);
      let angleDiff = Math.abs(angle2 - angle1);
      if (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;
      jitters.push(angleDiff);
    }

    // Curvature — deviation from straight line over 3 consecutive points
    if (i >= 2) {
      const pp = events[i - 2].data;
      const directDist = distance(pp, curr);
      const pathDist = distance(pp, prev) + distance(prev, curr);
      if (directDist > 0) {
        curvatures.push(pathDist / directDist); // 1.0 = perfectly straight
      }
    }
  }

  return {
    mouse_avg_velocity: mean(velocities),
    mouse_max_velocity: velocities.length ? Math.max(...velocities) : null,
    mouse_avg_acceleration: mean(accelerations),
    mouse_avg_jitter: mean(jitters),
    mouse_avg_curvature: mean(curvatures),
    mouse_total_distance: totalDistance,
    mouse_event_count: events.length,
    mouse_velocity_1s: slidingWindow(velocitySeries, 1000),
    mouse_velocity_5s: slidingWindow(velocitySeries, 5000),
    mouse_velocity_30s: slidingWindow(velocitySeries, 30000),
  };
}

// ---------------------------------------------------------------------------
// Scroll behavior
// ---------------------------------------------------------------------------

function extractScroll(events) {
  if (!events.length) return { scroll_event_count: 0 };

  let maxDepth = 0;
  let directionChanges = 0;
  let pauseCount = 0;
  const speeds = [];

  let prevPercent = null;
  let prevTs = null;
  let prevDirection = null; // 1 = down, -1 = up

  for (const event of events) {
    const { percent, ts } = event.data;
    maxDepth = Math.max(maxDepth, percent);

    if (prevPercent !== null && prevTs !== null) {
      const dt = ts - prevTs;
      const dp = Math.abs(percent - prevPercent);

      // Pause detection: >2s between scroll events
      if (dt > 2000) {
        pauseCount++;
      }

      // Speed
      if (dt > 0) {
        speeds.push(dp / dt); // percent/ms
      }

      // Direction change
      const direction = percent > prevPercent ? 1 : percent < prevPercent ? -1 : 0;
      if (direction !== 0 && prevDirection !== null && direction !== prevDirection) {
        directionChanges++;
      }
      if (direction !== 0) prevDirection = direction;
    }

    prevPercent = percent;
    prevTs = ts;
  }

  const avgSpeed = mean(speeds);
  // Fast = top 25% speeds, slow = bottom 25%
  const sortedSpeeds = [...speeds].sort((a, b) => a - b);
  const p25 = sortedSpeeds[Math.floor(sortedSpeeds.length * 0.25)] || 0;
  const p75 = sortedSpeeds[Math.floor(sortedSpeeds.length * 0.75)] || 0;

  const fastCount = speeds.filter((s) => s >= p75 && p75 > 0).length;
  const slowCount = speeds.filter((s) => s <= p25).length;

  return {
    scroll_max_depth: maxDepth,
    scroll_avg_speed: avgSpeed,
    scroll_direction_changes: directionChanges,
    scroll_pause_count: pauseCount,
    scroll_fast_ratio: speeds.length ? fastCount / speeds.length : null,
    scroll_slow_ratio: speeds.length ? slowCount / speeds.length : null,
    scroll_event_count: events.length,
  };
}

// ---------------------------------------------------------------------------
// Click patterns
// ---------------------------------------------------------------------------

function extractClicks(events) {
  if (!events.length) return { click_total: 0 };

  const interClickTimes = [];
  let rageCount = 0;
  let ctaCount = 0;
  let externalCount = 0;

  // For spatial clustering (simple grid-based)
  const clusterMap = new Map(); // "gridX,gridY" → count
  const CLUSTER_RADIUS = 50;

  // Rage click detection: sliding window of recent clicks
  const recentClicks = []; // [{x, y, ts}]
  let inRageSequence = false; // prevents overcounting clicks 4,5,... of the same incident

  for (let i = 0; i < events.length; i++) {
    const { x, y, ts, isCta, isExternal } = events[i].data;

    if (isCta) ctaCount++;
    if (isExternal) externalCount++;

    // Inter-click timing
    if (i > 0) {
      const prevTs = events[i - 1].data.ts;
      interClickTimes.push(ts - prevTs);
    }

    // Spatial clustering
    const gridKey = `${Math.floor(x / CLUSTER_RADIUS)},${Math.floor(y / CLUSTER_RADIUS)}`;
    clusterMap.set(gridKey, (clusterMap.get(gridKey) || 0) + 1);

    // Rage click: 3+ clicks within 500ms in the same ~100px area.
    // Count distinct incidents only (not every extra click in the same burst).
    recentClicks.push({ x, y, ts });
    while (recentClicks.length > 0 && ts - recentClicks[0].ts > 500) {
      recentClicks.shift();
    }
    if (recentClicks.length >= 3) {
      const allClose = recentClicks.every(
        (c) => Math.abs(c.x - x) < 100 && Math.abs(c.y - y) < 100
      );
      if (allClose && !inRageSequence) {
        rageCount++;
        inRageSequence = true;
      } else if (!allClose) {
        inRageSequence = false;
      }
    } else {
      inRageSequence = false;
    }
  }

  return {
    click_total: events.length,
    click_avg_rhythm_ms: mean(interClickTimes),
    click_rhythm_std: stddev(interClickTimes),
    click_spatial_clusters: clusterMap.size,
    click_rage_count: rageCount,
    click_cta_ratio: events.length ? ctaCount / events.length : null,
    click_external_ratio: events.length ? externalCount / events.length : null,
  };
}

// ---------------------------------------------------------------------------
// Form behavior
// ---------------------------------------------------------------------------

function extractForm(events) {
  if (!events.length) return { form_total_interactions: 0 };

  let submitCount = 0;
  let abandonCount = 0;
  let lastAbandonFieldIndex = null;
  const fillDurations = [];

  // Track per-field interactions for hesitation & correction
  const fieldInteractions = new Map(); // "formHash:fieldIndex" → {focusCount, blurCount}

  for (const event of events) {
    const { action, formHash, fieldIndex, fillDurationMs } = event.data;

    const fieldKey = `${formHash}:${fieldIndex}`;
    if (!fieldInteractions.has(fieldKey)) {
      fieldInteractions.set(fieldKey, { focusCount: 0, blurCount: 0, fillDurations: [] });
    }
    const field = fieldInteractions.get(fieldKey);

    if (action === "focus") field.focusCount++;
    if (action === "blur") {
      field.blurCount++;
      if (fillDurationMs > 0) {
        fillDurations.push(fillDurationMs);
        field.fillDurations.push(fillDurationMs);
      }
    }
    if (action === "submit") submitCount++;
    if (action === "abandon") {
      abandonCount++;
      if (typeof fieldIndex === "number") lastAbandonFieldIndex = fieldIndex;
    }
  }

  // Hesitation: focus then fill > 3s
  let hesitationCount = 0;
  let correctionCount = 0;
  let skipCount = 0;

  for (const field of fieldInteractions.values()) {
    // Correction: focused same field 2+ times
    if (field.focusCount >= 2) correctionCount++;

    // Hesitation: any fill duration > 3s
    if (field.fillDurations.some((d) => d > 3000)) hesitationCount++;

    // Skip: focused but never blurred with input (focusCount > blurCount)
    if (field.focusCount > 0 && field.blurCount === 0) skipCount++;
  }

  const totalFields = fieldInteractions.size;

  return {
    form_total_interactions: events.length,
    form_avg_fill_ms: mean(fillDurations),
    form_hesitation_count: hesitationCount,
    form_correction_count: correctionCount,
    form_field_skip_rate: totalFields > 0 ? skipCount / totalFields : null,
    form_submit_count: submitCount,
    form_abandon_count: abandonCount,
    form_last_abandon_field_index: lastAbandonFieldIndex,
  };
}

// ---------------------------------------------------------------------------
// Engagement (from engagement snapshot events)
// ---------------------------------------------------------------------------

function extractEngagement(events) {
  if (!events.length) return {};

  // Use the latest engagement snapshot (most complete)
  const latest = events[events.length - 1].data;

  const totalMs = (latest.activeMs || 0) + (latest.idleMs || 0);

  return {
    engagement_active_ms: latest.activeMs,
    engagement_idle_ms: latest.idleMs,
    engagement_active_ratio: totalMs > 0 ? latest.activeMs / totalMs : null,
    engagement_max_scroll: latest.maxScrollPercent,
    engagement_readthrough: latest.readthrough,
    engagement_micro_scrolls: latest.microScrolls,
  };
}

// ---------------------------------------------------------------------------
// Session-level signals
// ---------------------------------------------------------------------------

function extractSession(events, allEvents) {
  if (!events.length) return {};

  const latest = events[events.length - 1].data;

  // Session duration from all events
  let durationMs = null;
  if (allEvents.length >= 2) {
    const firstTs = allEvents[0].data.ts;
    const lastTs = allEvents[allEvents.length - 1].data.ts;
    durationMs = lastTs - firstTs;
  }

  return {
    session_duration_ms: durationMs,
    session_page_count: latest.pageCount,
    session_avg_nav_speed: latest.avgNavSpeedMs,
    session_is_bounce: latest.isBounce,
    session_is_hyper: latest.isHyperEngaged,
    session_time_bucket: latest.timeBucket,
  };
}

// ---------------------------------------------------------------------------
// Context (device/traffic)
// ---------------------------------------------------------------------------

function extractContext(events) {
  if (!events.length) return {};

  // Use the first context event (set once per session)
  const first = events[0].data;

  // languages may be missing on cached pre-extension bundles
  const langCount = Array.isArray(first.languages) ? first.languages.length : null;

  return {
    ctx_traffic_source: first.trafficSource,
    ctx_device_type: first.deviceType,
    ctx_browser: first.browser,
    ctx_os: first.os,
    ctx_screen_w: first.screenW,
    ctx_screen_h: first.screenH,
    ctx_connection_type: first.connectionType,
    // Extended fields (all nullable — older bundles don't emit them)
    ctx_timezone: first.timezone ?? null,
    ctx_tz_offset: first.timezoneOffset ?? null,
    ctx_language_count: langCount,
    ctx_viewport_w: first.viewportW ?? null,
    ctx_viewport_h: first.viewportH ?? null,
    ctx_dpr: first.devicePixelRatio ?? null,
    ctx_color_scheme: first.colorScheme ?? null,
    ctx_reduced_motion: typeof first.reducedMotion === "boolean" ? first.reducedMotion : null,
    ctx_hardware_concurrency: first.hardwareConcurrency ?? null,
    ctx_device_memory: first.deviceMemory ?? null,
    ctx_referrer_host: first.referrerHost ?? null,
    ctx_utm_source: first.utmSource ?? null,
    ctx_utm_medium: first.utmMedium ?? null,
    ctx_utm_campaign: first.utmCampaign ?? null,
    ctx_utm_term: first.utmTerm ?? null,
    ctx_utm_content: first.utmContent ?? null,
    metrica_client_id: first.metricaClientId ?? null,
    session_local_hour: localHour(first.ts, first.timezone),
  };
}

function localHour(tsMs, timezone) {
  if (!tsMs || !timezone) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      hour12: false,
    }).formatToParts(new Date(tsMs));
    const h = parts.find((p) => p.type === "hour");
    return h ? parseInt(h.value, 10) % 24 : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Performance (Web Vitals + Navigation Timing)
// ---------------------------------------------------------------------------

function extractPerformance(events) {
  if (!events.length) return {};

  // Take the latest performance snapshot. PerformanceCollector typically
  // emits once per session (beforeFlush), but if multiple snapshots arrive
  // (e.g. via BFCache restore) the last one has the most complete data.
  const latest = events[events.length - 1].data;

  return {
    perf_lcp: latest.lcp ?? null,
    perf_fcp: latest.fcp ?? null,
    perf_fid: latest.fid ?? null,
    perf_inp: latest.inp ?? null,
    perf_cls: latest.cls ?? null,
    perf_ttfb: latest.ttfb ?? null,
    perf_dom_interactive: latest.domInteractive ?? null,
    perf_dom_content_loaded: latest.domContentLoaded ?? null,
    perf_load_event: latest.loadEvent ?? null,
    perf_transfer_size: latest.transferSize ?? null,
    perf_long_task_count: typeof latest.longTaskCount === "number" ? latest.longTaskCount : 0,
    perf_long_task_total_ms: typeof latest.longTaskTotalMs === "number" ? latest.longTaskTotalMs : 0,
  };
}

// ---------------------------------------------------------------------------
// Copy behavior
// ---------------------------------------------------------------------------

function extractCopy(events) {
  return { copy_count: events.length };
}

// ---------------------------------------------------------------------------
// Tab visibility
// ---------------------------------------------------------------------------

function extractTabVisibility(events) {
  if (!events.length) return { tab_blur_count: 0, tab_hidden_ms: 0 };
  // Take the last snapshot — it has the highest cumulative counts
  const latest = events[events.length - 1].data;
  return {
    tab_blur_count: latest.tabBlurCount ?? 0,
    tab_hidden_ms: latest.tabHiddenMs ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Cross-session
// ---------------------------------------------------------------------------

function extractCrossSession(events) {
  if (!events.length) return {};

  const latest = events[events.length - 1].data;

  return {
    visitor_id: latest.visitorId ?? null,
    cross_visit_number: latest.visitNumber,
    cross_return_24h: latest.returnWithin24h,
    cross_return_7d: latest.returnWithin7d,
  };
}

// ---------------------------------------------------------------------------
// Orchestrator — extract all features for a session's events
// ---------------------------------------------------------------------------

/**
 * @param {Array<{type: string, data: object}>} events - all events for a session, sorted by ts ASC
 * @returns {object} flat feature object ready for DB upsert
 */
function extractAllFeatures(events) {
  // Group events by type
  const byType = {};
  for (const event of events) {
    if (!byType[event.type]) byType[event.type] = [];
    byType[event.type].push(event);
  }

  const features = {
    ...extractMouse(byType.mouse || []),
    ...extractScroll(byType.scroll || []),
    ...extractClicks(byType.click || []),
    ...extractForm(byType.form || []),
    ...extractEngagement(byType.engagement || []),
    ...extractSession(byType.session || [], events),
    ...extractContext(byType.context || []),
    ...extractCrossSession(byType.cross_session || []),
    ...extractPerformance(byType.performance || []),
    ...extractCopy(byType.copy || []),
    ...extractTabVisibility(byType.tab_visibility || []),
    event_count: events.length,
  };

  return features;
}

module.exports = {
  extractAllFeatures,
  extractMouse,
  extractScroll,
  extractClicks,
  extractForm,
  extractEngagement,
  extractSession,
  extractContext,
  extractCrossSession,
  extractPerformance,
  extractCopy,
  extractTabVisibility,
  slidingWindow,
};
