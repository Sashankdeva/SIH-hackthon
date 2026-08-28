export type ActionType = "click" | "type" | "type_secret" | "scroll" | "navigate" | "keypress" | "wait" | "done";


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
