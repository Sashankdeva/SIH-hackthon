// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { captureDomState, resetElementRegistry } from "../../perception/domCapture";
import { validateAction } from "../validator";
import { executeAction } from "../executor";

const TASK = "phase3-select-svg";

function idByLabel(label: string): number {
  const state = captureDomState(TASK);
  const hit = state.elements.find((e) => e.label === label);
  if (!hit) throw new Error(`no captured element labelled ${label}`);
  return hit.elementId;
}

describe("Phase 3 — native <select> via the type action", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    resetElementRegistry();
  });

  it("validator accepts `type` on a <select> and rejects `type_secret`", () => {
    document.body.innerHTML = `
      <label>Size <select><option value="s">Small</option><option value="m">Medium</option></select></label>`;
    const id = idByLabel("Size");
    expect(validateAction({ action: "type", elementId: id, value: "Medium", confidence: 0.9, taskId: TASK, stepId: 1 }, TASK).ok).toBe(true);
    const secret = validateAction({ action: "type_secret", elementId: id, valueRef: "[X]", confidence: 0.9, taskId: TASK, stepId: 1 }, TASK);
    expect(secret.ok).toBe(false);
  });

  it("validator rejects `type` on a disabled <select>", () => {
    document.body.innerHTML = `<label>Size <select disabled><option>Small</option></select></label>`;
    const id = idByLabel("Size");
    const r = validateAction({ action: "type", elementId: id, value: "Small", confidence: 0.9, taskId: TASK, stepId: 1 }, TASK);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/disabled/i);
  });

  it("selects an option by visible text and fires change", async () => {
    document.body.innerHTML = `
      <label>Color <select id="c"><option value="r">Red</option><option value="g">Green</option><option value="b">Blue</option></select></label>`;
    const sel = document.getElementById("c") as HTMLSelectElement;
    let changed = false;
    sel.addEventListener("change", () => { changed = true; });
    const id = idByLabel("Color");

    await executeAction({ action: "type", elementId: id, value: "Green", confidence: 0.9, taskId: TASK, stepId: 1 });

    expect(sel.value).toBe("g");
    expect(changed).toBe(true);
  });

  it("selects an option by its value attribute", async () => {
    document.body.innerHTML = `<label>Qty <select id="q"><option value="1">One</option><option value="2">Two</option></select></label>`;
    const sel = document.getElementById("q") as HTMLSelectElement;
    const id = idByLabel("Qty");
    await executeAction({ action: "type", elementId: id, value: "2", confidence: 0.9, taskId: TASK, stepId: 1 });
    expect(sel.value).toBe("2");
  });

  it("leaves the <select> untouched when no option matches (no false success)", async () => {
    document.body.innerHTML = `<label>Color <select id="c"><option value="r">Red</option><option value="g">Green</option></select></label>`;
    const sel = document.getElementById("c") as HTMLSelectElement;
    const before = sel.value;
    const id = idByLabel("Color");
    await executeAction({ action: "type", elementId: id, value: "Magenta", confidence: 0.9, taskId: TASK, stepId: 1 });
    expect(sel.value).toBe(before);
  });
});

describe("Phase 3 — safe click for SVG / non-HTML targets", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    resetElementRegistry();
  });

  it("standard <button> keeps native click behaviour", async () => {
    document.body.innerHTML = `<button id="b">Go</button>`;
    let clicks = 0;
    document.getElementById("b")!.addEventListener("click", () => { clicks++; });
    const id = idByLabel("Go");
    await executeAction({ action: "click", elementId: id, confidence: 0.9, taskId: TASK, stepId: 1 });
    expect(clicks).toBe(1);
  });

  it("SVG control with role=button receives a click event", async () => {
    document.body.innerHTML = `<svg role="button" aria-label="Zoom in" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>`;
    const svg = document.querySelector("svg")!;
    let clicked = false;
    svg.addEventListener("click", () => { clicked = true; });
    const id = idByLabel("Zoom in");
    await executeAction({ action: "click", elementId: id, confidence: 0.9, taskId: TASK, stepId: 1 });
    expect(clicked).toBe(true);
  });

  it("a target that cannot be clicked throws a typed execution error (no false success)", async () => {
    // Simulate a resolved element whose click affordance is absent.
    document.body.innerHTML = `<button id="b">Go</button>`;
    const id = idByLabel("Go");
    const el = document.getElementById("b")!;
    // Strip the click method and neuter event dispatch.
    (el as unknown as { click: unknown }).click = undefined;
    (el as unknown as { dispatchEvent: unknown }).dispatchEvent = undefined;
    await expect(
      executeAction({ action: "click", elementId: id, confidence: 0.9, taskId: TASK, stepId: 1 })
    ).rejects.toThrow(/click_target_not_clickable/);
  });
});
