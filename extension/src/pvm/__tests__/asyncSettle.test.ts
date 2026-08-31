// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  verifyActionSettled,
  makeTargetBaseline,
  type ActionSnapshot,
  type SettleConfig,
} from "../verify";
import { captureDomState, resetElementRegistry } from "../../perception/domCapture";
import type { ActionRequest } from "../../action/types";

// Tight windows: async changes below are scheduled well inside them, and the
// timeout paths resolve fast. The polling machinery is the same as production.
const FAST: SettleConfig = { clickMs: 90, typeMs: 90, scrollMs: 90, navigateMs: 60 };

function idOf(el: Element): number {
  captureDomState("settle");
  return Number(el.getAttribute("data-privy-id"));
}

function snap(action: ActionRequest, over: Partial<ActionSnapshot> = {}): ActionSnapshot {
  return {
    urlBefore: location.href,
    scrollYBefore: (window as unknown as { scrollY: number }).scrollY ?? 0,
    elementValueBefore: over.elementValueBefore ?? null,
    action,
    startedAt: Date.now(),
    targetBefore: action.elementId != null ? makeTargetBaseline(action.elementId) : null,
    ...over,
  };
}

const clickReq = (elementId?: number): ActionRequest =>
  ({ action: "click", elementId, confidence: 1, taskId: "t", stepId: 1 }) as ActionRequest;
const typeReq = (elementId: number, value: string): ActionRequest =>
  ({ action: "type", elementId, value, confidence: 1, taskId: "t", stepId: 1 }) as ActionRequest;

function mockScrollY(initial = 0): { set: (v: number) => void } {
  let y = initial;
  Object.defineProperty(window, "scrollY", { configurable: true, get: () => y });
  Object.defineProperty(window, "pageYOffset", { configurable: true, get: () => y });
  return { set: (v: number) => (y = v) };
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.title = "Settle";
  resetElementRegistry();
});

// ---------------------------------------------------------------------------
describe("Phase 5 — CLICK verification", () => {
  it("1. synchronous URL change → success", async () => {
    document.body.innerHTML = `<a href="#gone">Go</a>`;
    const a = document.querySelector("a")!;
    const s = snap(clickReq(idOf(a)));
    location.hash = "#gone";
    const r = await verifyActionSettled("t:1", s, FAST);
    expect(r.status).toBe("success");
    expect(r.observed).toBe("url_changed");
    location.hash = "";
  });

  it("2. synchronous DOM removal → success", async () => {
    document.body.innerHTML = `<button>Dismiss</button>`;
    const b = document.querySelector("button")!;
    const s = snap(clickReq(idOf(b)));
    b.remove();
    const r = await verifyActionSettled("t:1", s, FAST);
    expect(r.status).toBe("success");
    expect(r.observed).toBe("element_removed");
  });

  it("3. async aria-expanded change → success", async () => {
    document.body.innerHTML = `<button aria-expanded="false" aria-controls="menu">Menu</button><ul id="menu" hidden></ul>`;
    const b = document.querySelector("button")!;
    const s = snap(clickReq(idOf(b)));
    setTimeout(() => b.setAttribute("aria-expanded", "true"), 20);
    const r = await verifyActionSettled("t:1", s, FAST);
    expect(r.status).toBe("success");
    expect(r.observed).toBe("aria_expanded_changed");
  });

  it("4. async aria-pressed change → success", async () => {
    document.body.innerHTML = `<button aria-pressed="false">Bold</button>`;
    const b = document.querySelector("button")!;
    const s = snap(clickReq(idOf(b)));
    setTimeout(() => b.setAttribute("aria-pressed", "true"), 20);
    const r = await verifyActionSettled("t:1", s, FAST);
    expect(r.status).toBe("success");
    expect(r.observed).toBe("aria_pressed_changed");
  });

  it("5. async controlled region appears → success", async () => {
    document.body.innerHTML = `<button aria-controls="panel">Details</button><section id="panel" hidden><a href="/x">link</a></section>`;
    const b = document.querySelector("button")!;
    const s = snap(clickReq(idOf(b)));
    setTimeout(() => document.getElementById("panel")!.removeAttribute("hidden"), 20);
    const r = await verifyActionSettled("t:1", s, FAST);
    expect(r.status).toBe("success");
    expect(r.observed).toBe("controlled_region_shown");
  });

  it("6. async disabled-state change → success", async () => {
    document.body.innerHTML = `<button>Submit</button>`;
    const b = document.querySelector("button")!;
    const s = snap(clickReq(idOf(b)));
    setTimeout(() => (b as HTMLButtonElement).setAttribute("disabled", ""), 20);
    const r = await verifyActionSettled("t:1", s, FAST);
    expect(r.status).toBe("success");
    expect(r.observed).toBe("target_disabled_changed");
  });

  it("7. unrelated DOM mutation elsewhere → still ambiguous", async () => {
    document.body.innerHTML = `<button>Noop</button><div id="other">x</div>`;
    const b = document.querySelector("button")!;
    const s = snap(clickReq(idOf(b)));
    setTimeout(() => {
      document.getElementById("other")!.appendChild(document.createElement("span"));
      document.getElementById("other")!.setAttribute("aria-expanded", "true");
    }, 15);
    const r = await verifyActionSettled("t:1", s, FAST);
    expect(r.status).toBe("ambiguous");
    expect(r.observed).toBe("no_observable_change");
  });

  it("8. no change at all → ambiguous", async () => {
    document.body.innerHTML = `<button>Inert</button>`;
    const b = document.querySelector("button")!;
    const s = snap(clickReq(idOf(b)));
    const r = await verifyActionSettled("t:1", s, FAST);
    expect(r.status).toBe("ambiguous");
  });
});

// ---------------------------------------------------------------------------
describe("Phase 5 — TYPE verification", () => {
  it("9. immediate value match → success", async () => {
    document.body.innerHTML = `<input type="text">`;
    const el = document.querySelector("input") as HTMLInputElement;
    const id = idOf(el);
    el.value = "hello";
    const r = await verifyActionSettled("t:1", snap(typeReq(id, "hello")), FAST);
    expect(r.status).toBe("success");
    expect(r.observed).toBe("value_matches");
  });

  it("10. delayed value match → success", async () => {
    document.body.innerHTML = `<input type="text">`;
    const el = document.querySelector("input") as HTMLInputElement;
    const id = idOf(el);
    setTimeout(() => (el.value = "world"), 25);
    const r = await verifyActionSettled("t:1", snap(typeReq(id, "world")), FAST);
    expect(r.status).toBe("success");
  });

  it("11. framework-style delayed reconciliation (wrong, then correct, then stable) → success", async () => {
    document.body.innerHTML = `<input type="text" value="stale">`;
    const el = document.querySelector("input") as HTMLInputElement;
    const id = idOf(el);
    setTimeout(() => (el.value = "committed"), 30);
    const r = await verifyActionSettled("t:1", snap(typeReq(id, "committed")), FAST);
    expect(r.status).toBe("success");
  });

  it("12. eventual value mismatch (app reverts) → failure", async () => {
    document.body.innerHTML = `<input type="text">`;
    const el = document.querySelector("input") as HTMLInputElement;
    const id = idOf(el);
    el.value = "typed";
    // brief acceptance, then a revert that stands at the deadline
    setTimeout(() => (el.value = "reverted-by-app"), 30);
    const r = await verifyActionSettled("t:1", snap(typeReq(id, "typed")), FAST);
    expect(r.status).toBe("failure");
    expect(r.observed).toBe("value_mismatch");
  });

  it("13. target disappears mid-window → failure", async () => {
    document.body.innerHTML = `<input type="text">`;
    const el = document.querySelector("input") as HTMLInputElement;
    const id = idOf(el);
    setTimeout(() => el.remove(), 20);
    const r = await verifyActionSettled("t:1", snap(typeReq(id, "x")), FAST);
    expect(r.status).toBe("failure");
    expect(r.observed).toBe("element_not_found");
  });
});

// ---------------------------------------------------------------------------
describe("Phase 5 — SELECT verification", () => {
  const html = `<select><option value="s">Small</option><option value="m">Medium</option><option value="l">Large</option></select>`;

  it("14. immediate selection → success", async () => {
    document.body.innerHTML = html;
    const sel = document.querySelector("select") as HTMLSelectElement;
    const id = idOf(sel);
    sel.value = "m";
    const r = await verifyActionSettled("t:1", snap(typeReq(id, "Medium")), FAST);
    expect(r.status).toBe("success");
    expect(r.observed).toBe("option_selected");
  });

  it("15. delayed selection → success", async () => {
    document.body.innerHTML = html;
    const sel = document.querySelector("select") as HTMLSelectElement;
    const id = idOf(sel);
    setTimeout(() => (sel.value = "l"), 25);
    const r = await verifyActionSettled("t:1", snap(typeReq(id, "Large")), FAST);
    expect(r.status).toBe("success");
  });

  it("16. selection mismatch → failure", async () => {
    document.body.innerHTML = html;
    const sel = document.querySelector("select") as HTMLSelectElement;
    const id = idOf(sel);
    sel.value = "s";
    const r = await verifyActionSettled("t:1", snap(typeReq(id, "Large")), FAST);
    expect(r.status).toBe("failure");
    expect(r.observed).toBe("option_not_selected");
  });
});

// ---------------------------------------------------------------------------
describe("Phase 5 — SCROLL verification", () => {
  it("17. immediate scroll → success", async () => {
    const sc = mockScrollY(0);
    const s = snap({ action: "scroll", direction: "down", amount: 400, confidence: 1, taskId: "t", stepId: 1 } as ActionRequest);
    sc.set(400);
    const r = await verifyActionSettled("t:1", s, FAST);
    expect(r.status).toBe("success");
    expect(r.observed).toBe("scroll_changed");
  });

  it("18. smooth / delayed scroll → success (polled, not read too early)", async () => {
    const sc = mockScrollY(0);
    const s = snap({ action: "scroll", direction: "down", amount: 400, confidence: 1, taskId: "t", stepId: 1 } as ActionRequest);
    setTimeout(() => sc.set(320), 30);
    const r = await verifyActionSettled("t:1", s, FAST);
    expect(r.status).toBe("success");
  });

  it("19. already at the top, scrolling up → not success (ambiguous, boundary noted)", async () => {
    mockScrollY(0);
    Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, get: () => 5000 });
    Object.defineProperty(window, "innerHeight", { configurable: true, get: () => 800 });
    const s = snap({ action: "scroll", direction: "up", amount: 400, confidence: 1, taskId: "t", stepId: 1 } as ActionRequest);
    const r = await verifyActionSettled("t:1", s, FAST);
    expect(r.status).toBe("ambiguous");
    expect(r.observed).toBe("already_at_top");
  });

  it("20. non-scrollable page → ambiguous", async () => {
    mockScrollY(0);
    Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, get: () => 600 });
    Object.defineProperty(window, "innerHeight", { configurable: true, get: () => 800 });
    const s = snap({ action: "scroll", direction: "down", amount: 400, confidence: 1, taskId: "t", stepId: 1 } as ActionRequest);
    const r = await verifyActionSettled("t:1", s, FAST);
    expect(r.status).toBe("ambiguous");
    expect(r.observed).toBe("page_not_scrollable");
  });
});

// ---------------------------------------------------------------------------
describe("Phase 5 — NAVIGATION handling", () => {
  it("21. full navigation (URL already changed) → success without waiting for a new document", async () => {
    const s = snap({ action: "navigate", url: "https://example.test/next", confidence: 1, taskId: "t", stepId: 1 } as ActionRequest, {
      urlBefore: "https://example.test/prev",
    });
    // location.href already differs from urlBefore → immediate success, no polling
    const r = await verifyActionSettled("t:1", s, FAST);
    expect(r.status).toBe("success");
    expect(r.observed).toBe("url_changed");
  });

  it("22. SPA navigation via pushState (deferred a frame) → success", async () => {
    const before = location.href;
    const s = snap({ action: "navigate", url: "/spa-route", confidence: 1, taskId: "t", stepId: 1 } as ActionRequest, { urlBefore: before });
    setTimeout(() => history.pushState({}, "", "/spa-route"), 20);
    const r = await verifyActionSettled("t:1", s, FAST);
    expect(r.status).toBe("success");
    history.pushState({}, "", before);
  });

  it("23. navigation that does not change the URL → failure (cross-page continuation handles real nav elsewhere)", async () => {
    const s = snap({ action: "navigate", url: "/same", confidence: 1, taskId: "t", stepId: 1 } as ActionRequest, {
      urlBefore: location.href,
    });
    const r = await verifyActionSettled("t:1", s, FAST);
    expect(r.status).toBe("failure");
    expect(r.observed).toBe("url_unchanged");
  });
});

// ---------------------------------------------------------------------------
describe("Phase 5 — safety invariants", () => {
  it("24. unrelated mutation never becomes success (repeat, many mutations)", async () => {
    document.body.innerHTML = `<button>Target</button><div id="noise"></div>`;
    const b = document.querySelector("button")!;
    const s = snap(clickReq(idOf(b)));
    const noise = document.getElementById("noise")!;
    let n = 0;
    const iv = setInterval(() => {
      noise.appendChild(document.createElement("i"));
      noise.setAttribute("data-n", String(++n));
    }, 8);
    const r = await verifyActionSettled("t:1", s, FAST);
    clearInterval(iv);
    expect(r.status).toBe("ambiguous");
  });

  it("25. focus-only change never becomes success", async () => {
    document.body.innerHTML = `<button>A</button><input aria-label="B">`;
    const b = document.querySelector("button")!;
    const s = snap(clickReq(idOf(b)));
    setTimeout(() => (document.querySelector("input") as HTMLInputElement).focus(), 15);
    const r = await verifyActionSettled("t:1", s, FAST);
    expect(r.status).toBe("ambiguous");
  });

  it("26. arbitrary text mutation on a NON-target element never becomes success", async () => {
    document.body.innerHTML = `<button>Target</button><p id="status">idle</p>`;
    const b = document.querySelector("button")!;
    const s = snap(clickReq(idOf(b)));
    setTimeout(() => (document.getElementById("status")!.textContent = "loading…"), 15);
    const r = await verifyActionSettled("t:1", s, FAST);
    expect(r.status).toBe("ambiguous");
  });

  it("26b. empty target textContent is never treated as a typed value", async () => {
    document.body.innerHTML = `<input type="text">`;
    const el = document.querySelector("input") as HTMLInputElement;
    const id = idOf(el);
    el.value = ""; // executor "ran" but nothing landed
    const r = await verifyActionSettled("t:1", snap(typeReq(id, "wanted")), FAST);
    expect(r.status).toBe("failure");
    expect(r.observed).toBe("value_mismatch");
  });

  it("26c. a target label change unrelated to the click is not observed (only the target's own)", async () => {
    // The target's OWN label changing IS causal (state signal) — covered by test-set design.
    // Here: a sibling's label changes; target unchanged → ambiguous.
    document.body.innerHTML = `<button aria-label="Do it">Do it</button><button id="sib" aria-label="Sibling">Sibling</button>`;
    const b = document.querySelector("button")!;
    const s = snap(clickReq(idOf(b)));
    setTimeout(() => document.getElementById("sib")!.setAttribute("aria-label", "Changed"), 15);
    const r = await verifyActionSettled("t:1", s, FAST);
    expect(r.status).toBe("ambiguous");
  });
});
