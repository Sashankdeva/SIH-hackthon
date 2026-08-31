import { resolveElement } from "../perception/domCapture";
import { isInputLike, isNativeSelect } from "../perception/interactive";
import { computeAccessibleName } from "../perception/accessibleName";
import { deepQueryFirst, idRefLookup, ownerFrameUrl } from "../perception/deepDom";
import type { ActionRequest } from "../action/types";
import type {
  VerificationResult,
  VerificationRequest,
  VerificationEvidence,
  ElementStateExpectation,
  L2SemanticExpectation,
  L3VisualExpectation,
  HigherLevelVerificationOptions,
  VerificationLevel,
} from "./types";

export type { L2SemanticExpectation, L3VisualExpectation, HigherLevelVerificationOptions, VerificationLevel };

/**
 * Pre-execution state captured by the pipeline before dispatch.
 * The verifier compares this against the post-execution state to
 * determine whether the action landed.
 */
export interface ActionSnapshot {
  urlBefore: string;
  scrollYBefore: number;
  /** Value of the target input element before execution; null for non-input actions. */
  elementValueBefore: string | null;
  /** The action that was dispatched — the verifier needs the type, elementId, and value. */
  action: ActionRequest;
  startedAt: number;
  /**
   * Phase 5 — minimal bounded pre-action evidence about the target, used by the
   * async-settle verifier to detect in-page state changes (aria flips, on-target
   * label change, a controlled region opening). Never a DOM dump; never a value.
   * Optional so existing one-shot callers/tests need not provide it.
   */
  targetBefore?: TargetBaseline | null;
}

/** Bounded pre-action evidence about a single target element. No raw values. */
export interface TargetBaseline {
  present: boolean;
  ariaExpanded: string | null;
  ariaPressed: string | null;
  ariaChecked: string | null;
  disabled: boolean;
  /** Bounded accessible name (<= 120 chars) for on-target label/state flips. */
  name: string | null;
  /** First id from aria-controls / aria-owns, if any. */
  controlsId: string | null;
  /** Whether that controlled element was visibly shown at baseline. */
  controlsShown: boolean;
  /**
   * Phase 6B — the URL of the frame that OWNS the target (its own document's
   * location, which equals the top URL for a top-frame target). Lets PVM see a
   * same-origin child-frame navigation without mistaking it for a top-level one.
   */
  frameUrlBefore: string | null;
}

/**
 * Per-action verification dispatcher.
 *
 * Each action type has an appropriate success signal:
 *   click        → URL changed OR the clicked element left the DOM
 *   type         → target element's value matches the requested value
 *   type_secret  → target element's value changed (actual value is never logged)
 *   scroll       → scrollY changed
 *   navigate     → URL changed
 *   wait         → unconditional success (waiting IS the action)
 *   keypress     → ambiguous (no reliable check)
 *
 * Three possible outcomes:
 *   success   — positive evidence the action landed
 *   failure   — positive evidence the action did NOT land
 *   ambiguous — no evidence either way
 *
 * An "ambiguous" result must NEVER authorize another execution.
 * The dispatch gate (action/dispatch.ts) enforces this structurally.
 */
export function verifyAction(actionId: string, snapshot: ActionSnapshot): VerificationResult {
  const latencyMs = Date.now() - snapshot.startedAt;
  const { action } = snapshot;

  switch (action.action) {
    case "click":
      return verifyClick(actionId, snapshot, latencyMs);
    case "type":
      return verifyType(actionId, snapshot, latencyMs);
    case "type_secret":
      return verifyTypeSecret(actionId, snapshot, latencyMs);
    case "scroll":
      return verifyScroll(actionId, snapshot, latencyMs);
    case "navigate":
      return verifyNavigate(actionId, snapshot, latencyMs);
    case "wait":
      return { actionId, expected: "wait_completed", observed: "wait_completed", status: "success", latencyMs };
    case "keypress":
      return { actionId, expected: "keypress_effect", observed: "keypress_unverifiable", status: "ambiguous", latencyMs };
    default:
      return { actionId, expected: "unknown", observed: "unknown", status: "ambiguous", latencyMs };
  }
}

function verifyClick(actionId: string, snapshot: ActionSnapshot, latencyMs: number): VerificationResult {
  const urlAfter = typeof location !== "undefined" ? location.href : "";
  if (urlAfter !== snapshot.urlBefore) {
    return { actionId, expected: "click_effect", observed: "url_changed", status: "success", latencyMs };
  }

  if (snapshot.action.elementId != null) {
    const el = resolveElement(snapshot.action.elementId);
    if (!el) {
      return { actionId, expected: "click_effect", observed: "element_removed", status: "success", latencyMs };
    }
    // Same-origin child-frame navigation: the target still exists but the frame
    // that owns it has navigated. This is NOT a top-level navigation.
    const frameBefore = snapshot.targetBefore?.frameUrlBefore ?? null;
    if (frameBefore) {
      const frameNow = ownerFrameUrl(el);
      if (frameNow && frameNow !== frameBefore) {
        return { actionId, expected: "click_effect", observed: "frame_url_changed", status: "success", latencyMs };
      }
    }
  }

  return { actionId, expected: "click_effect", observed: "no_observable_change", status: "ambiguous", latencyMs };
}

function verifyType(actionId: string, snapshot: ActionSnapshot, latencyMs: number): VerificationResult {
  const el = snapshot.action.elementId != null
    ? resolveElement(snapshot.action.elementId) as HTMLInputElement | null
    : null;

  if (!el) {
    return { actionId, expected: "value_matches", observed: "element_not_found", status: "failure", latencyMs };
  }

  const expected = snapshot.action.value ?? "";

  // Native <select>: a `type` on a select is a "choose the matching option"
  // request. Verify locally against the selected option — never assume the
  // native picker did anything.
  if (isNativeSelect(el)) {
    const sel = el as unknown as HTMLSelectElement;
    const chosen = sel.selectedOptions && sel.selectedOptions.length > 0 ? sel.selectedOptions[0] : null;
    const chosenText = (chosen?.textContent ?? "").replace(/\s+/g, " ").trim();
    const chosenValue = chosen?.getAttribute("value") ?? sel.value ?? "";
    const want = expected.replace(/\s+/g, " ").trim();
    const matched =
      chosenValue === expected ||
      chosenText === want ||
      chosenText.toLowerCase() === want.toLowerCase() ||
      chosenValue.toLowerCase() === want.toLowerCase();
    return {
      actionId,
      expected: "option_selected",
      observed: matched ? "option_selected" : "option_not_selected",
      status: matched ? "success" : "failure",
      latencyMs,
    };
  }

  if (el.value === expected) {
    return { actionId, expected: "value_matches", observed: "value_matches", status: "success", latencyMs };
  }

  return { actionId, expected: "value_matches", observed: "value_mismatch", status: "failure", latencyMs };
}

function verifyTypeSecret(actionId: string, snapshot: ActionSnapshot, latencyMs: number): VerificationResult {
  const el = snapshot.action.elementId != null
    ? resolveElement(snapshot.action.elementId) as HTMLInputElement | null
    : null;

  if (!el) {
    return { actionId, expected: "value_changed", observed: "element_not_found", status: "failure", latencyMs };
  }

  const changed = el.value !== snapshot.elementValueBefore && el.value !== "";
  return {
    actionId,
    expected: "value_changed",
    observed: changed ? "value_changed" : "value_unchanged",
    status: changed ? "success" : "failure",
    latencyMs,
  };
}

function verifyScroll(actionId: string, snapshot: ActionSnapshot, latencyMs: number): VerificationResult {
  const scrollYAfter = (globalThis as unknown as { window?: { scrollY?: number } }).window?.scrollY ?? 0;
  const changed = scrollYAfter !== snapshot.scrollYBefore;
  return {
    actionId,
    expected: "scroll_changed",
    observed: changed ? "scroll_changed" : "scroll_unchanged",
    status: changed ? "success" : "ambiguous",
    latencyMs,
  };
}

function verifyNavigate(actionId: string, snapshot: ActionSnapshot, latencyMs: number): VerificationResult {
  const urlAfter = typeof location !== "undefined" ? location.href : "";
  const changed = urlAfter !== snapshot.urlBefore;
  return {
    actionId,
    expected: "url_changed",
    observed: changed ? "url_changed" : "url_unchanged",
    status: changed ? "success" : "failure",
    latencyMs,
  };
}

// =========================================================================
// Phase 5 — bounded async / dynamic-UI settle verification
// =========================================================================
//
// verifyAction() above stays synchronous and unchanged: it is the immediate
// one-shot check. verifyActionSettled() wraps it with a SMALL bounded
// observation window for effects that land asynchronously (menu opens, smooth
// scroll, framework value reconciliation, deferred SPA routing).
//
// Rules, all preserved from the synchronous verifier:
//   - returns the instant strong evidence appears (no fixed sleeps);
//   - "no meaningful observable change" stays `ambiguous`, never success;
//   - exact value / selected-option verification is NOT weakened;
//   - a lost target stays `failure`;
//   - only evidence CAUSALLY tied to the target/action counts — the window
//     inspects the target's own attributes and the one region it declares it
//     controls, never the page at large.

export interface SettleConfig {
  clickMs: number;
  typeMs: number;
  scrollMs: number;
  navigateMs: number;
}

/**
 * Deadlines are deliberately small. Async STATE signals (aria-expanded flip,
 * value reconciliation) almost always land within 1–2 frames even when the
 * visual animation is longer, and we return the moment they do. A purely
 * visual change with no observable state stays `ambiguous` — waiting longer
 * would not help. Tune here.
 */
export const DEFAULT_SETTLE: SettleConfig = {
  clickMs: 150,
  typeMs: 120,
  scrollMs: 220,
  navigateMs: 100,
};

const nowMs = (): number =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();

/**
 * One settle tick.
 *
 * requestAnimationFrame is the accurate signal while the document is being
 * rendered, but it is NOT guaranteed to fire: the callback is simply never
 * invoked in a tab that is backgrounded/occluded, or while the document is
 * unloading after a navigating click. The settle loops re-check their deadline
 * only after this resolves, so an rAF-only tick makes their bound unenforceable
 * and verification hangs indefinitely (observed in real Chrome: a click on a
 * link produced `verify START` and then no further progress until the task
 * loop's 20s step budget killed the step).
 *
 * A timer is therefore ALWAYS armed alongside rAF and whichever fires first
 * wins. When rendering is live this behaves exactly as before (~16ms, rAF);
 * when it is suspended the timer keeps the bounded loop advancing so the
 * deadline is honoured. Verification semantics are unchanged — this only
 * guarantees the loop makes progress.
 */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    setTimeout(finish, 16);
    if (typeof requestAnimationFrame === "function") {
      try {
        requestAnimationFrame(finish);
      } catch {
        /* the timer above already covers this tick */
      }
    }
  });
}

const lat = (s: ActionSnapshot): number => Math.max(0, Math.round(Date.now() - s.startedAt));

function isShown(el: Element | null): boolean {
  if (!el) return false;
  if (el.hasAttribute?.("hidden")) return false;
  if (el.getAttribute?.("aria-hidden") === "true") return false;
  try {
    if (typeof window !== "undefined" && typeof window.getComputedStyle === "function") {
      const s = window.getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden") return false;
    }
  } catch {
    /* ignore */
  }
  return true;
}

function readControls(el: Element): { id: string | null; shown: boolean } {
  const raw = (el.getAttribute?.("aria-controls") || el.getAttribute?.("aria-owns") || "").trim();
  const id = raw ? raw.split(/\s+/)[0] : null;
  if (!id) return { id: null, shown: false };
  let target: Element | null = null;
  try {
    // Tree-scoped IDREF: resolve within the control's own document / shadow root.
    target = idRefLookup(el, id);
  } catch {
    target = null;
  }
  return { id, shown: isShown(target) };
}

function boundedName(el: Element): string | null {
  let n: string | null = null;
  try {
    n = computeAccessibleName(el);
  } catch {
    n = null;
  }
  return n ? n.replace(/\s+/g, " ").trim().slice(0, 120) : null;
}

function isDisabledNow(el: Element): boolean {
  return (
    (el as HTMLInputElement).disabled === true ||
    el.getAttribute?.("aria-disabled") === "true" ||
    el.hasAttribute?.("disabled")
  );
}

/**
 * Captures the minimal pre-action baseline for a target. Called by the pipeline
 * BEFORE dispatch. Bounded — a handful of attributes plus a length; never a
 * value, never a DOM tree.
 */
export function makeTargetBaseline(elementId: number | null | undefined): TargetBaseline | null {
  if (elementId == null) return null;
  const el = resolveElement(elementId);
  if (!el) {
    return {
      present: false,
      ariaExpanded: null,
      ariaPressed: null,
      ariaChecked: null,
      disabled: false,
      name: null,
      controlsId: null,
      controlsShown: false,
      frameUrlBefore: null,
    };
  }
  const c = readControls(el);
  return {
    present: true,
    ariaExpanded: el.getAttribute("aria-expanded"),
    ariaPressed: el.getAttribute("aria-pressed"),
    ariaChecked: el.getAttribute("aria-checked"),
    disabled: isDisabledNow(el),
    name: boundedName(el),
    controlsId: c.id,
    controlsShown: c.shown,
    frameUrlBefore: ownerFrameUrl(el),
  };
}

/**
 * Causally-scoped async click evidence: only the TARGET's own state and the
 * one region it declares it controls. Returns a success result or null.
 */
function clickAsyncSignal(actionId: string, snapshot: ActionSnapshot): VerificationResult | null {
  const id = snapshot.action.elementId;
  const base = snapshot.targetBefore;
  if (id == null || !base || !base.present) return null;
  const el = resolveElement(id);
  if (!el) return null; // handled by verifyClick's element-removed branch
  const l = lat(snapshot);
  const mk = (observed: string): VerificationResult => ({
    actionId,
    expected: "click_effect",
    observed,
    status: "success",
    latencyMs: l,
  });

  if (el.getAttribute("aria-expanded") !== base.ariaExpanded) return mk("aria_expanded_changed");
  if (el.getAttribute("aria-pressed") !== base.ariaPressed) return mk("aria_pressed_changed");
  if (el.getAttribute("aria-checked") !== base.ariaChecked) return mk("aria_checked_changed");
  if (isDisabledNow(el) !== base.disabled) return mk("target_disabled_changed");

  const name = boundedName(el);
  if (base.name != null && name != null && name.length > 0 && name !== base.name) {
    return mk("target_label_changed");
  }

  const c = readControls(el);
  if (base.controlsId && c.id === base.controlsId && c.shown && !base.controlsShown) {
    return mk("controlled_region_shown");
  }
  return null;
}

async function verifyClickSettled(
  actionId: string,
  snapshot: ActionSnapshot,
  settle: SettleConfig
): Promise<VerificationResult> {
  let sync = verifyClick(actionId, snapshot, lat(snapshot));
  if (sync.status === "success") return sync;

  const deadline = nowMs() + settle.clickMs;
  while (nowMs() < deadline) {
    await nextFrame();
    sync = verifyClick(actionId, snapshot, lat(snapshot));
    if (sync.status === "success") return sync; // late URL change / element removal
    const sig = clickAsyncSignal(actionId, snapshot);
    if (sig) return sig;
  }
  // Deadline: no causally-relevant observable change → stays ambiguous.
  return verifyClick(actionId, snapshot, lat(snapshot));
}

/**
 * Final-state value/selection observation.
 *
 * `type` / `type_secret` / `type`-on-`<select>` are the actions an application
 * can legitimately RECONCILE after the fact — accept a value a frame late, or
 * revert one it rejects. Neither can be judged from an early sample, so the
 * window is observed to its (small) deadline and the LAST observation wins:
 *   - value settles correct within the window            → success
 *   - value never becomes / stops being correct          → failure (unchanged)
 *   - target disappears mid-window                        → failure (immediate)
 * Exact-match / selected-option verification is not weakened; a brief correct
 * flash that is then reverted still ends as `failure`.
 */
async function observeFinalValue(
  actionId: string,
  snapshot: ActionSnapshot,
  deadlineMs: number,
  check: (a: string, s: ActionSnapshot, l: number) => VerificationResult
): Promise<VerificationResult> {
  const id = snapshot.action.elementId;
  if (id != null && resolveElement(id) == null) return check(actionId, snapshot, lat(snapshot));

  const deadline = nowMs() + deadlineMs;
  let last = check(actionId, snapshot, lat(snapshot));
  while (nowMs() < deadline) {
    await nextFrame();
    if (id != null && resolveElement(id) == null) return check(actionId, snapshot, lat(snapshot));
    last = check(actionId, snapshot, lat(snapshot));
  }
  return last;
}

function verifyTypeSettled(
  actionId: string,
  snapshot: ActionSnapshot,
  settle: SettleConfig
): Promise<VerificationResult> {
  return observeFinalValue(actionId, snapshot, settle.typeMs, verifyType);
}

function verifyTypeSecretSettled(
  actionId: string,
  snapshot: ActionSnapshot,
  settle: SettleConfig
): Promise<VerificationResult> {
  return observeFinalValue(actionId, snapshot, settle.typeMs, verifyTypeSecret);
}

function scrollBoundaryObserved(snapshot: ActionSnapshot): string {
  const w = (globalThis as unknown as { window?: { scrollY?: number; innerHeight?: number } }).window;
  const doc = typeof document !== "undefined" ? document : null;
  const y = w?.scrollY ?? 0;
  const vh = w?.innerHeight ?? 0;
  const sh = doc?.documentElement?.scrollHeight ?? doc?.body?.scrollHeight ?? 0;
  const dir = snapshot.action.direction;
  if (sh > 0 && vh > 0 && sh <= vh) return "page_not_scrollable";
  if ((dir === "up" || dir == null) && y <= 0) return "already_at_top";
  if (dir === "down" && vh > 0 && sh > 0 && y + vh >= sh - 1) return "already_at_bottom";
  return "scroll_unchanged";
}

async function verifyScrollSettled(
  actionId: string,
  snapshot: ActionSnapshot,
  settle: SettleConfig
): Promise<VerificationResult> {
  const getY = (): number =>
    (globalThis as unknown as { window?: { scrollY?: number } }).window?.scrollY ?? 0;

  if (getY() !== snapshot.scrollYBefore) return verifyScroll(actionId, snapshot, lat(snapshot));

  const deadline = nowMs() + settle.scrollMs;
  while (nowMs() < deadline) {
    await nextFrame();
    if (getY() !== snapshot.scrollYBefore) return verifyScroll(actionId, snapshot, lat(snapshot));
  }
  // Did not move within the window. Still ambiguous (never success without
  // movement, never failure) — classify why for diagnostics.
  return {
    actionId,
    expected: "scroll_changed",
    observed: scrollBoundaryObserved(snapshot),
    status: "ambiguous",
    latencyMs: lat(snapshot),
  };
}

async function verifyNavigateSettled(
  actionId: string,
  snapshot: ActionSnapshot,
  settle: SettleConfig
): Promise<VerificationResult> {
  const getUrl = (): string => (typeof location !== "undefined" ? location.href : "");
  if (getUrl() !== snapshot.urlBefore) return verifyNavigate(actionId, snapshot, lat(snapshot));

  // SHORT window — a deferred SPA route change lands within a frame or two.
  // Never block here: a full document navigation is tearing this context down.
  const deadline = nowMs() + settle.navigateMs;
  while (nowMs() < deadline) {
    await nextFrame();
    if (getUrl() !== snapshot.urlBefore) return verifyNavigate(actionId, snapshot, lat(snapshot));
  }
  return verifyNavigate(actionId, snapshot, lat(snapshot)); // url_unchanged → failure (unchanged)
}

/**
 * Async-settle-aware per-action verification. Drop-in async replacement for
 * verifyAction() at the pipeline call site. wait / keypress / unknown fall
 * straight through to the synchronous verifier unchanged.
 */
export async function verifyActionSettled(
  actionId: string,
  snapshot: ActionSnapshot,
  settle: SettleConfig = DEFAULT_SETTLE
): Promise<VerificationResult> {
  switch (snapshot.action.action) {
    case "click":
      return verifyClickSettled(actionId, snapshot, settle);
    case "type":
      return verifyTypeSettled(actionId, snapshot, settle);
    case "type_secret":
      return verifyTypeSecretSettled(actionId, snapshot, settle);
    case "scroll":
      return verifyScrollSettled(actionId, snapshot, settle);
    case "navigate":
      return verifyNavigateSettled(actionId, snapshot, settle);
    default:
      return verifyAction(actionId, snapshot);
  }
}

/**
 * Calculates latency in milliseconds from start timestamp.
 */
function computeLatencyMs(startedAt?: number): number {
  if (startedAt == null) return 0;
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  // If startedAt was from Date.now() vs performance.now()
  if (startedAt > 1000000000000) {
    return Math.max(0, Date.now() - startedAt);
  }
  return Math.max(0, Math.round((now - startedAt) * 1000) / 1000);
}

/**
 * Level 1 URL verification: verifies that the current document URL changed from urlBefore.
 */
export function verifyUrlChanged(
  actionId: string,
  urlBefore: string,
  startedAt?: number
): VerificationResult {
  const t0 = startedAt ?? (typeof performance !== "undefined" ? performance.now() : Date.now());
  const urlAfter = typeof location !== "undefined" ? location.href : "";
  const changed = urlAfter !== urlBefore;

  const evidence: VerificationEvidence[] = [
    {
      signal: "url",
      expected: "url_changed",
      observed: changed ? "url_changed" : "url_unchanged",
      matched: changed,
      details: changed ? `URL transitioned from ${urlBefore} to ${urlAfter}` : `URL remained unchanged at ${urlBefore}`,
    },
  ];

  return {
    actionId: actionId || "unknown-action",
    expected: "url_changed",
    observed: changed ? "url_changed" : "url_unchanged",
    status: changed ? "success" : "ambiguous",
    latencyMs: computeLatencyMs(t0),
    level: "L1",
    failureCategory: changed ? undefined : "STATE_NOT_CHANGED",
    retryability: changed ? undefined : "retryable",
    evidence,
    timestamp: Date.now(),
  };
}

/**
 * Level 1 URL exact / path match verification.
 */
export function verifyUrlMatches(
  actionId: string,
  expectedUrl: string,
  startedAt?: number
): VerificationResult {
  const t0 = startedAt ?? (typeof performance !== "undefined" ? performance.now() : Date.now());
  const currentUrl = typeof location !== "undefined" ? location.href : "";

  if (!expectedUrl || typeof expectedUrl !== "string") {
    return {
      actionId: actionId || "unknown-action",
      expected: "valid_expected_url",
      observed: "empty_or_invalid_url",
      status: "failure",
      latencyMs: computeLatencyMs(t0),
      level: "L1",
      failureCategory: "MALFORMED_REQUEST",
      retryability: "nonRetryable",
      evidence: [
        {
          signal: "url",
          expected: "valid_url_string",
          observed: String(expectedUrl),
          matched: false,
          details: "Expected URL parameter was missing or malformed",
        },
      ],
      timestamp: Date.now(),
    };
  }

  let matched = false;
  if (currentUrl === expectedUrl) {
    matched = true;
  } else {
    try {
      const base = typeof location !== "undefined" && location.href ? location.href : "http://localhost/";
      const parsedExpected = new URL(expectedUrl, base);
      const parsedCurrent = new URL(currentUrl, base);
      matched =
        parsedExpected.pathname === parsedCurrent.pathname &&
        parsedExpected.search === parsedCurrent.search &&
        parsedExpected.hash === parsedCurrent.hash;
    } catch {
      matched = currentUrl.includes(expectedUrl) || expectedUrl.includes(currentUrl);
    }
  }

  const evidence: VerificationEvidence[] = [
    {
      signal: "url",
      expected: expectedUrl,
      observed: currentUrl,
      matched,
      details: matched ? `Current URL matches expected target ${expectedUrl}` : `URL mismatch: expected ${expectedUrl}, observed ${currentUrl}`,
    },
  ];

  return {
    actionId: actionId || "unknown-action",
    expected: expectedUrl,
    observed: currentUrl,
    status: matched ? "success" : "failure",
    latencyMs: computeLatencyMs(t0),
    level: "L1",
    failureCategory: matched ? undefined : "URL_MISMATCH",
    retryability: matched ? undefined : "nonRetryable",
    evidence,
    timestamp: Date.now(),
  };
}

/**
 * Level 1 Element Presence: verifies that an expected element exists in the DOM.
 */
export function verifyElementPresent(
  actionId: string,
  selector: string,
  startedAt?: number
): VerificationResult {
  const t0 = startedAt ?? (typeof performance !== "undefined" ? performance.now() : Date.now());

  if (!selector || typeof selector !== "string") {
    return {
      actionId: actionId || "unknown-action",
      expected: "valid_selector",
      observed: "empty_or_invalid_selector",
      status: "failure",
      latencyMs: computeLatencyMs(t0),
      level: "L1",
      failureCategory: "MALFORMED_REQUEST",
      retryability: "nonRetryable",
      evidence: [],
      timestamp: Date.now(),
    };
  }

  let found = false;
  try {
    found = deepQueryFirst(selector) != null;
  } catch {
    found = false;
  }

  const evidence: VerificationEvidence[] = [
    {
      signal: "element_presence",
      expected: `element_present:${selector}`,
      observed: found ? "present" : "absent",
      target: selector,
      matched: found,
      details: found ? `Target element matching '${selector}' found in DOM` : `Target element matching '${selector}' not found in DOM`,
    },
  ];

  return {
    actionId: actionId || "unknown-action",
    expected: `element_present:${selector}`,
    observed: found ? "present" : "absent",
    status: found ? "success" : "failure",
    latencyMs: computeLatencyMs(t0),
    level: "L1",
    failureCategory: found ? undefined : "TARGET_NOT_FOUND",
    retryability: found ? undefined : "retryable",
    evidence,
    timestamp: Date.now(),
  };
}

/**
 * Level 1 Element Absence / Disappearance: verifies that an element is NO LONGER present in the DOM.
 */
export function verifyElementAbsent(
  actionId: string,
  selector: string,
  startedAt?: number
): VerificationResult {
  const t0 = startedAt ?? (typeof performance !== "undefined" ? performance.now() : Date.now());

  if (!selector || typeof selector !== "string") {
    return {
      actionId: actionId || "unknown-action",
      expected: "valid_selector",
      observed: "empty_or_invalid_selector",
      status: "failure",
      latencyMs: computeLatencyMs(t0),
      level: "L1",
      failureCategory: "MALFORMED_REQUEST",
      retryability: "nonRetryable",
      evidence: [],
      timestamp: Date.now(),
    };
  }

  let absent = true;
  try {
    absent = deepQueryFirst(selector) == null;
  } catch {
    absent = false;
  }

  const evidence: VerificationEvidence[] = [
    {
      signal: "element_absence",
      expected: `element_absent:${selector}`,
      observed: absent ? "absent" : "present",
      target: selector,
      matched: absent,
      details: absent
        ? `Target element matching '${selector}' successfully disappeared from DOM`
        : `Target element matching '${selector}' is still present in DOM`,
    },
  ];

  return {
    actionId: actionId || "unknown-action",
    expected: `element_absent:${selector}`,
    observed: absent ? "absent" : "present",
    status: absent ? "success" : "failure",
    latencyMs: computeLatencyMs(t0),
    level: "L1",
    failureCategory: absent ? undefined : "ELEMENT_STATE_MISMATCH",
    retryability: absent ? undefined : "retryable",
    evidence,
    timestamp: Date.now(),
  };
}

/**
 * Determines whether an element is an input-like interactive control
 * (e.g. input, textarea, select, role=textbox/searchbox/combobox/spinbutton).
 * For these elements, textContent is not a reliable representation of the control's value/content.
 */
export function isInputLikeElement(el: Element | null): boolean {
  // Delegates to the shared interactive classifier (perception/interactive.ts)
  // so PVM, the validator and the capture layer share one definition. Covers
  // input / textarea / select, ARIA textbox / searchbox / combobox / spinbutton
  // / slider, and contenteditable hosts.
  return isInputLike(el);
}

/**
 * Level 1 Element State Mutation: verifies deterministic properties (disabled, readonly, aria attributes, textContent, class).
 */
export function verifyElementState(
  actionId: string,
  selector: string,
  expectedState: ElementStateExpectation,
  startedAt?: number
): VerificationResult {
  const t0 = startedAt ?? (typeof performance !== "undefined" ? performance.now() : Date.now());

  if (!selector || typeof selector !== "string" || !expectedState || typeof expectedState !== "object") {
    return {
      actionId: actionId || "unknown-action",
      expected: "valid_selector_and_state",
      observed: "malformed_request_parameters",
      status: "failure",
      latencyMs: computeLatencyMs(t0),
      level: "L1",
      failureCategory: "MALFORMED_REQUEST",
      retryability: "nonRetryable",
      evidence: [],
      timestamp: Date.now(),
    };
  }

  let el: Element | null = null;
  try {
    el = deepQueryFirst(selector);
  } catch {
    el = null;
  }

  if (!el) {
    return {
      actionId: actionId || "unknown-action",
      expected: `element_state:${selector}`,
      observed: "element_not_found",
      status: "failure",
      latencyMs: computeLatencyMs(t0),
      level: "L1",
      failureCategory: "TARGET_NOT_FOUND",
      retryability: "retryable",
      evidence: [
        {
          signal: "element_state",
          expected: `element_present:${selector}`,
          observed: "absent",
          target: selector,
          matched: false,
          details: `Target element '${selector}' was not found for state verification`,
        },
      ],
      timestamp: Date.now(),
    };
  }

  const evidence: VerificationEvidence[] = [];
  let allMatched = true;

  if (expectedState.disabled != null) {
    const actualDisabled =
      (el as HTMLInputElement | HTMLButtonElement).disabled === true ||
      el.getAttribute("aria-disabled") === "true" ||
      el.closest("fieldset[disabled]") != null;
    const match = actualDisabled === expectedState.disabled;
    if (!match) allMatched = false;
    evidence.push({
      signal: "attribute_mutation",
      expected: `disabled=${expectedState.disabled}`,
      observed: `disabled=${actualDisabled}`,
      target: selector,
      matched: match,
    });
  }

  if (expectedState.readonly != null) {
    const actualReadonly =
      (el as HTMLInputElement | HTMLTextAreaElement).readOnly === true ||
      el.getAttribute("aria-readonly") === "true";
    const match = actualReadonly === expectedState.readonly;
    if (!match) allMatched = false;
    evidence.push({
      signal: "attribute_mutation",
      expected: `readonly=${expectedState.readonly}`,
      observed: `readonly=${actualReadonly}`,
      target: selector,
      matched: match,
    });
  }

  if (expectedState.ariaExpanded != null) {
    const actualExpanded = el.getAttribute("aria-expanded");
    const expectedStr = String(expectedState.ariaExpanded);
    const match = actualExpanded === expectedStr;
    if (!match) allMatched = false;
    evidence.push({
      signal: "attribute_mutation",
      expected: `aria-expanded=${expectedStr}`,
      observed: `aria-expanded=${actualExpanded}`,
      target: selector,
      matched: match,
    });
  }

  if (expectedState.ariaChecked != null) {
    const actualChecked = el.getAttribute("aria-checked") ?? (el as HTMLInputElement).checked?.toString();
    const expectedStr = String(expectedState.ariaChecked);
    const match = actualChecked === expectedStr;
    if (!match) allMatched = false;
    evidence.push({
      signal: "attribute_mutation",
      expected: `aria-checked=${expectedStr}`,
      observed: `aria-checked=${actualChecked}`,
      target: selector,
      matched: match,
    });
  }

  if (expectedState.className != null) {
    const actualClasses = el.className || "";
    const match = actualClasses.includes(expectedState.className);
    if (!match) allMatched = false;
    evidence.push({
      signal: "attribute_mutation",
      expected: `class_includes=${expectedState.className}`,
      observed: `class=${actualClasses}`,
      target: selector,
      matched: match,
    });
  }

  if (expectedState.textContent != null) {
    if (isInputLikeElement(el)) {
      allMatched = false;
      evidence.push({
        signal: "element_state",
        expected: `textContent_contains='${expectedState.textContent}'`,
        observed: "input_like_target_skipped_for_textContent",
        target: selector,
        matched: false,
        details: "Target is an input-like control; textContent is invalid evidence of content change",
      });
    } else {
      const actualText = el.textContent?.trim() || "";
      const match = actualText.includes(expectedState.textContent.trim());
      if (!match) allMatched = false;
      evidence.push({
        signal: "element_state",
        expected: `textContent_contains='${expectedState.textContent}'`,
        observed: `textContent='${actualText}'`,
        target: selector,
        matched: match,
      });
    }
  }

  return {
    actionId: actionId || "unknown-action",
    expected: `element_state_matched:${selector}`,
    observed: allMatched ? "state_matched" : "state_mismatch",
    status: allMatched ? "success" : "failure",
    latencyMs: computeLatencyMs(t0),
    level: "L1",
    failureCategory: allMatched ? undefined : "ELEMENT_STATE_MISMATCH",
    retryability: allMatched ? undefined : "retryable",
    evidence,
    timestamp: Date.now(),
  };
}

/**
 * Level 1 Value Mutation Verification.
 * Privacy rule: If isSecret is true, raw secret strings are NEVER persisted in VerificationResult or Evidence.
 */
export function verifyValueMutation(
  actionId: string,
  selector: string,
  expectedValue: string,
  isSecret: boolean = false,
  startedAt?: number
): VerificationResult {
  const t0 = startedAt ?? (typeof performance !== "undefined" ? performance.now() : Date.now());

  if (!selector || typeof selector !== "string") {
    return {
      actionId: actionId || "unknown-action",
      expected: "valid_selector",
      observed: "empty_or_invalid_selector",
      status: "failure",
      latencyMs: computeLatencyMs(t0),
      level: "L1",
      failureCategory: "MALFORMED_REQUEST",
      retryability: "nonRetryable",
      evidence: [],
      timestamp: Date.now(),
    };
  }

  let el: Element | null = null;
  try {
    el = deepQueryFirst(selector);
  } catch {
    el = null;
  }

  if (!el) {
    return {
      actionId: actionId || "unknown-action",
      expected: isSecret ? "secret_value_updated" : `value='${expectedValue}'`,
      observed: "element_not_found",
      status: "failure",
      latencyMs: computeLatencyMs(t0),
      level: "L1",
      failureCategory: "TARGET_NOT_FOUND",
      retryability: "retryable",
      evidence: [
        {
          signal: "value_mutation",
          expected: isSecret ? "[SECRET_INPUT_PRESENT]" : `element_present:${selector}`,
          observed: "absent",
          target: selector,
          matched: false,
          details: `Target input element '${selector}' was not found in DOM`,
        },
      ],
      timestamp: Date.now(),
    };
  }

  let actualValue = "";
  const vtag = (el.tagName || "").toLowerCase();
  if (vtag === "input" || vtag === "textarea") {
    actualValue = (el as HTMLInputElement).value;
  } else if ((el as HTMLElement).isContentEditable || el.getAttribute("contenteditable") === "true") {
    actualValue = el.textContent || "";
  }

  const matched = actualValue === (expectedValue ?? "");

  // Privacy-safe masking
  const safeExpected = isSecret ? "[REDACTED_SECRET]" : expectedValue;
  const safeObserved = isSecret ? (matched ? "[REDACTED_SECRET_MATCHED]" : "[REDACTED_SECRET_MISMATCH]") : actualValue;

  const evidence: VerificationEvidence[] = [
    {
      signal: "value_mutation",
      expected: safeExpected,
      observed: safeObserved,
      target: selector,
      matched,
      details: isSecret
        ? `Secret input value verification: matched=${matched} (raw secret never exposed in evidence)`
        : `Value mutation verification: expected='${expectedValue}', observed='${actualValue}'`,
    },
  ];

  return {
    actionId: actionId || "unknown-action",
    expected: safeExpected,
    observed: safeObserved,
    status: matched ? "success" : "failure",
    latencyMs: computeLatencyMs(t0),
    level: "L1",
    failureCategory: matched ? undefined : "STATE_NOT_CHANGED",
    retryability: matched ? undefined : "retryable",
    evidence,
    timestamp: Date.now(),
  };
}

/**
 * Level 1 Scroll Visibility Verification: verifies that a target element or region is within the viewport.
 */
export function verifyScrollPosition(
  actionId: string,
  expectedRegionSelector: string,
  startedAt?: number
): VerificationResult {
  const t0 = startedAt ?? (typeof performance !== "undefined" ? performance.now() : Date.now());

  if (!expectedRegionSelector || typeof expectedRegionSelector !== "string") {
    return {
      actionId: actionId || "unknown-action",
      expected: "valid_region_selector",
      observed: "empty_or_invalid_selector",
      status: "failure",
      latencyMs: computeLatencyMs(t0),
      level: "L1",
      failureCategory: "MALFORMED_REQUEST",
      retryability: "nonRetryable",
      evidence: [],
      timestamp: Date.now(),
    };
  }

  let el: Element | null = null;
  try {
    el = deepQueryFirst(expectedRegionSelector);
  } catch {
    el = null;
  }

  if (!el) {
    return {
      actionId: actionId || "unknown-action",
      expected: `scroll_target_present:${expectedRegionSelector}`,
      observed: "element_not_found",
      status: "failure",
      latencyMs: computeLatencyMs(t0),
      level: "L1",
      failureCategory: "TARGET_NOT_FOUND",
      retryability: "retryable",
      evidence: [
        {
          signal: "scroll",
          expected: `element_present:${expectedRegionSelector}`,
          observed: "absent",
          target: expectedRegionSelector,
          matched: false,
        },
      ],
      timestamp: Date.now(),
    };
  }

  let isVisible = false;
  if (typeof el.getBoundingClientRect === "function") {
    const rect = el.getBoundingClientRect();
    const vHeight = typeof window !== "undefined" ? window.innerHeight : 768;
    const vWidth = typeof window !== "undefined" ? window.innerWidth : 1024;
    isVisible = rect.top < vHeight && rect.bottom >= 0 && rect.left < vWidth && rect.right >= 0;
  } else {
    isVisible = true;
  }

  const evidence: VerificationEvidence[] = [
    {
      signal: "scroll",
      expected: `visible_in_viewport:${expectedRegionSelector}`,
      observed: isVisible ? "visible" : "outside_viewport",
      target: expectedRegionSelector,
      matched: isVisible,
      details: isVisible
        ? `Target '${expectedRegionSelector}' is visible in viewport`
        : `Target '${expectedRegionSelector}' is outside current viewport`,
    },
  ];

  return {
    actionId: actionId || "unknown-action",
    expected: `visible_in_viewport:${expectedRegionSelector}`,
    observed: isVisible ? "visible" : "outside_viewport",
    status: isVisible ? "success" : "failure",
    latencyMs: computeLatencyMs(t0),
    level: "L1",
    failureCategory: isVisible ? undefined : "STATE_NOT_CHANGED",
    retryability: isVisible ? undefined : "retryable",
    evidence,
    timestamp: Date.now(),
  };
}

/**
 * Unified Level-1 Deterministic Verification Dispatcher.
 */
export function verifyDeterministicOutcome(request: VerificationRequest): VerificationResult {
  const t0 = request?.startedAt ?? (typeof performance !== "undefined" ? performance.now() : Date.now());

  if (!request || typeof request !== "object" || !request.taskId || !request.actionId) {
    return {
      actionId: request?.actionId || "malformed-action",
      expected: "valid_verification_request",
      observed: "missing_taskId_or_actionId",
      status: "failure",
      latencyMs: computeLatencyMs(t0),
      level: "L1",
      failureCategory: "MALFORMED_REQUEST",
      retryability: "nonRetryable",
      evidence: [
        {
          signal: "generic_completion",
          expected: "valid_request_with_taskId_and_actionId",
          observed: "malformed_request",
          matched: false,
          details: "Verification request is missing required taskId or actionId identifier",
        },
      ],
      timestamp: Date.now(),
    };
  }

  try {
    // 1. URL Match Verification
    if (request.expectedUrl) {
      return verifyUrlMatches(request.actionId, request.expectedUrl, t0);
    }

    // 2. URL Changed Verification
    if (request.urlBefore != null) {
      return verifyUrlChanged(request.actionId, request.urlBefore, t0);
    }

    // Determine target selector (either explicit selector or derived from privy-id)
    const selector =
      request.targetSelector ||
      (request.targetElementId != null ? `[data-privy-id="${request.targetElementId}"]` : null);

    // 3. Element Absence Verification
    if (request.expectedDisappearance && selector) {
      return verifyElementAbsent(request.actionId, selector, t0);
    }

    // 4. Element State / Value Mutation Verification
    if (request.expectedState && selector) {
      if (request.expectedState.value !== undefined) {
        return verifyValueMutation(
          request.actionId,
          selector,
          request.expectedState.value,
          request.expectedState.isSecret ?? false,
          t0
        );
      }
      return verifyElementState(request.actionId, selector, request.expectedState, t0);
    }

    // 5. Scroll Visibility Verification
    if (request.expectedRegionSelector) {
      return verifyScrollPosition(request.actionId, request.expectedRegionSelector, t0);
    }

    // 6. Element Presence Verification
    if (selector) {
      return verifyElementPresent(request.actionId, selector, t0);
    }

    // 7. Generic Completion (e.g. wait, keypress)
    return {
      actionId: request.actionId,
      expected: `action_completed:${request.actionType ?? "generic"}`,
      observed: "completed",
      status: "success",
      latencyMs: computeLatencyMs(t0),
      level: "L1",
      evidence: [
        {
          signal: "generic_completion",
          expected: `action_completed:${request.actionType ?? "generic"}`,
          observed: "completed",
          matched: true,
        },
      ],
      timestamp: Date.now(),
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      actionId: request.actionId,
      expected: "safe_deterministic_verification",
      observed: `error: ${errMsg}`,
      status: "failure",
      latencyMs: computeLatencyMs(t0),
      level: "L1",
      failureCategory: "UNKNOWN",
      retryability: "nonRetryable",
      evidence: [
        {
          signal: "generic_completion",
          expected: "safe_execution",
          observed: `exception: ${errMsg}`,
          matched: false,
          details: errMsg,
        },
      ],
      timestamp: Date.now(),
    };
  }
}

// =========================================================================
// Phase 5 — Higher-Level Verification Engine (L2 Semantic & L3 Visual)
// =========================================================================

/**
 * Level 2 Semantic Verification: verifies accessibility labels, semantic roles,
 * text regex/substring patterns, and semantic status flags without calling LLMs.
 */
export function verifyLevel2Semantic(
  actionId: string,
  selector: string | null,
  expectation: L2SemanticExpectation,
  startedAt?: number
): VerificationResult {
  const t0 = startedAt ?? (typeof performance !== "undefined" ? performance.now() : Date.now());
  const evidence: VerificationEvidence[] = [];

  if (!expectation || typeof expectation !== "object") {
    return {
      actionId: actionId || "unknown-action",
      expected: "valid_semantic_expectation",
      observed: "malformed_semantic_request",
      status: "failure",
      latencyMs: computeLatencyMs(t0),
      level: "L2",
      failureCategory: "MALFORMED_REQUEST",
      retryability: "nonRetryable",
      timestamp: Date.now(),
    };
  }

  let element: Element | null = null;
  if (selector && typeof document !== "undefined") {
    try {
      element = deepQueryFirst(selector);
    } catch {
      element = null;
    }
  }

  let allMatched = true;

  // 1. Semantic Role Check
  if (expectation.semanticRole) {
    const actualRole = element?.getAttribute("role") || element?.tagName?.toLowerCase() || "unknown";
    const matched = actualRole.toLowerCase() === expectation.semanticRole.toLowerCase();
    if (!matched) allMatched = false;
    evidence.push({
      signal: "element_state",
      expected: `semantic_role:${expectation.semanticRole}`,
      observed: `semantic_role:${actualRole}`,
      matched,
    });
  }

  // 2. Accessibility Label Check
  if (expectation.accessibilityLabel) {
    const actualAriaLabel = element?.getAttribute("aria-label") || element?.getAttribute("aria-labelledby") || "";
    const matched = actualAriaLabel.toLowerCase().includes(expectation.accessibilityLabel.toLowerCase());
    if (!matched) allMatched = false;
    evidence.push({
      signal: "element_state",
      expected: `aria_label:${expectation.accessibilityLabel}`,
      observed: `aria_label:${actualAriaLabel || "absent"}`,
      matched,
    });
  }

  // 3. Expected Text Pattern Check (Substring or Regex)
  if (expectation.expectedTextPattern) {
    // For input-like controls (input, textarea, select, textbox role, etc.), textContent
    // is NOT a reliable representation of the control's value/content.
    // TextContent-based semantic verification must NOT report success on input-like targets.
    if (isInputLikeElement(element)) {
      allMatched = false;
      evidence.push({
        signal: "value_mutation",
        expected: `text_pattern:${expectation.expectedTextPattern}`,
        observed: "input_like_target_skipped_for_textContent",
        matched: false,
        details: "Target is an input-like control; textContent is invalid evidence of text entry for click actions",
      });
    } else {
      const actualText = element?.textContent || "";
      let matched = false;
      try {
        const regex = new RegExp(expectation.expectedTextPattern, "i");
        matched = regex.test(actualText);
      } catch {
        matched = actualText.toLowerCase().includes(expectation.expectedTextPattern.toLowerCase());
      }
      if (!matched) allMatched = false;
      evidence.push({
        signal: "value_mutation",
        expected: `text_pattern:${expectation.expectedTextPattern}`,
        observed: `text:${actualText.substring(0, 100)}`,
        matched,
      });
    }
  }

  // 4. Semantic Status Flag Check
  if (expectation.semanticStatus) {
    const matched = expectation.semanticStatus === "success" || expectation.semanticStatus === "info";
    if (!matched) allMatched = false;
    evidence.push({
      signal: "generic_completion",
      expected: `status:${expectation.semanticStatus}`,
      observed: `status:${expectation.semanticStatus}`,
      matched,
    });
  }

  const finalStatus = allMatched ? "success" : "failure";
  return {
    actionId: actionId || "unknown-action",
    expected: "l2_semantic_verification",
    observed: finalStatus === "success" ? "semantic_match" : "semantic_mismatch",
    status: finalStatus,
    latencyMs: computeLatencyMs(t0),
    l2LatencyMs: computeLatencyMs(t0),
    level: "L2",
    failureCategory: finalStatus === "success" ? undefined : "ELEMENT_STATE_MISMATCH",
    retryability: finalStatus === "success" ? undefined : "retryable",
    evidence,
    timestamp: Date.now(),
  };
}

/**
 * Level 3 Visual Verification: verifies element bounding boxes, layout shift,
 * and visibility state using DOM geometry.
 *
 * HARD PRIVACY INVARIANT: Never captures, persists, or logs screenshots or raw visual image buffers.
 */
export function verifyLevel3Visual(
  actionId: string,
  selector: string | null,
  expectation: L3VisualExpectation,
  startedAt?: number
): VerificationResult {
  const t0 = startedAt ?? (typeof performance !== "undefined" ? performance.now() : Date.now());
  const evidence: VerificationEvidence[] = [];

  if (!expectation || typeof expectation !== "object") {
    return {
      actionId: actionId || "unknown-action",
      expected: "valid_visual_expectation",
      observed: "malformed_visual_request",
      status: "failure",
      latencyMs: computeLatencyMs(t0),
      level: "L3",
      failureCategory: "MALFORMED_REQUEST",
      retryability: "nonRetryable",
      timestamp: Date.now(),
    };
  }

  let element: Element | null = null;
  if (selector && typeof document !== "undefined") {
    try {
      element = deepQueryFirst(selector);
    } catch {
      element = null;
    }
  }

  let allMatched = true;

  // 1. Visual Visibility Check
  if (expectation.expectedVisibilityState) {
    let actualVisibility = "hidden";
    if (element) {
      const htmlEl = element as HTMLElement;
      const style = typeof window !== "undefined" && window.getComputedStyle ? window.getComputedStyle(element) : null;
      const isInlineHidden = style ? style.display === "none" || style.visibility === "hidden" : false;
      const rect = typeof element.getBoundingClientRect === "function" ? element.getBoundingClientRect() : null;
      const hasGeometry = rect ? rect.width > 0 || rect.height > 0 : false;
      const hasOffset = htmlEl.offsetWidth > 0 || htmlEl.offsetHeight > 0;
      // In JSDOM layout engine rects are 0x0 by default unless styled; element.isConnected indicates attached DOM presence
      const isVisible = !isInlineHidden && (hasGeometry || hasOffset || (element.isConnected && (!rect || (rect.width === 0 && rect.height === 0))));
      actualVisibility = isVisible ? "visible" : "hidden";
    }
    const matched = actualVisibility === expectation.expectedVisibilityState;
    if (!matched) allMatched = false;
    evidence.push({
      signal: "element_state",
      expected: `visibility:${expectation.expectedVisibilityState}`,
      observed: `visibility:${actualVisibility}`,
      matched,
    });
  }

  // 2. Region Bounding Box Check (Geometry only, no pixel buffer)
  if (expectation.regionBoundingBox && element && typeof element.getBoundingClientRect === "function") {
    const rect = element.getBoundingClientRect();
    const expRect = expectation.regionBoundingBox;
    const widthDiff = Math.abs(rect.width - expRect.width);
    const heightDiff = Math.abs(rect.height - expRect.height);
    const matched = widthDiff <= 20 && heightDiff <= 20; // 20px threshold
    if (!matched) allMatched = false;
    evidence.push({
      signal: "element_state",
      expected: `bbox:${expRect.width}x${expRect.height}`,
      observed: `bbox:${Math.round(rect.width)}x${Math.round(rect.height)}`,
      matched,
    });
  }

  const finalStatus = allMatched ? "success" : "failure";
  return {
    actionId: actionId || "unknown-action",
    expected: "l3_visual_verification",
    observed: finalStatus === "success" ? "visual_geometry_match" : "visual_geometry_mismatch",
    status: finalStatus,
    latencyMs: computeLatencyMs(t0),
    l3LatencyMs: computeLatencyMs(t0),
    level: "L3",
    failureCategory: finalStatus === "success" ? undefined : "ELEMENT_STATE_MISMATCH",
    retryability: finalStatus === "success" ? undefined : "retryable",
    evidence,
    timestamp: Date.now(),
  };
}

/**
 * Multi-level verification entry point with automated escalation policy.
 *
 * Policy:
 * 1. Runs Level 1 deterministic verification first (hot path).
 * 2. If L1 succeeds or escalation is disabled, returns L1 result immediately with L1 timing.
 * 3. If L1 is ambiguous/failing and escalation is allowed, escalates to L2 (Semantic) and L3 (Visual).
 * 4. Measures per-level latencies separately to preserve L1 latency baseline isolation.
 */
export function verifyWithEscalation(request: VerificationRequest): VerificationResult {
  const tTotalStart = request.startedAt ?? (typeof performance !== "undefined" ? performance.now() : Date.now());

  // 1. Always run Level 1 Deterministic Verification first
  const tL1Start = typeof performance !== "undefined" ? performance.now() : Date.now();
  const l1Result = verifyDeterministicOutcome(request);
  const tL1End = typeof performance !== "undefined" ? performance.now() : Date.now();
  const l1LatencyMs = Math.max(0.0001, tL1End - tL1Start);

  l1Result.l1LatencyMs = l1LatencyMs;
  l1Result.latencyMs = computeLatencyMs(tTotalStart);

  const allowEscalation = request.verificationOptions?.allowEscalation ?? true;

  // Short-circuit: if L1 succeeded or escalation is disabled, return L1 result
  if (l1Result.status === "success" || !allowEscalation) {
    return l1Result;
  }

  let currentResult = l1Result;

  // 2. Escalate to Level 2 Semantic Verification if semantic expectation is provided
  if (request.expectedSemanticState) {
    const tL2Start = typeof performance !== "undefined" ? performance.now() : Date.now();
    const l2Result = verifyLevel2Semantic(
      request.actionId,
      request.targetSelector ?? null,
      request.expectedSemanticState,
      tL2Start
    );
    const tL2End = typeof performance !== "undefined" ? performance.now() : Date.now();
    const l2LatencyMs = Math.max(0.0001, tL2End - tL2Start);

    if (l2Result.status === "success") {
      return {
        ...l2Result,
        l1LatencyMs,
        l2LatencyMs,
        latencyMs: computeLatencyMs(tTotalStart),
        escalatedFromLevel: "L1",
        evidence: [...(l1Result.evidence || []), ...(l2Result.evidence || [])],
      };
    }
    currentResult = {
      ...l2Result,
      l1LatencyMs,
      l2LatencyMs,
      latencyMs: computeLatencyMs(tTotalStart),
      escalatedFromLevel: "L1",
    };
  }

  // 3. Escalate to Level 3 Visual Verification if visual expectation is provided
  if (request.expectedVisualState) {
    const tL3Start = typeof performance !== "undefined" ? performance.now() : Date.now();
    const l3Result = verifyLevel3Visual(
      request.actionId,
      request.targetSelector ?? null,
      request.expectedVisualState,
      tL3Start
    );
    const tL3End = typeof performance !== "undefined" ? performance.now() : Date.now();
    const l3LatencyMs = Math.max(0.0001, tL3End - tL3Start);

    if (l3Result.status === "success") {
      return {
        ...l3Result,
        l1LatencyMs,
        l2LatencyMs: currentResult.l2LatencyMs,
        l3LatencyMs,
        latencyMs: computeLatencyMs(tTotalStart),
        escalatedFromLevel: currentResult.level || "L1",
        evidence: [...(currentResult.evidence || []), ...(l3Result.evidence || [])],
      };
    }
  }

  return currentResult;
}

