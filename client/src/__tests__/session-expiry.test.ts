import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// helpers.ts caches module-level state (the touch throttle and the volatile
// fallback id), so each test gets a fresh module instance.
async function loadHelpers() {
  vi.resetModules();
  return import("../helpers.js");
}

class MemoryStorage {
  private map = new Map<string, string>();
  throwOnAccess = false;
  getItem(k: string): string | null {
    if (this.throwOnAccess) throw new DOMException("denied", "SecurityError");
    return this.map.has(k) ? (this.map.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    if (this.throwOnAccess) throw new DOMException("denied", "SecurityError");
    this.map.set(k, v);
  }
  raw(k: string): string | undefined {
    return this.map.get(k);
  }
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal("sessionStorage", storage);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-01T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("session expiry", () => {
  it("keeps the same id across activity inside the window", async () => {
    const { getSessionId, touchSession } = await loadHelpers();
    const first = getSessionId();

    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(2 * 60 * 1000); // 2 min
      touchSession();
      expect(getSessionId()).toBe(first);
    }
    // 20 minutes of steady activity must not have rotated the session.
    expect(getSessionId()).toBe(first);
  });

  it("rotates after 30 minutes of inactivity", async () => {
    const { getSessionId, SESSION_INACTIVITY_MS } = await loadHelpers();
    const first = getSessionId();

    vi.advanceTimersByTime(SESSION_INACTIVITY_MS - 1000);
    expect(getSessionId()).toBe(first);

    vi.advanceTimersByTime(2000); // now past the window
    const second = getSessionId();
    expect(second).not.toBe(first);
  });

  it("rotates at the 24-hour cap even under continuous activity", async () => {
    // The prod failure was a tab left open for 148 days: activity alone must
    // not be able to keep one session alive indefinitely.
    const { getSessionId, touchSession, SESSION_MAX_MS } = await loadHelpers();
    const first = getSessionId();

    let elapsed = 0;
    while (elapsed < SESSION_MAX_MS - 20 * 60 * 1000) {
      vi.advanceTimersByTime(10 * 60 * 1000);
      elapsed += 10 * 60 * 1000;
      touchSession();
      expect(getSessionId()).toBe(first);
    }

    vi.advanceTimersByTime(30 * 60 * 1000);
    touchSession();
    expect(getSessionId()).not.toBe(first);
  });

  it("expires a restored tab whose storage survived", async () => {
    // sessionStorage persists across tab restore; that is how a session
    // reached 148 days on prod.
    const { getSessionId } = await loadHelpers();
    const first = getSessionId();

    vi.advanceTimersByTime(148 * 24 * 3600 * 1000);
    expect(getSessionId()).not.toBe(first);
  });

  it("adopts an id written by an older SDK build without timestamps", async () => {
    const { getSessionId } = await loadHelpers();
    storage.setItem("surfai_session_id", "legacy-id-from-old-bundle");

    // Adopted, not discarded — the visit is already in flight.
    expect(getSessionId()).toBe("legacy-id-from-old-bundle");
    // ...and the clock starts now, so it expires normally from here.
    vi.advanceTimersByTime(31 * 60 * 1000);
    expect(getSessionId()).not.toBe("legacy-id-from-old-bundle");
  });

  it("does not resurrect an expired session when the clock jumps backwards", async () => {
    const { getSessionId } = await loadHelpers();
    const first = getSessionId();

    vi.advanceTimersByTime(45 * 60 * 1000);
    const second = getSessionId();
    expect(second).not.toBe(first);

    // Device clock corrects backwards; a negative age must read as "just now"
    // rather than as a huge or negative duration.
    vi.setSystemTime(new Date("2026-09-01T11:00:00Z"));
    expect(getSessionId()).toBe(second);
  });

  it("never throws when sessionStorage is blocked", async () => {
    const { getSessionId, touchSession } = await loadHelpers();
    storage.throwOnAccess = true;

    // The SDK must never throw into the host page.
    expect(() => touchSession()).not.toThrow();
    let id = "";
    expect(() => {
      id = getSessionId();
    }).not.toThrow();
    expect(id).toBeTruthy();
    // Without storage the id is held in memory for the life of the page.
    expect(getSessionId()).toBe(id);
  });

  it("throttles storage writes on the hot activity path", async () => {
    const { getSessionId, touchSession } = await loadHelpers();
    getSessionId();
    const spy = vi.spyOn(storage, "setItem");

    // Mousemove is throttled to 150ms; simulate a burst of activity.
    for (let i = 0; i < 200; i++) {
      vi.advanceTimersByTime(150);
      touchSession();
    }

    // 200 * 150ms = 30s of activity → at most a couple of writes, not 200.
    expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
