import type { Collector } from "../types.js";
import type { SurfaiTracker } from "../tracker.js";
import { hashSelector, now } from "../helpers.js";

/**
 * Form interaction collector.
 *
 * Tracks: field focus/blur (no values), form abandonment,
 * submit success/failure, fill duration per field.
 * Never captures field values, only timing and structural data.
 */
export class FormCollector implements Collector {
  private tracker: SurfaiTracker;
  private focusTimes = new Map<EventTarget, number>();
  private activeForms = new Set<HTMLFormElement>();

  constructor(tracker: SurfaiTracker) {
    this.tracker = tracker;
  }

  start(): void {
    document.addEventListener("focusin", this.onFocusIn, { passive: true });
    document.addEventListener("focusout", this.onFocusOut, { passive: true });
    document.addEventListener("submit", this.onSubmit, { capture: true });
    // Detect form abandonment on page unload
    window.addEventListener("beforeunload", this.onBeforeUnload);
  }

  stop(): void {
    document.removeEventListener("focusin", this.onFocusIn);
    document.removeEventListener("focusout", this.onFocusOut);
    document.removeEventListener("submit", this.onSubmit, { capture: true });
    window.removeEventListener("beforeunload", this.onBeforeUnload);
    this.emitAbandonments();
  }

  private onFocusIn = (e: FocusEvent): void => {
    const target = e.target;
    if (!target || !this.isFormField(target)) return;

    this.tracker.markActivity();
    this.focusTimes.set(target, now());

    const form = (target as HTMLElement).closest("form");
    if (form) this.activeForms.add(form);

    this.tracker.pushEvent({
      type: "form",
      data: {
        action: "focus",
        formHash: form ? hashSelector(form) : 0,
        fieldIndex: this.getFieldIndex(target as HTMLElement),
        fieldType: this.getFieldType(target as HTMLElement),
        fillDurationMs: 0,
        ts: now(),
      },
    });
  };

  private onFocusOut = (e: FocusEvent): void => {
    const target = e.target;
    if (!target || !this.isFormField(target)) return;

    const focusTime = this.focusTimes.get(target) ?? now();
    this.focusTimes.delete(target);

    const form = (target as HTMLElement).closest("form");

    this.tracker.pushEvent({
      type: "form",
      data: {
        action: "blur",
        formHash: form ? hashSelector(form) : 0,
        fieldIndex: this.getFieldIndex(target as HTMLElement),
        fieldType: this.getFieldType(target as HTMLElement),
        fillDurationMs: now() - focusTime,
        ts: now(),
      },
    });
  };

  private onSubmit = (e: Event): void => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement)) return;

    this.activeForms.delete(form);

    this.tracker.pushEvent({
      type: "form",
      data: {
        action: "submit",
        formHash: hashSelector(form),
        fieldIndex: 0,
        fieldType: "",
        fillDurationMs: 0,
        ts: now(),
      },
    });
  };

  private onBeforeUnload = (): void => {
    this.emitAbandonments();
  };

  private emitAbandonments(): void {
    for (const form of this.activeForms) {
      this.tracker.pushEvent({
        type: "form",
        data: {
          action: "abandon",
          formHash: hashSelector(form),
          fieldIndex: 0,
          fieldType: "",
          fillDurationMs: 0,
          ts: now(),
        },
      });
    }
    this.activeForms.clear();
  }

  private isFormField(target: EventTarget): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  }

  private getFieldIndex(el: HTMLElement): number {
    const form = el.closest("form");
    if (!form) return 0;
    const fields = Array.from(form.querySelectorAll("input, textarea, select"));
    return fields.indexOf(el);
  }

  private getFieldType(el: HTMLElement): string {
    if (el.tagName === "SELECT") return "select";
    if (el.tagName === "TEXTAREA") return "textarea";
    return (el as HTMLInputElement).type || "text";
  }
}
