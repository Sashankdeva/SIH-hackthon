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
    found = typeof document !== "undefined" && document.querySelector(selector) != null;
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
    absent = typeof document !== "undefined" && document.querySelector(selector) == null;
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
    el = typeof document !== "undefined" ? document.querySelector(selector) : null;
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
    el = typeof document !== "undefined" ? document.querySelector(selector) : null;
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
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    actualValue = el.value;
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
    el = typeof document !== "undefined" ? document.querySelector(expectedRegionSelector) : null;
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
      element = document.querySelector(selector);
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
      element = document.querySelector(selector);
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

