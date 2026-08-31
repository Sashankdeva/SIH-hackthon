/**
 * Shared interactive-element model.
 *
 * Phase 3 — perception/action parity. Before this module, three layers each
 * had their own idea of "what is an interactive element":
 *
 *   - domCapture.ts   INTERACTIVE_SELECTOR + roleFor()   → what the model sees
 *   - validator.ts    isEditableTarget()                 → what may be typed into
 *   - pvm/verify.ts   isInputLikeElement()               → where textContent is
 *                                                          not valid evidence
 *
 * They disagreed about textbox / searchbox / combobox / spinbutton / slider /
 * contenteditable / tabindex controls, which produced "captured but not
 * operable" and "operable but not captured" mismatches on ordinary websites.
 *
 * This is the single source of truth. It is deliberately small: one classifier
 * returning a coarse role plus three capability booleans. Each of the three
 * layers now derives its predicate from here, so they cannot drift apart.
 *
 * No hostnames, no site-specific selectors — pure web-platform semantics.
 */

/** Coarse interaction role. Mirrors the strings capture reports to the model. */
export type InteractiveRole =
  | "button"
  | "link"
  | "textbox"
  | "searchbox"
  | "combobox"
  | "spinbutton"
  | "slider"
  | "checkbox"
  | "radio"
  | "switch"
  | "tab"
  | "menuitem"
  | "option"
  | "contenteditable"
  | "summary";

export interface InteractiveInfo {
  /** Coarse role; capture reports this as the element's `role`. */
  role: string;
  /**
   * The `type` / `type_secret` executor can inject text into this element
   * (native text input / textarea / number input / contenteditable host).
   */
  editable: boolean;
  /**
   * Value-bearing control whose `.textContent` is NOT its value — PVM must not
   * use textContent as evidence of text entry for these.
   */
  inputLike: boolean;
  /** A native <select> the select-via-`type` executor path can operate. */
  nativeSelect: boolean;
}

/** ARIA roles that denote a clickable (activatable) control. */
const CLICKABLE_ROLES = new Set([
  "button", "link", "tab", "menuitem", "menuitemcheckbox", "menuitemradio",
  "option", "treeitem", "switch", "checkbox", "radio", "combobox", "gridcell",
]);

/** ARIA roles that denote a value-bearing / text-entry control. */
const INPUT_LIKE_ROLES = new Set([
  "textbox", "searchbox", "combobox", "spinbutton", "slider", "listbox",
]);

/** ARIA attributes that mark a bare `tabindex` element as a real custom widget. */
const WIDGET_STATE_ATTRS = [
  "aria-pressed", "aria-expanded", "aria-haspopup", "aria-checked",
  "aria-selected", "aria-controls",
];

function attr(el: Element, name: string): string | null {
  return typeof el.getAttribute === "function" ? el.getAttribute(name) : null;
}

function explicitRole(el: Element): string {
  return (attr(el, "role") || "").toLowerCase().trim();
}

function isContentEditableHost(el: Element): boolean {
  // `isContentEditable` reflects the inherited/computed state; the attribute
  // check also catches the bare and empty-string forms (`contenteditable` /
  // `contenteditable=""`), both of which mean "true".
  if ((el as HTMLElement).isContentEditable === true) return true;
  const raw = attr(el, "contenteditable");
  if (raw == null) return false;
  const v = raw.toLowerCase().trim();
  return v === "" || v === "true" || v === "plaintext-only";
}

function tabIndexIsFocusable(el: Element): boolean {
  if (typeof el.hasAttribute !== "function" || !el.hasAttribute("tabindex")) return false;
  const raw = attr(el, "tabindex");
  if (raw == null) return false;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > -1;
}

/** Computed `cursor: pointer` — the author's own "this is clickable" signal. */
function hasPointerCursor(el: Element): boolean {
  try {
    const win = el.ownerDocument?.defaultView;
    if (!win || typeof win.getComputedStyle !== "function") return false;
    return win.getComputedStyle(el).cursor === "pointer";
  } catch {
    return false;
  }
}

function hasWidgetSignal(el: Element): boolean {
  if (explicitRole(el)) return true;
  if (attr(el, "onclick") != null) return true;
  for (const a of WIDGET_STATE_ATTRS) {
    if (attr(el, a) != null) return true;
  }
  // A focusable element the author also styled as clickable is a real control.
  // Frameworks routinely emit `tabindex="0"` + `cursor: pointer` with no ARIA
  // at all; requiring an ARIA attribute alone made those invisible to capture.
  if (hasPointerCursor(el)) return true;
  return false;
}

/**
 * Classifies an element as an interactive/actionable target, or returns null
 * when it is not one we should present to the model.
 *
 * Guarantees the parity invariant: a non-null result means the validator and
 * executor both know how to operate the element — `click` is always safe
 * (executor.safeClick), and `type` either injects text (`editable`), operates
 * a native select (`nativeSelect`), or is cleanly rejected by the validator.
 */

/**
 * Longest visible text we will accept as a control label. A genuine button
 * caption is short; anything longer is prose in a clickable container.
 */
const MAX_CUSTOM_CONTROL_TEXT = 60;

/** Looser bound when a real click handler was observed on the element. */
const MAX_PROBED_CONTROL_TEXT = 200;

/**
 * Generic custom-control detection.
 *
 * Many modern frameworks (react-native-web and friends) render primary actions
 * as a plain <div> carrying a JS click handler — no role, no tabindex, no href,
 * no ARIA. Those elements are invisible to every semantic rule above, so a page
 * can present real, visible actions while capture reports only decorative
 * links. The one signal such controls reliably DO carry is the author's own
 * `cursor: pointer`, which is what makes them look clickable to a human.
 *
 * To stay precise rather than scraping every styled div, ALL of these must hold:
 *   - the element is a generic container with no semantic signal of its own;
 *   - it has short, button-length visible text (a caption, not prose);
 *   - it has few element children (a leaf-ish control, not a section);
 *   - computed `cursor` is "pointer";
 *   - it contains NO interactive descendant — the innermost clickable wins, so
 *     a stack of nested clickable wrappers yields exactly one control.
 *
 * No hostnames, no URLs, no class names, no label text matching.
 */
function isCustomClickable(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag !== "div" && tag !== "span") return false;
  // Anything with its own semantic signal is handled by the rules above.
  if (explicitRole(el) || tabIndexIsFocusable(el) || isContentEditableHost(el)) return false;

  // Strongest evidence: the MAIN-world probe saw the page attach a real click
  // handler to THIS element (perception/clickableProbe.ts). Only the handler
  // owner is marked, so nested wrappers cannot duplicate. Still subject to the
  // caption / not-inside-a-control checks below.
  const probed = attr(el, "data-privy-clickable") != null;

  // Cheap structural filters first — these reject the overwhelming majority
  // before any style resolution happens.
  // Defensive: non-browser DOM stand-ins may not expose `children`.
  // Leaf-ish only matters for the weaker cursor heuristic; an observed handler
  // is definitive regardless of how the control is composed internally.
  const kids = (el as unknown as { children?: { length?: number } }).children;
  if (!probed && kids && typeof kids.length === "number" && kids.length > 3) return false;
  let text: string;
  try {
    text = (el.textContent || "").trim();
  } catch {
    return false;
  }
  // A control must be nameable, or the model cannot refer to it. Icon-only
  // controls carry their name in an authored attribute instead of text.
  const caption = text || (attr(el, "aria-label") || "").trim() || (attr(el, "title") || "").trim();
  // The short-caption cap exists to stop the WEAK cursor heuristic mistaking a
  // prose container for a control. An observed click handler is direct evidence,
  // so it gets a looser bound — real captions pick up incidental text such as a
  // CSS odometer price that renders every digit column. A generous bound still
  // excludes whole page sections.
  const captionLimit = probed ? MAX_PROBED_CONTROL_TEXT : MAX_CUSTOM_CONTROL_TEXT;
  if (caption.length === 0 || caption.length > captionLimit) return false;

  // Author intent: styled to be clicked, OR an observed real click handler.
  if (!probed && !hasPointerCursor(el)) return false;

  // Skip wrappers that merely contain a real control.
  try {
    if (typeof el.querySelector === "function" && el.querySelector(INNER_INTERACTIVE_SELECTOR)) {
      return false;
    }
  } catch {
    /* fall through — treat as a leaf */
  }

  // `cursor` INHERITS, so every span/div inside a link or button also computes
  // "pointer". Anything sitting inside a real control is part of that control,
  // not a separate one.
  const parent = (el as unknown as { parentElement?: Element | null }).parentElement ?? null;
  try {
    if (parent && typeof parent.closest === "function" && parent.closest(INNER_INTERACTIVE_SELECTOR)) {
      return false;
    }
  } catch {
    /* fall through */
  }

  // Frameworks stack several clickable wrappers around one visual control. Keep
  // the OUTERMOST of a same-text chain so a control is reported exactly once.
  let ancestor = parent;
  let depth = 0;
  while (ancestor && depth < 4) {
    try {
      const aw = ancestor.ownerDocument?.defaultView;
      if (
        aw &&
        typeof aw.getComputedStyle === "function" &&
        aw.getComputedStyle(ancestor).cursor === "pointer" &&
        (ancestor.textContent || "").trim() === text && text.length > 0
      ) {
        return false;
      }
    } catch {
      /* ignore this ancestor */
    }
    ancestor = (ancestor as unknown as { parentElement?: Element | null }).parentElement ?? null;
    depth++;
  }
  return true;
}

/**
 * Genuinely actionable elements, used both to reject wrappers that merely
 * CONTAIN a control and to reject elements sitting INSIDE one.
 *
 * Deliberately lists real widget roles rather than a bare `[role]`: landmark
 * and structural roles (main, region, list, img…) are not controls, and
 * matching them made almost every element look like it lived inside one.
 */
const INNER_INTERACTIVE_SELECTOR =
  "a[href], area[href], button, input, select, textarea, summary, [contenteditable], " +
  "[role=button], [role=link], [role=tab], [role=menuitem], [role=menuitemcheckbox], " +
  "[role=menuitemradio], [role=option], [role=treeitem], [role=checkbox], [role=radio], " +
  "[role=switch], [role=combobox], [role=textbox], [role=searchbox], [role=spinbutton], [role=slider]";

export function classifyInteractive(el: Element | null): InteractiveInfo | null {
  if (!el || typeof el.tagName !== "string") return null;
  const tag = el.tagName.toLowerCase();
  const role = explicitRole(el);

  // --- Native form controls -------------------------------------------------
  if (tag === "select") {
    return { role: "combobox", editable: false, inputLike: true, nativeSelect: true };
  }
  if (tag === "textarea") {
    return { role: role || "textbox", editable: true, inputLike: true, nativeSelect: false };
  }
  if (tag === "input") {
    const t = ((el as HTMLInputElement).type || "text").toLowerCase();
    if (t === "hidden") return null;
    if (t === "checkbox") return { role: "checkbox", editable: false, inputLike: false, nativeSelect: false };
    if (t === "radio") return { role: "radio", editable: false, inputLike: false, nativeSelect: false };
    if (t === "range") return { role: "slider", editable: false, inputLike: true, nativeSelect: false };
    if (t === "button" || t === "submit" || t === "reset" || t === "image") {
      return { role: "button", editable: false, inputLike: false, nativeSelect: false };
    }
    if (t === "file" || t === "color") {
      return { role: "button", editable: false, inputLike: false, nativeSelect: false };
    }
    // text-family (text/search/email/url/tel/password/number/date/… and any
    // unknown future type) → treated as an editable textbox.
    return { role: "textbox", editable: true, inputLike: true, nativeSelect: false };
  }

  if (tag === "button") {
    return { role: role || "button", editable: false, inputLike: false, nativeSelect: false };
  }
  if (tag === "summary") {
    return { role: role || "summary", editable: false, inputLike: false, nativeSelect: false };
  }
  if (tag === "a" || tag === "area") {
    const hasHref = typeof el.hasAttribute === "function" && el.hasAttribute("href");
    if (hasHref) return { role: role || "link", editable: false, inputLike: false, nativeSelect: false };
    // href-less anchor: only interactive if it opts in via role / tabindex.
    if (role && CLICKABLE_ROLES.has(role)) {
      return { role, editable: false, inputLike: false, nativeSelect: false };
    }
    if (tabIndexIsFocusable(el) && hasWidgetSignal(el)) {
      return { role: role || "button", editable: false, inputLike: false, nativeSelect: false };
    }
    return null;
  }

  // --- contenteditable host (any tag) -------------------------------------
  if (isContentEditableHost(el)) {
    return { role: role || "textbox", editable: true, inputLike: true, nativeSelect: false };
  }

  // --- Explicit ARIA role on a generic element --------------------------
  if (role) {
    if (INPUT_LIKE_ROLES.has(role)) {
      // Not a native input and not contenteditable → we can represent it and
      // click it, but we cannot safely type into it. Report honestly.
      const editable = false;
      return { role, editable, inputLike: true, nativeSelect: false };
    }
    if (CLICKABLE_ROLES.has(role)) {
      return { role, editable: false, inputLike: false, nativeSelect: false };
    }
    // Unknown/none-interactive role (e.g. presentation, generic, region):
    // fall through to the tabindex check below.
  }

  // --- Keyboard-focusable custom widget -------------------------------
  // A bare `tabindex` div is NOT a browser action; require a widget signal so
  // focusable scroll containers / layout wrappers are not scraped in.
  if (tabIndexIsFocusable(el) && hasWidgetSignal(el)) {
    return { role: role || "button", editable: false, inputLike: false, nativeSelect: false };
  }

  // --- Framework-rendered control with no semantics of its own ------------
  if (isCustomClickable(el)) {
    return { role: "button", editable: false, inputLike: false, nativeSelect: false };
  }

  return null;
}

/** True when the `type` / `type_secret` executor can inject text into `el`. */
export function isEditableInteractive(el: Element | null): boolean {
  const info = classifyInteractive(el);
  return !!info && info.editable;
}

/** True when `el` is a native <select> the select-via-`type` path can operate. */
export function isNativeSelect(el: Element | null): boolean {
  const info = classifyInteractive(el);
  return !!info && info.nativeSelect;
}

/** True for value-bearing controls where textContent is not the value. */
export function isInputLike(el: Element | null): boolean {
  const info = classifyInteractive(el);
  return !!info && info.inputLike;
}

const TEXT_ENTRY_GROUP = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);

/**
 * Loose role compatibility for stale-target resolution: the text-entry roles
 * are interchangeable (a control can flip searchbox↔textbox↔combobox across a
 * re-render without becoming a different control); everything else is exact.
 */
export function roleCompatible(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return true; // caller had no expectation
  if (a === b) return true;
  return TEXT_ENTRY_GROUP.has(a) && TEXT_ENTRY_GROUP.has(b);
}
