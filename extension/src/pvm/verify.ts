import type { VerificationResult } from "./types";

/**
 * Level 1 only for this sprint: deterministic URL/DOM checks. Level 2
 * (semantic success/error text) and Level 3 (visual comparison) are
 * deferred past Sept 1 — see docs/ARCHITECTURE.md and
 * PS26171_Role5_Pvm.pdf, Day 2.
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
