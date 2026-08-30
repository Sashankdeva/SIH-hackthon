// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  verifyLevel2Semantic,
  verifyLevel3Visual,
  verifyWithEscalation,
} from "../verify";
import type {
  VerificationRequest,
  L2SemanticExpectation,
  L3VisualExpectation,
} from "../types";

describe("Role 5 Phase 5 — Higher-Level Verification Interfaces & Escalation Readiness", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  // =========================================================================
  // 1. Level 2 Semantic Verification
  // =========================================================================
  describe("1. Level 2 Semantic Verification", () => {
    it("verifies semantic role and accessibility aria-label", () => {
      document.body.innerHTML = `
        <button id="pay-btn" role="button" aria-label="Confirm Payment of ₹500">Pay Now</button>
      `;

      const expectation: L2SemanticExpectation = {
        semanticRole: "button",
        accessibilityLabel: "Confirm Payment",
        expectedTextPattern: "Pay Now",
        semanticStatus: "success",
      };

      const result = verifyLevel2Semantic("act-l2-1", "#pay-btn", expectation);
      expect(result.status).toBe("success");
      expect(result.level).toBe("L2");
      expect(result.evidence).toBeDefined();
      expect(result.evidence?.length).toBe(4);
    });

    it("verifies regex pattern matching against text content", () => {
      document.body.innerHTML = `
        <div id="status-banner">Order #2026171 placed successfully</div>
      `;

      const expectation: L2SemanticExpectation = {
        expectedTextPattern: "Order #[0-9]+ placed",
      };

      const result = verifyLevel2Semantic("act-l2-2", "#status-banner", expectation);
      expect(result.status).toBe("success");
    });

    it("returns failure on semantic mismatch", () => {
      document.body.innerHTML = `
        <div id="status-banner">Payment Failed</div>
      `;

      const expectation: L2SemanticExpectation = {
        expectedTextPattern: "Order #[0-9]+ placed",
      };

      const result = verifyLevel2Semantic("act-l2-3", "#status-banner", expectation);
      expect(result.status).toBe("failure");
      expect(result.failureCategory).toBe("ELEMENT_STATE_MISMATCH");
    });
  });

  // =========================================================================
  // 2. Level 3 Visual Verification (Privacy-Safe Geometry)
  // =========================================================================
  describe("2. Level 3 Visual Verification (Privacy-Safe Geometry)", () => {
    it("verifies element visibility state using DOM geometry", () => {
      document.body.innerHTML = `
        <div id="modal" style="width: 300px; height: 200px;">Modal Content</div>
      `;

      const expectation: L3VisualExpectation = {
        expectedVisibilityState: "visible",
      };

      const result = verifyLevel3Visual("act-l3-1", "#modal", expectation);
      expect(result.status).toBe("success");
      expect(result.level).toBe("L3");
    });

    it("PRIVACY INVARIANT: ensures NO screenshots or raw visual byte buffers exist in evidence", () => {
      document.body.innerHTML = `
        <div id="card">Visual Element</div>
      `;

      const result = verifyLevel3Visual("act-l3-privacy", "#card", {
        expectedVisibilityState: "visible",
      });

      const jsonString = JSON.stringify(result);
      expect(jsonString).not.toContain("data:image");
      expect(jsonString).not.toContain("base64");
      expect(jsonString).not.toContain("Buffer");
      expect(result.evidence?.some((e) => e.observed.includes("image"))).toBe(false);
    });
  });

  // =========================================================================
  // 3. Multi-Level Escalation Engine
  // =========================================================================
  describe("3. Multi-Level Escalation Engine", () => {
    it("bypasses higher-level escalation when Level 1 deterministic verification succeeds", () => {
      document.body.innerHTML = `
        <div id="btn">Click</div>
      `;

      const request: VerificationRequest = {
        taskId: "t-esc-1",
        actionId: "act-esc-1",
        targetSelector: "#btn",
        expectedSemanticState: { expectedTextPattern: "Click" },
        expectedVisualState: { expectedVisibilityState: "visible" },
      };

      const result = verifyWithEscalation(request);
      expect(result.status).toBe("success");
      expect(result.level).toBe("L1"); // Remained at L1
      expect(result.l1LatencyMs).toBeDefined();
      expect(result.l2LatencyMs).toBeUndefined(); // L2 skipped
    });

    it("escalates to Level 2 when Level 1 is ambiguous and L2 expectation is provided", () => {
      const currentUrl = typeof window !== "undefined" && window.location.href ? window.location.href : "http://localhost/";
      const request: VerificationRequest = {
        taskId: "t-esc-2",
        actionId: "act-esc-2",
        targetSelector: "#app",
        urlBefore: currentUrl, // Same URL -> L1 status = "ambiguous" (STATE_NOT_CHANGED)
        expectedSemanticState: {
          expectedTextPattern: "Welcome",
          semanticStatus: "success",
        },
        verificationOptions: { allowEscalation: true },
      };

      document.body.innerHTML = `<div id="app">Welcome</div>`;

      // verifyUrlChanged returns status = "ambiguous" (URL_UNCHANGED)
      const result = verifyWithEscalation(request);
      expect(result.status).toBe("success");
      expect(result.level).toBe("L2"); // Escalated to L2
      expect(result.escalatedFromLevel).toBe("L1");
      expect(result.l1LatencyMs).toBeGreaterThan(0);
      expect(result.l2LatencyMs).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // 4. Per-Level Latency Isolation Micro-Benchmark
  // =========================================================================
  describe("4. Latency Isolation Benchmark", () => {
    it("measures Level 1 latency isolation over 1,000 iterations (l1LatencyMs p50 < 0.05ms)", () => {
      document.body.innerHTML = `<button id="target">OK</button>`;

      const request: VerificationRequest = {
        taskId: "t-bench",
        actionId: "act-bench",
        targetSelector: "#target",
      };

      const iterations = 1000;
      const l1Latencies: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const res = verifyWithEscalation(request);
        if (res.l1LatencyMs) {
          l1Latencies.push(res.l1LatencyMs);
        }
      }

      l1Latencies.sort((a, b) => a - b);
      const p50 = l1Latencies[Math.floor(iterations * 0.5)];
      const p95 = l1Latencies[Math.floor(iterations * 0.95)];
      const max = l1Latencies[iterations - 1];

      console.log(
        `[PVM L1 Latency Isolation Benchmark (1000 runs)] p50=${p50.toFixed(4)}ms | p95=${p95.toFixed(4)}ms | max=${max.toFixed(4)}ms`
      );

      expect(p50).toBeLessThan(0.05);
      expect(p95).toBeLessThan(0.2);
      expect(max).toBeLessThan(25.0);
    });
  });
});
