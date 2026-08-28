import type {
  VerificationResult,
  RecoveryDecision,
  FailureCategory,
  Retryability,
} from "./types";

export { type RecoveryDecision };

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
 * Recovery decision engine — governs whether an action should retry or escalate.
 */
export function decideRecovery(
  result: VerificationResult,
  attemptsSoFar: number,
  maxAttempts: number = MAX_RECOVERY_ATTEMPTS
): RecoveryDecision {
  if (!result || typeof result !== "object") {
    return {
      shouldRetry: false,
      reason: "malformed verification result",
      failureCategory: "MALFORMED_REQUEST",
      retryability: "nonRetryable",
      suggestedAction: "ABORT",
    };
  }

  if (result.status === "success") {
    return {
      shouldRetry: false,
      reason: "verified success",
      retryability: "nonRetryable",
    };
  }

  if (attemptsSoFar >= maxAttempts) {
    return {
      shouldRetry: false,
      reason: `stopped after ${attemptsSoFar} attempts — escalate rather than loop`,
      failureCategory: result.failureCategory ?? classifyFailure(result),
      retryability: "nonRetryable",
      suggestedAction: "ABORT",
    };
  }

  const category = result.failureCategory ?? classifyFailure(result);

  if (result.status === "failure") {
    const retryable = isFailureRetryable(category, attemptsSoFar, maxAttempts);
    if (retryable === "nonRetryable") {
      return {
        shouldRetry: false,
        reason: `non-retryable failure (${category}) — abort`,
        failureCategory: category,
        retryability: "nonRetryable",
        suggestedAction: "ABORT",
      };
    }
    const suggestedAction: "RETRY_IMMEDIATE" | "RECAPTURE_STATE" | "BACKOFF_RETRY" =
      category === "STATE_NOT_CHANGED" ? "BACKOFF_RETRY" : "RECAPTURE_STATE";
    return {
      shouldRetry: true,
      reason: "action failed — retry with a fresh state capture",
      failureCategory: category,
      retryability: "retryable",
      suggestedAction,
    };
  }

  // Ambiguous outcome (e.g. url_unchanged on navigate)
  return {
    shouldRetry: true,
    reason: "ambiguous outcome — re-evaluate before retrying",
    failureCategory: category,
    retryability: "inconclusive",
    suggestedAction: "RECAPTURE_STATE",
  };
}
