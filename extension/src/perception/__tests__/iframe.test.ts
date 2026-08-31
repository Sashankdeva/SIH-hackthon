// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureDomState,
  resetElementRegistry,
  resolveElement,
  resolveTarget,
} from "../domCapture";
import { deepActiveElement, sameOriginFrameDoc } from "../deepDom";
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

/** Append a same-origin iframe and return its document. */
function sameOriginFrame(html: string, parent: Document = document): Document {
  const f = parent.createElement("iframe");
  parent.body.appendChild(f);
  const idoc = f.contentDocument!;
  idoc.body.innerHTML = html;
  return idoc;
}

/** Append an iframe that the parent cannot reach (cross-origin simulation). */
function crossOriginFrame(html: string): HTMLIFrameElement {
  const f = document.createElement("iframe");
  document.body.appendChild(f);
  f.contentDocument!.body.innerHTML = html; // set up "its" content first
  Object.defineProperty(f, "contentDocument", { configurable: true, get: () => null });
  return f;
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
const clickReq = (id: number): ActionRequest =>
  ({ action: "click", elementId: id, confidence: 1, taskId: "t", stepId: 1 }) as ActionRequest;
const typeReq = (id: number, value: string): ActionRequest =>
  ({ action: "type", elementId: id, value, confidence: 1, taskId: "t", stepId: 1 }) as ActionRequest;

beforeEach(() => {
  document.body.innerHTML = "";
  document.title = "Frames";
  resetElementRegistry();
  resetTokenCounters();
});

// ---------------------------------------------------------------------------
describe("Phase 6B — basic same-origin iframe discovery", () => {
  it("1. a same-origin iframe exists and its document is reachable", () => {
    const idoc = sameOriginFrame(`<button>x</button>`);
    const frameEl = document.querySelector("iframe")!;
    expect(sameOriginFrameDoc(frameEl)).toBe(idoc);
  });

  it("2. capture traverses into the same-origin iframe document", () => {
    sameOriginFrame(`<button>Frame Go</button>`);
    document.body.insertAdjacentHTML("afterbegin", `<button>Top Go</button>`);
    const labels = captureDomState("t").elements.map((e) => e.label);
    expect(labels).toEqual(["Top Go", "Frame Go"]); // top tree first, then frame
  });

  it("3. a button inside the iframe classifies as button", () => {
    const idoc = sameOriginFrame(`<button aria-label="Close">×</button>`);
    const el = captureDomState("t").elements.find((e) => e.label === "Close");
    expect(el?.role).toBe("button");
    expect(resolveElement(el!.elementId)).toBe(idoc.querySelector("button"));
  });

  it("4. an input inside the iframe classifies as textbox and keeps inputType", () => {
    sameOriginFrame(`<label>Email <input type="email"></label>`);
    const el = captureDomState("t").elements.find((e) => e.label === "Email");
    expect(el?.role).toBe("textbox");
    expect(el?.inputType).toBe("email");
  });

  it("5. a select inside the iframe classifies as combobox", () => {
    sameOriginFrame(`<label>Size <select><option>S</option><option>M</option></select></label>`);
    const el = captureDomState("t").elements.find((e) => e.label === "Size");
    expect(el?.role).toBe("combobox");
  });

  it("nested same-origin iframe is traversed", () => {
    const idoc = sameOriginFrame(`<div></div>`);
    const inner = sameOriginFrame(`<button>Deep Frame Button</button>`, idoc);
    void inner;
    expect(captureDomState("t").elements.map((e) => e.label)).toContain("Deep Frame Button");
  });
});

// ---------------------------------------------------------------------------
describe("Phase 6B — execution & PVM inside a same-origin iframe", () => {
  it("6. click inside the iframe fires the frame-local listener", async () => {
    const idoc = sameOriginFrame(`<button>Act</button>`);
    let clicked = false;
    idoc.querySelector("button")!.addEventListener("click", () => (clicked = true));
    captureDomState("t");
    const id = idOf(idoc.querySelector("button")!);
    await executeAction(clickReq(id));
    expect(clicked).toBe(true);
  });

  it("7. type inside the iframe writes the frame-local input", async () => {
    const idoc = sameOriginFrame(`<input aria-label="Q">`);
    captureDomState("t");
    const el = idoc.querySelector("input") as HTMLInputElement;
    const id = idOf(el);
    expect(validateAction(typeReq(id, "hello"), "t").ok).toBe(true);
    await executeAction(typeReq(id, "hello"));
    expect(el.value).toBe("hello");
  });

  it("8. select inside the iframe chooses the frame-local option", async () => {
    const idoc = sameOriginFrame(`<label>Size <select><option value="s">Small</option><option value="m">Medium</option></select></label>`);
    captureDomState("t");
    const id = idOf(idoc.querySelector("select")!);
    await executeAction(typeReq(id, "Medium"));
    expect((idoc.querySelector("select") as HTMLSelectElement).value).toBe("m");
  });

  it("9. PVM verifies the frame-local result (click aria flip, type value, select option)", async () => {
    const idoc = sameOriginFrame(
      `<button aria-expanded="false">Menu</button><input aria-label="Q"><select><option value="a">A</option><option value="b">B</option></select>`
    );
    captureDomState("t");
    const btn = idoc.querySelector("button")!;
    const inp = idoc.querySelector("input") as HTMLInputElement;
    const sel = idoc.querySelector("select") as HTMLSelectElement;

    const sc = snap(clickReq(idOf(btn)));
    setTimeout(() => btn.setAttribute("aria-expanded", "true"), 8);
    expect((await verifyActionSettled("t:1", sc, FAST)).status).toBe("success");

    await executeAction(typeReq(idOf(inp), "typed"));
    expect((await verifyActionSettled("t:1", snap(typeReq(idOf(inp), "typed")), FAST)).observed).toBe("value_matches");

    await executeAction(typeReq(idOf(sel), "B"));
    expect((await verifyActionSettled("t:1", snap(typeReq(idOf(sel), "B")), FAST)).observed).toBe("option_selected");
  });
});

// ---------------------------------------------------------------------------
describe("Phase 6B — frame-aware element identity", () => {
  it("10. element ids are globally unique across frames (no numeric collision)", () => {
    sameOriginFrame(`<button>A</button><button>B</button>`);
    document.body.insertAdjacentHTML("afterbegin", `<button>C</button><button>D</button>`);
    const ids = captureDomState("t").elements.map((e) => e.elementId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(4);
  });

  it("11. a target id resolves to the element in the CORRECT frame", () => {
    const idoc = sameOriginFrame(`<button>Shared Label</button>`);
    document.body.insertAdjacentHTML("afterbegin", `<button>Shared Label</button>`);
    captureDomState("t");
    const topBtn = document.body.querySelector("button")!;
    const frameBtn = idoc.querySelector("button")!;
    expect(resolveElement(idOf(topBtn))).toBe(topBtn);
    expect(resolveElement(idOf(frameBtn))).toBe(frameBtn);
  });

  it("12. executing a frame target's id never actuates the same-labelled top control", async () => {
    const idoc = sameOriginFrame(`<button>Submit</button>`);
    document.body.insertAdjacentHTML("afterbegin", `<button>Submit</button>`);
    let topClicks = 0, frameClicks = 0;
    document.body.querySelector("button")!.addEventListener("click", () => topClicks++);
    idoc.querySelector("button")!.addEventListener("click", () => frameClicks++);
    captureDomState("t");
    await executeAction(clickReq(idOf(idoc.querySelector("button")!)));
    expect(frameClicks).toBe(1);
    expect(topClicks).toBe(0);
  });

  it("13. stale target recovery inside a frame (equivalent node)", () => {
    const idoc = sameOriginFrame(`<div class="w"><button>Buy</button></div>`);
    captureDomState("t");
    const id = idOf(idoc.querySelector("button")!);
    idoc.querySelector(".w")!.innerHTML = `<button>Buy</button>`;
    const r = resolveTarget(id, { role: "button", label: "Buy" });
    expect(r.status).toBe("resolved");
    expect(r.status === "resolved" && r.recovered).toBe(true);
    expect(idoc.querySelector("button")!.getAttribute("data-privy-id")).toBe(String(id));
  });

  it("14. duplicate equivalent candidates inside a frame → ambiguous, never guesses", () => {
    const idoc = sameOriginFrame(`<button>Add</button>`);
    captureDomState("t");
    const id = idOf(idoc.querySelector("button")!);
    idoc.body.innerHTML = `<button>Add</button><button>Add</button>`;
    expect(resolveTarget(id, { role: "button", label: "Add" }).status).toBe("ambiguous");
  });
});

// ---------------------------------------------------------------------------
describe("Phase 6B — routing / no side effects (top-frame orchestration)", () => {
  it("15. resolution targets the correct frame document", () => {
    const a = sameOriginFrame(`<button>One</button>`);
    const b = sameOriginFrame(`<button>Two</button>`);
    captureDomState("t");
    expect(resolveElement(idOf(a.querySelector("button")!))!.ownerDocument).toBe(a);
    expect(resolveElement(idOf(b.querySelector("button")!))!.ownerDocument).toBe(b);
  });

  it("16. acting on a frame control does not touch controls in other frames or the top", async () => {
    const a = sameOriginFrame(`<input aria-label="A">`);
    const b = sameOriginFrame(`<input aria-label="B">`);
    document.body.insertAdjacentHTML("afterbegin", `<input aria-label="Top">`);
    captureDomState("t");
    await executeAction(typeReq(idOf(a.querySelector("input")!), "x"));
    expect((a.querySelector("input") as HTMLInputElement).value).toBe("x");
    expect((b.querySelector("input") as HTMLInputElement).value).toBe("");
    expect((document.body.querySelector("input") as HTMLInputElement).value).toBe("");
  });

  it("17. a frame action yields a normal VerificationResult (recorded by the unchanged top-frame loop)", async () => {
    const idoc = sameOriginFrame(`<input aria-label="Q">`);
    captureDomState("t");
    const id = idOf(idoc.querySelector("input")!);
    await executeAction(typeReq(id, "recorded"));
    const r = await verifyActionSettled("t:1", snap(typeReq(id, "recorded")), FAST);
    expect(r.status).toBe("success");
    expect(typeof r.observed).toBe("string");
  });

  it("18. child frame removed before execution → safe typed failure (target lost)", () => {
    const idoc = sameOriginFrame(`<button>Gone</button>`);
    captureDomState("t");
    const id = idOf(idoc.querySelector("button")!);
    document.querySelector("iframe")!.remove();
    const r = resolveTarget(id, { role: "button", label: "Gone" });
    expect(r.status).toBe("missing");
  });
});

// ---------------------------------------------------------------------------
describe("Phase 6B — navigation semantics", () => {
  it("19/20. a child-frame URL change is 'frame_url_changed', NOT a top-level url_changed", async () => {
    const idoc = sameOriginFrame(`<button>Nav</button>`);
    captureDomState("t");
    const btn = idoc.querySelector("button")!;
    const realBaseline = makeTargetBaseline(idOf(btn))!;
    // Snapshot taken BEFORE the frame moved: its recorded frameUrlBefore differs
    // from the element's live owner-frame URL → a same-origin child-frame nav.
    const s = snap(clickReq(idOf(btn)), {
      targetBefore: { ...realBaseline, frameUrlBefore: `${realBaseline.frameUrlBefore ?? "about:blank"}#before-nav` },
    });

    const r = await verifyActionSettled("t:1", s, FAST);
    expect(r.observed).toBe("frame_url_changed");
    expect(r.status).toBe("success");
    // top frame stayed put — no false top-level navigation
    expect(location.href).toBe(s.urlBefore);
  });

  it("21. child frame reload: old ids go stale, resolveTarget recovers or reports missing", () => {
    const idoc = sameOriginFrame(`<button>R</button>`);
    captureDomState("t");
    const id = idOf(idoc.querySelector("button")!);
    idoc.body.innerHTML = `<button>R</button>`; // "reloaded" — fresh node, no privy-id
    expect(resolveTarget(id, { role: "button", label: "R" }).status).toBe("resolved");

    const idoc2 = sameOriginFrame(`<span>nothing interactive</span>`, idoc);
    void idoc2;
    idoc.body.innerHTML = ``;
    expect(resolveTarget(id, { role: "button", label: "R" }).status).toBe("missing");
  });

  it("22. target disappears with frame replacement → missing (never assumed success)", () => {
    sameOriginFrame(`<button>Frame Btn</button>`);
    const s1 = captureDomState("t");
    const id = s1.elements.find((e) => e.label === "Frame Btn")!.elementId;
    document.querySelector("iframe")!.remove();
    document.body.appendChild(document.createElement("iframe")); // a different, empty frame
    expect(resolveTarget(id, { role: "button", label: "Frame Btn" }).status).toBe("missing");
  });
});

// ---------------------------------------------------------------------------
describe("Phase 6B — privacy (same-origin iframe uses the EXISTING pipeline)", () => {
  it("23/24. an iframe password is tokenized; raw value never reaches wire, context, or logs", () => {
    const logs: string[] = [];
    const spies = ["log", "warn", "error"].map((k) =>
      vi.spyOn(console, k as "log").mockImplementation((...a: unknown[]) => logs.push(a.map(String).join(" ")))
    );
    try {
      const idoc = sameOriginFrame(`<label>Password <input type="password"></label><button>Sign in</button>`);
      (idoc.querySelector("input") as HTMLInputElement).value = "IFRAME_SECRET_p@ss";

      const ps = captureDomState("t");
      const det = detectTier1(ps.elements);
      const red = redact(det);
      const fw = buildSanitizedContext(ps, det, red, "log in");
      expect(fw.ok).toBe(true);
      const ctx = fw.ok ? fw.context : null;

      expect(det.some((d) => d.category === "password")).toBe(true);
      const pwId = ps.elements.find((e) => e.inputType === "password")!.elementId;
      expect(ctx!.fields[String(pwId)]).toMatch(/^\[PASSWORD_\d+\]$/);
      expect(ctx!.elements.find((e) => e.elementId === pwId)!.label).toBe(ctx!.fields[String(pwId)]);

      expect(JSON.stringify(toWireSanitizedContext(ctx!))).not.toContain("IFRAME_SECRET_p@ss");
      expect(JSON.stringify(ctx)).not.toContain("IFRAME_SECRET_p@ss");
      expect(logs.join("\n")).not.toContain("IFRAME_SECRET_p@ss");
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});

// ---------------------------------------------------------------------------
describe("Phase 6B — cross-origin safety (must stay unsupported)", () => {
  it("25. a cross-origin iframe is skipped — its controls are never captured", () => {
    crossOriginFrame(`<button>XO Button</button><input type="password" value="XO_SECRET">`);
    document.body.insertAdjacentHTML("afterbegin", `<button>Top Button</button>`);
    const labels = captureDomState("t").elements.map((e) => e.label);
    expect(labels).toContain("Top Button");
    expect(labels).not.toContain("XO Button");
  });

  it("26. contentDocument that THROWS a SecurityError never breaks capture", () => {
    const f = document.createElement("iframe");
    document.body.appendChild(f);
    Object.defineProperty(f, "contentDocument", {
      configurable: true,
      get: () => { throw new DOMException("Blocked a frame with origin", "SecurityError"); },
    });
    document.body.insertAdjacentHTML("afterbegin", `<button>Still Captured</button>`);
    expect(() => captureDomState("t")).not.toThrow();
    expect(captureDomState("t").elements.map((e) => e.label)).toContain("Still Captured");
  });

  it("27. no cross-origin content enters the sanitized payload (no partial payload)", () => {
    crossOriginFrame(`<input type="text" name="xo_card" value="4111111111111111"><button>Pay</button>`);
    sameOriginFrame(`<button>SO Button</button>`);
    const ps = captureDomState("t");
    const wire = JSON.stringify(toWireSanitizedContext(
      (buildSanitizedContext(ps, detectTier1(ps.elements), redact(detectTier1(ps.elements)), "task") as { context: unknown }).context as never
    ));
    expect(wire).toContain("SO Button");
    expect(wire).not.toContain("xo_card");
    expect(wire).not.toContain("4111111111111111");
    expect(wire).not.toContain("Pay");
  });

  it("28. a stale id whose frame is now cross-origin fails safe (missing/unknown), never guesses", () => {
    const idoc = sameOriginFrame(`<button>Was SO</button>`);
    captureDomState("t");
    const id = idOf(idoc.querySelector("button")!);
    // frame goes cross-origin: parent loses contentDocument access
    Object.defineProperty(document.querySelector("iframe")!, "contentDocument", { configurable: true, get: () => null });
    const r = resolveTarget(id, { role: "button", label: "Was SO" });
    expect(["missing", "unknown"]).toContain(r.status);
  });

  it("deepActiveElement crosses into a same-origin iframe's focused control", () => {
    const idoc = sameOriginFrame(`<input aria-label="F">`);
    const inp = idoc.querySelector("input") as HTMLInputElement;
    inp.focus();
    // top document.activeElement is the <iframe>; deepActiveElement recurses in
    expect(document.activeElement).toBe(document.querySelector("iframe"));
    expect(deepActiveElement()).toBe(inp);
  });
});
