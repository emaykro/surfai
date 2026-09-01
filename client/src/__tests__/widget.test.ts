import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SurfaiTracker } from "../tracker";
import { SmartWidgetEngine } from "../widget";

describe("SmartWidgetEngine", () => {
  let tracker: SurfaiTracker;
  let store: Record<string, string>;

  beforeEach(() => {
    store = {};
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    // Remove any existing DOM widget from previous tests
    document.querySelectorAll("#surfai-retention-widget").forEach((el) => el.remove());

    tracker = new SurfaiTracker({
      endpoint: "/api/events",
    });
    tracker.start();
  });

  afterEach(() => {
    document.querySelectorAll("#surfai-retention-widget").forEach((el) => el.remove());
    tracker.stop();
    vi.restoreAllMocks();
  });

  it("renders retention widget into DOM on show()", () => {
    const widget = new SmartWidgetEngine(tracker, {
      title: "Exclusive Discount",
      ctaText: "Get Now",
      autoShowOnIntent: false,
    });

    widget.show();

    const el = document.getElementById("surfai-retention-widget");
    expect(el).not.toBeNull();
    expect(el?.textContent).toContain("Exclusive Discount");
    expect(el?.textContent).toContain("Get Now");
  });

  it("tracks goal event when widget is shown", () => {
    const goalSpy = vi.spyOn(tracker, "goal");
    const widget = new SmartWidgetEngine(tracker, {
      title: "Retention Title",
      autoShowOnIntent: false,
    });

    widget.show();

    expect(goalSpy).toHaveBeenCalledWith("widget_shown", { title: "Retention Title" });
  });

  it("prevents showing multiple times in the same browser session", () => {
    const widget = new SmartWidgetEngine(tracker, {
      title: "Once per session",
      autoShowOnIntent: false,
    });

    widget.show();
    expect(document.querySelectorAll("#surfai-retention-widget").length).toBe(1);

    // Second call should not duplicate or reopen
    widget.hide();
    widget.show();
    expect(store["surfai_widget_shown"]).toBe("1");
  });

  it("responds to onHighIntent when autoShowOnIntent is enabled", () => {
    new SmartWidgetEngine(tracker, {
      enabled: true,
      autoShowOnIntent: true,
    });

    // Notify intent signal
    tracker.notifyIntent({
      level: "high",
      scoreEstimate: 0.85,
      reasons: ["exit_intent_after_deep_scroll"],
      elapsedMs: 45000,
    });

    const el = document.getElementById("surfai-retention-widget");
    expect(el).not.toBeNull();
    expect(el?.textContent).toContain("Подождите, не уходите без бонуса!");
  });
});
