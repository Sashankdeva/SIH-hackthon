// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { captureDomState, resetElementRegistry } from "../../perception/domCapture";
import { validateAction } from "../validator";
import { executeAction } from "../executor";
import { verifyAction, type ActionSnapshot } from "../../pvm/verify";
import { setLocalSecret, clearLocalSecrets } from "../secretStore";

const TASK = "phase4a-controlled-input";

function idByLabel(label: string): number {
  const state = captureDomState(TASK);
  const hit = state.elements.find((e) => e.label === label);
  if (!hit) throw new Error(`no captured element labelled ${label}`);
  return hit.elementId;
}

function snap(elementId: number, value: string, before = ""): ActionSnapshot {
  return {
    urlBefore: location.href,
    scrollYBefore: 0,
    elementValueBefore: before,
    action: { action: "type", elementId, value, confidence: 1, taskId: TASK, stepId: 1 },
    startedAt: Date.now(),
  };
}

/**
 * Minimal reproduction of how React / Vue / Svelte / Angular guard a
 * *controlled* input:
 *
 *   - the framework installs its own `value` accessor on the element INSTANCE
 *     that keeps a change-tracker in lock-step;
 *   - on each `input` event it commits the DOM value to component state ONLY
 *     when the tracker disagrees with the DOM (i.e. the change came from
 *     outside the framework);
 *   - on re-render a controlled input is forced back to component state.
 *
 * Consequence: `el.value = x` (which goes through the instance setter) updates
 * the tracker too, so the `input` handler sees "no external change", state is
 * never updated, and the next render reverts the field. Writing through the
 * PROTOTYPE setter leaves the tracker stale → the change is detected & kept.
 */
function installControlledInput(el: HTMLInputElement, initialState = ""): {
  getState: () => string;
  rerender: () => void;
} {
  const nativeDesc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!;
  let stateValue = initialState;
  nativeDesc.set!.call(el, stateValue);
  let trackerValue = stateValue;

  Object.defineProperty(el, "value", {
    configurable: true,
    get() {
      return nativeDesc.get!.call(el);
    },
    set(v: string) {
      trackerValue = v; // framework's tracked instance setter
      nativeDesc.set!.call(el, v);
    },
  });

  el.addEventListener("input", () => {
    const domValue = nativeDesc.get!.call(el) as string;
    if (trackerValue === domValue) return; // framework: no external change → onChange NOT fired
    trackerValue = domValue;
    stateValue = domValue; // onChange → component state updates
  });

  return {
    getState: () => stateValue,
    rerender: () => nativeDesc.set!.call(el, stateValue), // controlled: DOM := state
  };
}

describe("Phase 4A — controlled-input execution hardening", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    resetElementRegistry();
    clearLocalSecrets();
  });

  it("1. types into a plain native <input>", async () => {
    document.body.innerHTML = `<label>Query <input type="text"></label>`;
    const id = idByLabel("Query");
    await executeAction({ action: "type", elementId: id, value: "hello world", confidence: 1, taskId: TASK, stepId: 1 });
    expect((document.querySelector("input") as HTMLInputElement).value).toBe("hello world");
  });

  it("2. types into a <textarea>", async () => {
    document.body.innerHTML = `<label>Notes <textarea></textarea></label>`;
    const id = idByLabel("Notes");
    const text = "line one\nline two";
    await executeAction({ action: "type", elementId: id, value: text, confidence: 1, taskId: TASK, stepId: 1 });
    expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe(text);
  });

  it("3. controlled-input simulation: framework observes the update and commits it to state", async () => {
    document.body.innerHTML = `<label>Search <input id="q" type="text"></label>`;
    const el = document.getElementById("q") as HTMLInputElement;
    const app = installControlledInput(el, "");
    const id = idByLabel("Search");

    await executeAction({ action: "type", elementId: id, value: "Galaxy", confidence: 1, taskId: TASK, stepId: 1 });

    expect(el.value).toBe("Galaxy");
    expect(app.getState()).toBe("Galaxy"); // the framework accepted the change
  });

  it("4. dispatches a bubbling input event", async () => {
    document.body.innerHTML = `<form><input type="text" aria-label="F"></form>`;
    let got = false;
    document.querySelector("form")!.addEventListener("input", (e) => {
      got = e.bubbles === true;
    });
    const id = idByLabel("F");
    await executeAction({ action: "type", elementId: id, value: "x", confidence: 1, taskId: TASK, stepId: 1 });
    expect(got).toBe(true);
  });

  it("5. dispatches a bubbling change event", async () => {
    document.body.innerHTML = `<form><input type="text" aria-label="F"></form>`;
    let got = false;
    document.querySelector("form")!.addEventListener("change", (e) => {
      got = e.bubbles === true;
    });
    const id = idByLabel("F");
    await executeAction({ action: "type", elementId: id, value: "x", confidence: 1, taskId: TASK, stepId: 1 });
    expect(got).toBe(true);
  });

  it("6. value is preserved after a simulated controlled re-render", async () => {
    document.body.innerHTML = `<label>Search <input id="q" type="text"></label>`;
    const el = document.getElementById("q") as HTMLInputElement;
    const app = installControlledInput(el, "");
    const id = idByLabel("Search");

    await executeAction({ action: "type", elementId: id, value: "persisted", confidence: 1, taskId: TASK, stepId: 1 });
    app.rerender();

    expect(el.value).toBe("persisted");
    expect(app.getState()).toBe("persisted");
  });

  it("REGRESSION: direct `el.value = ...` is reverted by a controlled re-render", () => {
    document.body.innerHTML = `<input id="q" type="text">`;
    const el = document.getElementById("q") as HTMLInputElement;
    const app = installControlledInput(el, "");

    // The pre-Phase-4A approach: assign through the instance setter, then signal.
    el.value = "typed-directly";
    el.dispatchEvent(new Event("input", { bubbles: true }));

    // Framework never saw an external change → state still empty → re-render reverts.
    expect(app.getState()).toBe("");
    app.rerender();
    expect(el.value).not.toBe("typed-directly");
    expect(el.value).toBe("");
  });

  it("7. disabled input is rejected by the validator", () => {
    document.body.innerHTML = `<label>D <input type="text" disabled></label>`;
    const id = idByLabel("D");
    const r = validateAction({ action: "type", elementId: id, value: "x", confidence: 1, taskId: TASK, stepId: 1 }, TASK);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/disabled/i);
  });

  it("8. readonly input is rejected by the validator", () => {
    document.body.innerHTML = `<label>R <input type="text" readonly></label>`;
    const id = idByLabel("R");
    const r = validateAction({ action: "type", elementId: id, value: "x", confidence: 1, taskId: TASK, stepId: 1 }, TASK);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/readonly/i);
  });

  it("9. empty / whitespace-only type is rejected by the validator", () => {
    document.body.innerHTML = `<label>E <input type="text"></label>`;
    const id = idByLabel("E");
    for (const v of [null, "", "   ", "\t\n"]) {
      const r = validateAction(
        { action: "type", elementId: id, value: v as string | null, confidence: 1, taskId: TASK, stepId: 1 },
        TASK
      );
      expect(r.ok).toBe(false);
    }
  });

  it("10. type_secret still resolves the token locally and fills the field (semantics unchanged)", async () => {
    setLocalSecret("[PASSWORD_01]", "s3cr3t-Phase4A");
    document.body.innerHTML = `<label>Password <input type="password"></label>`;
    const id = idByLabel("Password");
    await executeAction({ action: "type_secret", elementId: id, valueRef: "[PASSWORD_01]", confidence: 1, taskId: TASK, stepId: 1 });
    expect((document.querySelector("input") as HTMLInputElement).value).toBe("s3cr3t-Phase4A");
  });

  it("10b. type_secret with an unknown ref is a safe no-op (semantics unchanged)", async () => {
    document.body.innerHTML = `<input type="password" value="unchanged" aria-label="P">`;
    const id = idByLabel("P");
    await executeAction({ action: "type_secret", elementId: id, valueRef: "[MISSING]", confidence: 1, taskId: TASK, stepId: 1 });
    expect((document.querySelector("input") as HTMLInputElement).value).toBe("unchanged");
  });

  it("11. native <select> behaviour is unchanged (option chosen, not text-injected)", async () => {
    document.body.innerHTML = `<label>Size <select><option value="s">Small</option><option value="m">Medium</option></select></label>`;
    const id = idByLabel("Size");
    await executeAction({ action: "type", elementId: id, value: "Medium", confidence: 1, taskId: TASK, stepId: 1 });
    expect((document.querySelector("select") as HTMLSelectElement).value).toBe("m");
  });

  it("12. PVM verifies a successful type", async () => {
    document.body.innerHTML = `<input type="text" aria-label="V">`;
    const id = idByLabel("V");
    await executeAction({ action: "type", elementId: id, value: "verified", confidence: 1, taskId: TASK, stepId: 1 });
    const res = verifyAction(`${TASK}:1`, snap(id, "verified"));
    expect(res.status).toBe("success");
    expect(res.observed).toBe("value_matches");
  });

  it("13. PVM still reports a genuine mismatch as failure (not hidden)", async () => {
    document.body.innerHTML = `<input type="text" aria-label="Stuck">`;
    const el = document.querySelector("input") as HTMLInputElement;
    const id = idByLabel("Stuck");
    // An aggressively controlled component that reverts every external write
    // synchronously: the executor runs, but the DOM value never becomes the
    // requested one, so PVM must report failure — never success/ambiguous.
    Object.defineProperty(el, "value", { configurable: true, get: () => "stuck", set: () => {} });
    await executeAction({ action: "type", elementId: id, value: "wanted-value", confidence: 1, taskId: TASK, stepId: 1 });
    const res = verifyAction(`${TASK}:1`, snap(id, "wanted-value"));
    expect(res.status).toBe("failure");
    expect(res.observed).toBe("value_mismatch");
  });
});
