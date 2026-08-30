import { resolveElement } from "../perception/domCapture";
import { resolveSecret } from "../privacy/secretStore";
import { resolveFromProfile } from "../privacy/profileStore";
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
 * Resolves local secret values in priority order:
 *  1. privacy/secretStore (sync, in-memory secrets captured from page session)
 *  2. profileStore (user's saved details from extension popup)
 */
async function resolveLocalValue(token: string): Promise<string | null> {
  const secret = resolveSecret(token);
  if (secret != null) return secret;
  return await resolveFromProfile(token);
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
      // The real secret is resolved locally via valueRef (the redaction token)
      // and never appears in the server request or response.
      const el = resolveElement(req.elementId!);
      const secret = await resolveLocalValue(req.valueRef ?? "");
      if (!el) {
        console.warn("[executor] type_secret target element not found:", req.elementId);
      } else if (secret == null) {
        console.warn(
          "[executor] no local value for",
          req.valueRef,
          "— add your details in the extension popup to auto-fill this field."
        );
      } else {
        injectTextIntoElement(el, secret);
      }
      return;
    }
    case "done": {
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
      const rawKey = req.value && req.value.trim() !== "" ? req.value.trim() : "Enter";

      // Parse optional modifier combinations (e.g. "Ctrl+Enter", "Shift+Tab", "Alt+ArrowDown", "Meta+K")
      const parts = rawKey.split("+").map((p) => p.trim()).filter(Boolean);
      let baseKey = parts.length > 0 ? parts[parts.length - 1] : "Enter";
      let ctrlKey = false;
      let shiftKey = false;
      let altKey = false;
      let metaKey = false;

      if (parts.length > 1) {
        for (let i = 0; i < parts.length - 1; i++) {
          const mod = parts[i].toLowerCase();
          if (mod === "ctrl" || mod === "control") ctrlKey = true;
          else if (mod === "shift") shiftKey = true;
          else if (mod === "alt") altKey = true;
          else if (mod === "meta" || mod === "cmd" || mod === "command") metaKey = true;
        }
      } else {
        baseKey = rawKey;
      }

      let target: Element = document.activeElement ?? document.body;
      if (req.elementId != null) {
        const el = resolveElement(req.elementId);
        if (el) {
          (el as HTMLElement).focus?.();
          target = el;
        }
      }

      const eventInit: KeyboardEventInit = {
        key: baseKey,
        code: baseKey,
        ctrlKey,
        shiftKey,
        altKey,
        metaKey,
        bubbles: true,
        cancelable: true,
      };
      target.dispatchEvent(new KeyboardEvent("keydown", eventInit));
      target.dispatchEvent(new KeyboardEvent("keyup", eventInit));
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
