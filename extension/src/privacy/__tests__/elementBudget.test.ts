// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  captureDomState,
  resetElementRegistry,
  resolveElement,
  resolveTarget,
  getCaptureMeta,
  captureBudgetSignals,
} from "../../perception/domCapture";
import { budgetElements, DEFAULT_BUDGET } from "../../perception/elementBudget";
import { detectTier1 } from "../tier1DomRules";
import { redact, resetTokenCounters } from "../redact";
import { buildSanitizedContext, toWireSanitizedContext } from "../sanitizedContext";

const MAX = DEFAULT_BUDGET.maxElements;

/** JSDOM has no layout — stamp a deterministic rect on an element. */
function rect(el: Element, top: number, height = 32, left = 8, width = 180): void {
  (el as HTMLElement).getBoundingClientRect = () =>
    ({ top, height, left, width, bottom: top + height, right: left + width, x: left, y: top, toJSON() {} }) as DOMRect;
}

function sanitize(task = "do the task") {
  const ps = captureDomState("budget-task");
  const det = detectTier1(ps.elements);
  const red = redact(det);
  const fw = buildSanitizedContext(ps, det, red, task);
  if (!fw.ok) throw new Error("firewall blocked");
  return { pageState: ps, context: fw.context, wire: toWireSanitizedContext(fw.context) };
}

/** Build N plain buttons; optionally place the first `inView` of them on-screen. */
function bigButtonPage(n: number, inView = 6): void {
  const main = document.createElement("main");
  for (let i = 0; i < n; i++) {
    const b = document.createElement("button");
    b.textContent = `Item ${i}`;
    main.appendChild(b);
  }
  document.body.appendChild(main);
  const btns = Array.from(document.querySelectorAll("button"));
  btns.forEach((b, i) => rect(b, i < inView ? 40 + i * 40 : 2000 + i * 40));
}

describe("Phase 4B — long-page element budgeting", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.title = "Budget Test";
    resetElementRegistry();
    resetTokenCounters();
  });

  it("1. small page → every relevant control is preserved, budget inert", () => {
    document.body.innerHTML = `
      <nav><a href="/x">Home</a></nav>
      <form>
        <label>Name <input type="text"></label>
        <label>Notes <textarea></textarea></label>
        <label>Size <select><option>S</option><option>M</option></select></label>
        <button type="submit">Save</button>
      </form>`;
    const { pageState, context } = sanitize();
    expect(context.elements.length).toBe(pageState.elements.length);
    expect(context.elements.length).toBeLessThanOrEqual(MAX);
  });

  it("2. large page → budget applied, count capped at the configured max", () => {
    bigButtonPage(MAX + 220);
    const { pageState, context } = sanitize();
    expect(pageState.elements.length).toBe(MAX + 220);
    expect(context.elements.length).toBe(MAX);
  });

  it("3. viewport controls are prioritized over below-the-fold controls", () => {
    bigButtonPage(MAX + 300, 20);
    const { pageState, context } = sanitize();
    const keptIds = new Set(context.elements.map((e) => e.elementId));
    // The 20 elements stamped inside the viewport must all survive.
    const inViewportIds = pageState.elements.slice(0, 20).map((e) => e.elementId);
    for (const id of inViewportIds) expect(keptIds.has(id)).toBe(true);
  });

  it("4. the focused control is always preserved even when far below the fold", () => {
    bigButtonPage(MAX + 300, 4);
    const btns = Array.from(document.querySelectorAll("button"));
    const deep = btns[btns.length - 1];
    rect(deep, 99999);
    deep.focus();
    expect(document.activeElement).toBe(deep);
    const { context } = sanitize();
    const focusedId = getIdOf(deep);
    expect(context.elements.some((e) => e.elementId === focusedId)).toBe(true);
  });

  it("5. editable controls are preserved ahead of plain below-fold links", () => {
    const main = document.createElement("main");
    // one editable field, far below the fold
    const input = document.createElement("input");
    input.type = "text";
    input.setAttribute("aria-label", "Coupon code");
    main.appendChild(input);
    // a flood of below-fold links
    for (let i = 0; i < MAX + 200; i++) {
      const a = document.createElement("a");
      a.href = `/l${i}`;
      a.textContent = `Link ${i}`;
      main.appendChild(a);
    }
    document.body.appendChild(main);
    Array.from(main.children).forEach((el, i) => rect(el, 3000 + i * 30));
    const { context } = sanitize();
    const couponId = getIdOf(input);
    expect(context.elements.some((e) => e.elementId === couponId)).toBe(true);
  });

  it("6. many identical labels stay distinguishable (not collapsed to one)", () => {
    const main = document.createElement("main");
    const unique = document.createElement("button");
    unique.textContent = "Proceed to checkout";
    main.appendChild(unique);
    for (let i = 0; i < MAX + 120; i++) {
      const b = document.createElement("button");
      b.textContent = "Add to cart";
      main.appendChild(b);
    }
    document.body.appendChild(main);
    Array.from(main.querySelectorAll("button")).forEach((b, i) => rect(b, 40 + i * 20));

    const { context } = sanitize();
    // The lone unique control survives the duplicate flood.
    expect(context.elements.some((e) => e.label === "Proceed to checkout")).toBe(true);
    // Multiple distinct "Add to cart" instances remain, each its own id.
    const carts = context.elements.filter((e) => e.label === "Add to cart");
    expect(carts.length).toBeGreaterThan(10);
    expect(new Set(carts.map((e) => e.elementId)).size).toBe(carts.length);
  });

  it("7. hidden controls remain excluded (never enter capture or budget)", () => {
    document.body.innerHTML = `
      <button>Visible</button>
      <button hidden>Hidden attr</button>
      <button style="display:none">Display none</button>
      <div aria-hidden="true"><button>Nested aria-hidden</button></div>`;
    const { context } = sanitize();
    const labels = context.elements.map((e) => e.label);
    expect(labels).toContain("Visible");
    expect(labels).not.toContain("Hidden attr");
    expect(labels).not.toContain("Display none");
    expect(labels).not.toContain("Nested aria-hidden");
  });

  it("8. disabled state is still captured (budget does not strip it)", () => {
    bigButtonPage(MAX + 50);
    const btns = Array.from(document.querySelectorAll("button"));
    (btns[0] as HTMLButtonElement).disabled = true;
    rect(btns[0], 60);
    const { pageState } = sanitize();
    const first = pageState.elements.find((e) => e.elementId === getIdOf(btns[0]));
    expect(first?.disabled).toBe(true);
  });

  it("9. every element_id serialised to the model resolves to a live node", () => {
    bigButtonPage(MAX + 300, 30);
    const { context } = sanitize();
    for (const e of context.elements) {
      expect(resolveElement(e.elementId)).not.toBeNull();
    }
  });

  it("10. stale-target resolution works for BOTH kept and omitted element ids", () => {
    bigButtonPage(MAX + 200, 10);
    const { pageState, context } = sanitize();
    const keptIds = new Set(context.elements.map((e) => e.elementId));
    const keptId = context.elements[0].elementId;
    const omitted = pageState.elements.find((e) => !keptIds.has(e.elementId))!;

    // metadata exists for all captured controls, budgeted or not
    expect(getCaptureMeta(keptId)).not.toBeNull();
    expect(getCaptureMeta(omitted.elementId)).not.toBeNull();

    // an omitted control is still fully resolvable by the existing mechanism
    const r = resolveTarget(omitted.elementId, { role: omitted.role, label: omitted.label });
    expect(r.status).toBe("resolved");

    // and a kept control recovers after an equivalent-node re-render
    const keptEl = resolveElement(keptId)!;
    const clone = keptEl.cloneNode(true) as Element;
    clone.removeAttribute("data-privy-id");
    keptEl.replaceWith(clone);
    const meta = getCaptureMeta(keptId)!;
    const r2 = resolveTarget(keptId, { role: meta.role, label: context.elements[0].label });
    expect(r2.status).toBe("resolved");
  });

  it("11. an omitted control reappears on the next fresh capture after scrolling", () => {
    bigButtonPage(MAX + 300, 4);
    const s1 = sanitize();
    const keptIds = new Set(s1.context.elements.map((e) => e.elementId));
    const omitted = s1.pageState.elements.find((e) => !keptIds.has(e.elementId))!;
    expect(getCaptureMeta(omitted.elementId)).not.toBeNull();

    // "scroll": the previously-omitted control is now on screen.
    const node = resolveElement(omitted.elementId)!;
    rect(node, 120);
    const s2 = sanitize();
    expect(s2.context.elements.some((e) => e.elementId === omitted.elementId)).toBe(true);
  });

  it("12. serialised payload size is bounded on a very large page", () => {
    // Long labels so the secondary byte guard is actually exercised.
    const main = document.createElement("main");
    for (let i = 0; i < MAX + 250; i++) {
      const b = document.createElement("button");
      // > MAX_LABEL so every kept element serialises near the 120-char cap,
      // pushing the estimate past maxBytes and forcing the secondary guard.
      b.textContent = `Interactive control ${i} ` + "descriptive ".repeat(12);
      main.appendChild(b);
    }
    document.body.appendChild(main);
    Array.from(main.querySelectorAll("button")).forEach((b, i) => rect(b, i < 40 ? 40 + i * 20 : 4000 + i * 20));

    const { context, wire } = sanitize();
    expect(context.elements.length).toBeLessThanOrEqual(MAX);
    const bytes = new TextEncoder().encode(JSON.stringify(wire)).length;
    expect(bytes).toBeLessThanOrEqual(DEFAULT_BUDGET.maxBytes);
  });

  it("13. sanitization is unchanged — redacted fields still tokenised even below the fold", () => {
    const main = document.createElement("main");
    // sensitive fields, deliberately far below the fold on an over-budget page
    for (const [label, type] of [["Email", "email"], ["Password", "password"], ["Card Number", "text"]] as const) {
      const l = document.createElement("label");
      l.textContent = label + " ";
      const inp = document.createElement("input");
      inp.type = type;
      inp.value = `CANARY_${label.replace(/\s/g, "")}_VALUE`;
      l.appendChild(inp);
      main.appendChild(l);
    }
    for (let i = 0; i < MAX + 200; i++) {
      const b = document.createElement("button");
      b.textContent = `Filler ${i}`;
      main.appendChild(b);
    }
    document.body.appendChild(main);
    Array.from(main.querySelectorAll("input,button")).forEach((el, i) => rect(el, 5000 + i * 20));

    const { context } = sanitize();
    const json = JSON.stringify(context);
    // redacted fields survive the budget as tokens
    expect(Object.keys(context.fields).length).toBe(3);
    for (const id of Object.keys(context.fields)) {
      expect(context.elements.some((e) => String(e.elementId) === id)).toBe(true);
    }
    // and no raw value leaked anywhere
    expect(json).not.toMatch(/CANARY_\w+_VALUE/);
  });

  it("14. budgeting introduces no raw-value leakage on a huge mixed page", () => {
    const main = document.createElement("main");
    const secret = document.createElement("input");
    secret.type = "password";
    secret.setAttribute("aria-label", "Password");
    secret.value = "hunter2-do-not-leak";
    main.appendChild(secret);
    for (let i = 0; i < MAX + 250; i++) {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.setAttribute("aria-label", `Field ${i}`);
      inp.value = `plain-value-${i}`;
      main.appendChild(inp);
    }
    document.body.appendChild(main);
    Array.from(main.querySelectorAll("input")).forEach((el, i) => rect(el, i < 20 ? 40 + i * 30 : 4000 + i * 20));

    const { wire } = sanitize();
    const json = JSON.stringify(wire);
    expect(json).not.toContain("hunter2-do-not-leak");
    expect(json).not.toMatch(/plain-value-\d+/);
  });

  it("BENCHMARK: before/after element count and payload bytes", () => {
    bigButtonPage(600, 30);
    const ps = captureDomState("bench");
    const det = detectTier1(ps.elements);
    const red = redact(det);
    const redSet = new Set(red.map((r) => r.elementId));
    const signals = captureBudgetSignals();

    const before = budgetElements(ps.elements, signals, redSet, { maxElements: 1e9, maxBytes: 1e9 });
    const after = budgetElements(ps.elements, signals, redSet, DEFAULT_BUDGET);

    const estBytes = (els: { role: string; label: string | null }[]) =>
      els.reduce((n, e) => n + 34 + e.role.length + (e.label ? e.label.length : 4), 40);

    const beforeBytes = estBytes(before.kept);
    const afterBytes = estBytes(after.kept);

    // eslint-disable-next-line no-console
    console.log(
      `[Phase 4B BENCHMARK] elements ${before.kept.length} -> ${after.kept.length} ` +
      `(${Math.round((1 - after.kept.length / before.kept.length) * 100)}% cut) | ` +
      `~bytes ${beforeBytes} -> ${afterBytes}`
    );

    expect(before.budgeted).toBe(false);
    expect(after.budgeted).toBe(true);
    expect(after.kept.length).toBe(MAX);
    expect(afterBytes).toBeLessThan(beforeBytes * 0.6);
  });
});

/** Helper: the capture id of a live element (via its data-privy-id after capture). */
function getIdOf(el: Element): number {
  const raw = el.getAttribute("data-privy-id");
  if (!raw) throw new Error("element was not captured");
  return Number(raw);
}
