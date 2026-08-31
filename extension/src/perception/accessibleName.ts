/**
 * Generic accessible-name computation.
 *
 * Phase 3 — this replaces domCapture.ts's private `labelFor`. The existing
 * precedence and exact return values are preserved (domCapture.test.ts locks
 * ~30 cases); the only additions are terminal fallbacks for controls whose
 * name is carried by a child instead of by text:
 *
 *   - the visible caption (`value`) of a button-like <input>
 *   - <img alt> inside the control
 *   - child <svg> with <title> or aria-label
 *   - any descendant with aria-label
 *
 * These are authored labels, never page prose. New fallbacks are trimmed,
 * whitespace-collapsed and bounded to MAX_LABEL. Raw text-input values are
 * never read (privacy).
 */

import { deepQueryAll, idRefLookup } from "./deepDom";

export const MAX_LABEL = 120;

function bounded(text: string | null | undefined): string | null {
  if (!text) return null;
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.slice(0, MAX_LABEL);
}

/** Descendant query that also pierces `el`'s own open shadow root(s). */
function safeQueryAll(el: Element, selector: string): Element[] {
  try {
    return deepQueryAll(selector, el);
  } catch {
    return [];
  }
}

/**
 * Terminal fallback: a control whose visible name lives in a child icon.
 * Only authored attributes are read: alt text, <svg><title>, aria-label.
 */
function iconName(el: Element): string | null {
  for (const img of safeQueryAll(el, "img[alt]")) {
    const alt = bounded(img.getAttribute("alt"));
    if (alt) return alt;
  }
  for (const svg of safeQueryAll(el, "svg")) {
    const svgAria = bounded(svg.getAttribute("aria-label"));
    if (svgAria) return svgAria;
    const title = svg.querySelector("title");
    const titleText = bounded(title?.textContent);
    if (titleText) return titleText;
  }
  for (const node of safeQueryAll(el, "[aria-label]")) {
    const lbl = bounded(node.getAttribute("aria-label"));
    if (lbl) return lbl;
  }
  return null;
}

/**
 * Deterministic accessible-name extraction following accessibility precedence:
 *   1. aria-label
 *   2. aria-labelledby (multi-ID, space-separated)
 *   3. associated <label> (.labels or closest enclosing <label>, nested controls filtered)
 *   4. placeholder
 *   5. title
 *   6. name (form controls)
 *   7. text content (non-form-controls)
 *   8. NEW — button-like <input> caption / child icon name
 */
/** Nested controls whose own captions are not part of this element's name. */
const NESTED_CONTROL_SELECTOR = "input, select, textarea, button, label";

/**
 * `el`'s text with the captions of nested form controls removed. Returns null
 * when there is nothing nested to strip (so the caller keeps the cheap path)
 * or when stripping would leave nothing.
 */
function textWithoutNestedControls(el: Element): string | null {
  try {
    if (typeof el.querySelector !== "function" || !el.querySelector(NESTED_CONTROL_SELECTOR)) {
      return null;
    }
    const clone = el.cloneNode(true) as Element;
    clone.querySelectorAll(NESTED_CONTROL_SELECTOR).forEach((n) => n.remove());
    const text = (clone.textContent || "").replace(/\s+/g, " ").trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

export function computeAccessibleName(el: Element): string | null {
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
        // Tree-scoped: resolve the IDREF within `el`'s own document/shadow root,
        // never escaping into an unrelated root.
        const target = idRefLookup(el, id);
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

  const parentLabel = typeof el.closest === "function" ? el.closest("label") : null;
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
  const tag = el.tagName.toLowerCase();
  if (name && (tag === "input" || tag === "select" || tag === "textarea")) {
    return name;
  }

  // 7. textContent fallback (only for non-form-controls, e.g. buttons, links, ARIA widgets)
  if (tag !== "input" && tag !== "textarea" && tag !== "select") {
    // A container-sized control (a result card wrapped in one link) also
    // contains its OWN nested controls, whose captions land at the front of
    // textContent and push the item's real identity past the length cap —
    // e.g. a compare checkbox's label preceding the product title. Drop nested
    // form controls first, exactly as the <label> paths above already do, so
    // the element's own text leads. Falls back to raw text if that empties it.
    const stripped = textWithoutNestedControls(el);
    if (stripped) return stripped.slice(0, MAX_LABEL);
    const text = el.textContent?.trim().replace(/\s+/g, " ");
    if (text) return text.slice(0, MAX_LABEL);
  }

  // 8. NEW — names carried by a child rather than by text.
  //    a) button-like <input>: `value` is the authored caption, not user data.
  if (tag === "input") {
    const inputType = ((el as HTMLInputElement).type || "text").toLowerCase();
    if (inputType === "submit" || inputType === "button" || inputType === "reset") {
      const val = bounded((el as HTMLInputElement).value);
      if (val) return val;
    }
  }
  //    b) icon-only controls (only when there is no text content at all).
  if (tag !== "input" && tag !== "textarea" && tag !== "select") {
    const icon = iconName(el);
    if (icon) return icon;
  }

  return null;
}

/**
 * Lowercased, whitespace-collapsed, bounded form of an accessible name, used
 * as the deterministic key for stale-target fallback resolution.
 */
export function normalizeName(name: string | null | undefined): string {
  if (!name) return "";
  return name.replace(/\s+/g, " ").trim().toLowerCase().slice(0, MAX_LABEL);
}
