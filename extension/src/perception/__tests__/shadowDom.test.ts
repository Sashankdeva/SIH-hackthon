// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureDomState,
  resetElementRegistry,
  resolveElement,
  resolveTarget,
} from "../domCapture";
import { computeAccessibleName } from "../accessibleName";
import { deepActiveElement } from "../deepDom";
import { detectTier1 } from "../../privacy/tier1DomRules";
import { redact, resetTokenCounters } from "../../privacy/redact";
import { buildSanitizedContext, toWireSanitizedContext } from "../../privacy/sanitizedContext";
import { validateAction } from "../../action/validator";
import { executeAction } from "../../action/executor";
import {
  verifyActionSettled,
  makeTargetBaseline,
  type ActionSnapshot,
  type SettleConfig,
} from "../../pvm/verify";
import type { ActionRequest } from "../../action/types";

const FAST: SettleConfig = { clickMs: 60, typeMs: 60, scrollMs: 60, navigateMs: 40 };

/** Attach an open shadow root to a fresh host appended to `parent`, return the root. */
function openShadow(html: string, parent: ParentNode = document.body): ShadowRoot {
  const host = document.createElement("div");
  host.className = "host";
  parent.appendChild(host);
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = html;
  return root;
}

function idOf(el: Element): number {
  const raw = el.getAttribute("data-privy-id");
  if (!raw) throw new Error("element was not captured");
  return Number(raw);
}

function snap(action: ActionRequest, over: Partial<ActionSnapshot> = {}): ActionSnapshot {
  return {
    urlBefore: location.href,
    scrollYBefore: 0,
    elementValueBefore: over.elementValueBefore ?? null,
    action,
    startedAt: Date.now(),
    targetBefore: action.elementId != null ? makeTargetBaseline(action.elementId) : null,
    ...over,
  };
}
const clickReq = (elementId: number): ActionRequest =>
  ({ action: "click", elementId, confidence: 1, taskId: "t", stepId: 1 }) as ActionRequest;
const typeReq = (elementId: number, value: string): ActionRequest =>
  ({ action: "type", elementId, value, confidence: 1, taskId: "t", stepId: 1 }) as ActionRequest;

beforeEach(() => {
  document.body.innerHTML = "";
  document.title = "Shadow";
  resetElementRegistry();
  resetTokenCounters();
});

// ---------------------------------------------------------------------------
describe("Phase 6A — discovery", () => {
  it("1. one open shadow root: interactive elements are discovered", () => {
    openShadow(`<button>Shadow Go</button>`);
    const els = captureDomState("t").elements;
    expect(els.map((e) => e.label)).toContain("Shadow Go");
  });

  it("2. nested open shadow roots are discovered", () => {
    const outer = openShadow(`<div id="inner-host"></div>`);
    const innerHost = outer.getElementById("inner-host")!;
    const inner = innerHost.attachShadow({ mode: "open" });
    inner.innerHTML = `<button>Deep Button</button>`;
    const els = captureDomState("t").elements;
    expect(els.map((e) => e.label)).toContain("Deep Button");
  });

  it("3. button inside a shadow root classifies as button", () => {
    openShadow(`<button aria-label="Close">×</button>`);
    const el = captureDomState("t").elements.find((e) => e.label === "Close");
    expect(el?.role).toBe("button");
  });

  it("4. input inside a shadow root classifies as textbox and keeps inputType", () => {
    openShadow(`<label>Email <input type="email"></label>`);
    const el = captureDomState("t").elements.find((e) => e.label === "Email");
    expect(el?.role).toBe("textbox");
    expect(el?.inputType).toBe("email");
  });

  it("5. select inside a shadow root classifies as combobox", () => {
    openShadow(`<label>Size <select><option>S</option><option>M</option></select></label>`);
    const el = captureDomState("t").elements.find((e) => e.label === "Size");
    expect(el?.role).toBe("combobox");
    expect(el?.tag).toBe("select");
  });
});

// ---------------------------------------------------------------------------
describe("Phase 6A — target resolution", () => {
  it("6. a shadow element_id resolves back to the live node", () => {
    const root = openShadow(`<button>Resolve me</button>`);
    captureDomState("t");
    const live = root.querySelector("button")!;
    expect(resolveElement(idOf(live))).toBe(live);
  });

  it("7. stale shadow target replaced by an equivalent node → recovered", () => {
    const root = openShadow(`<button>Buy</button>`);
    captureDomState("t");
    const id = idOf(root.querySelector("button")!);
    // SPA re-render inside the shadow root: new node, same role + name, no privy-id
    root.innerHTML = `<button>Buy</button>`;
    const r = resolveTarget(id, { role: "button", label: "Buy" });
    expect(r.status).toBe("resolved");
    expect(r.status === "resolved" && r.recovered).toBe(true);
    expect(root.querySelector("button")!.getAttribute("data-privy-id")).toBe(String(id));
  });

  it("8. multiple equivalent shadow matches → ambiguous", () => {
    const root = openShadow(`<button>Add</button>`);
    captureDomState("t");
    const id = idOf(root.querySelector("button")!);
    root.innerHTML = `<button>Add</button><button>Add</button>`;
    const r = resolveTarget(id, { role: "button", label: "Add" });
    expect(r.status).toBe("ambiguous");
  });

  it("9. disappeared shadow target → missing", () => {
    const root = openShadow(`<button>Remove</button>`);
    captureDomState("t");
    const id = idOf(root.querySelector("button")!);
    root.innerHTML = ``;
    const r = resolveTarget(id, { role: "button", label: "Remove" });
    expect(r.status).toBe("missing");
  });
});

// ---------------------------------------------------------------------------
describe("Phase 6A — accessible names", () => {
  it("10. shadow aria-label", () => {
    const root = openShadow(`<button aria-label="Play video">▶</button>`);
    expect(computeAccessibleName(root.querySelector("button")!)).toBe("Play video");
  });

  it("11. shadow aria-labelledby resolves within the SAME shadow root", () => {
    const root = openShadow(`<span id="lbl">Shipping address</span><button aria-labelledby="lbl">go</button>`);
    // an unrelated top-document element with the same id must NOT be picked up
    document.body.insertAdjacentHTML("beforeend", `<span id="lbl">WRONG</span>`);
    expect(computeAccessibleName(root.querySelector("button")!)).toBe("Shipping address");
  });

  it("12. shadow child SVG <title>", () => {
    const root = openShadow(`<button><svg viewBox="0 0 1 1"><title>Menu</title><path d="M0 0"/></svg></button>`);
    expect(computeAccessibleName(root.querySelector("button")!)).toBe("Menu");
  });

  it("13. shadow child <img alt>", () => {
    const root = openShadow(`<button><img alt="Wishlist" src="x.png"></button>`);
    expect(computeAccessibleName(root.querySelector("button")!)).toBe("Wishlist");
  });

  it("14. shadow aria-controls resolves within the shadow root for PVM baseline", () => {
    const root = openShadow(`<button aria-controls="panel">Details</button><section id="panel" hidden>x</section>`);
    captureDomState("t");
    const base = makeTargetBaseline(idOf(root.querySelector("button")!));
    expect(base?.controlsId).toBe("panel");
    expect(base?.controlsShown).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("Phase 6A — privacy (shadow elements use the EXISTING pipeline)", () => {
  it("15/16/17. a shadow password is tokenized; raw value never reaches payload or logs", () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.map(String).join(" ")));
    const errSpy = vi.spyOn(console, "error").mockImplementation((...a) => logs.push(a.map(String).join(" ")));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((...a) => logs.push(a.map(String).join(" ")));
    try {
      const root = openShadow(`<label>Password <input type="password"></label><button>Sign in</button>`);
      (root.querySelector("input") as HTMLInputElement).value = "SHADOW_SECRET_hunter2";

      const ps = captureDomState("t");
      const det = detectTier1(ps.elements);
      const red = redact(det);
      const fw = buildSanitizedContext(ps, det, red, "log in");
      expect(fw.ok).toBe(true);
      const ctx = fw.ok ? fw.context : null;

      // password element was detected + redacted
      expect(det.some((d) => d.category === "password")).toBe(true);
      const pwId = ps.elements.find((e) => e.inputType === "password")!.elementId;
      expect(ctx!.fields[String(pwId)]).toMatch(/^\[PASSWORD_\d+\]$/);
      // its entry in the flat element list carries the token, not a label leak
      expect(ctx!.elements.find((e) => e.elementId === pwId)!.label).toBe(ctx!.fields[String(pwId)]);

      const wireJson = JSON.stringify(toWireSanitizedContext(ctx!));
      expect(wireJson).not.toContain("SHADOW_SECRET_hunter2");
      expect(JSON.stringify(ctx)).not.toContain("SHADOW_SECRET_hunter2");
      expect(logs.join("\n")).not.toContain("SHADOW_SECRET_hunter2");
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
describe("Phase 6A — focus & budget", () => {
  it("18. a focused control inside an open shadow root gets the focus signal", () => {
    const root = openShadow(`<input aria-label="Search">`);
    const inp = root.querySelector("input") as HTMLInputElement;
    inp.focus();
    // document.activeElement is the HOST; deepActiveElement recurses to the input
    expect(document.activeElement).not.toBe(inp);
    expect(deepActiveElement()).toBe(inp);
  });

  it("19. budget includes relevant shadow controls; duplicate labels stay distinct", () => {
    const root = openShadow(
      `<button aria-label="Unique CTA">go</button>` +
      Array.from({ length: 8 }, () => `<button>Add</button>`).join("")
    );
    const ps = captureDomState("t");
    const fw = buildSanitizedContext(ps, detectTier1(ps.elements), redact(detectTier1(ps.elements)), "task");
    const ctx = fw.ok ? fw.context : null;
    expect(ctx!.elements.some((e) => e.label === "Unique CTA")).toBe(true);
    const adds = ctx!.elements.filter((e) => e.label === "Add");
    expect(adds.length).toBeGreaterThan(1);
    expect(new Set(adds.map((e) => e.elementId)).size).toBe(adds.length);
    // sanity: the shadow buttons resolve
    for (const b of root.querySelectorAll("button")) expect(resolveElement(idOf(b))).toBe(b);
  });
});

// ---------------------------------------------------------------------------
describe("Phase 6A — PVM on resolved shadow elements", () => {
  it("20. shadow button click verification (aria-expanded flip → success)", async () => {
    const root = openShadow(`<button aria-expanded="false">Menu</button>`);
    captureDomState("t");
    const btn = root.querySelector("button")!;
    const s = snap(clickReq(idOf(btn)));
    setTimeout(() => btn.setAttribute("aria-expanded", "true"), 10);
    const r = await verifyActionSettled("t:1", s, FAST);
    expect(r.status).toBe("success");
    expect(r.observed).toBe("aria_expanded_changed");
  });

  it("21. shadow input type verification (exact value)", async () => {
    const root = openShadow(`<input aria-label="Q">`);
    captureDomState("t");
    const el = root.querySelector("input") as HTMLInputElement;
    const id = idOf(el);
    expect(validateAction(typeReq(id, "hello"), "t").ok).toBe(true);
    await executeAction(typeReq(id, "hello"));
    expect(el.value).toBe("hello");
    const r = await verifyActionSettled("t:1", snap(typeReq(id, "hello")), FAST);
    expect(r.status).toBe("success");
    expect(r.observed).toBe("value_matches");
  });

  it("22. shadow select verification", async () => {
    const root = openShadow(`<label>Size <select><option value="s">Small</option><option value="m">Medium</option></select></label>`);
    captureDomState("t");
    const id = idOf(root.querySelector("select")!);
    await executeAction(typeReq(id, "Medium"));
    expect((root.querySelector("select") as HTMLSelectElement).value).toBe("m");
    const r = await verifyActionSettled("t:1", snap(typeReq(id, "Medium")), FAST);
    expect(r.status).toBe("success");
    expect(r.observed).toBe("option_selected");
  });
});

// ---------------------------------------------------------------------------
describe("Phase 6A — dynamic Shadow DOM", () => {
  it("23. shadow host re-renders its subtree → equivalent node recovered", () => {
    const root = openShadow(`<div class="wrap"><button>Confirm</button></div>`);
    captureDomState("t");
    const id = idOf(root.querySelector("button")!);
    root.querySelector(".wrap")!.innerHTML = `<button>Confirm</button>`;
    expect(resolveTarget(id, { role: "button", label: "Confirm" }).status).toBe("resolved");
  });

  it("24. shadow node replaced in place (privy-id stripped) → recovered", () => {
    const root = openShadow(`<button>Save</button>`);
    captureDomState("t");
    const id = idOf(root.querySelector("button")!);
    const fresh = document.createElement("button");
    fresh.textContent = "Save";
    root.querySelector("button")!.replaceWith(fresh);
    const r = resolveTarget(id, { role: "button", label: "Save" });
    expect(r.status).toBe("resolved");
    expect(fresh.getAttribute("data-privy-id")).toBe(String(id));
  });

  it("25. nested shadow root recreated → target still resolvable by role+name, else missing", () => {
    const outer = openShadow(`<div id="ih"></div>`);
    let inner = outer.getElementById("ih")!.attachShadow({ mode: "open" });
    inner.innerHTML = `<button>Nested</button>`;
    captureDomState("t");
    const id = idOf(inner.querySelector("button")!);

    // tear the nested host out and rebuild an equivalent one
    outer.getElementById("ih")!.remove();
    outer.innerHTML = `<div id="ih"></div>`;
    inner = outer.getElementById("ih")!.attachShadow({ mode: "open" });
    inner.innerHTML = `<button>Nested</button>`;

    const r = resolveTarget(id, { role: "button", label: "Nested" });
    expect(r.status).toBe("resolved");
    expect(r.status === "resolved" && r.recovered).toBe(true);
  });

  it("shadow same-node, label unchanged → resolved without recovery; target disabled → still resolves (state is capture's job)", () => {
    const root = openShadow(`<button>Act</button>`);
    captureDomState("t");
    const btn = root.querySelector("button") as HTMLButtonElement;
    const id = idOf(btn);
    btn.disabled = true;
    const r = resolveTarget(id, { role: "button", label: "Act" });
    expect(r.status).toBe("resolved");
    expect(r.status === "resolved" && r.recovered).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("Phase 6A — boundaries (must NOT change)", () => {
  it("26. a CLOSED shadow root is not traversed — controls stay absent, no crash", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const closed = host.attachShadow({ mode: "closed" });
    closed.innerHTML = `<button>Closed Button</button><input type="password">`;
    document.body.insertAdjacentHTML("beforeend", `<button>Light Button</button>`);

    const els = captureDomState("t").elements;
    expect(els.map((e) => e.label)).toContain("Light Button");
    expect(els.map((e) => e.label)).not.toContain("Closed Button");
    // nothing from the closed root leaked into privacy detection either
    const det = detectTier1(els);
    expect(det.length).toBe(0);
    // a made-up id for the closed control does not resolve
    expect(resolveElement(99999)).toBeNull();
  });

  it("27. a CROSS-ORIGIN iframe is NOT traversed (same-origin iframe support is Phase 6B)", () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const idoc = iframe.contentDocument!;
    idoc.body.innerHTML = `<button>XOrigin Button</button>`;
    // Simulate a cross-origin frame: the parent cannot reach contentDocument.
    Object.defineProperty(iframe, "contentDocument", { configurable: true, get: () => null });
    document.body.insertAdjacentHTML("beforeend", `<button>Top Button</button>`);

    const els = captureDomState("t").elements;
    expect(els.map((e) => e.label)).toContain("Top Button");
    expect(els.map((e) => e.label)).not.toContain("XOrigin Button");
  });
});
