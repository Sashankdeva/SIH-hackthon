// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyActionSettled, type ActionSnapshot } from "../verify";
import { resetElementRegistry, captureDomState } from "../../perception/domCapture";
import type { ActionRequest } from "../../action/types";

/**
 * Regression: the settle loop must stay bounded when requestAnimationFrame
 * never fires.
 *
 * Real-Chrome failure this locks: clicking a link starts a navigation, the
 * document stops being rendered, rAF callbacks are never invoked, and
 * verifyActionSettled — whose loop only re-checks its deadline after a frame
 * tick — never returned. The step burned the full 20s task-loop budget and the
 * task died on its first action.
 */
describe("PVM settle loop is bounded without requestAnimationFrame", () => {
  let originalRaf: typeof globalThis.requestAnimationFrame;

  beforeEach(() => {
    document.body.innerHTML = "";
    resetElementRegistry();
    originalRaf = globalThis.requestAnimationFrame;
  });

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRaf;
    vi.restoreAllMocks();
  });

  const snapshotFor = (action: ActionRequest): ActionSnapshot => ({
    urlBefore: location.href,
    scrollYBefore: 0,
    elementValueBefore: null,
    action,
    startedAt: Date.now(),
    targetBefore: null,
  });

  it("click verification resolves even when rAF callbacks never fire", async () => {
    // rAF that accepts the callback and NEVER invokes it — exactly what Chrome
    // does for a tab that is not being rendered.
    globalThis.requestAnimationFrame = ((_cb: FrameRequestCallback) => 1) as typeof globalThis.requestAnimationFrame;

    document.body.innerHTML = `<button id="b" aria-label="Go">Go</button>`;
    const ids = captureDomState("t").elements.map((e) => e.elementId);

    const action: ActionRequest = {
      action: "click", elementId: ids[0], confidence: 1, taskId: "t", stepId: 1,
    };

    const started = Date.now();
    const result = await verifyActionSettled("t:1", snapshotFor(action));
    const elapsed = Date.now() - started;

    // Must terminate, and well inside the 20s step budget.
    expect(result).toBeDefined();
    expect(elapsed).toBeLessThan(3000);
    // Nothing observable changed → still ambiguous. Never fabricated success.
    expect(result.status).not.toBe("success");
  });

  it("scroll verification (longest window) also resolves without rAF", async () => {
    globalThis.requestAnimationFrame = ((_cb: FrameRequestCallback) => 1) as typeof globalThis.requestAnimationFrame;

    const action: ActionRequest = {
      action: "scroll", direction: "down", amount: 100, confidence: 1, taskId: "t", stepId: 1,
    };

    const started = Date.now();
    const result = await verifyActionSettled("t:2", snapshotFor(action));
    expect(result).toBeDefined();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("still resolves when requestAnimationFrame is absent entirely", async () => {
    // @ts-expect-error deliberately removing the API
    delete globalThis.requestAnimationFrame;

    document.body.innerHTML = `<button id="b" aria-label="Go">Go</button>`;
    const ids = captureDomState("t").elements.map((e) => e.elementId);
    const action: ActionRequest = {
      action: "click", elementId: ids[0], confidence: 1, taskId: "t", stepId: 1,
    };

    const result = await verifyActionSettled("t:3", snapshotFor(action));
    expect(result).toBeDefined();
    expect(result.status).not.toBe("success");
  });
});
