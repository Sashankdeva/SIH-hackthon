// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { verifyAction, type ActionSnapshot } from "../verify";
import { captureDomState, resetElementRegistry } from "../../perception/domCapture";
import { executeAction } from "../../action/executor";

const TASK = "phase3-select-verify";

function idByLabel(label: string): number {
  const state = captureDomState(TASK);
  return state.elements.find((e) => e.label === label)!.elementId;
}

function snapshot(elementId: number, value: string): ActionSnapshot {
  return {
    urlBefore: location.href,
    scrollYBefore: 0,
    elementValueBefore: "",
    action: { action: "type", elementId, value, confidence: 1, taskId: TASK, stepId: 1 },
    startedAt: Date.now(),
  };
}

describe("Phase 3 — PVM verification of <select> option choice", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    resetElementRegistry();
  });

  it("success: the chosen option matches the requested value", async () => {
    document.body.innerHTML = `<label>Size <select id="s"><option value="s">Small</option><option value="m">Medium</option></select></label>`;
    const id = idByLabel("Size");
    await executeAction({ action: "type", elementId: id, value: "Medium", confidence: 1, taskId: TASK, stepId: 1 });
    const res = verifyAction(`${TASK}:1`, snapshot(id, "Medium"));
    expect(res.status).toBe("success");
    expect(res.expected).toBe("option_selected");
    expect(res.observed).toBe("option_selected");
  });

  it("failure: nothing changed because the option does not exist", () => {
    document.body.innerHTML = `<label>Size <select id="s"><option value="s">Small</option><option value="m">Medium</option></select></label>`;
    const id = idByLabel("Size");
    // No execute — or an execute that could not match. Verifier must not claim success.
    const res = verifyAction(`${TASK}:1`, snapshot(id, "Large"));
    expect(res.status).toBe("failure");
    expect(res.observed).toBe("option_not_selected");
  });

  it("failure: element vanished before verification", () => {
    document.body.innerHTML = `<label>Size <select id="s"><option>Small</option></select></label>`;
    const id = idByLabel("Size");
    document.getElementById("s")!.remove();
    const res = verifyAction(`${TASK}:1`, snapshot(id, "Small"));
    expect(res.status).toBe("failure");
    expect(res.observed).toBe("element_not_found");
  });

  it("does not turn an unmatched select into an ambiguous/success outcome", async () => {
    document.body.innerHTML = `<label>Size <select id="s"><option value="s">Small</option></select></label>`;
    const id = idByLabel("Size");
    await executeAction({ action: "type", elementId: id, value: "Extra Large", confidence: 1, taskId: TASK, stepId: 1 });
    const res = verifyAction(`${TASK}:1`, snapshot(id, "Extra Large"));
    expect(res.status).toBe("failure");
  });
});
