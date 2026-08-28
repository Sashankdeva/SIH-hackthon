import { resolveElement } from "../perception/domCapture";
import { resolveSecret } from "../privacy/secretStore";
import { resolveFromProfile } from "../privacy/profileStore";
import type { ActionRequest } from "./types";

/**
 * Two local sources, in priority order, for the real value behind a
 * redaction token — neither of which the server can see:
 *  1. secretStore — a value already present on this page (a password
 *     the user had typed), captured at redaction time.
 *  2. profileStore — the user's own saved details (name, email, phone,
 *     address), entered once in the popup.
 * Chrome exposes no API for reading its own saved autofill data, so 2
 * is our own store rather than the browser's — see profileStore.ts.
 */
async function resolveLocalValue(token: string): Promise<string | null> {
  return resolveSecret(token) ?? (await resolveFromProfile(token));
}

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
      // The real secret is resolved locally via valueRef (the redaction
      // token) — it was captured off the DOM at redaction time
      // (privacy/sanitizedContext.ts:captureSecrets) and never appeared
      // in the server request or response. See PS26171 Structured
      // Action Protocol: "Secret-safe typing."
      const el = resolveElement(req.elementId!) as HTMLInputElement | null;
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
