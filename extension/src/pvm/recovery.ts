import type {
  VerificationResult,
  RecoveryDecision,
  FailureCategory,
  Retryability,
  SuggestedRecoveryAction,
  PvmRecoveryContext,
  PvmPredictionCandidate,
} from "./types";
import { findCandidatesInMemory, computeStateSignature } from "./memory";

export { type RecoveryDecision, type PvmRecoveryContext, type SuggestedRecoveryAction };

export const MAX_RECOVERY_ATTEMPTS = 2;

/**
 * Classifies the deterministic failure category from verification evidence and results.
 */
export function classifyFailure(result: VerificationResult): FailureCategory {
  if (!result || typeof result !== "object") {
    return "MALFORMED_REQUEST";
  }
  if (result.failureCategory) {
    return result.failureCategory;
  }

  const exp = (result.expected || "").toLowerCase();
  const obs = (result.observed || "").toLowerCase();

  if (obs.includes("target_not_found") || obs.includes("absent") || exp.includes("element_present")) {
    return "TARGET_NOT_FOUND";
  }
  if (exp.includes("element_absent") || obs.includes("element_state_mismatch")) {
    return "ELEMENT_STATE_MISMATCH";
  }
  if (exp === "url_changed" || obs === "url_unchanged" || obs === "same_url" || obs.includes("state_not_changed") || obs === "unchanged") {
    return "STATE_NOT_CHANGED";
  }
  if (exp.startsWith("http") || obs.startsWith("http") || exp.includes("valid_expected_url") || exp.includes("url_matches")) {
    return "URL_MISMATCH";
  }
  if (obs.includes("timeout") || exp.includes("timeout")) {
    return "TIMEOUT";
  }
  if (obs.includes("interrupted") || obs.includes("channel_lost")) {
    return "EXECUTION_INTERRUPTED";
  }
  if (obs.includes("tab_unavailable")) {
    return "TAB_UNAVAILABLE";
  }
  if (obs.includes("malformed") || exp.includes("malformed") || exp.includes("valid_")) {
    return "MALFORMED_REQUEST";
  }
  return "UNKNOWN";
}

/**
 * Determines whether a failure category is safe to retry within attempt budget.
 */
export function isFailureRetryable(
  category: FailureCategory,
  attemptsSoFar: number = 0,
  maxAttempts: number = MAX_RECOVERY_ATTEMPTS
): Retryability {
  if (attemptsSoFar >= maxAttempts) {
    return "nonRetryable";
  }

  switch (category) {
    case "TARGET_NOT_FOUND":
    case "STATE_NOT_CHANGED":
    case "ELEMENT_STATE_MISMATCH":
    case "STALE_STATE":
      return "retryable";
    case "URL_MISMATCH":
    case "TAB_UNAVAILABLE":
    case "MALFORMED_REQUEST":
      return "nonRetryable";
    case "TIMEOUT":
    case "EXECUTION_INTERRUPTED":
      return "retryable";
    case "UNKNOWN":
    default:
      return "inconclusive";
  }
}

/**
 * Recovery decision engine — governs whether an action should retry, use alternative candidate, or escalate.
 *
 * Invariants:
 * - Role 5 ONLY returns structured recommendations; it NEVER executes browser actions or retries itself.
 * - Sub-millisecond execution latency.
 * - Bounded retry limits prevent infinite execution loops.
 */
export function decideRecovery(
  result: VerificationResult,
  attemptsOrContext: number | PvmRecoveryContext,
  maxAttemptsOverride?: number
): RecoveryDecision {
  const startTime = typeof performance !== "undefined" ? performance.now() : Date.now();
  const getLatency = () =>
    Math.max(0.0001, (typeof performance !== "undefined" ? performance.now() : Date.now()) - startTime);

  const context: PvmRecoveryContext =
    typeof attemptsOrContext === "number"
      ? { attemptsSoFar: attemptsOrContext, maxAttempts: maxAttemptsOverride ?? MAX_RECOVERY_ATTEMPTS }
      : attemptsOrContext;

  const attemptsSoFar = context.attemptsSoFar ?? 0;
  const maxAttempts = context.maxAttempts ?? maxAttemptsOverride ?? MAX_RECOVERY_ATTEMPTS;

  if (!result || typeof result !== "object") {
    return {
      shouldRetry: false,
      reason: "malformed verification result",
      failureCategory: "MALFORMED_REQUEST",
      retryability: "nonRetryable",
      suggestedAction: "ABORT",
      recoveryLatencyMs: getLatency(),
    };
  }

  if (result.status === "success") {
    return {
      shouldRetry: false,
      reason: "verified success",
      retryability: "nonRetryable",
      recoveryLatencyMs: getLatency(),
    };
  }

  if (attemptsSoFar >= maxAttempts) {
    return {
      shouldRetry: false,
      reason: `stopped after ${attemptsSoFar} attempts — escalate rather than loop`,
      failureCategory: result.failureCategory ?? classifyFailure(result),
      retryability: "nonRetryable",
      suggestedAction: "ABORT",
      recoveryLatencyMs: getLatency(),
    };
  }

  const category = result.failureCategory ?? classifyFailure(result);
  const retryable = isFailureRetryable(category, attemptsSoFar, maxAttempts);

  if (retryable === "nonRetryable") {
    return {
      shouldRetry: false,
      reason: `non-retryable failure (${category}) — abort`,
      failureCategory: category,
      retryability: "nonRetryable",
      suggestedAction: "ABORT",
      recoveryLatencyMs: getLatency(),
    };
  }

  // Check if PVM memory has alternative candidate actions for this state
  let candidates: PvmPredictionCandidate[] = context.pvmCandidates || [];
  if (candidates.length === 0 && (context.stateSignature || context.stateInput)) {
    const stateSig = context.stateSignature || (context.stateInput ? computeStateSignature(context.stateInput) : "");
    if (stateSig) {
      candidates = findCandidatesInMemory(stateSig);
    }
  }

  // Filter candidates matching task/session scope if specified
  const validCandidates = candidates.filter((c) => {
    if (context.taskScope && c.taskScope && c.taskScope !== context.taskScope) return false;
    if (context.sessionScope && c.sessionScope && c.sessionScope !== context.sessionScope) return false;
    return c.confidence >= 0.8;
  });

  if (validCandidates.length > 0) {
    const altCandidate = validCandidates[0];
    return {
      shouldRetry: true,
      reason: `failure recovery — alternative PVM candidate available (${altCandidate.actionType})`,
      failureCategory: category,
      retryability: "retryable",
      suggestedAction: "ALTERNATIVE_CANDIDATE",
      alternativeCandidate: altCandidate,
      recoveryLatencyMs: getLatency(),
    };
  }

  // Determine standard recovery suggestion based on failure classification
  let suggestedAction: SuggestedRecoveryAction;
  switch (category) {
    case "STATE_NOT_CHANGED":
      suggestedAction = "BACKOFF_RETRY";
      break;
    case "TIMEOUT":
    case "EXECUTION_INTERRUPTED":
      suggestedAction = "RETRY_IMMEDIATE";
      break;
    case "TARGET_NOT_FOUND":
    case "ELEMENT_STATE_MISMATCH":
    case "STALE_STATE":
    default:
      suggestedAction = "RECAPTURE_STATE";
      break;
  }

  const actionDesc =
    suggestedAction === "RECAPTURE_STATE"
      ? "a fresh state capture"
      : suggestedAction.toLowerCase().replace("_", " ");

  const reasonPrefix =
    result.status === "ambiguous"
      ? `action ambiguous (${category}) — ambiguous outcome — retry with ${actionDesc}`
      : `action failed (${category}) — retry with ${actionDesc}`;

  return {
    shouldRetry: true,
    reason: reasonPrefix,
    failureCategory: category,
    retryability: "retryable",
    suggestedAction,
    recoveryLatencyMs: getLatency(),
  };
}
