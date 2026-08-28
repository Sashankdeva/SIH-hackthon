import type {
  VerificationResult,
  VerificationRequest,
  VerificationEvidence,
  ElementStateExpectation,
} from "./types";

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
