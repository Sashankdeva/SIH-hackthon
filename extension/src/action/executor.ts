import { resolveElement } from "../perception/domCapture";
import { resolveLocalSecret } from "./secretStore";
import type { ActionRequest } from "./types";

/**
 * Injects text into a validated DOM target (input, textarea, or contenteditable)
 * with full event signaling (focus -> input -> change -> blur) for modern SPA compatibility.
 */
function injectTextIntoElement(el: Element, text: string): void {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.focus();
    el.value = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.blur();
    return;
  }

  if (
    (el as HTMLElement).isContentEditable === true ||
    el.getAttribute("contenteditable") === "true" ||
    el.getAttribute("contenteditable") === ""
  ) {
    (el as HTMLElement).focus();
    (el as HTMLElement).textContent = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    (el as HTMLElement).blur();
    return;
  }
}

/**
 * Maps a validated ActionRequest to real browser interaction.
 * Never call this on an unvalidated request — see validator.ts.
 * See PS26171_Role1_Extension.pdf, Day 2.
 */
export async function executeAction(req: ActionRequest): Promise<void> {
  switch (req.action) {
    case "click": {
      const el = resolveElement(req.elementId!);
      (el as HTMLElement | null)?.click();
      return;
    }
    case "type": {
      const el = resolveElement(req.elementId!);
      if (el) {
        injectTextIntoElement(el, req.value ?? "");
      }
      return;
    }
    case "type_secret": {
      // The real secret is resolved from local session storage via valueRef — it
      // never travels through the server response or any caller of this
      // function. See PS26171 Structured Action Protocol: "Secret-safe typing."
      const el = resolveElement(req.elementId!);
      const secret = await resolveLocalSecret(req.valueRef ?? "");
      if (el && secret != null) {
        injectTextIntoElement(el, secret);
      }
      return;
    }
    case "scroll": {
      const delta = req.amount ?? 400;
      let top = 0;
      let left = 0;
      if (req.direction === "up") top = -delta;
      else if (req.direction === "down") top = delta;
      else if (req.direction === "left") left = -delta;
      else if (req.direction === "right") left = delta;
      else top = delta; // default to down

      window.scrollBy({ top, left, behavior: "smooth" });
      return;
    }
    case "navigate": {
      // Protocol validation is handled by validateAction() in validator.ts.
      // executeAction() is only invoked after validateAction() passes.
      if (req.url) {
        location.href = req.url;
      }
      return;
    }
    case "keypress": {
      const key = req.value ?? "Enter";
      const eventInit: KeyboardEventInit = {
        key,
        code: key,
        bubbles: true,
        cancelable: true,
      };
      const active = document.activeElement ?? document.body;
      active.dispatchEvent(new KeyboardEvent("keydown", eventInit));
      active.dispatchEvent(new KeyboardEvent("keyup", eventInit));
      return;
    }
    case "wait": {
      const ms = Math.min(req.amount ?? 1000, 5000);
      await new Promise((resolve) => setTimeout(resolve, ms));
      return;
    }
    default: {
      const _exhaustive: never = req.action;
      console.warn(`[executor] unhandled action type: ${_exhaustive}`);
    }
  }
}
