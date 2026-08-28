import type { CapturedElement, PageState } from "./types";

/**
 * DOM/accessibility-only capture for this sprint. The local vision model
 * (ONNX Runtime Web + WebGPU) is deferred past the Sept 1 milestone —
 * see docs/ARCHITECTURE.md and PS26171_Role2_Perception.pdf.
 */
const INTERACTIVE_SELECTOR =
  "input, textarea, select, button, a[href], [role='button'], [role='link'], [role='checkbox'], [role='radio'], [role='combobox'], [role='tab'], [role='switch'], [role='menuitem'], [contenteditable='true'], [tabindex='0']";

let nextElementId = 1;
const elementRegistry = new WeakMap<Element, number>();

/**
 * Assigns or retrieves a unique element identifier.
 * Uses a WeakMap for fast O(1) in-memory resolution, paired with a stable
 * DOM data attribute (data-privy-id) to allow recovery across DOM re-renders.
 */
function idFor(el: Element): number {
  let id = elementRegistry.get(el);
  if (id !== undefined) return id;

  const existingAttr = el.getAttribute("data-privy-id");
  if (existingAttr) {
    const parsed = parseInt(existingAttr, 10);
    if (!isNaN(parsed) && parsed > 0) {
      elementRegistry.set(el, parsed);
      if (parsed >= nextElementId) {
        nextElementId = parsed + 1;
      }
      return parsed;
    }
  }

  id = nextElementId++;
  try {
    el.setAttribute("data-privy-id", String(id));
  } catch {
    // Non-critical fallback if DOM node does not support setting attributes
  }
  elementRegistry.set(el, id);
  return id;
}

/**
 * Deterministic label extraction following accessibility precedence:
 * 1. aria-label
 * 2. aria-labelledby (supporting multi-ID space-separated references)
 * 3. associated HTML <label> (via .labels or closest enclosing <label>, with nested controls filtered)
 * 4. placeholder
 * 5. title
 * 6. name (for form inputs)
 * 7. textContent fallback (for non-input interactive elements like buttons/links)
 */
function labelFor(el: Element): string | null {
  // 1. aria-label
  const aria = el.getAttribute("aria-label")?.trim();
  if (aria) return aria;

  // 2. aria-labelledby (handles multi-ID space-separated list)
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const ids = labelledBy.trim().split(/\s+/);
    const parts: string[] = [];
    for (const id of ids) {
      if (!id) continue;
      try {
        const target = document.getElementById(id);
        if (target) {
          const text = target.textContent?.trim();
          if (text) parts.push(text);
        }
      } catch {
        // Safe lookup fallback
      }
    }
    if (parts.length > 0) {
      const combined = parts.join(" ").replace(/\s+/g, " ").trim();
      if (combined) return combined;
    }
  }

  // 3. Associated HTML <label>
  if ("labels" in el) {
    const formEl = el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    if (formEl.labels && formEl.labels.length > 0) {
      const labelTexts: string[] = [];
      for (const lbl of Array.from(formEl.labels)) {
        try {
          const clone = lbl.cloneNode(true) as HTMLElement;
          const nestedControls = clone.querySelectorAll("input, select, textarea, button");
          nestedControls.forEach((nc) => nc.remove());
          const text = clone.textContent?.trim().replace(/\s+/g, " ");
          if (text) labelTexts.push(text);
        } catch {
          const text = lbl.textContent?.trim().replace(/\s+/g, " ");
          if (text) labelTexts.push(text);
        }
      }
      const joined = labelTexts.filter(Boolean).join(" ").trim();
      if (joined) return joined;
    }
  }

  const parentLabel = el.closest("label");
  if (parentLabel) {
    try {
      const clone = parentLabel.cloneNode(true) as HTMLElement;
      const nestedControls = clone.querySelectorAll("input, select, textarea, button");
      nestedControls.forEach((nc) => nc.remove());
      const text = clone.textContent?.trim().replace(/\s+/g, " ");
      if (text) return text;
    } catch {
      // Safe fallback
    }
  }

  // 4. placeholder
  const placeholder = el.getAttribute("placeholder")?.trim();
  if (placeholder) return placeholder;

  // 5. title
  const title = el.getAttribute("title")?.trim();
  if (title) return title;

  // 6. name (for form controls)
  const name = el.getAttribute("name")?.trim();
  if (
    name &&
    (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)
  ) {
    return name;
  }

  // 7. textContent fallback (only for non-form-controls, e.g. buttons, links, ARIA widgets)
  if (
    !(el instanceof HTMLInputElement) &&
    !(el instanceof HTMLTextAreaElement) &&
    !(el instanceof HTMLSelectElement)
  ) {
    const text = el.textContent?.trim().replace(/\s+/g, " ");
    if (text) return text.slice(0, 120);
  }

  return null;
}

/**
 * Maps elements to standard semantic roles while preserving inputType.
 */
function roleFor(el: Element): string {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit.toLowerCase().trim();

  const tag = el.tagName.toLowerCase();
  if (tag === "a") return "link";
  if (tag === "button") return "button";
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  if (tag === "input") {
    const input = el as HTMLInputElement;
    const type = (input.type || "text").toLowerCase();
    if (type === "button" || type === "submit" || type === "reset") return "button";
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    return "textbox";
  }
  return tag;
}

function isDisabled(el: Element): boolean {
  if ((el as HTMLInputElement).disabled === true) return true;
  if (el.getAttribute("aria-disabled") === "true") return true;
  if (el.hasAttribute("disabled")) return true;
  if (el.closest("fieldset[disabled]")) return true;
  return false;
}

function isReadOnly(el: Element): boolean {
  if ((el as HTMLInputElement).readOnly === true) return true;
  if (el.getAttribute("aria-readonly") === "true") return true;
  if (el.hasAttribute("readonly")) return true;
  return false;
}

function isElementVisible(el: Element): boolean {
  // 1. Check aria-hidden / hidden attributes on element or ancestors
  if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") return false;
  if (el.closest("[aria-hidden='true'], [hidden]")) return false;

  // 2. Check computed style properties if available
  if (typeof window !== "undefined" && typeof window.getComputedStyle === "function") {
    try {
      const style = window.getComputedStyle(el);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        style.opacity === "0"
      ) {
        return false;
      }
    } catch {
      // Non-critical fallback if computed style lookup is restricted
    }
  }

  // 3. Check bounding box dimensions when layout engine is active
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    if (el instanceof HTMLElement && (el.offsetWidth > 0 || el.offsetHeight > 0)) {
      return true;
    }
    // In headless test environments (like JSDOM) where no layout engine is computing rects,
    // document.body rect is 0x0. If body has 0x0 rect and computedStyle passed, treat as visible.
    const bodyRect = typeof document !== "undefined" && document.body ? document.body.getBoundingClientRect() : null;
    if (bodyRect && bodyRect.width === 0 && bodyRect.height === 0) {
      return true;
    }
    return false;
  }

  return true;
}

export function captureDomState(taskId: string): PageState {
  const elements: CapturedElement[] = [];

  document.querySelectorAll(INTERACTIVE_SELECTOR).forEach((el) => {
    if (!isElementVisible(el)) return;

    const inputType = el instanceof HTMLInputElement ? (el.type || "text").toLowerCase() : null;
    const placeholder = el.getAttribute("placeholder")?.trim() || null;
    const disabled = isDisabled(el);
    const readonly = isReadOnly(el);

    const captured: CapturedElement = {
      elementId: idFor(el),
      role: roleFor(el),
      label: labelFor(el),
      tag: el.tagName.toLowerCase(),
      inputType,
    };

    if (disabled) captured.disabled = true;
    if (readonly) captured.readonly = true;
    if (placeholder) captured.placeholder = placeholder;

    elements.push(captured);
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
 * Re-queries the live DOM rather than trusting a cached reference.
 * Uses WeakMap registry first, then falls back to stable data-privy-id attribute
 * lookup if the node was re-created during a framework re-render.
 */
export function resolveElement(elementId: number): Element | null {
  if (!elementId) return null;

  for (const el of document.querySelectorAll(INTERACTIVE_SELECTOR)) {
    if (elementRegistry.get(el) === elementId) return el;
  }

  try {
    const fallbackEl = document.querySelector(`[data-privy-id="${elementId}"]`);
    if (fallbackEl) {
      elementRegistry.set(fallbackEl, elementId);
      return fallbackEl;
    }
  } catch {
    // Safe lookup fallback
  }

  return null;
}

/**
 * Utility helper to reset element registry state (used for testing).
 */
export function resetElementRegistry(): void {
  nextElementId = 1;
}
