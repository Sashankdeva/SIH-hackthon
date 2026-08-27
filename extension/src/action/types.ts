export type ActionType = "click" | "type" | "type_secret" | "scroll" | "navigate" | "keypress" | "wait";

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
}

export interface ActionValidationResult {
  ok: boolean;
  reason?: string;
}
