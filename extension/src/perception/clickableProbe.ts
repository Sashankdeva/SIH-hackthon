/**
 * MAIN-world clickable probe.
 *
 * Many frameworks render their primary actions as plain <div>s with no role,
 * no tabindex, no href, no ARIA and no `cursor: pointer` — the click handler is
 * attached programmatically. From the isolated world those are indistinguishable
 * from layout containers, so real actions were invisible to perception while
 * scraping every <div> would flood the context with false positives.
 *
 * The evidence DOES exist, but only in the page's own world:
 *   - React/Preact/RN-web expose a props object on the node (`__reactProps$…`)
 *     whose `onClick` is a real function;
 *   - anything else that registers a click listener goes through
 *     `EventTarget.prototype.addEventListener`, which we wrap at document_start.
 *
 * This module runs in the MAIN world (see vision-main/index.ts) and marks the
 * element that OWNS a click handler with a plain DOM attribute. Attributes are
 * shared across worlds, so the isolated-world classifier can read it. Only the
 * handler owner is marked, so nested wrappers do not produce duplicates.
 *
 * Framework-generic: no hostnames, URLs, class names, or label matching. It
 * reports what the page itself declared, and every marked element still has to
 * pass the ordinary visibility, naming, privacy and budget rules downstream.
 */

export const CLICKABLE_ATTR = "data-privy-clickable";

/** Elements that already carry their own semantics need no marking. */
const ALREADY_SEMANTIC = "a[href], area[href], button, input, select, textarea, summary, [role], [contenteditable], [tabindex]";

/** Upper bound on elements examined in a single pass. */
const MAX_SCAN = 5000;
/** Debounce for mutation-driven rescans. */
const RESCAN_MS = 300;

function mark(el: Element): void {
  try {
    if (el.nodeType !== 1) return;
    if (el.hasAttribute(CLICKABLE_ATTR)) return;
    if (typeof el.matches === "function" && el.matches(ALREADY_SEMANTIC)) return;
    el.setAttribute(CLICKABLE_ATTR, "1");
  } catch {
    /* never let the probe break the page */
  }
}

/** True when the node carries a framework props object with a real click handler. */
function hasFrameworkClickHandler(el: Element): boolean {
  let keys: string[];
  try {
    keys = Object.keys(el);
  } catch {
    return false;
  }
  for (const k of keys) {
    if (k.charCodeAt(0) !== 95) continue; // fast reject: framework keys start with "_"
    if (k.indexOf("Props$") === -1) continue;
    try {
      const props = (el as unknown as Record<string, unknown>)[k] as Record<string, unknown> | null;
      if (!props) continue;
      if (typeof props.onClick === "function") return true;
      if (typeof props.onClickCapture === "function") return true;
      if (typeof props.onPress === "function") return true;
    } catch {
      /* inaccessible — ignore */
    }
  }
  return false;
}

function scan(root: ParentNode): void {
  let n = 0;
  let nodes: ArrayLike<Element>;
  try {
    nodes = root.querySelectorAll("div, span");
  } catch {
    return;
  }
  for (let i = 0; i < nodes.length && n < MAX_SCAN; i++, n++) {
    const el = nodes[i];
    if (hasFrameworkClickHandler(el)) mark(el);
  }
}

let installed = false;

/** Idempotent. Safe to call more than once. */
export function installClickableProbe(): void {
  if (installed) return;
  installed = true;

  // 1. Framework-agnostic: anything registering a real click listener.
  try {
    const proto = EventTarget.prototype;
    const original = proto.addEventListener;
    proto.addEventListener = function (this: EventTarget, type: string, listener: unknown, options?: unknown) {
      try {
        if (type === "click" && listener && (this as Element).nodeType === 1) {
          mark(this as Element);
        }
      } catch {
        /* ignore */
      }
      return original.call(this, type as string, listener as EventListener, options as boolean);
    } as typeof proto.addEventListener;
  } catch {
    /* patching unavailable — the framework scan below still applies */
  }

  // 2. Framework props scan: initial passes plus a debounced observer, since
  //    controls are rendered after load.
  const run = (): void => {
    try {
      if (document.body) scan(document);
    } catch {
      /* ignore */
    }
  };
  run();
  if (typeof document !== "undefined") {
    document.addEventListener("DOMContentLoaded", run, { once: true });
    window.addEventListener?.("load", run, { once: true } as AddEventListenerOptions);
  }

  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new MutationObserver(() => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(run, RESCAN_MS);
    });
    if (document.documentElement) {
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
  } catch {
    /* observer unavailable — initial passes still applied */
  }
}
