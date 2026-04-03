import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SurfaiTracker } from "../tracker";
import { ClickCollector } from "../collectors/click";
import { ContextCollector } from "../collectors/context";
import { CrossSessionCollector } from "../collectors/cross-session";

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

    // Context uses requestIdleCallback or setTimeout(0)
    await new Promise((r) => setTimeout(r, 50));
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
