// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { captureDomState, resetElementRegistry, resolveTarget } from "../domCapture";

/** Capture, returning a quick id lookup by accessible label. */
function capture(): Record<string, number> {
  const state = captureDomState("t");
  const byLabel: Record<string, number> = {};
  for (const el of state.elements) if (el.label) byLabel[el.label] = el.elementId;
  return byLabel;
}

describe("Phase 3 — stale-target resolution (resolveTarget)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    resetElementRegistry();
  });

  it("original node unchanged → resolved, not recovered", () => {
    document.body.innerHTML = `<button>Checkout</button>`;
    const { Checkout } = capture();
    const r = resolveTarget(Checkout, { role: "button", label: "Checkout" });
    expect(r.status).toBe("resolved");
    expect(r.status === "resolved" && r.recovered).toBe(false);
    expect(r.status === "resolved" && r.element).toBe(document.querySelector("button"));
  });

  it("original node replaced by an equivalent node (privy-id stripped) → recovered by role+label", () => {
    document.body.innerHTML = `<div id="host"><button>Buy now</button></div>`;
    const { ["Buy now"]: id } = capture();

    // SPA re-render: brand new node, same role + accessible name, no data-privy-id.
    document.getElementById("host")!.innerHTML = `<button>Buy now</button>`;

    const r = resolveTarget(id, { role: "button", label: "Buy now" });
    expect(r.status).toBe("resolved");
    expect(r.status === "resolved" && r.recovered).toBe(true);
    // The id is stamped back so downstream resolveElement() agrees.
    expect(document.querySelector("button")!.getAttribute("data-privy-id")).toBe(String(id));
  });

  it("multiple equivalent nodes → ambiguous, never guesses", () => {
    document.body.innerHTML = `<div id="host"><button>Add to cart</button></div>`;
    const { ["Add to cart"]: id } = capture();

    document.getElementById("host")!.innerHTML = `
      <button>Add to cart</button>
      <button>Add to cart</button>
    `;

    const r = resolveTarget(id, { role: "button", label: "Add to cart" });
    expect(r.status).toBe("ambiguous");
    expect(r.status === "ambiguous" && r.candidates).toBe(2);
  });

  it("changed label on the SAME node → still resolved (identity beats label)", () => {
    document.body.innerHTML = `<button>Add to cart</button>`;
    const { ["Add to cart"]: id } = capture();
    document.querySelector("button")!.textContent = "Added ✓";

    const r = resolveTarget(id, { role: "button", label: "Add to cart" });
    expect(r.status).toBe("resolved");
    expect(r.status === "resolved" && r.recovered).toBe(false);
  });

  it("disappeared target with no equivalent → missing", () => {
    document.body.innerHTML = `<div id="host"><button>Remove item</button></div>`;
    const { ["Remove item"]: id } = capture();
    document.getElementById("host")!.innerHTML = ``;

    const r = resolveTarget(id, { role: "button", label: "Remove item" });
    expect(r.status).toBe("missing");
  });

  it("same node but role changed incompatibly → missing", () => {
    document.body.innerHTML = `<button id="x">Toggle</button>`;
    const { Toggle } = capture();
    // The framework swapped the control type in place (kept the privy-id).
    const el = document.getElementById("x")!;
    const replacement = document.createElement("p");
    replacement.id = "x";
    replacement.textContent = "Toggle";
    replacement.setAttribute("data-privy-id", el.getAttribute("data-privy-id")!);
    el.replaceWith(replacement);

    const r = resolveTarget(Toggle, { role: "button", label: "Toggle" });
    expect(r.status).toBe("missing");
  });

  it("stale numeric id that was never captured → unknown (defers to normal validation)", () => {
    document.body.innerHTML = `<button>Only button</button>`;
    capture();
    const r = resolveTarget(999999, { role: "button", label: "Nonexistent" });
    expect(r.status).toBe("unknown");
  });

  it("text-entry role drift (searchbox↔textbox) on the same node is tolerated", () => {
    document.body.innerHTML = `<input type="text" aria-label="Search">`;
    const { Search } = capture();
    const r = resolveTarget(Search, { role: "searchbox", label: "Search" });
    expect(r.status).toBe("resolved");
  });

  it("icon-only control (no accessible name) that was replaced → missing, never guesses", () => {
    document.body.innerHTML = `<div id="host"><button><svg viewBox="0 0 1 1"><path d="M0 0"/></svg></button></div>`;
    const state = captureDomState("t");
    const id = state.elements[0].elementId;
    expect(state.elements[0].label).toBeNull();

    document.getElementById("host")!.innerHTML = `<button><svg viewBox="0 0 1 1"><path d="M0 0"/></svg></button>`;
    const r = resolveTarget(id, { role: "button", label: null });
    expect(r.status).toBe("missing");
  });
});
