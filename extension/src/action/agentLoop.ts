/**
 * Phase 4 — Multi-Step Agent Loop
 *
 * Orchestrates the full agent execution cycle:
 *   Capture page state
 *     ↓ Sanitize (Privacy Firewall)
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
 */

import type { SanitizedContext, StepRecord } from "../privacy/sanitizedContext";
import type { RecoveryDecision } from "../pvm/types";
import { cleanupSession } from "./session";
import { captureCurrentPage, buildStepRecord } from "../content/index";
import { buildSanitizedContext } from "../privacy/sanitizedContext";
import { sendMessage } from "../messaging/bus";
import { runOneStepTyped, isStepError } from "../content/pipeline";
import type { StepResult } from "../content/pipeline";
import { processRole5ActionLifecycle } from "../pvm/integration";

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
 *  6. Verifies the outcome using the existing PVM verifier.
 *  7. Records a sanitized StepRecord (no raw values or secrets).
 *  8. Repeats with the new page state.
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

      // Attach accumulated history so the model sees prior steps.
      // The server is stateless — we own all context.
      const context: SanitizedContext = {
        ...firewall.context,
        history: history.length > 0 ? [...history] : undefined,
      };

      console.log(
        "[agentLoop] step", stepNumber,
        "/ elements:", context.elements.length,
        "/ history:", history.length
      );

      // ---- Step 3: Send to reasoning API + validate + execute + verify ----
      // runStep() = runOneStep() which internally:
      //   • fetchAction() — sends context to the LLM reasoning server
      //   • validateAction() — existing validator (action/validator.ts)
      //   • createDispatch() → executeAction() — existing executor
      //   • verifyAction() — existing PVM verifier (pvm/verify.ts)
      // We apply a per-step timeout around this to prevent hangs.
      let stepResult: StepResult | null = null;

      const stepTimeoutPromise = new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), stepTimeoutMs)
      );
      const stepRunPromise = runStep(context);

      stepResult = await Promise.race([stepRunPromise, stepTimeoutPromise]);

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

      // ---- Step 5 (Phase 5): PVM lifecycle — learn successes, classify failures ----
      //
      // processRole5ActionLifecycle wraps the existing verifyWithEscalation (L1/L2/L3),
      // records positive outcomes into PVM memory, and calls decideRecovery for
      // non-success results. We feed a VerificationRequest derived from the result
      // so the lifecycle can look up candidates and apply recovery logic.
      //
      // NOTE: This does NOT change the verification that already happened inside
      // runOneStep → verifyAction(). It adds PVM memory learning on top of it.
      const actionId = stepResult.actionId;
      const safeStateInput = {
        url: pageState.url,
        title: pageState.title,
        elements: context.elements.map((el) => ({
          elementId: el.elementId,
          role: el.role,
        })),
      };
      const safeActionInput = {
        action: actionId, // opaque identifier; detailed action is private after execution
      };

      let pvmRecovery: RecoveryDecision | null = null;

      try {
        const pvmLifecycle = await processRole5ActionLifecycle({
          taskId,
          actionId,
          actionInput: safeActionInput,
          stateInput: safeStateInput,
          verificationRequest: {
            taskId,
            actionId,
            actionType: actionId.split(":")[0] ?? "unknown",
          },
          taskScope: taskId,
          attemptsSoFar: stepNumber - 1,
        });

        pvmRecovery = pvmLifecycle.recoveryDecision;

        if (pvmLifecycle.learnedRecord) {
          console.log(
            "[agentLoop/pvm] step", stepNumber,
            "outcome learned — stateHash:", pvmLifecycle.learnedRecord.stateHash
          );
        }
        if (pvmRecovery) {
          console.log(
            "[agentLoop/pvm] step", stepNumber,
            "recovery decision:", pvmRecovery.suggestedAction,
            "shouldRetry:", pvmRecovery.shouldRetry,
            "reason:", pvmRecovery.reason
          );
        }
      } catch (pvmErr) {
        // PVM lifecycle is non-critical; log and continue
        console.warn("[agentLoop/pvm] lifecycle error (non-fatal):", pvmErr);
      }

      // ---- Step 6: Route on verification status ----

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
            "unknown",
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
            "unknown",
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

      // ---- Step 7: Record sanitized history (no raw values / secrets) ----
      stepsExecuted++;

      const actionTypeFromExpected =
        stepResult.expected === "wait_completed"  ? "wait"
        : stepResult.expected === "click_effect"  ? "click"
        : stepResult.expected === "value_matches" ? "type"
        : stepResult.expected === "value_changed" ? "type_secret"
        : stepResult.expected === "scroll_changed"? "scroll"
        : stepResult.expected === "url_changed"   ? "navigate"
        : stepResult.expected === "keypress_effect"? "keypress"
        : "unknown";

      const record = buildStepRecord(
        stepNumber,
        actionTypeFromExpected,
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
    cleanupSession(taskId);
  }
}
