import type { StepRecord } from "../privacy/sanitizedContext";

export type ActionType = "click" | "type" | "type_secret" | "scroll" | "navigate" | "keypress" | "wait" | "done";

export type TaskStatus = "active" | "navigating" | "completed" | "failed" | "cancelled";

/**
 * Structured diagnostics for the most recent task failure. Persisted on
 * activeTask so the popup (and anything reading storage) can see which layer
 * failed and why — not just the collapsed one-liner in `lastDetail`.
 *
 * Every field here is safe to display: codes are slugs, `detail` is bounded
 * and never carries a raw response body or a raw typed value.
 */
export interface TaskFailureInfo {
  /** Which layer of the pipeline produced the failure. */
  stage:
    | "reasoning_server"
    | "model_response"
    | "action_validation"
    | "action_execution"
    | "verification"
    | "task_loop";
  /** Machine-readable reason (StepFailureReason, or a task-loop reason). */
  reason: string;
  /** Short, safe, human-readable cause code / message. */
  detail?: string;
  /** HTTP status from the /reason call, when stage === "reasoning_server". */
  httpStatus?: number | null;
  /** Safe slug from the server error body, when available. */
  serverErrorCode?: string;
  /** 1-based step number the failure occurred on. */
  step: number;
  /** Epoch ms when the failure was recorded. */
  at: number;
}

export interface ActiveTaskState {
  taskId: string;
  task: string;
  taskStartedAt: number;
  stepNumber: number;
  history: StepRecord[];
  status: TaskStatus;
  updatedAt: number;
  lastDetail?: string;
  /** Set whenever `status === "failed"`; carries the typed failure classification. */
  failure?: TaskFailureInfo;
  tabId?: number | null;
  /**
   * C7 — the step number that has been DISPATCHED to the pipeline but whose
   * outcome has not yet been recorded in `history`. Persisted before the step's
   * side-effecting work so that if a lifecycle event (navigation, crash, BFCache)
   * interrupts the step, the resumed loop can tell "step not started" apart from
   * "step started, outcome unknown" and NEVER re-execute it.
   */
  pendingStep?: number;
}


export type LifecycleInterruptionReason =
  | "CONTENT_SCRIPT_UNAVAILABLE"
  | "TAB_UNAVAILABLE"
  | "WRONG_TAB_IDENTITY"
  | "EXECUTION_CONTEXT_LOST"
  | "MESSAGE_CHANNEL_LOST"
  | "PAGE_RELOADED"
  | "UNEXPECTED_NAVIGATION";

/** Mirrors shared/schemas/action.schema.json — keep both in sync. */
export interface ActionRequest {
  action: ActionType;
  elementId?: number | null;
  value?: string | null;
  valueRef?: string | null;
  direction?: "up" | "down" | "left" | "right" | null;
  amount?: number | null;
  url?: string | null;
  confidence: number;
  taskId: string;
  stepId: number;
  tabId?: number | null;
}

export interface ActionValidationResult {
  ok: boolean;
  reason?: string;
}

/** Wire format adhering strictly to shared/schemas/action.schema.json */
export interface WireActionResponse {
  action: ActionType;
  element_id?: number | null;
  value?: string | null;
  value_ref?: string | null;
  direction?: "up" | "down" | "left" | "right" | null;
  amount?: number | null;
  url?: string | null;
  confidence: number;
  task_id: string;
  step_id: number;
  tab_id?: number | null;
}

/** Converts wire snake_case ActionResponse to client camelCase ActionRequest */
export function fromWireActionResponse(wire: WireActionResponse): ActionRequest {
  return {
    action: wire.action,
    elementId: wire.element_id,
    value: wire.value,
    valueRef: wire.value_ref,
    direction: wire.direction,
    amount: wire.amount,
    url: wire.url,
    confidence: wire.confidence,
    taskId: wire.task_id,
    stepId: wire.step_id,
    tabId: wire.tab_id,
  };
}
