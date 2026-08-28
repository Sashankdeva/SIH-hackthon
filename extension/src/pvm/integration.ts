/**
 * Role 5 — End-to-End Agent Loop Integration Lifecycle
 *
 * Orchestrates Candidate Prediction Lookup -> Multi-Level Verification ->
 * Verified Learning -> Failure Recovery Guidance in a unified, sub-millisecond pipeline.
 */

import type {
  Role5LifecycleParams,
  Role5LifecycleResult,
  Role5LifecycleTimings,
  PvmRecord,
  RecoveryDecision,
  PvmPredictionCandidate,
} from "./types";
import {
  computeStateSignature,
  computeActionSignature,
  findAndValidateCandidates,
  recordVerifiedOutcome,
} from "./memory";
import { verifyWithEscalation } from "./verify";
import { decideRecovery } from "./recovery";

export type { Role5LifecycleParams, Role5LifecycleResult, Role5LifecycleTimings };

/**
 * Executes the complete Role 5 Action Lifecycle:
 * 1. Candidate Lookup & Applicability Validation (Prediction)
 * 2. Multi-Level Deterministic Verification & Escalation (Verification)
 * 3. Verified Outcome Learning (PVM Memory Persistence - Positive Invariant)
 * 4. Failure Classification & Recovery Recommendation (Recovery Guidance)
 */
export async function processRole5ActionLifecycle(
  params: Role5LifecycleParams
): Promise<Role5LifecycleResult> {
  const tTotalStart = typeof performance !== "undefined" ? performance.now() : Date.now();

  // -------------------------------------------------------------------------
  // Step 1: Candidate Lookup & Validation
  // -------------------------------------------------------------------------
  const tLookupStart = typeof performance !== "undefined" ? performance.now() : Date.now();
  const stateSig = computeStateSignature(params.stateInput);
  const actionSig = computeActionSignature(params.actionInput);

  const validatedCandidates = findAndValidateCandidates(params.stateInput, {
    currentActionInput: params.actionInput,
    taskScope: params.taskScope,
    sessionScope: params.sessionScope,
    minConfidenceThreshold: 0.8,
  });

  const matchedCandidate: PvmPredictionCandidate | null =
    validatedCandidates.length > 0 ? validatedCandidates[0].candidate : null;

  const tLookupEnd = typeof performance !== "undefined" ? performance.now() : Date.now();
  const lookupMs = Math.max(0.0001, tLookupEnd - tLookupStart);

  // -------------------------------------------------------------------------
  // Step 2: Multi-Level Verification & Escalation
  // -------------------------------------------------------------------------
  const tVerifyStart = typeof performance !== "undefined" ? performance.now() : Date.now();
  const verificationResult = verifyWithEscalation(params.verificationRequest);
  const tVerifyEnd = typeof performance !== "undefined" ? performance.now() : Date.now();
  const verificationMs = Math.max(0.0001, tVerifyEnd - tVerifyStart);

  // -------------------------------------------------------------------------
  // Step 3: Verified Learning (Invariant: ONLY store positive success outcomes)
  // -------------------------------------------------------------------------
  const tLearnStart = typeof performance !== "undefined" ? performance.now() : Date.now();
  let learnedRecord: PvmRecord | null = null;

  if (verificationResult.status === "success") {
    learnedRecord = await recordVerifiedOutcome({
      taskId: params.taskId,
      stateSignature: stateSig,
      actionSignature: actionSig,
      actionType: params.actionInput.action,
      targetRole: params.actionInput.targetRole ?? undefined,
      targetElementId: params.actionInput.targetElementId ?? null,
      verificationResult,
      taskScope: params.taskScope,
      sessionScope: params.sessionScope,
    });
  }
  const tLearnEnd = typeof performance !== "undefined" ? performance.now() : Date.now();
  const learningMs = Math.max(0.0001, tLearnEnd - tLearnStart);

  // -------------------------------------------------------------------------
  // Step 4: Failure Classification & Recovery Recommendation
  // -------------------------------------------------------------------------
  const tRecoveryStart = typeof performance !== "undefined" ? performance.now() : Date.now();
  let recoveryDecision: RecoveryDecision | null = null;

  if (verificationResult.status !== "success") {
    recoveryDecision = decideRecovery(verificationResult, {
      attemptsSoFar: params.attemptsSoFar ?? 0,
      stateSignature: stateSig,
      stateInput: params.stateInput,
      taskScope: params.taskScope,
      sessionScope: params.sessionScope,
    });
  }
  const tRecoveryEnd = typeof performance !== "undefined" ? performance.now() : Date.now();
  const recoveryMs = Math.max(0.0001, tRecoveryEnd - tRecoveryStart);

  const tTotalEnd = typeof performance !== "undefined" ? performance.now() : Date.now();
  const totalMs = Math.max(0.0001, tTotalEnd - tTotalStart);

  return {
    actionId: params.actionId,
    candidate: matchedCandidate,
    verificationResult,
    learnedRecord,
    recoveryDecision,
    timings: {
      lookupMs,
      verificationMs,
      learningMs,
      recoveryMs,
      totalMs,
    },
  };
}
