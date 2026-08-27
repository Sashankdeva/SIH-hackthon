import type { VerificationResult } from "./types";

export interface RecoveryDecision {
  shouldRetry: boolean;
  reason: string;
}

/**
 * Basic recovery loop — Day 3 task. On failure, retry once; on
 * ambiguous, ask the caller to re-capture state and request fresh
 * reasoning rather than blindly retrying the same action. See
 * PS26171_Role5_Pvm.pdf.
 */
export function decideRecovery(result: VerificationResult, attemptsSoFar: number): RecoveryDecision {
  const MAX_ATTEMPTS = 2;

  if (result.status === "success") {
    return { shouldRetry: false, reason: "verified success" };
  }
  if (attemptsSoFar >= MAX_ATTEMPTS) {
    return { shouldRetry: false, reason: `stopped after ${attemptsSoFar} attempts — escalate rather than loop` };
  }
  if (result.status === "failure") {
    return { shouldRetry: true, reason: "action failed — retry with a fresh state capture" };
  }
  return { shouldRetry: true, reason: "ambiguous outcome — re-evaluate before retrying" };
}
