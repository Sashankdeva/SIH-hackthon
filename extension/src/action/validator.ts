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
  "done",
]);

const MIN_CONFIDENCE = 0.5;

/**
 * Validates whether a navigation URL uses a safe, permitted protocol.
 * Disallows dangerous pseudo-protocols like javascript:, data:, vbscript:, file:.
 */
export function isSafeNavigationUrl(rawUrl: string): boolean {
  if (!rawUrl || typeof rawUrl !== "string") return false;
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;

  // Strip control characters and check scheme prefix
  const sanitized = trimmed.replace(/[\x00-\x1F\x7F]/g, "").toLowerCase();
  if (
    sanitized.startsWith("javascript:") ||
    sanitized.startsWith("data:") ||
    sanitized.startsWith("vbscript:") ||
    sanitized.startsWith("file:")
  ) {
    return false;
  }

  try {
    const base = typeof location !== "undefined" && location.href ? location.href : "http://localhost/";
    const parsed = new URL(trimmed, base);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Checks if a target DOM element is an editable text control.
 */
function isEditableTarget(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === "textarea") return true;
  if (tag === "input") {
    const nonTextTypes = new Set(["button", "submit", "reset", "image", "hidden", "checkbox", "radio", "file"]);
    const inputType = ((el as HTMLInputElement).type || "text").toLowerCase();
    return !nonTextTypes.has(inputType);
  }
  if ((el as HTMLElement).isContentEditable === true) return true;
  const contentEditableAttr = el.getAttribute?.("contenteditable");
  return contentEditableAttr === "true" || contentEditableAttr === "";
}

/**
 * Checks if a target DOM element or its enclosing fieldset is disabled.
 */
function isElementDisabled(el: Element): boolean {
  if ((el as HTMLInputElement).disabled === true) {
    return true;
  }
  if (el.getAttribute?.("aria-disabled") === "true") {
    return true;
  }
  if (el.hasAttribute?.("disabled")) {
    return true;
  }
  return el.closest?.("fieldset[disabled]") != null;
}

/**
 * Checks if a target DOM element is readonly.
 */
function isElementReadonly(el: Element): boolean {
  if ((el as HTMLInputElement).readOnly === true) {
    return true;
  }
  if (el.getAttribute?.("aria-readonly") === "true") {
    return true;
  }
  if (el.hasAttribute?.("readonly")) {
    return true;
  }
  return false;
}

/**
 * Every action returned by the server passes through here before
 * execution. Reject anything that doesn't check out — never execute on
 * trust alone. See PS26171_Role1_Extension.pdf, Day 2.
 */
export function validateAction(req: ActionRequest, expectedTaskId: string): ActionValidationResult {
  if (!req || typeof req !== "object") {
    return { ok: false, reason: "Malformed action request payload." };
  }

  if (!ALLOWED_ACTIONS.has(req.action)) {
    return { ok: false, reason: `Unknown action type: ${req.action}` };
  }

  if (req.taskId !== expectedTaskId) {
    return { ok: false, reason: "Action targets a different task/session — rejected." };
  }

  if (typeof req.confidence !== "number" || isNaN(req.confidence) || req.confidence < MIN_CONFIDENCE) {
    return { ok: false, reason: `Confidence ${req.confidence} below threshold ${MIN_CONFIDENCE}.` };
  }

  // Element-targeted actions
  if (req.action === "click" || req.action === "type" || req.action === "type_secret") {
    if (req.elementId == null || typeof req.elementId !== "number") {
      return { ok: false, reason: "Missing elementId for element-targeted action." };
    }

    const el = resolveElement(req.elementId);
    if (!el) {
      return { ok: false, reason: `Element ${req.elementId} not found — page may have changed since capture.` };
    }

    if (isElementDisabled(el)) {
      return { ok: false, reason: `Target element ${req.elementId} is disabled.` };
    }

    if (req.action === "type" || req.action === "type_secret") {
      if (isElementReadonly(el)) {
        return { ok: false, reason: `Target element ${req.elementId} is readonly.` };
      }

      if (!isEditableTarget(el)) {
        return {
          ok: false,
          reason: `Element ${req.elementId} (<${el.tagName.toLowerCase()}>) is not an editable text input.`,
        };
      }
    }

    if (req.action === "type_secret") {
      if (!req.valueRef || typeof req.valueRef !== "string" || req.valueRef.trim() === "") {
        return { ok: false, reason: "Missing or empty valueRef for type_secret action." };
      }
    }
  }

  if (req.action === "navigate") {
    if (!req.url || typeof req.url !== "string" || req.url.trim() === "") {
      return { ok: false, reason: "Missing url for navigate action." };
    }
    if (!isSafeNavigationUrl(req.url)) {
      return { ok: false, reason: `Unsafe or disallowed navigation URL: ${req.url}` };
    }
  }

  if (req.action === "scroll") {
    if (req.direction && !["up", "down", "left", "right"].includes(req.direction)) {
      return { ok: false, reason: `Invalid scroll direction: ${req.direction}` };
    }
    if (req.amount != null && (typeof req.amount !== "number" || isNaN(req.amount) || req.amount < 0)) {
      return { ok: false, reason: `Invalid scroll amount: ${req.amount}` };
    }
  }

  if (req.action === "wait") {
    if (req.amount != null && (typeof req.amount !== "number" || isNaN(req.amount) || req.amount < 0)) {
      return { ok: false, reason: `Invalid wait amount: ${req.amount}` };
    }
  }

  return { ok: true };
}
