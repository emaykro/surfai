import { murmurhash3 } from "./hash.js";

/** Returns true if the event target is an input-like element (security rule). */
export function isInputElement(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    target.isContentEditable
  );
}

export function scrollPercent(): number {
  const doc = document.documentElement;
  const scrollTop = window.scrollY || doc.scrollTop;
  const scrollHeight = doc.scrollHeight - doc.clientHeight;
  if (scrollHeight === 0) return 100;
  return Math.round((scrollTop / scrollHeight) * 100);
}

export function now(): number {
  return Date.now();
}

export function getSessionId(): string {
  const key = "surfai_session_id";
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(key, id);
  }
  return id;
}

/** Build a simple CSS selector for an element (no text content). */
export function cssSelector(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : "";
  const classes = el.className && typeof el.className === "string"
    ? "." + el.className.trim().split(/\s+/).join(".")
    : "";
  return `${tag}${id}${classes}`;
}

/** Hash a CSS selector with MurmurHash3. */
export function hashSelector(el: Element): number {
  return murmurhash3(cssSelector(el));
}

/** Round coordinate to 10px grid. */
export function roundCoord(v: number): number {
  return Math.round(v / 10) * 10;
}

/** Classify element type for click tracking. */
export function classifyElement(el: Element): string {
  const tag = el.tagName;
  if (tag === "BUTTON" || (el as HTMLInputElement).type === "submit") return "button";
  if (tag === "A") return "link";
  if (tag === "IMG") return "image";
  return "other";
}

/** Check if an anchor points to an external domain. */
export function isExternalLink(el: Element): boolean {
  if (el.tagName !== "A") return false;
  const href = (el as HTMLAnchorElement).href;
  if (!href) return false;
  try {
    const url = new URL(href, window.location.origin);
    return url.origin !== window.location.origin;
  } catch {
    return false;
  }
}

/** Return the hostname of an external link, or null if same-origin / not a link. */
export function externalLinkHost(el: Element): string | null {
  if (el.tagName !== "A") return null;
  const href = (el as HTMLAnchorElement).href;
  if (!href) return null;
  try {
    const url = new URL(href, window.location.origin);
    return url.origin !== window.location.origin ? url.hostname : null;
  } catch {
    return null;
  }
}

/** Check if element looks like a CTA (button, submit, or link with CTA-like text). */
export function isCta(el: Element): boolean {
  const tag = el.tagName;
  if (tag === "BUTTON") return true;
  if ((el as HTMLInputElement).type === "submit") return true;
  // Links with role="button" or common CTA classes
  if (el.getAttribute("role") === "button") return true;
  return false;
}

/** Get time-of-day bucket. */
export function timeBucket(): string {
  const h = new Date().getHours();
  if (h >= 0 && h < 6) return "night";
  if (h >= 6 && h < 12) return "morning";
  if (h >= 12 && h < 18) return "day";
  return "evening";
}

/** Detect traffic source from document.referrer. */
export function detectTrafficSource(): string {
  const ref = document.referrer;
  if (!ref) return "direct";

  try {
    const url = new URL(ref);
    const host = url.hostname.toLowerCase();

    // Search engines
    if (/google\.|bing\.|yandex\.|yahoo\.|baidu\.|duckduckgo\./.test(host)) {
      // Check for paid (gclid, yclid, utm_medium=cpc)
      const params = new URLSearchParams(window.location.search);
      if (params.get("gclid") || params.get("yclid") || params.get("utm_medium") === "cpc") {
        return "paid";
      }
      return "organic";
    }

    // Social
    if (/facebook\.|instagram\.|twitter\.|t\.co|linkedin\.|tiktok\.|vk\.com|ok\.ru/.test(host)) {
      return "social";
    }

    return "referral";
  } catch {
    return "direct";
  }
}

/** Detect device type from screen size and user agent. */
export function detectDeviceType(): string {
  const w = window.screen.width;
  if (w <= 768) return "mobile";
  if (w <= 1024) return "tablet";
  return "desktop";
}

/** Extract browser name from user agent. */
export function detectBrowser(): string {
  const ua = navigator.userAgent;
  if (ua.includes("Firefox")) return "Firefox";
  if (ua.includes("Edg/")) return "Edge";
  if (ua.includes("OPR/") || ua.includes("Opera")) return "Opera";
  if (ua.includes("YaBrowser")) return "YandexBrowser";
  if (ua.includes("Chrome")) return "Chrome";
  if (ua.includes("Safari")) return "Safari";
  return "other";
}

/** Extract OS from user agent. */
export function detectOS(): string {
  const ua = navigator.userAgent;
  if (ua.includes("Windows")) return "Windows";
  if (ua.includes("Mac OS")) return "macOS";
  if (ua.includes("Linux")) return "Linux";
  if (ua.includes("Android")) return "Android";
  if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
  return "other";
}

/** Get connection type from Network Information API. */
export function getConnectionType(): string {
  const nav = navigator as Navigator & {
    connection?: { effectiveType?: string };
  };
  return nav.connection?.effectiveType ?? "unknown";
}

// ---------------------------------------------------------------------------
// Extended context helpers (added 2026-04-10)
// ---------------------------------------------------------------------------

/** IANA timezone of the user, e.g. "Europe/Moscow". "unknown" on failure. */
export function getTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown";
  } catch {
    return "unknown";
  }
}

/** Timezone offset from UTC in minutes (JS convention — negative means ahead of UTC). */
export function getTimezoneOffset(): number {
  try {
    return new Date().getTimezoneOffset();
  } catch {
    return 0;
  }
}

/** Full accept-language list as reported by the browser. */
export function getLanguages(): string[] {
  try {
    if (Array.isArray(navigator.languages) && navigator.languages.length > 0) {
      return [...navigator.languages];
    }
    return navigator.language ? [navigator.language] : [];
  } catch {
    return [];
  }
}

/** Inner window width in CSS pixels. */
export function getViewportWidth(): number {
  return window.innerWidth || document.documentElement.clientWidth || 0;
}

/** Inner window height in CSS pixels. */
export function getViewportHeight(): number {
  return window.innerHeight || document.documentElement.clientHeight || 0;
}

/** Device pixel ratio (1.0 on non-retina). */
export function getDevicePixelRatio(): number {
  return window.devicePixelRatio || 1;
}

/** User's color scheme preference: "light" | "dark" | "no-preference". */
export function getColorScheme(): string {
  try {
    if (typeof window.matchMedia !== "function") return "no-preference";
    if (window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
    if (window.matchMedia("(prefers-color-scheme: light)").matches) return "light";
    return "no-preference";
  } catch {
    return "no-preference";
  }
}

/** True if user requested reduced motion. */
export function getReducedMotion(): boolean {
  try {
    if (typeof window.matchMedia !== "function") return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** Logical CPU cores, or 0 if not reported. */
export function getHardwareConcurrency(): number {
  return navigator.hardwareConcurrency || 0;
}

/** Device memory in GB (0.25–8 buckets per spec), or 0 if not reported. */
export function getDeviceMemory(): number {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return typeof nav.deviceMemory === "number" ? nav.deviceMemory : 0;
}

/** Hostname of document.referrer, or empty string. */
export function getReferrerHost(): string {
  const ref = document.referrer;
  if (!ref) return "";
  try {
    return new URL(ref).hostname || "";
  } catch {
    return "";
  }
}

/**
 * Extract UTM campaign params from the current URL.
 * Returns empty strings for missing params so the shape is stable.
 */
export function getUtmParams(): {
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  utmTerm: string;
  utmContent: string;
} {
  const empty = { utmSource: "", utmMedium: "", utmCampaign: "", utmTerm: "", utmContent: "" };
  try {
    const params = new URLSearchParams(window.location.search);
    return {
      utmSource: params.get("utm_source") || "",
      utmMedium: params.get("utm_medium") || "",
      utmCampaign: params.get("utm_campaign") || "",
      utmTerm: params.get("utm_term") || "",
      utmContent: params.get("utm_content") || "",
    };
  } catch {
    return empty;
  }
}
