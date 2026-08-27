import type { ActionRequest, LifecycleInterruptionReason } from "./types";
import {
  executeWithBoundedRetry,
  cleanupActionTracker,
  isLifecycleInterruptionRetryable,
  type ActionExecutionLifecycleResult,
  MAX_RETRY_ATTEMPTS,
  DEFAULT_ACTION_TIMEOUT_MS,
} from "./verifier";

export type SessionState =
  | "IDLE"
  | "RUNNING"
  | "VERIFYING"
  | "RETRYING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "TIMED_OUT"
  | "INTERRUPTED";

export const TERMINAL_SESSION_STATES: ReadonlySet<SessionState> = new Set([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
  "INTERRUPTED",
]);

export interface ExecutionSession {
  taskId: string;
  tabId: number | null;
  state: SessionState;
  activeStepId: number | null;
  activeActionId: string | null;
  abortController: AbortController;
  startedAt: number;
  lastUpdatedAt: number;
  lastResult?: ActionExecutionLifecycleResult;
  queue: Promise<ActionExecutionLifecycleResult | null>;
}

// In-memory registry of active execution sessions, scoped strictly by taskId
const sessionRegistry = new Map<string, ExecutionSession>();

/**
 * Retrieves an existing execution session or creates a new one in IDLE state.
 */
export function getOrCreateSession(taskId: string, tabId?: number | null): ExecutionSession {
  let session = sessionRegistry.get(taskId);
  if (!session) {
    session = {
      taskId,
      tabId: tabId ?? null,
      state: "IDLE",
      activeStepId: null,
      activeActionId: null,
      abortController: new AbortController(),
      startedAt: Date.now(),
      lastUpdatedAt: Date.now(),
      queue: Promise.resolve(null),
    };
    sessionRegistry.set(taskId, session);
  } else if (tabId != null && session.tabId == null) {
    session.tabId = tabId;
  }
  return session;
}

/**
 * Checks whether a session exists for the given taskId.
 */
export function getSession(taskId: string): ExecutionSession | undefined {
  return sessionRegistry.get(taskId);
}

/**
 * Checks if a session has reached an immutable terminal state.
 */
export function isSessionTerminal(session: ExecutionSession): boolean {
  return TERMINAL_SESSION_STATES.has(session.state);
}

/**
 * Explicitly marks an active session as COMPLETED (terminal state).
 */
export function completeSession(taskId: string): ActionExecutionLifecycleResult {
  const session = getOrCreateSession(taskId);
  if (isSessionTerminal(session)) {
    return {
      actionId: session.activeActionId ?? `${taskId}-step-${session.activeStepId ?? 0}`,
      taskId,
      stepId: session.activeStepId ?? 0,
      action: session.lastResult?.action ?? "wait",
      valueRef: session.lastResult?.valueRef,
      tabId: session.tabId,
      status: session.state as any,
      executed: session.lastResult?.executed ?? false,
      verified: session.lastResult?.verified ?? false,
      attempts: session.lastResult?.attempts ?? 0,
      error: `Session already in terminal state: ${session.state}`,
    };
  }

  session.state = "COMPLETED";
  session.lastUpdatedAt = Date.now();
  const res: ActionExecutionLifecycleResult = {
    actionId: session.activeActionId ?? `${taskId}-step-${session.activeStepId ?? 0}`,
    taskId,
    stepId: session.activeStepId ?? 0,
    action: session.lastResult?.action ?? "wait",
    valueRef: session.lastResult?.valueRef,
    tabId: session.tabId,
    status: "VERIFIED",
    executed: true,
    verified: true,
    attempts: session.lastResult?.attempts ?? 1,
  };
  session.lastResult = res;
  return res;
}

/**
 * Safely cancels an active execution session.
 * Aborts any pending operations, prevents future retries, and moves to CANCELLED state.
 * Terminal states (COMPLETED, FAILED, CANCELLED, TIMED_OUT, INTERRUPTED) remain immutable.
 */
export function cancelSession(
  taskId: string,
  reason: string = "Session cancelled by caller"
): ActionExecutionLifecycleResult {
  const session = getOrCreateSession(taskId);

  // Terminal state protection: if already terminal, do not mutate state
  if (isSessionTerminal(session)) {
    return {
      actionId: session.activeActionId ?? `${taskId}-step-${session.activeStepId ?? 0}`,
      taskId,
      stepId: session.activeStepId ?? 0,
      action: session.lastResult?.action ?? "wait",
      valueRef: session.lastResult?.valueRef,
      tabId: session.tabId,
      status: session.state as any,
      executed: false,
      verified: false,
      attempts: session.lastResult?.attempts ?? 0,
      error: `Session already in terminal state: ${session.state}`,
    };
  }

  // Trigger cooperative abort signal
  session.abortController.abort(reason);
  session.state = "CANCELLED";
  session.lastUpdatedAt = Date.now();

  const cancelResult: ActionExecutionLifecycleResult = {
    actionId: session.activeActionId ?? `${taskId}-step-${session.activeStepId ?? 0}`,
    taskId,
    stepId: session.activeStepId ?? 0,
    action: session.lastResult?.action ?? "wait",
    valueRef: session.lastResult?.valueRef,
    tabId: session.tabId,
    status: "CANCELLED",
    executed: false,
    verified: false,
    attempts: 0,
    error: reason,
  };

  session.lastResult = cancelResult;
  return cancelResult;
}

/**
 * Safely interrupts an active session due to browser or lifecycle events
 * (e.g. content script disconnect, tab closed, page reloaded).
 * Moves to INTERRUPTED state and aborts active controller.
 */
export function interruptSession(
  taskId: string,
  reason: LifecycleInterruptionReason | string = "Execution interrupted by browser lifecycle change"
): ActionExecutionLifecycleResult {
  const session = getOrCreateSession(taskId);

  if (isSessionTerminal(session)) {
    return {
      actionId: session.activeActionId ?? `${taskId}-step-${session.activeStepId ?? 0}`,
      taskId,
      stepId: session.activeStepId ?? 0,
      action: session.lastResult?.action ?? "wait",
      valueRef: session.lastResult?.valueRef,
      tabId: session.tabId,
      status: session.state as any,
      executed: false,
      verified: false,
      attempts: session.lastResult?.attempts ?? 0,
      error: `Session already in terminal state: ${session.state}`,
    };
  }

  session.abortController.abort(reason);
  session.state = "INTERRUPTED";
  session.lastUpdatedAt = Date.now();

  const interruptResult: ActionExecutionLifecycleResult = {
    actionId: session.activeActionId ?? `${taskId}-step-${session.activeStepId ?? 0}`,
    taskId,
    stepId: session.activeStepId ?? 0,
    action: session.lastResult?.action ?? "wait",
    valueRef: session.lastResult?.valueRef,
    tabId: session.tabId,
    status: "INTERRUPTED",
    executed: false,
    verified: false,
    attempts: 0,
    error: reason,
  };

  session.lastResult = interruptResult;
  return interruptResult;
}

/**
 * Cleans up temporary resources for a task session (abort controllers, queue, and action tracking entries).
 */
export function cleanupSession(taskId: string): void {
  const session = sessionRegistry.get(taskId);
  if (session) {
    if (!session.abortController.signal.aborted) {
      session.abortController.abort("Session cleaned up");
    }
    sessionRegistry.delete(taskId);
  }
  cleanupActionTracker(taskId);
}

/**
 * Resets all session registries (used for test isolation).
 */
export function resetSessionRegistry(): void {
  for (const session of sessionRegistry.values()) {
    if (!session.abortController.signal.aborted) {
      session.abortController.abort("Reset all sessions");
    }
  }
  sessionRegistry.clear();
}

export { isLifecycleInterruptionRetryable };

/**
 * Executes an action serialized within the task's execution session.
 * Guarantees:
 * - Tab identity is verified (wrong tab identity immediately interrupted).
 * - Concurrent actions within the same session are queued sequentially.
 * - Cancelled, interrupted, or terminal sessions immediately reject new or pending actions.
 * - Stale callbacks from older attempts/steps cannot overwrite newer state.
 * - Terminal states (COMPLETED, FAILED, CANCELLED, TIMED_OUT, INTERRUPTED) are immutable.
 */
export async function runActionInSession(
  req: ActionRequest,
  expectedTaskId: string,
  maxAttempts: number = MAX_RETRY_ATTEMPTS,
  timeoutMs: number = DEFAULT_ACTION_TIMEOUT_MS
): Promise<ActionExecutionLifecycleResult> {
  const taskId = req?.taskId ?? expectedTaskId;
  const session = getOrCreateSession(taskId, req?.tabId);
  const actionId = `${req?.taskId ?? expectedTaskId}-step-${req?.stepId ?? 0}`;

  // Terminal state protection: reject actions on terminal sessions
  if (isSessionTerminal(session)) {
    return {
      actionId,
      taskId,
      stepId: req?.stepId ?? 0,
      action: req?.action ?? "wait",
      valueRef: req?.valueRef,
      tabId: req?.tabId ?? session.tabId,
      status: session.state as any,
      executed: false,
      verified: false,
      attempts: 0,
      error: `Session is already in terminal state: ${session.state}`,
    };
  }

  // Tab Identity Protection: verify single-tab execution continuity
  if (session.tabId != null && req?.tabId != null && session.tabId !== req.tabId) {
    return {
      actionId,
      taskId,
      stepId: req?.stepId ?? 0,
      action: req?.action ?? "wait",
      valueRef: req?.valueRef,
      tabId: req.tabId,
      status: "INTERRUPTED",
      executed: false,
      verified: false,
      attempts: 0,
      error: `WRONG_TAB_IDENTITY: Action targeting tab ${req.tabId} rejected by session bound to tab ${session.tabId}`,
    };
  }

  // Check cancellation before queuing
  if (session.abortController.signal.aborted || session.state === "CANCELLED") {
    return {
      actionId,
      taskId,
      stepId: req?.stepId ?? 0,
      action: req?.action ?? "wait",
      valueRef: req?.valueRef,
      tabId: req?.tabId ?? session.tabId,
      status: "CANCELLED",
      executed: false,
      verified: false,
      attempts: 0,
      error: session.abortController.signal.reason
        ? String(session.abortController.signal.reason)
        : "Session is cancelled",
    };
  }

  // Duplicate in-flight action protection
  if (session.state === "RUNNING" && session.activeActionId === actionId) {
    return {
      actionId,
      taskId,
      stepId: req?.stepId ?? 0,
      action: req?.action ?? "wait",
      valueRef: req?.valueRef,
      tabId: req?.tabId ?? session.tabId,
      status: "DUPLICATE_PREVENTED",
      executed: false,
      verified: false,
      attempts: 0,
      error: `Duplicate action ${actionId} is already executing in this session`,
    };
  }

  // Queue task serialized per session
  const executeStep = async (): Promise<ActionExecutionLifecycleResult> => {
    // Check if session was cancelled or interrupted while in queue
    if (session.abortController.signal.aborted || isSessionTerminal(session)) {
      return (
        session.lastResult ?? {
          actionId,
          taskId,
          stepId: req?.stepId ?? 0,
          action: req?.action ?? "wait",
          valueRef: req?.valueRef,
          tabId: req?.tabId ?? session.tabId,
          status: (session.state === "CANCELLED" ? "CANCELLED" : session.state) as any,
          executed: false,
          verified: false,
          attempts: 0,
          error: "Session cancelled, interrupted, or finalized while action was queued",
        }
      );
    }

    session.state = "RUNNING";
    session.activeStepId = req?.stepId ?? 0;
    session.activeActionId = actionId;
    session.lastUpdatedAt = Date.now();

    // Execute with bounded retry & abort signal
    const result = await executeWithBoundedRetry(
      req,
      expectedTaskId,
      maxAttempts,
      timeoutMs,
      session.abortController.signal
    );

    // Check lifecycle interruption first
    if ((session.state as SessionState) === "INTERRUPTED" || result.status === "INTERRUPTED") {
      const interruptedResult: ActionExecutionLifecycleResult = {
        actionId: result.actionId,
        taskId: result.taskId,
        stepId: result.stepId,
        action: result.action,
        valueRef: result.valueRef,
        tabId: result.tabId ?? session.tabId,
        status: "INTERRUPTED",
        executed: result.executed,
        verified: false,
        attempts: result.attempts,
        error: result.error || "Action interrupted by browser lifecycle event",
      };
      session.state = "INTERRUPTED";
      session.lastResult = interruptedResult;
      return interruptedResult;
    }

    // Stale callback & cancellation domination check
    if (session.abortController.signal.aborted || (session.state as SessionState) === "CANCELLED" || result.status === "CANCELLED") {
      const cancelledResult: ActionExecutionLifecycleResult = {
        actionId: result.actionId,
        taskId: result.taskId,
        stepId: result.stepId,
        action: result.action,
        valueRef: result.valueRef,
        tabId: result.tabId ?? session.tabId,
        status: "CANCELLED",
        executed: result.executed,
        verified: false,
        attempts: result.attempts,
        error: "Action cancelled during execution",
      };
      session.state = "CANCELLED";
      session.lastResult = cancelledResult;
      return cancelledResult;
    }

    // Update session state based on execution outcome
    if (result.verified) {
      session.state = "IDLE"; // Ready for next sequential action step
    } else if (result.status === "TIMEOUT") {
      session.state = "TIMED_OUT";
    } else {
      session.state = "FAILED";
    }

    session.lastUpdatedAt = Date.now();
    session.lastResult = result;
    return result;
  };

  session.queue = session.queue.then(executeStep, executeStep);
  const finalResult = await session.queue;
  return finalResult!;
}
