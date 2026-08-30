/**
 * Phase 6 — Multi-step Agent Loop
 *
 * Orchestrates the full capture → reason → validate → execute → verify
 * lifecycle across up to MAX_STEPS browser interactions.
 *
 * Architecture:
 *
 *     ↓ Capture live DOM (captureCurrentPage)
 *     ↓ Privacy Firewall (buildSanitizedContext)
 *     ↓ Send to reasoning API
 *     ↓ Receive ActionResponse
 *     ↓ Existing Action Validator  (action/validator.ts via runOneStep)
 *     ↓ Existing Action Executor   (action/executor.ts via dispatch.ts via runOneStep)
 *     ↓ Existing PVM Verification  (pvm/verify.ts via runOneStep)
 *     ↓ Capture NEW page state
 *     ↓ Send new state to reasoning
 *     ↓ Repeat
 *
 * Termination:
 *   - Model returns `done`                    → ok: true
 *   - Unrecoverable error / invalid response  → ok: false
 *   - Action validation failure               → ok: false
 *   - Execution failure                       → ok: false
 *   - Verification failure                    → ok: false
 *   - Reasoning / API failure                 → ok: false
 *   - Step limit reached                      → ok: false
 *
 * IMPORTANT: This module ONLY orchestrates. It does NOT re-implement:
 *   - The validator   — stays in action/validator.ts
 *   - The executor    — stays in action/executor.ts
 *   - The ActionResponse format — stays in action/types.ts
 *   - The PVM system  — stays in pvm/
 * All are exercised through runOneStep() from content/pipeline.ts.
 *
 * PVM OWNERSHIP MODEL (ISSUE-02 resolution):
 *   pipeline.ts owns:
 *     • Level-1 snapshot-based deterministic verification (verifyAction)
 *     • Level-2 semantic escalation (verifyLevel2Semantic), when required
 *     • Verified-outcome memory write (recordVerifiedOutcome), on success only
 *   agentLoop.ts owns:
 *     • Recovery decision consultation (decideRecovery), on non-success only
 *     • Step routing (retry / continue / halt) based on recovery decision
 *   There is exactly ONE verification lifecycle and ONE memory write per action.
 */

import type { SanitizedContext, StepRecord } from "../privacy/sanitizedContext";
import type { RecoveryDecision, VerificationResult } from "../pvm/types";
import { decideRecovery } from "../pvm/recovery";
import { cleanupSession } from "./session";
import { clearLocalSecrets } from "./secretStore";
import { captureCurrentPage, buildStepRecord } from "../content/index";
import { buildSanitizedContext } from "../privacy/sanitizedContext";
import { sendMessage } from "../messaging/bus";
import { runOneStepTyped, isStepError } from "../content/pipeline";
import type { StepResult } from "../content/pipeline";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** How the agent loop terminated. */
export type AgentLoopTerminationReason =
  | "done"               // Model signalled task complete
  | "step_limit"         // MAX_STEPS reached without done
  | "server_error"       // Network/API failure or non-200 response
  | "validation_failed"  // Existing validator rejected the action
  | "execution_failed"   // Executor threw (browser interaction error)
  | "verification_failed"// PVM verifier returned failure
  | "dom_capture_failed" // captureCurrentPage returned null
  | "firewall_blocked"   // Privacy Firewall blocked the payload
  | "timeout"            // Per-step or overall timeout exceeded
  | "aborted";           // External abort signal fired

/** Caller-supplied options for one agent task. */
export interface AgentLoopOptions {
  /** The natural-language task the user submitted. */
  task: string;
  /** Maximum browser interactions before halting. Default: 8. */
  maxSteps?: number;
  /** Per-step wall-clock budget in ms. Default: 20 000. */
  stepTimeoutMs?: number;
  /** Overall task wall-clock budget in ms. Default: 60 000. */
  taskTimeoutMs?: number;
  /**
   * Injectable one-step runner — defaults to the real pipeline's runOneStep.
   * Override in tests to control server responses without hitting the network.
   *
   * Phase 6: accepts StepResult so that tests can return structured StepError
   * values to verify specific termination reasons. Returning plain `null` still
   * works for backwards-compatible mocks and maps to "server_error".
   */
  runStep?: (context: SanitizedContext) => Promise<StepResult | null>;
  /** Optional abort signal to cancel the loop externally. */
  signal?: AbortSignal;
}

/** The result returned after the loop finishes (success or failure). */
export interface AgentLoopResult {
  /** true only if the model emitted `done` and all prior steps verified. */
  ok: boolean;
  /** Number of browser interactions actually performed (done doesn't count). */
  stepsExecuted: number;
  /** Why the loop stopped. */
  terminationReason: AgentLoopTerminationReason;
  /** Human-readable explanation for logging / popup display. */
  detail: string;
  /** Sanitized step-level history accumulated during the run. */
  history: StepRecord[];
  /**
   * Phase 5: The last recovery decision produced by the PVM recovery engine.
   * Present when the loop terminated due to a non-retryable verification failure.
   * Null on success or step-limit termination.
   */
  recoveryDecision?: RecoveryDecision | null;
}

// ---------------------------------------------------------------------------
// Default limits (exported so callers and tests can reference them)
// ---------------------------------------------------------------------------

export const AGENT_LOOP_MAX_STEPS = 8;
export const AGENT_LOOP_STEP_TIMEOUT_MS = 20_000;
export const AGENT_LOOP_TASK_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Action-type derivation from VerificationResult.expected
//
// This is the canonical post-execution source of the action type.
// ActionRequest.action is consumed inside pipeline.ts:runOneStepTyped()
// and is not in scope here. VerificationResult.expected is the only
// reliable, non-opaque record of what action was attempted.
//
// ISSUE-01 RESOLUTION: actionId has the format "${taskId}:${stepId}",
// so actionId.split(":")[0] yields the first UUID segment — NOT the
// action type. This function replaces that incorrect derivation.
// ---------------------------------------------------------------------------

/**
 * Derives the canonical action type string from a VerificationResult.
 * This is the single source of truth for action type in the agent loop
 * scope, where ActionRequest is no longer accessible.
 */
function actionTypeFromResult(result: VerificationResult): string {
  switch (result.expected) {
    case "wait_completed":   return "wait";
    case "click_effect":     return "click";
    case "value_matches":    return "type";
    case "value_changed":    return "type_secret";
    case "scroll_changed":   return "scroll";
    case "url_changed":      return "navigate";
    case "keypress_effect":  return "keypress";
    case "done":             return "done";
    default:                 return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

/**
 * Runs the full multi-step agent loop for a single user-submitted task.
 *
 * Every iteration:
 *  1. Captures the *current* live DOM (never reuses stale state).
 *  2. Runs the Privacy Firewall to sanitize sensitive fields.
 *  3. Sends the sanitized context + accumulated history to the reasoning API.
 *  4. Passes the returned ActionResponse through the existing validator.
 *  5. Executes via the existing dispatch gate (one execution per response).
 *  6. Verifies the outcome using the existing PVM verifier (L1 + L2 if needed).
 *  7. On non-success, consults decideRecovery for retry guidance.
 *  8. Records a sanitized StepRecord (no raw values or secrets).
 *  9. Repeats with the new page state.
 *
 * @param taskId  A unique ID for this task run (UUID). The caller is
 *                responsible for generating it so it can also be used
 *                for session tracking before calling this function.
 * @param options Caller-supplied configuration (see AgentLoopOptions).
 */
export async function runAgentLoop(
  taskId: string,
  options: AgentLoopOptions
): Promise<AgentLoopResult> {
  const {
    task,
    maxSteps = AGENT_LOOP_MAX_STEPS,
    stepTimeoutMs = AGENT_LOOP_STEP_TIMEOUT_MS,
    taskTimeoutMs = AGENT_LOOP_TASK_TIMEOUT_MS,
    runStep = runOneStepTyped,
    signal,
  } = options;

  const taskStartedAt = Date.now();
  const history: StepRecord[] = [];
  let stepsExecuted = 0;

  console.log("[agentLoop] task started:", task, "taskId:", taskId);

  try {
    for (let stepNumber = 1; stepNumber <= maxSteps; stepNumber++) {

      // ---- Abort signal check ----
      if (signal?.aborted) {
        return {
          ok: false,
          stepsExecuted,
          terminationReason: "aborted",
          detail: "Task aborted by caller before step " + stepNumber + ".",
          history,
        };
      }

      // ---- Overall task timeout ----
      const elapsed = Date.now() - taskStartedAt;
      if (elapsed >= taskTimeoutMs) {
        console.warn("[agentLoop] task budget exhausted after", elapsed, "ms");
        return {
          ok: false,
          stepsExecuted,
          terminationReason: "timeout",
          detail: `Task timed out after ${elapsed}ms (limit ${taskTimeoutMs}ms).`,
          history,
        };
      }

      // ---- Step 1: Capture fresh page state ----
      // CRITICAL: never reuse state from a prior step — the page may have
      // changed due to the previous action (navigation, DOM mutation, etc.)
      const capture = await captureCurrentPage(taskId);
      if (!capture) {
        return {
          ok: false,
          stepsExecuted,
          terminationReason: "dom_capture_failed",
          detail: "DOM capture failed — cannot reason on a blank page.",
          history,
        };
      }
      const { pageState, domDetections, domRedactions } = capture;

      // ---- Step 2: Privacy Firewall / Sanitize ----
      const firewall = buildSanitizedContext(
        { ...pageState, taskId },
        domDetections,
        domRedactions,
        task
      );

      if (!firewall.ok) {
        console.error("[agentLoop] Privacy Firewall blocked step", stepNumber, firewall.missingElementIds);
        await sendMessage({
          type: "PRIVACY_BLOCKED",
          payload: { taskId, missingElementIds: firewall.missingElementIds },
        }).catch(() => {/* non-critical */});
        return {
          ok: false,
          stepsExecuted,
          terminationReason: "firewall_blocked",
          detail: "Blocked by Privacy Firewall — nothing was sent.",
          history,
        };
      }

      // Attach accumulated history so the model sees what has already happened.
      const context = {
        ...firewall.context,
        history: history.length > 0 ? [...history] : undefined,
      };

      console.log(
        "[agentLoop] step", stepNumber, "/ context elements:", context.elements.length,
        "history:", history.length
      );

      // ---- Step 3: Run one pipeline step (ISSUE-04: timer always cleared in finally) ----
      //
      // runOneStepTyped (or the injected test runStep) owns the full
      // single-action lifecycle:
      //   fetch → validate → dispatch → L1 verify → L2 if needed → memory write
      //
      // This loop adds the outer retry/recovery layer around that.
      let stepResult: StepResult | null = null;
      let stepTimerId: ReturnType<typeof setTimeout> | undefined;

      try {
        const stepTimeoutPromise = new Promise<null>((resolve) => {
          stepTimerId = setTimeout(() => resolve(null), stepTimeoutMs);
        });
        const stepRunPromise = runStep(context);
        stepResult = await Promise.race([stepRunPromise, stepTimeoutPromise]);
      } finally {
        clearTimeout(stepTimerId);
      }

      // ---- Step 4: Handle result ----

      // Phase 6: StepError — the pipeline returned a structured failure with a
      // specific root cause. Use its reason directly so the caller sees
      // "validation_failed" / "execution_failed" / "server_error" precisely.
      if (isStepError(stepResult)) {
        console.warn(
          "[agentLoop] step", stepNumber,
          "failed (", stepResult.reason, "):", stepResult.detail
        );
        return {
          ok: false,
          stepsExecuted,
          terminationReason: stepResult.reason,
          detail: `Step ${stepNumber} ${stepResult.reason}: ${stepResult.detail}`,
          history,
        };
      }

      // null → legacy mock / unexpected pipeline failure — keep server_error as
      // the fallback so pre-Phase-6 test mocks continue to work unchanged.
      if (stepResult === null) {
        console.warn("[agentLoop] step", stepNumber, "returned null — halting");
        return {
          ok: false,
          stepsExecuted,
          terminationReason: "server_error",
          detail: `Step ${stepNumber} server_error: unexpected null from runStep (legacy mock or pipeline fallback).`,
          history,
        };
      }

      // "done" → model signals the task is complete
      if (stepResult.expected === "done") {
        console.log("[agentLoop] task complete (done) after", stepsExecuted, "action(s)");
        await sendMessage({ type: "ACTION_RESULT", payload: stepResult }).catch(() => {/* non-critical */});
        return {
          ok: true,
          stepsExecuted,
          terminationReason: "done",
          detail: `Task complete — done after ${stepsExecuted} step(s).`,
          history,
        };
      }

      // ---- Step 5: Canonical action-type derivation (ISSUE-01 resolved) ----
      //
      // The action type is derived from stepResult.expected — the canonical
      // post-execution record of what action was attempted.
      //
      // DO NOT use actionId.split(":")[0] — actionId has the format
      // "${taskId}:${stepId}", so splitting on ":" yields the first UUID
      // segment (e.g. "3f2a9b81"), not the action type.
      const actionType = actionTypeFromResult(stepResult);

      // ---- Step 6: Recovery decision (ISSUE-02 resolved) ----
      //
      // PVM lifecycle ownership:
      //   pipeline.ts   → owns L1 verification, L2 escalation, memory write
      //   agentLoop.ts  → owns recovery consultation ONLY
      //
      // We do NOT call processRole5ActionLifecycle here because that function
      // calls verifyWithEscalation internally, which would re-run the
      // verification that pipeline.ts already completed — creating a duplicate
      // PVM lifecycle. Instead we call decideRecovery directly with the
      // already-computed stepResult from pipeline.ts.
      //
      // Memory learning: pipeline.ts:runOneStepTyped already called
      // recordVerifiedOutcome on success. We do NOT call it again here.
      let pvmRecovery: RecoveryDecision | null = null;

      if (stepResult.status !== "success") {
        try {
          pvmRecovery = decideRecovery(stepResult, {
            attemptsSoFar: stepNumber - 1,
            stateSignature: undefined,
            stateInput: {
              url: pageState.url,
              title: pageState.title,
              elements: context.elements.map((el) => ({
                elementId: el.elementId,
                role: el.role,
              })),
            },
            taskScope: taskId,
          });

          if (pvmRecovery) {
            console.log(
              "[agentLoop/pvm] step", stepNumber,
              "recovery decision:", pvmRecovery.suggestedAction,
              "shouldRetry:", pvmRecovery.shouldRetry,
              "reason:", pvmRecovery.reason
            );
          }
        } catch (pvmErr) {
          // Recovery is non-critical; log and continue
          console.warn("[agentLoop/pvm] recovery error (non-fatal):", pvmErr);
        }
      }

      // ---- Step 7: Route on verification status ----

      // Hard verification failure → consult recovery engine
      if (stepResult.status === "failure") {
        console.warn("[agentLoop] step", stepNumber, "verification failed:", stepResult.observed);
        await sendMessage({ type: "ACTION_RESULT", payload: stepResult }).catch(() => {/* non-critical */});

        // If recovery says retry is possible, re-capture fresh state and continue the loop.
        // The next iteration will call captureCurrentPage() again — no stale state.
        if (pvmRecovery?.shouldRetry) {
          console.log(
            "[agentLoop/pvm] recovery recommends retry (suggestedAction:",
            pvmRecovery.suggestedAction + ") — recapturing page state"
          );
          // Consume one step slot and continue — the next loop iteration re-captures
          stepsExecuted++;
          const recoveryRecord = buildStepRecord(
            stepNumber,
            actionType,
            null,
            null,
            "failure"
          );
          history.push(recoveryRecord);
          continue;
        }

        // Non-retryable failure — halt
        return {
          ok: false,
          stepsExecuted,
          terminationReason: "verification_failed",
          detail: `Step ${stepNumber} verification failed (${stepResult.observed}) — halting.`,
          history,
          recoveryDecision: pvmRecovery,
        };
      }

      // Ambiguous result: PVM recovery decides whether to retry (re-capture) or continue
      if (stepResult.status === "ambiguous") {
        if (pvmRecovery?.shouldRetry) {
          console.log(
            "[agentLoop/pvm] ambiguous result — recovery recommends retry (",
            pvmRecovery.suggestedAction + ") — recapturing page state"
          );
          stepsExecuted++;
          const ambiguousRecord = buildStepRecord(
            stepNumber,
            actionType,
            null,
            null,
            "ambiguous"
          );
          history.push(ambiguousRecord);
          continue;
        }
        // No retry suggested — treat ambiguous as an acceptable outcome and continue
        console.log("[agentLoop] step", stepNumber, "ambiguous — continuing (no retry recommended)");
      }

      // ---- Step 8: Record sanitized history (no raw values / secrets) ----
      stepsExecuted++;

      const record = buildStepRecord(
        stepNumber,
        actionType,
        null,
        null,
        stepResult.status as "success" | "failure" | "ambiguous"
      );
      history.push(record);

      await sendMessage({ type: "ACTION_RESULT", payload: stepResult }).catch(() => {/* non-critical */});
      console.log("[agentLoop] step", stepNumber, "complete:", stepResult.status);
    }

    // ---- Step budget exhausted ----
    console.warn("[agentLoop] step budget exhausted (maxSteps =", maxSteps, ")");
    return {
      ok: false,
      stepsExecuted,
      terminationReason: "step_limit",
      detail: `Task halted after ${maxSteps} steps without completion.`,
      history,
    };

  } finally {
    // ISSUE-05: Clear all in-memory secrets on every runAgentLoop exit path
    // (success, failure, exception, early return, step-limit, timeout, abort).
    // Prevents cross-task secret retention within a single page visit.
    clearLocalSecrets();
    cleanupSession(taskId);
  }
}
