import { describe, expect, it, vi } from "vitest";
import {
  assessPerceptionSufficiency,
  boxContainsPoint,
  iou,
  mapVisionTargetToDom,
  runVisionFallback,
  VISION_MIN_CONFIDENCE,
  type Box,
  type ElementBox,
  type VisionSource,
  type VisionTarget,
} from "../visionFallback";

const el = (elementId: number, rect: Box, role = "link", label: string | null = null): ElementBox => ({
  elementId,
  role,
  label,
  rect,
});
const target = (boundingBox: Box, confidence = 0.9, targetDescription = ""): VisionTarget => ({
  targetDescription,
  boundingBox,
  confidence,
});
const source = (impl: () => Promise<VisionTarget>): VisionSource => ({ analyse: impl });

describe("C9 — geometry primitives", () => {
  it("iou: identical boxes = 1, disjoint = 0, half overlap ≈ 0.33", () => {
    expect(iou([0, 0, 10, 10], [0, 0, 10, 10])).toBe(1);
    expect(iou([0, 0, 10, 10], [100, 100, 10, 10])).toBe(0);
    expect(iou([0, 0, 10, 10], [5, 0, 10, 10])).toBeCloseTo(50 / 150, 5);
  });

  it("boxContainsPoint: inside / on edge / outside", () => {
    expect(boxContainsPoint([0, 0, 10, 10], [5, 5])).toBe(true);
    expect(boxContainsPoint([0, 0, 10, 10], [10, 10])).toBe(true);
    expect(boxContainsPoint([0, 0, 10, 10], [11, 5])).toBe(false);
  });
});

describe("C9 §10 — perception-sufficiency decision", () => {
  it("1. non-element action → DOM_SUFFICIENT (vision never considered)", () => {
    expect(
      assessPerceptionSufficiency({ actionType: "scroll", requestedElementId: null, contextElementIds: [] }).decision
    ).toBe("DOM_SUFFICIENT");
  });

  it("1b. element action, id present and resolved → DOM_SUFFICIENT", () => {
    expect(
      assessPerceptionSufficiency({
        actionType: "click",
        requestedElementId: 7,
        contextElementIds: [7, 8],
        resolutionStatus: "resolved",
      }).decision
    ).toBe("DOM_SUFFICIENT");
  });

  it("2. element action with no element_id → DOM_INSUFFICIENT", () => {
    const r = assessPerceptionSufficiency({ actionType: "click", requestedElementId: null, contextElementIds: [1] });
    expect(r).toEqual({ decision: "DOM_INSUFFICIENT", reason: "no_dom_target_for_element_action" });
  });

  it("2b. referenced id absent from the context the model saw → DOM_INSUFFICIENT", () => {
    const r = assessPerceptionSufficiency({ actionType: "click", requestedElementId: 99, contextElementIds: [1, 2] });
    expect(r).toEqual({ decision: "DOM_INSUFFICIENT", reason: "referenced_element_absent_from_context" });
  });

  it("2c. resolver reported missing / ambiguous → DOM_INSUFFICIENT", () => {
    expect(
      assessPerceptionSufficiency({
        actionType: "click",
        requestedElementId: 3,
        contextElementIds: [3],
        resolutionStatus: "missing",
      })
    ).toEqual({ decision: "DOM_INSUFFICIENT", reason: "dom_target_unresolved" });
    expect(
      assessPerceptionSufficiency({
        actionType: "type",
        requestedElementId: 3,
        contextElementIds: [3],
        resolutionStatus: "ambiguous",
      })
    ).toEqual({ decision: "DOM_INSUFFICIENT", reason: "dom_target_ambiguous" });
  });
});

describe("C9 §11/§13 — vision fallback failure safety", () => {
  const insufficient = { decision: "DOM_INSUFFICIENT", reason: "dom_target_unresolved" } as const;
  const sufficient = { decision: "DOM_SUFFICIENT" } as const;

  it("1. DOM-sufficient → not_triggered, vision source never called", async () => {
    const analyse = vi.fn();
    const out = await runVisionFallback({
      sufficiency: sufficient,
      elements: [],
      visionSource: source(analyse as never),
      trace: () => {},
    });
    expect(out).toEqual({ status: "not_triggered" });
    expect(analyse).not.toHaveBeenCalled();
  });

  it("2/3. DOM-insufficient with NO vision source (production path) → unavailable", async () => {
    const out = await runVisionFallback({ sufficiency: insufficient, elements: [], trace: () => {} });
    expect(out).toEqual({ status: "unavailable", reason: "no_local_vision_source" });
  });

  it("3b. screenshot / analysis throws → unavailable, never success", async () => {
    const out = await runVisionFallback({
      sufficiency: insufficient,
      elements: [],
      visionSource: source(() => Promise.reject(new Error("permission denied"))),
      trace: () => {},
    });
    expect(out).toEqual({ status: "unavailable", reason: "vision_error" });
  });

  it("4. malformed vision result → unavailable", async () => {
    const out = await runVisionFallback({
      sufficiency: insufficient,
      elements: [],
      visionSource: source(() => Promise.resolve({ foo: "bar" } as never)),
      trace: () => {},
    });
    expect(out).toEqual({ status: "unavailable", reason: "malformed_vision_result" });
  });

  it("5. low-confidence vision result → unavailable, no mapping attempted", async () => {
    const spy = vi.fn(() => Promise.resolve(target([0, 0, 50, 20], VISION_MIN_CONFIDENCE - 0.3)));
    const out = await runVisionFallback({
      sufficiency: insufficient,
      elements: [el(1, [0, 0, 50, 20])],
      visionSource: source(spy),
      trace: () => {},
    });
    expect(out).toEqual({ status: "unavailable", reason: "low_confidence" });
  });

  it("timeout → unavailable", async () => {
    const out = await runVisionFallback({
      sufficiency: insufficient,
      elements: [],
      visionSource: source(() => new Promise(() => {})), // never resolves
      trace: () => {},
    });
    expect(out).toEqual({ status: "unavailable", reason: "vision_timeout" });
  }, 10_000);
});

describe("C9 §6 — DOM ↔ vision-box mapping", () => {
  it("6. one element containing the vision box centre → resolved", () => {
    const els = [el(10, [0, 0, 100, 40], "link", "Section"), el(11, [500, 500, 80, 20], "button", "Elsewhere")];
    const r = mapVisionTargetToDom(target([10, 5, 60, 25], 0.9, "Section"), els);
    expect(r).toEqual({ status: "resolved", elementId: 10, via: "containment", score: 1 });
  });

  it("6b. near-coincident vision box vs element box → resolved", () => {
    const els = [el(20, [0, 0, 100, 40], "button", "Submit")];
    // a vision box that is slightly inset from the element — centre lands inside
    const r = mapVisionTargetToDom(target([3, 2, 94, 36], 0.9, "Submit"), els);
    expect(r.status).toBe("resolved");
    if (r.status === "resolved") {
      expect(r.elementId).toBe(20);
      expect(r.score).toBeGreaterThan(0.7);
    }
  });

  it("7. two equally plausible overlapping elements → ambiguous, no click", () => {
    const els = [el(1, [0, 0, 100, 50]), el(2, [10, 0, 100, 50])];
    const r = mapVisionTargetToDom(target([5, 0, 100, 50], 0.9), els);
    expect(r.status).toBe("ambiguous");
    if (r.status === "ambiguous") expect(r.candidates.sort()).toEqual([1, 2]);
  });

  it("8. vision box over empty space → unresolved", () => {
    const els = [el(1, [0, 0, 20, 20]), el(2, [300, 300, 20, 20])];
    const r = mapVisionTargetToDom(target([1000, 1000, 40, 40], 0.9), els);
    expect(r).toEqual({ status: "unresolved" });
  });

  it("9. stale/moved geometry: only far-away elements → unresolved (never force-matched)", () => {
    const els = [el(1, [0, 0, 30, 30], "link", "Nav")];
    // element used to be here; now the vision box is 400px away
    const r = mapVisionTargetToDom(target([400, 400, 40, 20], 0.95, "Nav"), els);
    expect(r).toEqual({ status: "unresolved" });
  });

  it("description incompatible with the only overlapping element → unresolved", () => {
    const els = [el(1, [0, 0, 100, 40], "button", "Save")];
    const r = mapVisionTargetToDom(target([0, 0, 100, 40], 0.9, "open the settings dialog"), els);
    expect(r).toEqual({ status: "unresolved" });
  });

  it("mapped outcome is surfaced by runVisionFallback with an injected source", async () => {
    const els = [el(42, [0, 0, 120, 30], "link", "Flights")];
    const out = await runVisionFallback({
      sufficiency: { decision: "DOM_INSUFFICIENT", reason: "dom_target_unresolved" },
      elements: els,
      visionSource: source(() => Promise.resolve(target([10, 5, 60, 20], 0.9, "Flights"))),
      trace: () => {},
    });
    expect(out).toEqual({ status: "mapped", elementId: 42, via: "containment", score: 1 });
  });
});

describe("C9 §3/§15 — privacy boundary of the module", () => {
  it("10. module needs no network / chrome APIs: it runs with fetch and chrome removed", async () => {
    const g = globalThis as unknown as { fetch?: unknown; chrome?: unknown; XMLHttpRequest?: unknown };
    const savedFetch = g.fetch;
    const savedChrome = g.chrome;
    const savedXHR = g.XMLHttpRequest;
    // Any accidental network / screenshot dependency would throw here.
    delete g.fetch;
    delete g.chrome;
    delete g.XMLHttpRequest;
    try {
      const noSource = await runVisionFallback({
        sufficiency: { decision: "DOM_INSUFFICIENT", reason: "dom_target_unresolved" },
        elements: [el(1, [0, 0, 10, 10])],
        trace: () => {},
      });
      expect(noSource).toEqual({ status: "unavailable", reason: "no_local_vision_source" });

      const withSource = await runVisionFallback({
        sufficiency: { decision: "DOM_INSUFFICIENT", reason: "dom_target_unresolved" },
        elements: [el(1, [0, 0, 100, 40], "link", "Home")],
        visionSource: source(() => Promise.resolve(target([5, 5, 60, 20], 0.9, "Home"))),
        trace: () => {},
      });
      expect(withSource.status).toBe("mapped");
    } finally {
      g.fetch = savedFetch;
      g.chrome = savedChrome;
      g.XMLHttpRequest = savedXHR;
    }
  });

  it("10b. runVisionFallback can never return a success/executed status", async () => {
    const outcomes = await Promise.all([
      runVisionFallback({ sufficiency: { decision: "DOM_SUFFICIENT" }, elements: [], trace: () => {} }),
      runVisionFallback({
        sufficiency: { decision: "DOM_INSUFFICIENT", reason: "dom_target_ambiguous" },
        elements: [],
        trace: () => {},
      }),
    ]);
    for (const o of outcomes) {
      expect(["not_triggered", "unavailable", "mapped", "unresolved", "ambiguous"]).toContain(o.status);
      expect(o.status).not.toBe("success");
    }
  });
});
