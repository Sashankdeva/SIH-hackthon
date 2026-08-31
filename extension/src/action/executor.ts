import { resolveElement } from "../perception/domCapture";
import { isNativeSelect } from "../perception/interactive";
import { resolveSecret } from "../privacy/secretStore";
import { resolveFromProfile } from "../privacy/profileStore";
import type { ActionRequest } from "./types";

/**
 * Generic safe activation for a click target.
 *
 * Standard HTMLElements keep their existing behaviour (`el.click()` — fires the
 * default action for buttons, links, submit inputs). SVG interactive controls
 * (`<svg role="button">`, `<a>` inside SVG, `<use>`-based icons) do NOT expose
 * HTMLElement.click(), so `.click()` on them throws; for those we synthesise a
 * pointer/mouse/click event sequence.
 *
 * If neither path is possible the target is not safely clickable — throw a
 * typed error so the pipeline records a real execution failure rather than a
 * false success.
 */
function safeClick(el: Element | null): void {
  if (!el) throw new Error("click_target_missing");

  const maybeClick = (el as unknown as { click?: unknown }).click;
  if (typeof maybeClick === "function") {
    (maybeClick as () => void).call(el);
    return;
  }

  if (typeof el.dispatchEvent === "function") {
    const EventCtor: typeof MouseEvent | typeof Event | undefined =
      typeof MouseEvent !== "undefined" ? MouseEvent
      : typeof Event !== "undefined" ? Event
      : undefined;
    if (!EventCtor) throw new Error("click_target_not_clickable");
    const init = { bubbles: true, cancelable: true, composed: true } as EventInit;
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      try {
        el.dispatchEvent(new (EventCtor as typeof Event)(type, init));
      } catch {
        // A given event type may be unsupported by the environment — the
        // trailing "click" is the one that matters and is dispatched last.
      }
    }
    return;
  }

  throw new Error("click_target_not_clickable");
}

/**
 * Deterministic native <select> option selection. Matches the requested value
 * against option `value` then visible text (exact, then case-insensitive).
 * Dispatches input + change. Never opens the native picker; never guesses.
 * Returns true when an option was selected.
 */
function selectOptionByValue(el: Element, requested: string): boolean {
  const sel = el as unknown as HTMLSelectElement;
  const options: HTMLOptionElement[] = sel.options
    ? Array.from(sel.options as unknown as ArrayLike<HTMLOptionElement>)
    : Array.from((el.querySelectorAll?.("option") ?? []) as unknown as ArrayLike<HTMLOptionElement>);
  if (options.length === 0) return false;

  const want = requested.replace(/\s+/g, " ").trim();
  const wantLc = want.toLowerCase();
  const text = (o: HTMLOptionElement) => (o.textContent ?? "").replace(/\s+/g, " ").trim();
  const value = (o: HTMLOptionElement) => o.getAttribute("value") ?? text(o);

  const match =
    options.find((o) => value(o) === requested) ||
    options.find((o) => text(o) === want) ||
    options.find((o) => value(o).toLowerCase() === wantLc) ||
    options.find((o) => text(o).toLowerCase() === wantLc);

  if (!match) return false;

  try {
    sel.value = value(match);
  } catch {
    // fall back to the option's own selected flag
  }
  try {
    (match as unknown as { selected?: boolean }).selected = true;
  } catch {
    // non-fatal
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

/**
 * Returns the *prototype* `value` setter for a native input/textarea, bound to
 * `el`, or null when the environment has no such descriptor (e.g. test fakes
 * where `value` is a plain instance field).
 *
 * WHY: React / Vue / Svelte / Angular install their own `value` accessor on the
 * element INSTANCE and use a change-tracker keyed on the prototype descriptor.
 * Writing through the instance setter (`el.value = x`) updates that tracker in
 * lock-step, so on the resulting `input` event the framework sees
 * `tracker === node.value` and treats it as "no external change" — the app
 * state never updates and the next render reverts the DOM. Calling the
 * prototype's native setter directly bypasses the instance accessor: the real
 * DOM value changes while the tracker stays stale, so the framework's `input`
 * handler detects a genuine external change and commits it. This is the same
 * mechanism React Testing Library / user-event use.
 */
function nativeValueSetter(el: Element): ((value: string) => void) | null {
  // Cross-realm safe: `instanceof` fails for elements from a same-origin child
  // frame (different realm). Resolve the prototype from the element's OWN realm.
  const tag = (el.tagName || "").toLowerCase();
  if (tag !== "input" && tag !== "textarea") return null;
  const win = (el.ownerDocument?.defaultView ?? null) as
    | (Window & typeof globalThis)
    | null;
  const Ctor =
    tag === "textarea"
      ? win?.HTMLTextAreaElement ?? (typeof HTMLTextAreaElement !== "undefined" ? HTMLTextAreaElement : null)
      : win?.HTMLInputElement ?? (typeof HTMLInputElement !== "undefined" ? HTMLInputElement : null);
  if (!Ctor) return null;
  const desc = Object.getOwnPropertyDescriptor(Ctor.prototype, "value");
  if (desc && typeof desc.set === "function") {
    const set = desc.set;
    return (value: string) => set.call(el, value);
  }
  return null;
}

/** Bubbling `input` event — `InputEvent` when available, plain `Event` otherwise. */
function dispatchInputEvent(el: Element): void {
  let ev: Event;
  try {
    ev = typeof InputEvent === "function"
      ? new InputEvent("input", { bubbles: true, cancelable: false })
      : new Event("input", { bubbles: true });
  } catch {
    ev = new Event("input", { bubbles: true });
  }
  el.dispatchEvent(ev);
}

/**
 * Injects text into a validated DOM target (input, textarea, or contenteditable)
 * with full event signaling (focus -> input -> change -> blur) for modern SPA compatibility.
 *
 * Native inputs/textareas are written through the prototype value setter (see
 * nativeValueSetter) so framework-controlled inputs actually keep the value.
 * The contenteditable branch is unchanged.
 */
function injectTextIntoElement(el: Element, text: string): void {
  const tag = (el.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea") {
    const input = el as HTMLInputElement | HTMLTextAreaElement;
    try { input.focus(); } catch { /* focus is best-effort */ }
    const setter = nativeValueSetter(el);
    if (setter) setter(text);
    else input.value = text;
    dispatchInputEvent(el);
    el.dispatchEvent(new Event("change", { bubbles: true }));
    try { input.blur(); } catch { /* blur is best-effort */ }
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
      safeClick(el);
      return;
    }
    case "type": {
      const el = resolveElement(req.elementId!);
      if (el) {
        // A native <select> reached here means "choose the option matching
        // this value" — the validator allows `type` on selects for exactly
        // this. Everything else is text injection.
        if (isNativeSelect(el)) {
          selectOptionByValue(el, req.value ?? "");
        } else {
          injectTextIntoElement(el, req.value ?? "");
        }
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
