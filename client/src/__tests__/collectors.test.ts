import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SurfaiTracker } from "../tracker";
import { ClickCollector } from "../collectors/click";
import { ContextCollector } from "../collectors/context";
import { CrossSessionCollector } from "../collectors/cross-session";
import { SessionCollector } from "../collectors/session";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetch() {
  return vi.fn().mockResolvedValue({ ok: true, status: 200 });
}

function createTracker() {
  return new SurfaiTracker({
    endpoint: "/api/events",
    flushInterval: 60_000,
    mouseSampleRate: 0,
    idleThreshold: 10_000,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ClickCollector", () => {
  let fetchSpy: ReturnType<typeof mockFetch>;

  beforeEach(() => {
    fetchSpy = mockFetch();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("crypto", { randomUUID: () => "test-uuid" });
    const store: Record<string, string> = {};
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("captures click events with hashed selector", async () => {
    const tracker = createTracker();
    const click = new ClickCollector(tracker);
    tracker.addCollector(click);
    tracker.start();

    const btn = document.createElement("button");
    btn.id = "cta-buy";
    document.body.appendChild(btn);
    btn.click();

    await tracker.flush();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const clickEvents = body.events.filter((e: any) => e.type === "click");
    expect(clickEvents.length).toBeGreaterThanOrEqual(1);

    const ev = clickEvents[0].data;
    expect(ev.elType).toBe("button");
    expect(ev.isCta).toBe(true);
    expect(ev.elTagHash).toBeTypeOf("number");
    expect(ev.ts).toBeTypeOf("number");

    tracker.stop();
    document.body.removeChild(btn);
  });

  it("skips clicks on INPUT elements", async () => {
    const tracker = createTracker();
    const click = new ClickCollector(tracker);
    tracker.addCollector(click);
    tracker.start();

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.click();

    await tracker.flush();

    // Only core events (from click resetting idle), no click events from ClickCollector
    if (fetchSpy.mock.calls.length > 0) {
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      const clickEvents = body.events.filter((e: any) => e.type === "click");
      expect(clickEvents.length).toBe(0);
    }

    tracker.stop();
    document.body.removeChild(input);
  });
});

describe("ContextCollector", () => {
  let fetchSpy: ReturnType<typeof mockFetch>;

  beforeEach(() => {
    fetchSpy = mockFetch();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("crypto", { randomUUID: () => "test-uuid" });
    const store: Record<string, string> = {};
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("emits context data on start", async () => {
    const tracker = createTracker();
    const ctx = new ContextCollector(tracker);
    tracker.addCollector(ctx);
    tracker.start();

    await tracker.flush();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const ctxEvents = body.events.filter((e: any) => e.type === "context");
    expect(ctxEvents.length).toBe(1);

    const data = ctxEvents[0].data;
    expect(data.deviceType).toBeTypeOf("string");
    expect(data.browser).toBeTypeOf("string");
    expect(data.os).toBeTypeOf("string");
    expect(data.screenW).toBeTypeOf("number");
    expect(data.screenH).toBeTypeOf("number");
    expect(data.language).toBeTypeOf("string");

    tracker.stop();
  });

  it("emits extended context fields (timezone, viewport, dpr, utm, hardware, ...)", async () => {
    // Seed URL with UTM params so the collector picks them up
    const originalHref = window.location.href;
    const urlWithUtm = new URL(window.location.href);
    urlWithUtm.searchParams.set("utm_source", "yandex");
    urlWithUtm.searchParams.set("utm_medium", "cpc");
    urlWithUtm.searchParams.set("utm_campaign", "spring_sale");
    window.history.replaceState({}, "", urlWithUtm.toString());

    try {
      const tracker = createTracker();
      const ctx = new ContextCollector(tracker);
      tracker.addCollector(ctx);
      tracker.start();

      await tracker.flush();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      const ctxEvents = body.events.filter((e: { type: string }) => e.type === "context");
      expect(ctxEvents.length).toBe(1);

      const data = ctxEvents[0].data;

      // Extended fields should all be present with correct types
      expect(data.timezone).toBeTypeOf("string");
      expect(data.timezoneOffset).toBeTypeOf("number");
      expect(Array.isArray(data.languages)).toBe(true);
      expect(data.viewportW).toBeTypeOf("number");
      expect(data.viewportH).toBeTypeOf("number");
      expect(data.devicePixelRatio).toBeTypeOf("number");
      expect(typeof data.colorScheme).toBe("string");
      expect(typeof data.reducedMotion).toBe("boolean");
      expect(data.hardwareConcurrency).toBeTypeOf("number");
      expect(data.deviceMemory).toBeTypeOf("number");
      expect(typeof data.referrerHost).toBe("string");

      // UTM fields picked up from the URL
      expect(data.utmSource).toBe("yandex");
      expect(data.utmMedium).toBe("cpc");
      expect(data.utmCampaign).toBe("spring_sale");
      expect(data.utmTerm).toBe("");
      expect(data.utmContent).toBe("");

      tracker.stop();
    } finally {
      window.history.replaceState({}, "", originalHref);
    }
  });
});

describe("CrossSessionCollector", () => {
  let fetchSpy: ReturnType<typeof mockFetch>;

  beforeEach(() => {
    fetchSpy = mockFetch();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("crypto", { randomUUID: () => "test-visitor-uuid" });
    const store: Record<string, string> = {};
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
    });
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("emits cross_session event with visitor ID on first visit", async () => {
    const tracker = createTracker();
    const cs = new CrossSessionCollector(tracker);
    tracker.addCollector(cs);
    tracker.start();

    await tracker.flush();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const csEvents = body.events.filter((e: any) => e.type === "cross_session");
    expect(csEvents.length).toBe(1);

    const data = csEvents[0].data;
    expect(data.visitorId).toBe("test-visitor-uuid");
    expect(data.visitNumber).toBe(1);
    expect(data.returnWithin24h).toBe(false); // first visit
    expect(data.returnWithin7d).toBe(false);

    tracker.stop();
  });
});

describe("SessionCollector", () => {
  let fetchSpy: ReturnType<typeof mockFetch>;

  beforeEach(() => {
    fetchSpy = mockFetch();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("crypto", { randomUUID: () => "test-uuid" });
    const store: Record<string, string> = {};
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("emits session summary via beforeFlush() into the buffer", () => {
    const tracker = createTracker();
    const session = new SessionCollector(tracker);
    tracker.addCollector(session);
    tracker.start();

    // Direct unit-level check: beforeFlush() should push a session event
    // synchronously into the tracker buffer.
    session.beforeFlush();

    // Drain the buffer manually to inspect what beforeFlush pushed.
    const buf = (tracker as unknown as { buffer: { type: string; data: unknown }[] }).buffer;
    const sessionEvents = buf.filter((e) => e.type === "session");
    expect(sessionEvents.length).toBe(1);

    const data = sessionEvents[0].data as {
      pageCount: number;
      timeBucket: string;
      isBounce: boolean;
      isHyperEngaged: boolean;
    };
    expect(data.pageCount).toBe(1);
    expect(typeof data.timeBucket).toBe("string");
    expect(typeof data.isBounce).toBe("boolean");
    expect(typeof data.isHyperEngaged).toBe("boolean");

    tracker.stop();
  });

  it("beforeFlush() is idempotent — only emits once per lifetime", () => {
    const tracker = createTracker();
    const session = new SessionCollector(tracker);
    tracker.addCollector(session);
    tracker.start();

    session.beforeFlush();
    session.beforeFlush();
    session.beforeFlush();

    const buf = (tracker as unknown as { buffer: { type: string }[] }).buffer;
    const sessionEvents = buf.filter((e) => e.type === "session");
    expect(sessionEvents.length).toBe(1);

    tracker.stop();
  });

  it("session event survives a buffer with >100 events at unload (regression test)", async () => {
    // Regression: before the unloading-flag fix, a full buffer (≥100 events)
    // would trigger pushEvent's auto-flush via async fetch during
    // runBeforeFlushHooks, race against the page unload, and drop the
    // session summary. flushBeacon must now drain everything via sendBeacon.
    const sendBeaconSpy = vi.fn().mockReturnValue(true);
    vi.stubGlobal("navigator", {
      ...navigator,
      sendBeacon: sendBeaconSpy,
    });

    const tracker = createTracker();
    const session = new SessionCollector(tracker);
    tracker.addCollector(session);
    tracker.start();

    // Fill the buffer directly with 250 synthetic mouse events — more
    // than the 100-event flush threshold, enough to force multi-beacon
    // draining. We write directly to the private buffer to bypass
    // pushEvent's async auto-flush, which would otherwise drain the
    // events before unload and make the test meaningless.
    const privateBuf = (tracker as unknown as { buffer: { type: string; data: unknown }[] }).buffer;
    for (let i = 0; i < 250; i++) {
      privateBuf.push({ type: "mouse", data: { x: i, y: i, ts: i } });
    }

    // Simulate page unload
    window.dispatchEvent(new Event("beforeunload"));

    // Must have sent more than one beacon (drained the whole buffer)
    expect(sendBeaconSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

    // Collect all events across all beacons and confirm the session summary
    // is somewhere in the union.
    const allEvents: { type: string }[] = [];
    for (const call of sendBeaconSpy.mock.calls) {
      const blob = call[1] as Blob;
      const body = JSON.parse(await blob.text());
      allEvents.push(...body.events);
    }
    const sessionEvents = allEvents.filter((e) => e.type === "session");
    expect(sessionEvents.length).toBe(1);
    // Buffer should be fully drained
    const buf = (tracker as unknown as { buffer: unknown[] }).buffer;
    expect(buf.length).toBe(0);

    tracker.stop();
  });

  it("session event reaches the wire when beforeunload fires (regression test)", async () => {
    // This is the specific bug that motivated the refactor:
    // tracker's own beforeunload listener was registered before SessionCollector's,
    // so flushBeacon drained the buffer first and SessionCollector's pushEvent
    // landed in an already-empty buffer that was never flushed.
    //
    // With the beforeFlush() hook, the order is now guaranteed: tracker calls
    // collectors' beforeFlush() first, then drains.

    // Spy on sendBeacon — flushBeacon prefers it over fetch
    const sendBeaconSpy = vi.fn().mockReturnValue(true);
    vi.stubGlobal("navigator", {
      ...navigator,
      sendBeacon: sendBeaconSpy,
    });

    const tracker = createTracker();
    const session = new SessionCollector(tracker);
    tracker.addCollector(session);
    tracker.start();

    // Simulate page unload
    window.dispatchEvent(new Event("beforeunload"));

    expect(sendBeaconSpy).toHaveBeenCalledTimes(1);

    // Decode the beacon body and verify it contains the session event
    const blob = sendBeaconSpy.mock.calls[0][1] as Blob;
    const body = JSON.parse(await blob.text());
    const sessionEvents = body.events.filter((e: { type: string }) => e.type === "session");
    expect(sessionEvents.length).toBe(1);

    tracker.stop();
  });
});
