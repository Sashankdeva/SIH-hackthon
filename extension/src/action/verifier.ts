import { verifyUrlChanged, verifyElementPresent } from "../pvm/verify";
import { decideRecovery, type RecoveryDecision } from "../pvm/recovery";
import type { VerificationResult } from "../pvm/types";
import { validateAction } from "./validator";
import { executeAction } from "./executor";
import { sendMessage } from "../messaging/bus";
import type { ActionRequest } from "./types";

export type ActionLifecycleStatus =
  | "VALIDATED"
  | "EXECUTED"
  | "VERIFIED"
  | "VALIDATION_FAILED"
  | "EXECUTION_FAILED"
  | "VERIFICATION_FAILED"
  | "VERIFICATION_AMBIGUOUS"
  | "TIMEOUT"
  | "RETRY_EXHAUSTED"
  | "DUPLICATE_PREVENTED"
  | "CANCELLED"
  | "INTERRUPTED";

export interface ActionExecutionTimings {
  validationDurationMs: number;
  executionDurationMs: number;
  verificationDurationMs: number;
  totalOrchestrationDurationMs: number;
}

export interface ActionExecutionLifecycleResult {
  actionId: string;
  taskId: string;
  stepId: number;
  action: ActionRequest["action"];
  valueRef?: string | null;
  tabId?: number | null;
  status: ActionLifecycleStatus;
  executed: boolean;
  verified: boolean;
  attempts: number;
  timings?: ActionExecutionTimings;
  verification?: VerificationResult;
  recovery?: RecoveryDecision;
  error?: string;
}

// In-memory set to prevent duplicate verification invocations for the same action step
const verifiedActionSet = new Set<string>();

// Scoped attempt tracker per actionId (${taskId}-step-${stepId})
const retryAttemptTracker = new Map<string, number>();

export const MAX_RETRY_ATTEMPTS = 2;
export const DEFAULT_ACTION_TIMEOUT_MS = 5000;

/**
 * Checks if an action ID has already undergone verification.
 */
export function isActionAlreadyVerified(actionId: string): boolean {
  return verifiedActionSet.has(actionId);
}

/**
 * Returns recorded attempt count for an action ID.
 */
export function getRetryAttempts(actionId: string): number {
  return retryAttemptTracker.get(actionId) ?? 0;
}

/**
 * Resets the verification and retry registries (used for test isolation and session resets).
 */
export function resetVerificationTracker(): void {
  verifiedActionSet.clear();
  retryAttemptTracker.clear();
}

export function resetRetryTracker(): void {
  retryAttemptTracker.clear();
}

/**
 * Determines whether a lifecycle interruption is retryable.
 * Transient page reloads with element revalidation may retry within budget.
 * Permanent failures (unloaded content script, closed tab, wrong tab identity, context loss) NEVER retry.
 */
export function isLifecycleInterruptionRetryable(reason?: string): boolean {
  if (!reason) return false;
  const lower = reason.toLowerCase();
  if (
    lower.includes("content_script_unavailable") ||
    lower.includes("tab_unavailable") ||
    lower.includes("wrong_tab_identity") ||
    lower.includes("execution_context_lost") ||
    lower.includes("message_channel_lost") ||
    lower.includes("cancelled")
  ) {
    return false;
  }
  if (
    lower.includes("page_reloaded") ||
    lower.includes("reloaded") ||
    lower.includes("reconnected")
  ) {
    return true;
  }
  return false;
}

/**
 * Clears retry attempt history and verified tracker entries for a specific taskId.
 */
export function cleanupActionTracker(taskId: string): void {
  for (const key of Array.from(retryAttemptTracker.keys())) {
    if (key.startsWith(`${taskId}-step-`)) {
      retryAttemptTracker.delete(key);
    }
  }
  for (const key of Array.from(verifiedActionSet)) {
    if (key.startsWith(`${taskId}-step-`)) {
      verifiedActionSet.delete(key);
    }
  }
}

/**
 * Wraps a promise in a timeout and cancellation guard to prevent browser agent execution from hanging indefinitely.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number = DEFAULT_ACTION_TIMEOUT_MS,
  timeoutMsg: string = "Action execution timed out",
  signal?: AbortSignal
): Promise<T> {
  if (signal?.aborted) {
    throw new Error(signal.reason ? String(signal.reason) : "Action execution cancelled");
  }

  let timerId: ReturnType<typeof setTimeout>;
  let abortListener: (() => void) | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => reject(new Error(timeoutMsg)), timeoutMs);
    if (signal) {
      abortListener = () => reject(new Error(signal.reason ? String(signal.reason) : "Action execution cancelled"));
      signal.addEventListener("abort", abortListener, { once: true });
    }
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timerId!);
    if (signal && abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

/**
 * Invokes existing Role 5 verification on a successfully executed action.
 * Ensures verification exceptions are isolated and never crash the extension runtime.
 */
export async function verifyExecutedAction(
  req: ActionRequest,
  contextBefore?: { url: string; startTime: number },
  attemptNumber: number = 0,
  signal?: AbortSignal
): Promise<ActionExecutionLifecycleResult> {
  const actionId = `${req.taskId}-step-${req.stepId}`;
  const startTime = contextBefore?.startTime ?? Date.now();

  if (signal?.aborted) {
    return {
      actionId,
      taskId: req.taskId,
      stepId: req.stepId,
      action: req.action,
      valueRef: req.valueRef,
      tabId: req.tabId,
      status: "CANCELLED",
      executed: false,
      verified: false,
      attempts: attemptNumber + 1,
      error: signal.reason ? String(signal.reason) : "Action cancelled before verification",
    };
  }

  // Deduplication check: prevent duplicate verification cycles
  if (verifiedActionSet.has(actionId)) {
    return {
      actionId,
      taskId: req.taskId,
      stepId: req.stepId,
      action: req.action,
      valueRef: req.valueRef,
      tabId: req.tabId,
      status: "DUPLICATE_PREVENTED",
      executed: true,
      verified: false,
      attempts: attemptNumber + 1,
      error: `Duplicate verification prevented for action ${actionId}`,
    };
  }

  try {
    let verification: VerificationResult;

    switch (req.action) {
      case "navigate": {
        const urlBefore = contextBefore?.url ?? (typeof location !== "undefined" ? location.href : "");
        verification = verifyUrlChanged(actionId, urlBefore, startTime);
        break;
      }
      case "click":
      case "type":
      case "type_secret": {
        // Level 1 check: verify element presence using privy-id or body selector
        const selector = req.elementId != null ? `[data-privy-id="${req.elementId}"]` : "body";
        verification = verifyElementPresent(actionId, selector, startTime);
        break;
      }
      case "scroll":
      case "keypress":
      case "wait": {
        // Generic Level 1 completion verification
        verification = {
          actionId,
          expected: `action_completed:${req.action}`,
          observed: "completed",
          status: "success",
          latencyMs: Date.now() - startTime,
        };
        break;
      }
      default: {
        verification = {
          actionId,
          expected: "supported_action",
          observed: "unsupported",
          status: "failure",
          latencyMs: Date.now() - startTime,
        };
        break;
      }
    }

    verifiedActionSet.add(actionId);
    const recovery = decideRecovery(verification, attemptNumber);

    let status: ActionLifecycleStatus = "VERIFIED";
    if (verification.status === "failure") {
      status = "VERIFICATION_FAILED";
    } else if (verification.status === "ambiguous") {
      status = "VERIFICATION_AMBIGUOUS";
    }

    return {
      actionId,
      taskId: req.taskId,
      stepId: req.stepId,
      action: req.action,
      valueRef: req.valueRef,
      tabId: req.tabId,
      status,
      executed: true,
      verified: verification.status === "success",
      attempts: attemptNumber + 1,
      verification,
      recovery,
    };
  } catch (err) {
    // Safe error isolation: Role 5 exceptions do not crash the extension
    const fallbackVerification: VerificationResult = {
      actionId,
      expected: "safe_verification",
      observed: `error: ${err instanceof Error ? err.message : String(err)}`,
      status: "failure",
      latencyMs: Date.now() - startTime,
    };

    return {
      actionId,
      taskId: req.taskId,
      stepId: req.stepId,
      action: req.action,
      valueRef: req.valueRef,
      tabId: req.tabId,
      status: "VERIFICATION_FAILED",
      executed: true,
      verified: false,
      attempts: attemptNumber + 1,
      verification: fallbackVerification,
      recovery: { shouldRetry: false, reason: "verification exception caught" },
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Single-pass action lifecycle runner:
 * 1. Validate action request against active task and DOM constraints.
 * 2. If valid, execute browser action with full event signaling.
 * 3. If executed, invoke post-action verification and report via message bus.
 */
export async function executeAndVerifyAction(
  req: ActionRequest,
  expectedTaskId: string,
  attemptNumber: number = 0,
  signal?: AbortSignal
): Promise<ActionExecutionLifecycleResult> {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const actionId = `${req?.taskId ?? "unknown"}-step-${req?.stepId ?? 0}`;

  if (signal?.aborted) {
    return {
      actionId,
      taskId: req?.taskId ?? expectedTaskId,
      stepId: req?.stepId ?? 0,
      action: req?.action ?? "wait",
      valueRef: req?.valueRef,
      tabId: req?.tabId,
      status: "CANCELLED",
      executed: false,
      verified: false,
      attempts: attemptNumber + 1,
      error: signal.reason ? String(signal.reason) : "Action cancelled before execution",
    };
  }

  // Stale Result / Malformed payload validation
  if (!req || typeof req !== "object" || !req.taskId) {
    return {
      actionId,
      taskId: req?.taskId ?? "unknown",
      stepId: req?.stepId ?? 0,
      action: req?.action ?? "wait",
      valueRef: req?.valueRef,
      tabId: req?.tabId,
      status: "VALIDATION_FAILED",
      executed: false,
      verified: false,
      attempts: attemptNumber + 1,
      error: "Malformed action request payload.",
    };
  }

  // Stage 1: Validation
  const tValidationStart = typeof performance !== "undefined" ? performance.now() : Date.now();
  const validation = validateAction(req, expectedTaskId);
  const tValidationEnd = typeof performance !== "undefined" ? performance.now() : Date.now();
  const validationDurationMs = Math.round((tValidationEnd - tValidationStart) * 1000) / 1000;

  if (!validation.ok) {
    return {
      actionId,
      taskId: req.taskId,
      stepId: req.stepId,
      action: req.action,
      valueRef: req.valueRef,
      tabId: req.tabId,
      status: "VALIDATION_FAILED",
      executed: false,
      verified: false,
      attempts: attemptNumber + 1,
      timings: {
        validationDurationMs,
        executionDurationMs: 0,
        verificationDurationMs: 0,
        totalOrchestrationDurationMs: Math.round((tValidationEnd - t0) * 1000) / 1000,
      },
      error: validation.reason,
    };
  }

  // Stage 2: Capture pre-execution context
  const urlBefore = typeof location !== "undefined" ? location.href : "";
  const startTime = Date.now();

  // Stage 3: Execution
  const tExecutionStart = typeof performance !== "undefined" ? performance.now() : Date.now();
  try {
    await executeAction(req);
  } catch (err) {
    const tExecutionEnd = typeof performance !== "undefined" ? performance.now() : Date.now();
    const errMsg = err instanceof Error ? err.message : String(err);
    const isInterruption =
      errMsg.includes("CONTENT_SCRIPT_UNAVAILABLE") ||
      errMsg.includes("EXECUTION_CONTEXT_LOST") ||
      errMsg.includes("TAB_UNAVAILABLE") ||
      errMsg.includes("MESSAGE_CHANNEL_LOST") ||
      errMsg.includes("PAGE_RELOADED");

    return {
      actionId,
      taskId: req.taskId,
      stepId: req.stepId,
      action: req.action,
      valueRef: req.valueRef,
      tabId: req.tabId,
      status: isInterruption ? "INTERRUPTED" : "EXECUTION_FAILED",
      executed: false,
      verified: false,
      attempts: attemptNumber + 1,
      timings: {
        validationDurationMs,
        executionDurationMs: Math.round((tExecutionEnd - tExecutionStart) * 1000) / 1000,
        verificationDurationMs: 0,
        totalOrchestrationDurationMs: Math.round((tExecutionEnd - t0) * 1000) / 1000,
      },
      error: `Execution failed: ${errMsg}`,
    };
  }
  const tExecutionEnd = typeof performance !== "undefined" ? performance.now() : Date.now();
  const executionDurationMs = Math.round((tExecutionEnd - tExecutionStart) * 1000) / 1000;

  if (signal?.aborted) {
    return {
      actionId,
      taskId: req.taskId,
      stepId: req.stepId,
      action: req.action,
      valueRef: req.valueRef,
      tabId: req.tabId,
      status: "CANCELLED",
      executed: true,
      verified: false,
      attempts: attemptNumber + 1,
      timings: {
        validationDurationMs,
        executionDurationMs,
        verificationDurationMs: 0,
        totalOrchestrationDurationMs: Math.round((tExecutionEnd - t0) * 1000) / 1000,
      },
      error: signal.reason ? String(signal.reason) : "Action cancelled immediately after execution",
    };
  }

  // Stage 4: Post-Action Verification Chaining
  const tVerificationStart = typeof performance !== "undefined" ? performance.now() : Date.now();
  const result = await verifyExecutedAction(req, { url: urlBefore, startTime }, attemptNumber, signal);
  const tVerificationEnd = typeof performance !== "undefined" ? performance.now() : Date.now();
  const verificationDurationMs = Math.round((tVerificationEnd - tVerificationStart) * 1000) / 1000;

  result.timings = {
    validationDurationMs,
    executionDurationMs,
    verificationDurationMs,
    totalOrchestrationDurationMs: Math.round((tVerificationEnd - t0) * 1000) / 1000,
  };

  // Stage 5: Report result over message bus if verification succeeded
  if (result.verification && typeof chrome !== "undefined" && typeof chrome.runtime?.sendMessage === "function") {
    try {
      await sendMessage({
        type: "ACTION_RESULT",
        payload: result.verification,
      });
    } catch {
      // Non-critical messaging notification failure
    }
  }

  return result;
}

/**
 * Executes an action with bounded recovery retries governed strictly by Role 5 decision logic and abort signaling.
 *
 * Rules:
 * - Deterministic failures (validation failure, unknown action, missing secret, unsafe URL) NEVER retry.
 * - Retry is attempted ONLY when Role 5 explicitly returns recovery.shouldRetry === true, or retryable lifecycle interruptions.
 * - Non-retryable interruptions (tab unavailable, content script lost, context destroyed) NEVER retry.
 * - Retry budget is strictly bounded by maxAttempts (default: 2, attempts 0, 1, then stop).
 * - Timeouts and abort signals are guarded per attempt.
 */
export async function executeWithBoundedRetry(
  req: ActionRequest,
  expectedTaskId: string,
  maxAttempts: number = MAX_RETRY_ATTEMPTS,
  timeoutMs: number = DEFAULT_ACTION_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<ActionExecutionLifecycleResult> {
  const actionId = `${req?.taskId ?? "unknown"}-step-${req?.stepId ?? 0}`;
  let currentAttempt = retryAttemptTracker.get(actionId) ?? 0;

  while (currentAttempt <= maxAttempts) {
    if (signal?.aborted) {
      return {
        actionId,
        taskId: req?.taskId ?? expectedTaskId,
        stepId: req?.stepId ?? 0,
        action: req?.action ?? "wait",
        valueRef: req?.valueRef,
        tabId: req?.tabId,
        status: "CANCELLED",
        executed: false,
        verified: false,
        attempts: currentAttempt + 1,
        error: signal.reason ? String(signal.reason) : "Action cancelled before attempt",
      };
    }

    retryAttemptTracker.set(actionId, currentAttempt);

    let result: ActionExecutionLifecycleResult;
    try {
      result = await withTimeout(
        executeAndVerifyAction(req, expectedTaskId, currentAttempt, signal),
        timeoutMs,
        `Action ${actionId} timed out after ${timeoutMs}ms`,
        signal
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isCancelled = errMsg.toLowerCase().includes("cancel") || signal?.aborted;
      const isInterruption =
        errMsg.includes("CONTENT_SCRIPT_UNAVAILABLE") ||
        errMsg.includes("EXECUTION_CONTEXT_LOST") ||
        errMsg.includes("TAB_UNAVAILABLE") ||
        errMsg.includes("MESSAGE_CHANNEL_LOST") ||
        errMsg.includes("PAGE_RELOADED");

      result = {
        actionId,
        taskId: req?.taskId ?? expectedTaskId,
        stepId: req?.stepId ?? 0,
        action: req?.action ?? "wait",
        valueRef: req?.valueRef,
        tabId: req?.tabId,
        status: isCancelled ? "CANCELLED" : isInterruption ? "INTERRUPTED" : "TIMEOUT",
        executed: false,
        verified: false,
        attempts: currentAttempt + 1,
        error: errMsg,
      };
      return result;
    }

    result.attempts = currentAttempt + 1;

    // Return immediately if verified or if validation failed deterministically or cancelled
    if (result.verified || result.status === "VALIDATION_FAILED" || result.status === "CANCELLED") {
      return result;
    }

    // If not executed and failure is non-retryable, return immediately
    if (!result.executed && !isLifecycleInterruptionRetryable(result.error)) {
      return result;
    }

    // Evaluate Role 5 recovery decision or retryable lifecycle event
    const shouldRetry = result.recovery?.shouldRetry === true || isLifecycleInterruptionRetryable(result.error);
    if (!shouldRetry || currentAttempt >= maxAttempts || signal?.aborted) {
      if (currentAttempt > 0 && currentAttempt >= maxAttempts && !result.verified) {
        result.status = "RETRY_EXHAUSTED";
        result.error = result.error || `Retry budget exhausted after ${currentAttempt + 1} attempts`;
      }
      return result;
    }

    // Allow bounded retry step: clear deduplication tracker for this action ID to re-verify
    verifiedActionSet.delete(actionId);
    currentAttempt++;

    // Transient backoff before retry attempt
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  return {
    actionId,
    taskId: req?.taskId ?? expectedTaskId,
    stepId: req?.stepId ?? 0,
    action: req?.action ?? "wait",
    valueRef: req?.valueRef,
    tabId: req?.tabId,
    status: "RETRY_EXHAUSTED",
    executed: false,
    verified: false,
    attempts: currentAttempt,
    error: `Retry budget exhausted after ${currentAttempt} attempts`,
  };
}
