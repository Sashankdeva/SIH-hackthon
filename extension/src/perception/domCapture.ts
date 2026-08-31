import type { CapturedElement, PageState, ValueState } from "./types";
import { classifyInteractive, roleCompatible } from "./interactive";
import { computeAccessibleName, normalizeName } from "./accessibleName";
import { deepQueryAll, deepQueryFirst, deepActiveElement, deepContains } from "./deepDom";
import type { BudgetSignals } from "./elementBudget";

/**
 * Deterministic DOM & accessibility tree capture.
 * Local ONNX face detection (via onnxruntime-web / WebGPU) is integrated
 * alongside DOM capture through `faceDetector.ts` and `vision-main/index.ts`.
 */

/**
 * Broad candidate selector. It is intentionally permissive — the authoritative
 * "is this interactive?" decision is made per-element by classifyInteractive()
 * (perception/interactive.ts), the single source of truth shared with the
 * validator and the verifier. This replaces the old hand-maintained role list
 * that drifted out of sync with what the executor could actually operate.
 */
const INTERACTIVE_SELECTOR =
  "a, area, button, input, select, textarea, summary, [role], [contenteditable], [tabindex], div, span";

let nextElementId = 1;
const elementRegistry = new WeakMap<Element, number>();

/**
 * Per-capture structural metadata for each element_id, kept CLIENT-SIDE ONLY —
 * it is never added to the sanitized payload (the /reason wire schema forbids
 * extra element fields). It exists so that when the numeric id goes stale
 * (node replaced during the model round-trip), resolveTarget() can deterministically
 * re-find the same control by its role + accessible name.
 */
export interface CaptureMeta {
  /** Coarse role from classifyInteractive at capture time. */
  role: string;
  /** normalizeName() of the accessible name at capture time. */
  name: string;
  /** Structural fingerprint: bounded ancestor tag/index path + type + role. */
  fingerprint: string;
}
const captureMeta = new Map<number, CaptureMeta>();

/**
 * Per-capture structural ranking signals for each element_id, CLIENT-SIDE ONLY.
 * Consumed by elementBudget.budgetElements() when a page has more interactive
 * controls than one reasoning step can use. Never serialised.
 */
const captureRank = new Map<number, BudgetSignals>();

/** The ranking signals from the most recent captureDomState() call. */
export function captureBudgetSignals(): Map<number, BudgetSignals> {
  return captureRank;
}

function safeRect(el: Element): { top: number; bottom: number; left: number; right: number; width: number; height: number } | null {
  try {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
  } catch {
    return null;
  }
}

/** Index of `el` among its same-tag siblings (bounded scan). */
function siblingIndex(el: Element): number {
  let idx = 0;
  let n: Element | null = (el as unknown as { previousElementSibling?: Element | null }).previousElementSibling ?? null;
  let guard = 0;
  while (n && guard < 200) {
    if (n.tagName === el.tagName) idx++;
    n = (n as unknown as { previousElementSibling?: Element | null }).previousElementSibling ?? null;
    guard++;
  }
  return idx;
}

/**
 * Deterministic, local structural fingerprint. Never derived from model input,
 * never an executable selector — purely a stable descriptor used to recognise
 * the "same place in the tree" after a re-render. Bounded ancestor depth.
 */
export function fingerprintFor(el: Element): string {
  const parts: string[] = [];
  let n: Element | null = el;
  let depth = 0;
  while (n && n.nodeType === 1 && depth < 6) {
    const tag = (n.tagName || "").toLowerCase();
    if (!tag || tag === "body" || tag === "html") break;
    parts.unshift(`${tag}[${siblingIndex(n)}]`);
    n = (n as unknown as { parentElement?: Element | null }).parentElement ?? null;
    depth++;
  }
  const t = (el.tagName || "").toLowerCase() === "input" ? ((el as HTMLInputElement).type || "").toLowerCase() : "";
  const r = (el.getAttribute?.("role") || "").toLowerCase().trim();
  return `${parts.join(">")}|${t}|${r}`;
}

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
 * Deterministic label extraction. Delegates to the shared accessible-name
 * calculator (perception/accessibleName.ts) so capture, validation and the
 * stale-target resolver all read the same name for an element.
 */
function labelFor(el: Element): string | null {
  return computeAccessibleName(el);
}

function isDisabled(el: Element): boolean {
  if ((el as HTMLInputElement).disabled === true) return true;
  if (el.getAttribute?.("aria-disabled") === "true") return true;
  if (el.hasAttribute?.("disabled")) return true;
  if (el.closest?.("fieldset[disabled]")) return true;
  return false;
}

function isReadOnly(el: Element): boolean {
  if ((el as HTMLInputElement).readOnly === true) return true;
  if (el.getAttribute?.("aria-readonly") === "true") return true;
  if (el.hasAttribute?.("readonly")) return true;
  return false;
}

/**
 * Safe current value state for an editable control, read from the LIVE DOM at
 * capture time (so it reflects text this task just typed, not action history).
 *
 * Only a three-way occupancy flag ever leaves this function — the field's
 * actual text is read into a local, reduced to a boolean, and discarded. A
 * password input short-circuits to "redacted" without its content being
 * inspected at all; the privacy firewall additionally forces "redacted" for
 * every element it classifies as sensitive (see buildSanitizedContext), so
 * classification always wins over ordinary occupancy.
 */
function valueStateFor(
  el: Element,
  info: { editable: boolean },
  inputType: string | null
): ValueState | undefined {
  if (!info.editable) return undefined;
  if (inputType === "password") return "redacted";
  try {
    const tag = (el.tagName || "").toLowerCase();
    const text =
      tag === "input" || tag === "textarea"
        ? (el as HTMLInputElement | HTMLTextAreaElement).value ?? ""
        : el.textContent ?? "";
    return text.trim().length > 0 ? "nonempty" : "empty";
  } catch {
    return undefined;
  }
}

function isElementVisible(el: Element): boolean {
  // 1. Check aria-hidden / hidden attributes on element or ancestors
  if (el.hasAttribute?.("hidden") || el.getAttribute?.("aria-hidden") === "true") return false;
  if (el.closest?.("[aria-hidden='true'], [hidden]")) return false;

  // 2. Check computed style properties if available. Use the element's OWN realm
  // (a same-origin child frame has its own window) — cross-realm getComputedStyle
  // is unreliable.
  const realmWin = (el.ownerDocument?.defaultView ?? (typeof window !== "undefined" ? window : null)) as
    | (Window & typeof globalThis)
    | null;
  if (realmWin && typeof realmWin.getComputedStyle === "function") {
    try {
      const style = realmWin.getComputedStyle(el);
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
    const he = el as unknown as { offsetWidth?: number; offsetHeight?: number };
    if ((he.offsetWidth ?? 0) > 0 || (he.offsetHeight ?? 0) > 0) {
      return true;
    }

    // A genuinely visible control can still report a 0x0 SELF rect when it
    // generates no box of its own: `display: contents`, or a wrapper whose
    // visible content is entirely in floated / absolutely-positioned /
    // overflowing descendants (very common for navigation anchors that wrap an
    // icon span + a label span). It is visible iff a descendant actually paints
    // a box. display:none / visibility:hidden / hidden / aria-hidden were all
    // rejected in steps 1-2 above, and each of those ALSO collapses or hides
    // descendant boxes, so this probe can never revive a genuinely hidden
    // subtree — it only rescues transparent wrappers. Bounded breadth-first
    // walk so a deep tree can't make capture expensive.
    try {
      const queue: Element[] = [];
      const first = el.children;
      for (let i = 0; i < first.length; i++) queue.push(first[i]);
      let probed = 0;
      while (queue.length > 0 && probed < 48) {
        const child = queue.shift() as Element;
        probed++;
        const cr = child.getBoundingClientRect();
        if (cr.width > 0 && cr.height > 0) return true;
        const grand = child.children;
        for (let i = 0; i < grand.length; i++) queue.push(grand[i]);
      }
    } catch {
      // fall through to the jsdom heuristic / return false
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

  // Viewport + focus context for element-budget ranking (elementBudget.ts).
  const vpW = typeof window !== "undefined" && window.innerWidth ? window.innerWidth : 1024;
  const vpH = typeof window !== "undefined" && window.innerHeight ? window.innerHeight : 768;
  // Deep active element: document.activeElement returns the shadow HOST when
  // focus is inside an open shadow tree — recurse to the real focused control.
  const active = deepActiveElement();
  let docIndex = 0;

  // deepQueryAll pierces OPEN shadow roots (nested included). Closed roots and
  // iframes are never traversed. Order is deterministic (light tree per root,
  // then its open shadow subtrees in host order).
  deepQueryAll(INTERACTIVE_SELECTOR).forEach((el) => {
    // Single source of truth: only present elements the validator + executor
    // can actually operate. Filters out focusable-but-inert wrappers, bare
    // <a> without href, presentation-role nodes, etc. Classified BEFORE the
    // visibility check so the generic div/span candidates (added so that
    // framework-rendered controls are reachable at all) are rejected by the
    // cheap structural filters instead of each paying a style resolution.
    const info = classifyInteractive(el);
    if (!info) return;
    if (!isElementVisible(el)) return;

    const inputType = (el.tagName || "").toLowerCase() === "input" ? ((el as HTMLInputElement).type || "text").toLowerCase() : null;
    const placeholder = el.getAttribute("placeholder")?.trim() || null;
    const disabled = isDisabled(el);
    const readonly = isReadOnly(el);
    const label = labelFor(el);
    const elementId = idFor(el);

    const captured: CapturedElement = {
      elementId,
      role: info.role,
      label,
      tag: el.tagName.toLowerCase(),
      inputType,
    };

    if (disabled) captured.disabled = true;
    if (readonly) captured.readonly = true;
    if (placeholder) captured.placeholder = placeholder;

    // Safe occupancy of editable controls — never the value itself.
    const valueState = valueStateFor(el, info, inputType);
    if (valueState) captured.valueState = valueState;

    // Client-side only — not serialized into the sanitized payload.
    captureMeta.set(elementId, {
      role: info.role,
      name: normalizeName(label),
      fingerprint: fingerprintFor(el),
    });

    const rect = safeRect(el);
    const inViewport = rect
      ? rect.bottom > 0 && rect.top < vpH && rect.right > 0 && rect.left < vpW
      : true;
    let viewportGap = 0;
    if (rect && !inViewport) {
      if (rect.top >= vpH) viewportGap = rect.top - vpH;
      else if (rect.bottom <= 0) viewportGap = -rect.bottom;
      else if (rect.left >= vpW) viewportGap = rect.left - vpW;
      else if (rect.right <= 0) viewportGap = -rect.right;
    }
    // deepContains crosses open shadow boundaries via host links so a control
    // that owns the shadow tree holding focus is still flagged focused.
    const focused = active != null && (el === active || deepContains(el, active));
    captureRank.set(elementId, {
      docIndex: docIndex++,
      inViewport,
      viewportGap,
      focused,
      editable: info.editable,
      area: rect ? Math.max(0, rect.width) * Math.max(0, rect.height) : 0,
    });

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

  // WeakMap identity first — across the document AND all reachable open shadow roots.
  for (const el of deepQueryAll(INTERACTIVE_SELECTOR)) {
    if (elementRegistry.get(el) === elementId) return el;
  }

  // Fallback: the stable data-privy-id attribute, also searched into open shadow roots.
  try {
    const fallbackEl = deepQueryFirst(`[data-privy-id="${elementId}"]`);
    if (fallbackEl) {
      elementRegistry.set(fallbackEl, elementId);
      return fallbackEl;
    }
  } catch {
    // Safe lookup fallback
  }

  return null;
}

/** Read the client-side capture metadata for an element_id (null if unknown). */
export function getCaptureMeta(elementId: number): CaptureMeta | null {
  return captureMeta.get(elementId) ?? null;
}

/**
 * Is `el` still a usable target RIGHT NOW?
 *
 * A framework can detach or repurpose a node between the moment it is resolved
 * and the moment the executor acts on it. Acting on such a node silently does
 * nothing, which surfaces as an endless run of `ambiguous` steps rather than an
 * honest failure. Checked immediately before execution.
 */
export function isUsableTarget(el: Element | null, expectedRole?: string | null): boolean {
  if (!el) return false;
  // `isConnected` is absent in some non-browser DOM stand-ins — only trust it
  // when the environment actually provides it.
  const connected = (el as unknown as { isConnected?: unknown }).isConnected;
  if (typeof connected === "boolean" && !connected) return false;
  const info = classifyInteractive(el);
  if (!info) return false;
  if (expectedRole && !roleCompatible(info.role, expectedRole)) return false;
  return isElementVisible(el);
}

export type TargetResolution =
  | { status: "resolved"; element: Element; recovered: boolean }
  /** The id had capture metadata but the control is gone and no unique twin exists. */
  | { status: "missing" }
  /** Multiple live controls match the captured role + name — refuse to guess. */
  | { status: "ambiguous"; candidates: number }
  /** No metadata and no live node — caller falls back to normal validation. */
  | { status: "unknown" };

/** All currently-interactive elements on the page (incl. open shadow roots), classified once. */
function liveInteractiveElements(): Element[] {
  const out: Element[] = [];
  try {
    deepQueryAll(INTERACTIVE_SELECTOR).forEach((el) => {
      if (classifyInteractive(el)) out.push(el);
    });
  } catch {
    // ignore
  }
  return out;
}

/**
 * Stale-target resolution (Phase 3, steps 6–7).
 *
 * Deterministic and entirely local. The model never supplies a selector; this
 * only ever matches on data captured by THIS client:
 *
 *   1. try the numeric id (WeakMap / data-privy-id) — if the node is still
 *      there and still an interactive control of a compatible role, use it
 *      (a changed label on the same node is fine — identity is strong);
 *   2. otherwise look for live controls whose (role, normalized accessible
 *      name) equals the captured pair;
 *        - exactly one  → adopt it (stamp the id back on so the executor and
 *          PVM resolve the same node) and report `recovered: true`;
 *        - zero         → `missing` (target disappeared / role changed);
 *        - two or more  → `ambiguous` (never guess between equivalents).
 *
 * `expected` (role + label from the SanitizedContext the model reasoned over)
 * takes precedence over the stored capture metadata when provided.
 */
export function resolveTarget(
  elementId: number,
  expected?: { role?: string | null; label?: string | null },
  options?: { strict?: boolean }
): TargetResolution {
  if (!elementId || elementId <= 0) return { status: "unknown" };

  // `strict` = the id was NOT present in the context the model reasoned over,
  // so there is no trustworthy expected role/label. Recovery must not invent
  // one from a previous capture's metadata; direct resolution only.
  const strict = options?.strict === true;
  const meta = strict ? undefined : captureMeta.get(elementId);
  const wantRole = (expected?.role ?? meta?.role) || null;
  const wantName = expected?.label != null ? normalizeName(expected.label) : (meta?.name ?? "");

  // 1. Direct hit on the same DOM node.
  const direct = resolveElement(elementId);
  if (direct) {
    const info = classifyInteractive(direct);
    if (info && roleCompatible(info.role, wantRole) && isUsableTarget(direct, wantRole)) {
      return { status: "resolved", element: direct, recovered: false };
    }
    // The id still points at a node, but it is no longer a compatible
    // interactive control: the framework re-rendered and reused or repurposed
    // that node (data-privy-id rides along with it). Giving up here reported
    // `target_lost` even when the real replacement control was sitting in the
    // live DOM. Fall through to the deterministic (role, accessible name)
    // recovery below instead — it still refuses to guess.
  }

  // No metadata to match on and the node is gone: let the normal validator
  // path produce its own "element not found" rejection.
  if (!meta && !expected) return { status: "unknown" };

  // 2. Deterministic fallback by (role, accessible name).
  if (!wantName) {
    // Nothing safe to match on (icon-only control with no name, now replaced).
    return meta ? { status: "missing" } : { status: "unknown" };
  }

  const candidates = liveInteractiveElements().filter((el) => {
    const info = classifyInteractive(el);
    if (!info || !roleCompatible(info.role, wantRole)) return false;
    if (!isUsableTarget(el, wantRole)) return false;
    return normalizeName(computeAccessibleName(el)) === wantName;
  });

  if (candidates.length === 1) {
    const el = candidates[0];
    try {
      el.setAttribute("data-privy-id", String(elementId));
    } catch {
      // non-fatal
    }
    elementRegistry.set(el, elementId);
    return { status: "resolved", element: el, recovered: true };
  }
  if (candidates.length === 0) {
    return meta ? { status: "missing" } : { status: "unknown" };
  }
  return { status: "ambiguous", candidates: candidates.length };
}

/** Hard upper bound on waiting for a replacement target to appear. */
export const TARGET_SETTLE_MS = 1_200;
const TARGET_POLL_MS = 120;

/**
 * resolveTarget against the CURRENT DOM, tolerating a page that is still
 * settling at resolve time.
 *
 * Resolution runs AFTER the /reason round trip, so seconds may have passed
 * since the capture the model reasoned over; a list can still be re-rendering
 * when the action comes back. A single synchronous attempt then reported
 * `target_lost` for a control that was about to exist.
 *
 * Only the `missing` case is retried — `resolved`, `ambiguous` and `unknown`
 * are already final answers and return immediately, so a healthy page pays no
 * delay. Bounded by TARGET_SETTLE_MS and never busy-loops; if the replacement
 * never appears, `missing` stands and `target_lost` remains correct.
 */
export async function resolveTargetSettled(
  elementId: number,
  expected?: { role?: string | null; label?: string | null },
  options?: { strict?: boolean }
): Promise<TargetResolution> {
  let res = resolveTarget(elementId, expected, options);
  if (res.status !== "missing") return res;

  const deadline = Date.now() + TARGET_SETTLE_MS;
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, TARGET_POLL_MS);
    });
    res = resolveTarget(elementId, expected, options);
    if (res.status !== "missing") return res;
  }
  return res; // genuinely gone → target_lost is the right answer
}

/**
 * Utility helper to reset element registry state (used for testing).
 */
export function resetElementRegistry(): void {
  nextElementId = 1;
  captureMeta.clear();
  captureRank.clear();
}
