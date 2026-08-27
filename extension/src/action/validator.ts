import { resolveElement } from "../perception/domCapture";
import type { ActionRequest, ActionValidationResult } from "./types";

const ALLOWED_ACTIONS = new Set<ActionRequest["action"]>([
  "click",
  "type",
  "type_secret",
  "scroll",
  "navigate",
  "keypress",
  "wait",
]);

const MIN_CONFIDENCE = 0.5;

/**
 * Every action returned by the server passes through here before
 * execution. Reject anything that doesn't check out — never execute on
 * trust alone. See PS26171_Role1_Extension.pdf, Day 2.
 */
export function validateAction(req: ActionRequest, expectedTaskId: string): ActionValidationResult {
  if (!ALLOWED_ACTIONS.has(req.action)) {
    return { ok: false, reason: `Unknown action type: ${req.action}` };
  }
  if (req.taskId !== expectedTaskId) {
    return { ok: false, reason: "Action targets a different task/session — rejected." };
  }
  if (req.confidence < MIN_CONFIDENCE) {
    return { ok: false, reason: `Confidence ${req.confidence} below threshold ${MIN_CONFIDENCE}.` };
  }
  if (req.action === "click" || req.action === "type" || req.action === "type_secret") {
    if (req.elementId == null) {
      return { ok: false, reason: "Missing elementId for element-targeted action." };
    }
    if (!resolveElement(req.elementId)) {
      return { ok: false, reason: `Element ${req.elementId} not found — page may have changed since capture.` };
    }
  }
  if (req.action === "navigate" && !req.url) {
    return { ok: false, reason: "Missing url for navigate action." };
  }
  return { ok: true };
}
