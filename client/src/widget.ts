import type { SurfaiTracker } from "./tracker.js";
import type { WidgetConfig, IntentSignal } from "./types.js";

const STORAGE_KEY = "surfai_widget_shown";

/**
 * Smart Personalization & Retention Widget Engine.
 * Renders an isolated, modern retention widget when high-intent behavior or exit intent is detected.
 */
export class SmartWidgetEngine {
  private tracker: SurfaiTracker;
  private config: WidgetConfig;
  private container: HTMLElement | null = null;
  private isVisible = false;

  constructor(tracker: SurfaiTracker, config: WidgetConfig = {}) {
    this.tracker = tracker;
    this.config = {
      enabled: true,
      title: "Специальное предложение для вас",
      subtitle: "Получите персональную консультацию и скидку 15% на первый заказ прямо сейчас.",
      ctaText: "Получить скидку",
      ctaUrl: "#order",
      badgeText: "🔥 Персональный бонус",
      autoShowOnIntent: true,
      theme: "dark",
      ...config,
    };

    if (this.config.autoShowOnIntent) {
      this.bindAutoIntent();
    }
  }

  private hasShownInSession(): boolean {
    try {
      return window.sessionStorage?.getItem(STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  }

  private markShownInSession(): void {
    try {
      window.sessionStorage?.setItem(STORAGE_KEY, "1");
    } catch {
      // ignore
    }
  }

  /**
   * Bind automatic intent trigger listener.
   */
  bindAutoIntent(): void {
    this.tracker.onHighIntent((signal: IntentSignal) => {
      if (!this.config.enabled || this.hasShownInSession()) return;

      // Adapt subtitle based on reason
      const customConfig: Partial<WidgetConfig> = {};
      if (signal.reasons.some((r) => r.includes("exit_intent"))) {
        customConfig.title = "Подождите, не уходите без бонуса!";
        customConfig.badgeText = "⚡ Эксклюзивно";
      } else if (signal.reasons.some((r) => r.includes("deep_readthrough"))) {
        customConfig.title = "Понравилось наше предложение?";
        customConfig.badgeText = "⭐ Персональный расчет";
      }

      this.show(customConfig);
    });
  }

  /**
   * Show the retention widget with optional overrides.
   */
  show(overrides: Partial<WidgetConfig> = {}): void {
    if (this.isVisible || typeof document === "undefined") return;

    const merged = { ...this.config, ...overrides };
    this.markShownInSession();
    this.isVisible = true;

    // Create container
    const el = document.createElement("div");
    el.id = "surfai-retention-widget";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", merged.title || "Retention Widget");

    const isDark = merged.theme !== "light";
    const bg = isDark ? "#161922" : "#ffffff";
    const textColor = isDark ? "#f3f4f6" : "#111827";
    const subColor = isDark ? "#9ca3af" : "#6b7280";
    const border = isDark ? "rgba(255, 255, 255, 0.12)" : "rgba(0, 0, 0, 0.1)";
    const shadow = "0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5)";

    el.style.cssText = `
      position: fixed;
      bottom: 24px;
      right: 24px;
      max-width: 380px;
      width: calc(100vw - 48px);
      background: ${bg};
      color: ${textColor};
      border: 1px solid ${border};
      border-radius: 14px;
      padding: 20px;
      box-shadow: ${shadow};
      z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      box-sizing: border-box;
      transform: translateY(20px);
      opacity: 0;
      transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.3s ease;
    `;

    el.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
        <span style="font-size:11px; font-weight:700; color:#34d399; background:rgba(52,211,153,0.15); border:1px solid rgba(52,211,153,0.3); padding:3px 8px; border-radius:4px; text-transform:uppercase; letter-spacing:0.4px;">
          ${merged.badgeText || "Персонально"}
        </span>
        <button id="surfai-widget-close" style="background:none; border:none; color:${subColor}; font-size:18px; line-height:1; cursor:pointer; padding:4px;" aria-label="Close">✕</button>
      </div>
      <h4 style="margin:0 0 6px 0; font-size:15px; font-weight:700; color:${textColor}; line-height:1.3;">
        ${merged.title}
      </h4>
      <p style="margin:0 0 16px 0; font-size:12px; color:${subColor}; line-height:1.5;">
        ${merged.subtitle}
      </p>
      <div style="display:flex; gap:8px;">
        <a id="surfai-widget-cta" href="${merged.ctaUrl || "#"}" style="flex:1; text-align:center; background:#6c7cff; color:#ffffff; padding:9px 14px; border-radius:8px; font-size:13px; font-weight:600; text-decoration:none; display:inline-block; transition:opacity 0.2s;">
          ${merged.ctaText || "Подробнее"}
        </a>
        ${merged.phone ? `
          <a id="surfai-widget-phone" href="tel:${merged.phone}" style="background:rgba(255,255,255,0.08); color:${textColor}; padding:9px 12px; border-radius:8px; font-size:13px; font-weight:600; text-decoration:none; display:inline-block;">
            📞
          </a>
        ` : ""}
      </div>
    `;

    document.body.appendChild(el);
    this.container = el;

    // Trigger animate-in
    requestAnimationFrame(() => {
      if (this.container) {
        this.container.style.transform = "translateY(0)";
        this.container.style.opacity = "1";
      }
    });

    // Track show event
    this.tracker.goal("widget_shown", { title: merged.title || "" });

    // Close button handler
    const closeBtn = el.querySelector("#surfai-widget-close");
    if (closeBtn) {
      closeBtn.addEventListener("click", () => {
        this.tracker.goal("widget_dismiss");
        this.hide();
      });
    }

    // CTA button handler
    const ctaBtn = el.querySelector("#surfai-widget-cta");
    if (ctaBtn) {
      ctaBtn.addEventListener("click", () => {
        this.tracker.goal("widget_cta_click", { ctaUrl: merged.ctaUrl || "" });
        this.hide();
      });
    }
  }

  /**
   * Hide and remove the widget from DOM.
   */
  hide(): void {
    if (!this.container || !this.isVisible) return;
    this.isVisible = false;
    this.container.style.transform = "translateY(20px)";
    this.container.style.opacity = "0";

    setTimeout(() => {
      if (this.container && this.container.parentNode) {
        this.container.parentNode.removeChild(this.container);
      }
      this.container = null;
    }, 300);
  }
}
