import { resolveElement } from "../perception/domCapture";
import type { ActionRequest } from "../action/types";
import type { VerificationResult } from "./types";

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
  // Signal 1: URL changed (e.g. link click, form submit with redirect)
  const urlAfter = location.href;
  if (urlAfter !== snapshot.urlBefore) {
    return { actionId, expected: "click_effect", observed: "url_changed", status: "success", latencyMs };
  }

  // Signal 2: the clicked element is no longer in the DOM
  // (e.g. modal close, list-item delete, SPA re-render)
  if (snapshot.action.elementId != null) {
    const stillPresent = resolveElement(snapshot.action.elementId) != null;
    if (!stillPresent) {
      return { actionId, expected: "click_effect", observed: "element_removed", status: "success", latencyMs };
    }
  }

  // No observable change — could still have succeeded (analytics, state toggle)
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
  if (el.value === expected) {
    return { actionId, expected: "value_matches", observed: "value_matches", status: "success", latencyMs };
  }

  return { actionId, expected: "value_matches", observed: "value_mismatch", status: "failure", latencyMs };
}

/**
 * Verifies that the target element's value changed without ever
 * logging, comparing, or including the actual secret value.
 * The observed field reports only "value_changed" or "value_unchanged".
 */
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
  const urlAfter = location.href;
  const changed = urlAfter !== snapshot.urlBefore;
  return {
    actionId,
    expected: "url_changed",
    observed: changed ? "url_changed" : "url_unchanged",
    status: changed ? "success" : "failure",
    latencyMs,
  };
}

// --- Legacy helpers kept for backwards compatibility ---

/**
 * @deprecated Use verifyAction instead. Kept for any external callers.
 */
export function verifyUrlChanged(actionId: string, urlBefore: string, startedAt: number): VerificationResult {
  const urlAfter = location.href;
  const changed = urlAfter !== urlBefore;
  return {
    actionId,
    expected: "url_changed",
    observed: changed ? "url_changed" : "url_unchanged",
    status: changed ? "success" : "ambiguous",
    latencyMs: Date.now() - startedAt,
  };
}

export function verifyElementPresent(actionId: string, selector: string, startedAt: number): VerificationResult {
  const found = document.querySelector(selector) != null;
  return {
    actionId,
    expected: `element_present:${selector}`,
    observed: found ? "present" : "absent",
    status: found ? "success" : "failure",
    latencyMs: Date.now() - startedAt,
  };
}
