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
