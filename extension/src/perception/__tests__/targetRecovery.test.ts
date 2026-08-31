// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { captureDomState, resetElementRegistry, resolveTarget, resolveTargetSettled, resolveElement, isUsableTarget, TARGET_SETTLE_MS } from "../domCapture";

/**
 * C14 — target recovery after a page change.
 *
 * Real Chrome failure: "Step 6 failed — action failed local validation
 * (target_lost)". resolveTarget short-circuited to `missing` whenever the id
 * still resolved to a node that was no longer a compatible interactive control
 * (framework re-render reusing the node, data-privy-id riding along), never
 * reaching the (role, accessible name) recovery sitting directly below it.
 */
describe("target recovery after DOM replacement", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.title = "T";
    resetElementRegistry();
  });

  const idOf = (label: string) =>
    captureDomState("t").elements.find((e) => e.label === label)!.elementId;

  it("1. target unchanged → direct resolution, not a recovery", () => {
    document.body.innerHTML = `<button aria-label="Add to cart">Add</button>`;
    const id = idOf("Add to cart");
    const r = resolveTarget(id, { role: "button", label: "Add to cart" });
    expect(r.status).toBe("resolved");
    if (r.status === "resolved") expect(r.recovered).toBe(false);
  });

  it("2. DOM node replaced → recovered by role + accessible name", () => {
    document.body.innerHTML = `<button aria-label="Add to cart">Add</button>`;
    const id = idOf("Add to cart");
    // framework swaps in a brand new node with the same role + name
    document.body.innerHTML = `<button aria-label="Add to cart">Add</button>`;
    const r = resolveTarget(id, { role: "button", label: "Add to cart" });
    expect(r.status).toBe("resolved");
    if (r.status === "resolved") expect(r.recovered).toBe(true);
  });

  it("3. THE BUG: id still resolves but the node is no longer interactive → recovers instead of target_lost", () => {
    document.body.innerHTML = `<button aria-label="Add to cart">Add</button>`;
    const id = idOf("Add to cart");
    const stale = document.querySelector("button")!;

    // Re-render reuses that node as a non-interactive wrapper (id rides along),
    // and builds the real control elsewhere.
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-privy-id", String(id));
    stale.replaceWith(wrapper);
    const real = document.createElement("button");
    real.setAttribute("aria-label", "Add to cart");
    real.textContent = "Add";
    document.body.appendChild(real);

    const r = resolveTarget(id, { role: "button", label: "Add to cart" });
    expect(r.status).toBe("resolved");          // was "missing" before the fix
    if (r.status === "resolved") {
      expect(r.recovered).toBe(true);
      expect(r.element).toBe(real);
    }
  });

  it("4. current DOM temporarily empty → bounded settle then recovery", async () => {
    document.body.innerHTML = `<button aria-label="Add to cart">Add</button>`;
    const id = idOf("Add to cart");
    document.body.innerHTML = ``; // mid re-render

    setTimeout(() => {
      document.body.innerHTML = `<button aria-label="Add to cart">Add</button>`;
    }, 200);

    const r = await resolveTargetSettled(id, { role: "button", label: "Add to cart" });
    expect(r.status).toBe("resolved");
    if (r.status === "resolved") expect(r.recovered).toBe(true);
  });

  it("5. zero candidates → target_lost still stands, and is bounded", async () => {
    document.body.innerHTML = `<button aria-label="Add to cart">Add</button>`;
    const id = idOf("Add to cart");
    document.body.innerHTML = `<button aria-label="Something Else">X</button>`;

    const started = Date.now();
    const r = await resolveTargetSettled(id, { role: "button", label: "Add to cart" });
    const elapsed = Date.now() - started;
    expect(r.status).toBe("missing");
    expect(elapsed).toBeLessThan(TARGET_SETTLE_MS + 1500);
  });

  it("6. multiple candidates → ambiguous, never an arbitrary pick", async () => {
    document.body.innerHTML = `<button aria-label="Add to cart">Add</button>`;
    const id = idOf("Add to cart");
    document.body.innerHTML = `
      <button aria-label="Add to cart">A</button>
      <button aria-label="Add to cart">B</button>`;
    const r = await resolveTargetSettled(id, { role: "button", label: "Add to cart" });
    expect(r.status).toBe("ambiguous");
    if (r.status === "ambiguous") expect(r.candidates).toBe(2);
  });

  it("7. a different-role control with the same name is NOT accepted", () => {
    document.body.innerHTML = `<button aria-label="Cart">Cart</button>`;
    const id = idOf("Cart");
    document.body.innerHTML = `<a href="/cart" aria-label="Cart">Cart</a>`; // link, not button
    const r = resolveTarget(id, { role: "button", label: "Cart" });
    expect(r.status).toBe("missing");
  });

  it("8. recovered target is rebound so executor/PVM resolve the same node", () => {
    document.body.innerHTML = `<button aria-label="Add to cart">Add</button>`;
    const id = idOf("Add to cart");
    document.body.innerHTML = `<button aria-label="Add to cart">Add</button>`;
    const r = resolveTarget(id, { role: "button", label: "Add to cart" });
    expect(r.status).toBe("resolved");
    if (r.status === "resolved") {
      // the id is stamped back onto the live node — one shared target identity
      expect(r.element.getAttribute("data-privy-id")).toBe(String(id));
    }
  });

  it("9. resolveTargetSettled returns immediately for a healthy target (no delay)", async () => {
    document.body.innerHTML = `<button aria-label="Go">Go</button>`;
    const id = idOf("Go");
    const started = Date.now();
    const r = await resolveTargetSettled(id, { role: "button", label: "Go" });
    expect(r.status).toBe("resolved");
    expect(Date.now() - started).toBeLessThan(60);
  });
});

describe("permanent target-resolution guarantees", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.title = "T";
    resetElementRegistry();
  });

  const idOf2 = (label: string) =>
    captureDomState("t").elements.find((e) => e.label === label)!.elementId;

  it("10. a detached node is never returned as resolved", () => {
    document.body.innerHTML = `<button aria-label="Act">Act</button>`;
    const id = idOf2("Act");
    const node = document.querySelector("button")!;
    node.remove(); // detached, still in the WeakMap
    const r = resolveTarget(id, { role: "button", label: "Act" });
    expect(r.status).toBe("missing");
  });

  it("11. isUsableTarget rejects detached, hidden, and role-mismatched nodes", () => {
    document.body.innerHTML = `<button id="b" aria-label="Act">Act</button>`;
    const b = document.getElementById("b")!;
    expect(isUsableTarget(b, "button")).toBe(true);
    expect(isUsableTarget(b, "textbox")).toBe(false); // role mismatch
    b.remove();
    expect(isUsableTarget(b, "button")).toBe(false); // detached
    expect(isUsableTarget(null, "button")).toBe(false);
  });

  it("12. strict mode refuses to recover from stale capture metadata", () => {
    document.body.innerHTML = `<button aria-label="Act">Act</button>`;
    const id = idOf2("Act");
    // node replaced by an equivalent one; captureMeta still remembers role+name
    document.body.innerHTML = `<button aria-label="Act">Act</button>`;

    // strict FIRST — a non-strict call would rebind the id onto the replacement
    // and make the direct path succeed afterwards.
    // strict (id was NOT in the context): no invented metadata, no recovery
    expect(resolveTarget(id, undefined, { strict: true }).status).not.toBe("resolved");
    // non-strict (id WAS in the context): deterministic recovery is allowed
    expect(resolveTarget(id, { role: "button", label: "Act" }).status).toBe("resolved");
  });

  it("13. recovery still refuses to pick between two equal candidates", () => {
    document.body.innerHTML = `<button aria-label="Act">Act</button>`;
    const id = idOf2("Act");
    document.body.innerHTML =
      `<button aria-label="Act">A</button><button aria-label="Act">B</button>`;
    const r = resolveTarget(id, { role: "button", label: "Act" });
    expect(r.status).toBe("ambiguous");
  });

  it("14. a hidden replacement is not accepted as the recovered target", () => {
    document.body.innerHTML = `<button aria-label="Act">Act</button>`;
    const id = idOf2("Act");
    document.body.innerHTML = `<button aria-label="Act" style="display:none">Act</button>`;
    expect(resolveTarget(id, { role: "button", label: "Act" }).status).toBe("missing");
  });

  it("15. a healthy direct target resolves fast and is NOT marked recovered", async () => {
    document.body.innerHTML = `<button aria-label="Act">Act</button>`;
    const id = idOf2("Act");
    const started = Date.now();
    const r = await resolveTargetSettled(id, { role: "button", label: "Act" });
    expect(Date.now() - started).toBeLessThan(60);
    expect(r.status).toBe("resolved");
    if (r.status === "resolved") expect(r.recovered).toBe(false);
  });

  it("16. the recovered node carries the id so executor and PVM share one target", () => {
    document.body.innerHTML = `<button aria-label="Act">Act</button>`;
    const id = idOf2("Act");
    document.body.innerHTML = `<button aria-label="Act">Act</button>`;
    const r = resolveTarget(id, { role: "button", label: "Act" });
    expect(r.status).toBe("resolved");
    if (r.status === "resolved") {
      expect(r.element.getAttribute("data-privy-id")).toBe(String(id));
      // both layers resolve the identical node
      expect(resolveElement(id)).toBe(r.element);
    }
  });
});
