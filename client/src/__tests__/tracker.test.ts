import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SurfaiTracker } from "../tracker";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetch(ok = true, status = 200) {
  return vi.fn().mockResolvedValue({ ok, status });
}

function createTracker(endpoint = "/api/events", overrides = {}) {
  return new SurfaiTracker({
    endpoint,
    flushInterval: 60_000, // high — we flush manually in tests
    mouseSampleRate: 0, // no throttle in tests
    idleThreshold: 1_000,
    ...overrides,
  });
}

/** Simulate a mousemove event on document */
function fireMouseMove(x = 100, y = 200) {
  const evt = new MouseEvent("mousemove", {
    clientX: x,
    clientY: y,
    bubbles: true,
  });
  document.dispatchEvent(evt);
}

/** Simulate a scroll event */
function fireScroll() {
  document.dispatchEvent(new Event("scroll", { bubbles: true }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SurfaiTracker", () => {
  let fetchSpy: ReturnType<typeof mockFetch>;

  beforeEach(() => {
    fetchSpy = mockFetch();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("crypto", {
      randomUUID: () => "test-session-uuid",
    });
    // sessionStorage mock
    const store: Record<string, string> = {};
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---- Idempotent start ---------------------------------------------------

  describe("idempotent start()", () => {
    it("should not add duplicate listeners when start() called twice", () => {
      const tracker = createTracker();
      const addSpy = vi.spyOn(document, "addEventListener");

      tracker.start();
      const firstCallCount = addSpy.mock.calls.length;

      tracker.start(); // second call should be no-op
      expect(addSpy.mock.calls.length).toBe(firstCallCount);

      tracker.stop();
    });

    it("should allow restart after stop()", () => {
      const tracker = createTracker();
      tracker.start();
      tracker.stop();
      // Should not throw
      tracker.start();
      tracker.stop();
    });
  });

  // ---- PII filtering (isInputElement) -------------------------------------

  describe("PII filtering", () => {
    it("should skip mousemove events on INPUT elements", () => {
      const tracker = createTracker();
      tracker.start();

      const input = document.createElement("input");
      document.body.appendChild(input);

      const evt = new MouseEvent("mousemove", {
        clientX: 50,
        clientY: 50,
        bubbles: true,
      });
      Object.defineProperty(evt, "target", { value: input });
      document.dispatchEvent(evt);

      // Flush — should have no events
      (tracker as any).flush();
      // fetch should not have been called (empty buffer)
      expect(fetchSpy).not.toHaveBeenCalled();

      tracker.stop();
      document.body.removeChild(input);
    });

    it("should skip mousemove events on TEXTAREA elements", () => {
      const tracker = createTracker();
      tracker.start();

      const textarea = document.createElement("textarea");
      document.body.appendChild(textarea);

      const evt = new MouseEvent("mousemove", {
        clientX: 50,
        clientY: 50,
        bubbles: true,
      });
      Object.defineProperty(evt, "target", { value: textarea });
      document.dispatchEvent(evt);

      (tracker as any).flush();
      expect(fetchSpy).not.toHaveBeenCalled();

      tracker.stop();
      document.body.removeChild(textarea);
    });
  });

  // ---- Batching & flush ---------------------------------------------------

  describe("batching", () => {
    it("should collect mousemove events and flush them", async () => {
      const tracker = createTracker();
      tracker.start();

      fireMouseMove(100, 200);
      fireMouseMove(110, 210);

      await (tracker as any).flush();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.sessionId).toBe("test-session-uuid");
      expect(body.events).toHaveLength(2);
      expect(body.events[0].type).toBe("mouse");
      expect(body.sentAt).toBeTypeOf("number");

      tracker.stop();
    });

    it("should not flush when buffer is empty", async () => {
      const tracker = createTracker();
      tracker.start();

      await (tracker as any).flush();
      expect(fetchSpy).not.toHaveBeenCalled();

      tracker.stop();
    });
  });

  // ---- Batch limits -------------------------------------------------------

  describe("batch limits", () => {
    it("should cap flush at 100 events", async () => {
      const tracker = createTracker();
      tracker.start();

      // Push 150 events directly into buffer
      for (let i = 0; i < 150; i++) {
        (tracker as any).buffer.push({
          type: "mouse",
          data: { x: i, y: i, ts: Date.now() },
        });
      }

      await (tracker as any).flush();

      // First flush should send max 100
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.events.length).toBeLessThanOrEqual(100);

      // Remaining 50 should still be in buffer
      expect((tracker as any).buffer.length).toBe(50);

      tracker.stop();
    });
  });

  // ---- Retry logic --------------------------------------------------------

  describe("retry on server error", () => {
    it("should retry on 500 errors", async () => {
      const failFetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 500 })
        .mockResolvedValueOnce({ ok: false, status: 500 })
        .mockResolvedValueOnce({ ok: true, status: 200 });
      vi.stubGlobal("fetch", failFetch);

      const tracker = createTracker();
      tracker.start();
      fireMouseMove();

      await (tracker as any).flush();

      // 3 attempts total (2 retries + 1 success)
      expect(failFetch).toHaveBeenCalledTimes(3);

      tracker.stop();
    });

    it("should not retry on 400 errors", async () => {
      const failFetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 400 });
      vi.stubGlobal("fetch", failFetch);

      const tracker = createTracker();
      tracker.start();
      fireMouseMove();

      await (tracker as any).flush();

      expect(failFetch).toHaveBeenCalledTimes(1);

      tracker.stop();
    });
  });

  // ---- Scroll events ------------------------------------------------------

  describe("scroll tracking", () => {
    it("should record scroll events with percent", async () => {
      const tracker = createTracker();
      tracker.start();

      fireScroll();
      await (tracker as any).flush();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.events[0].type).toBe("scroll");
      expect(body.events[0].data.percent).toBeTypeOf("number");

      tracker.stop();
    });
  });
});
