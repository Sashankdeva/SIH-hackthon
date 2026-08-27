import type { CapturedElement, PageState } from "./types";

/**
 * DOM/accessibility-only capture for this sprint. The local vision model
 * (ONNX Runtime Web + WebGPU) is deferred past the Sept 1 milestone —
 * see docs/ARCHITECTURE.md and PS26171_Role2_Perception.pdf.
 */
const INTERACTIVE_SELECTOR =
  "input, textarea, select, button, a[href], [role='button'], [role='link'], [contenteditable='true']";

let nextElementId = 1;
const elementRegistry = new WeakMap<Element, number>();

function idFor(el: Element): number {
  let id = elementRegistry.get(el);
  if (id === undefined) {
    id = nextElementId++;
    elementRegistry.set(el, id);
  }
  return id;
}

function labelFor(el: Element): string | null {
  const aria = el.getAttribute("aria-label");
  if (aria) return aria;

  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const target = document.getElementById(labelledBy);
    if (target?.textContent) return target.textContent.trim();
  }

  if (el instanceof HTMLInputElement && el.labels?.length) {
    const joined = Array.from(el.labels)
      .map((l) => l.textContent?.trim())
      .filter(Boolean)
      .join(" ");
    if (joined) return joined;
  }

  const text = el.textContent?.trim();
  return text ? text.slice(0, 120) : null;
}

function roleFor(el: Element): string {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;

  const tag = el.tagName.toLowerCase();
  if (tag === "a") return "link";
  if (tag === "button") return "button";
  if (tag === "input") return `input:${(el as HTMLInputElement).type || "text"}`;
  if (tag === "select") return "select";
  if (tag === "textarea") return "textarea";
  return tag;
}

export function captureDomState(taskId: string): PageState {
  const elements: CapturedElement[] = [];

  document.querySelectorAll(INTERACTIVE_SELECTOR).forEach((el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return; // skip hidden elements

    elements.push({
      elementId: idFor(el),
      role: roleFor(el),
      label: labelFor(el),
      tag: el.tagName.toLowerCase(),
      inputType: el instanceof HTMLInputElement ? el.type : null,
    });
  });

  return {
    taskId,
    url: location.href,
    title: document.title,
    capturedAt: Date.now(),
    elements,
  };
}

/**
 * Re-queries the live DOM rather than trusting a cached reference — the
 * page may have re-rendered since capture, and the action validator
 * relies on this returning null when an element genuinely no longer exists.
 */
export function resolveElement(elementId: number): Element | null {
  for (const el of document.querySelectorAll(INTERACTIVE_SELECTOR)) {
    if (elementRegistry.get(el) === elementId) return el;
  }
  return null;
}
