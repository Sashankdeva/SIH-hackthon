import { resolveElement } from "../perception/domCapture";
import type { ActionRequest } from "./types";

/**
 * Maps a validated ActionRequest to real browser interaction. Never call
 * this on an unvalidated request — see validator.ts. See
 * PS26171_Role1_Extension.pdf, Day 2.
 */
export async function executeAction(req: ActionRequest): Promise<void> {
  switch (req.action) {
    case "click": {
      const el = resolveElement(req.elementId!);
      (el as HTMLElement | null)?.click();
      return;
    }
    case "type": {
      const el = resolveElement(req.elementId!) as HTMLInputElement | null;
      if (el) {
        el.focus();
        el.value = req.value ?? "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
      return;
    }
    case "type_secret": {
      // The real secret is resolved from local storage via valueRef — it
      // never travels through the server response or any caller of this
      // function. See PS26171 Structured Action Protocol: "Secret-safe typing."
      const el = resolveElement(req.elementId!) as HTMLInputElement | null;
      const secret = await resolveLocalSecret(req.valueRef ?? "");
      if (el && secret != null) {
        el.focus();
        el.value = secret;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
      return;
    }
    case "scroll": {
      const delta = req.amount ?? 400;
      window.scrollBy({ top: req.direction === "up" ? -delta : delta, behavior: "smooth" });
      return;
    }
    case "navigate": {
      if (req.url) location.href = req.url;
      return;
    }
    case "keypress": {
      if (req.value) {
        document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: req.value, bubbles: true }));
      }
      return;
    }
    case "wait": {
      await new Promise((resolve) => setTimeout(resolve, req.amount ?? 500));
      return;
    }
  }
}

async function resolveLocalSecret(_valueRef: string): Promise<string | null> {
  // Stub for this sprint — real implementation resolves against a
  // locally-scoped secret store whose contents the server never sees.
  return null;
}
