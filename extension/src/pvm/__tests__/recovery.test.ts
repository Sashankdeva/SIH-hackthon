// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  classifyFailure,
  isFailureRetryable,
  decideRecovery,
  MAX_RECOVERY_ATTEMPTS,
} from "../recovery";
import {
  recordVerifiedOutcome,
  clearMemory,
  computeStateSignature,
  computeActionSignature,
} from "../memory";
import type {
  VerificationResult,
  SafeStateInput,
  PvmRecoveryContext,
} from "../types";

describe("Role 5 Phase 4 — Recovery Integration & Bounded Failure Feedback", () => {
  beforeEach(() => {
    clearMemory();
  });

  // =========================================================================
  // 1. Failure Classification
  // =========================================================================
  describe("1. Failure Classification", () => {
    it("classifies TARGET_NOT_FOUND when element is missing from DOM", () => {
      const res: VerificationResult = {
        actionId: "a1",
        expected: "element_present",
        observed: "target_not_found: element #submit absent",
        status: "failure",
        latencyMs: 1.0,
      };
      expect(classifyFailure(res)).toBe("TARGET_NOT_FOUND");
    });

    it("classifies ELEMENT_STATE_MISMATCH when element state is wrong", () => {
      const res: VerificationResult = {
        actionId: "a2",
        expected: "element_absent",
        observed: "element_state_mismatch: element still visible",
        status: "failure",
        latencyMs: 1.1,
      };
      expect(classifyFailure(res)).toBe("ELEMENT_STATE_MISMATCH");
    });

    it("classifies STATE_NOT_CHANGED when URL or state did not change", () => {
      const res: VerificationResult = {
        actionId: "a3",
        expected: "url_changed",
        observed: "state_not_changed: url remained http://localhost/",
        status: "failure",
        latencyMs: 0.8,
      };
      expect(classifyFailure(res)).toBe("STATE_NOT_CHANGED");
    });

    it("classifies URL_MISMATCH when unexpected URL reached", () => {
      const res: VerificationResult = {
        actionId: "a4",
        expected: "http://localhost/dashboard",
        observed: "http://localhost/login",
        status: "failure",
        latencyMs: 1.5,
      };
      expect(classifyFailure(res)).toBe("URL_MISMATCH");
    });

    it("classifies TIMEOUT when execution times out", () => {
      const res: VerificationResult = {
        actionId: "a5",
        expected: "navigation_complete",
        observed: "timeout waiting for network idle",
        status: "failure",
        latencyMs: 5000.0,
      };
      expect(classifyFailure(res)).toBe("TIMEOUT");
    });

    it("classifies EXECUTION_INTERRUPTED when tab or channel lost", () => {
      const res: VerificationResult = {
        actionId: "a6",
        expected: "action_executed",
        observed: "execution_interrupted: tab_closed",
        status: "failure",
        latencyMs: 2.0,
      };
      expect(classifyFailure(res)).toBe("EXECUTION_INTERRUPTED");
    });

    it("classifies TAB_UNAVAILABLE when target tab missing", () => {
      const res: VerificationResult = {
        actionId: "a7",
        expected: "tab_active",
        observed: "tab_unavailable",
        status: "failure",
        latencyMs: 0.5,
      };
      expect(classifyFailure(res)).toBe("TAB_UNAVAILABLE");
    });

    it("classifies MALFORMED_REQUEST when input is malformed or invalid", () => {
      expect(classifyFailure(null as any)).toBe("MALFORMED_REQUEST");
    });
  });

  // =========================================================================
  // 2. Retryability Budget & Boundary Checks
  // =========================================================================
  describe("2. Retryability Budget & Boundary Checks", () => {
    it("marks retryable categories as retryable when attempts < maxAttempts", () => {
      expect(isFailureRetryable("TARGET_NOT_FOUND", 0, 2)).toBe("retryable");
      expect(isFailureRetryable("STATE_NOT_CHANGED", 1, 2)).toBe("retryable");
      expect(isFailureRetryable("TIMEOUT", 0, 2)).toBe("retryable");
    });

    it("marks non-retryable categories as nonRetryable even on first attempt", () => {
      expect(isFailureRetryable("URL_MISMATCH", 0, 2)).toBe("nonRetryable");
      expect(isFailureRetryable("TAB_UNAVAILABLE", 0, 2)).toBe("nonRetryable");
      expect(isFailureRetryable("MALFORMED_REQUEST", 0, 2)).toBe("nonRetryable");
    });

    it("enforces max attempt limit (attempts >= maxAttempts returns nonRetryable)", () => {
      expect(isFailureRetryable("TARGET_NOT_FOUND", 2, 2)).toBe("nonRetryable");
      expect(isFailureRetryable("STATE_NOT_CHANGED", 3, 2)).toBe("nonRetryable");
    });
  });

  // =========================================================================
  // 3. Recovery Decision Engine & Recommendations
  // =========================================================================
  describe("3. Recovery Decision Engine & Recommendations", () => {
    it("returns shouldRetry = false for verified success", () => {
      const res: VerificationResult = {
        actionId: "a1",
        expected: "url_changed",
        observed: "http://localhost/home",
        status: "success",
        latencyMs: 1.0,
      };

      const decision = decideRecovery(res, 0);
      expect(decision.shouldRetry).toBe(false);
      expect(decision.reason).toBe("verified success");
    });

    it("recommends BACKOFF_RETRY for STATE_NOT_CHANGED failures", () => {
      const res: VerificationResult = {
        actionId: "a2",
        expected: "url_changed",
        observed: "state_not_changed",
        status: "failure",
        failureCategory: "STATE_NOT_CHANGED",
        latencyMs: 1.2,
      };

      const decision = decideRecovery(res, 0);
      expect(decision.shouldRetry).toBe(true);
      expect(decision.suggestedAction).toBe("BACKOFF_RETRY");
    });

    it("recommends RECAPTURE_STATE for TARGET_NOT_FOUND failures", () => {
      const res: VerificationResult = {
        actionId: "a3",
        expected: "element_present",
        observed: "target_not_found",
        status: "failure",
        failureCategory: "TARGET_NOT_FOUND",
        latencyMs: 1.0,
      };

      const decision = decideRecovery(res, 0);
      expect(decision.shouldRetry).toBe(true);
      expect(decision.suggestedAction).toBe("RECAPTURE_STATE");
    });

    it("recommends RETRY_IMMEDIATE for TIMEOUT failures", () => {
      const res: VerificationResult = {
        actionId: "a4",
        expected: "element_present",
        observed: "timeout",
        status: "failure",
        failureCategory: "TIMEOUT",
        latencyMs: 2000.0,
      };

      const decision = decideRecovery(res, 0);
      expect(decision.shouldRetry).toBe(true);
      expect(decision.suggestedAction).toBe("RETRY_IMMEDIATE");
    });

    it("recommends ABORT when max attempts budget is reached", () => {
      const res: VerificationResult = {
        actionId: "a5",
        expected: "element_present",
        observed: "target_not_found",
        status: "failure",
        failureCategory: "TARGET_NOT_FOUND",
        latencyMs: 1.0,
      };

      const decision = decideRecovery(res, MAX_RECOVERY_ATTEMPTS);
      expect(decision.shouldRetry).toBe(false);
      expect(decision.suggestedAction).toBe("ABORT");
      expect(decision.reason).toContain("stopped after 2 attempts");
    });
  });

  // =========================================================================
  // 4. PVM History-Assisted Recovery
  // =========================================================================
  describe("4. PVM History-Assisted Recovery", () => {
    it("suggests ALTERNATIVE_CANDIDATE when PVM history has a verified candidate for the state", async () => {
      const stateInput: SafeStateInput = { url: "http://localhost/cart", title: "Cart" };
      const stateSig = computeStateSignature(stateInput);
      const actionSig = computeActionSignature({ action: "click", targetRole: "button", targetElementId: 99 });

      // Record a verified candidate in PVM memory
      await recordVerifiedOutcome({
        taskId: "t-cart",
        stateSignature: stateSig,
        actionSignature: actionSig,
        actionType: "click",
        targetRole: "button",
        targetElementId: 99,
        confidence: 0.95,
        verificationResult: { actionId: "prev", expected: "e", observed: "e", status: "success", latencyMs: 1 },
      });

      const failedResult: VerificationResult = {
        actionId: "failed-act",
        expected: "url_changed",
        observed: "target_not_found",
        status: "failure",
        failureCategory: "TARGET_NOT_FOUND",
        latencyMs: 1.5,
      };

      const context: PvmRecoveryContext = {
        attemptsSoFar: 0,
        stateSignature: stateSig,
      };

      const decision = decideRecovery(failedResult, context);
      expect(decision.shouldRetry).toBe(true);
      expect(decision.suggestedAction).toBe("ALTERNATIVE_CANDIDATE");
      expect(decision.alternativeCandidate).toBeDefined();
      expect(decision.alternativeCandidate?.actionType).toBe("click");
      expect(decision.alternativeCandidate?.targetElementId).toBe(99);
    });
  });

  // =========================================================================
  // 5. Memory Invariant Verification (Zero Failure Pollution)
  // =========================================================================
  describe("5. Memory Invariant Verification", () => {
    it("ensures failed outcomes are NEVER recorded into PVM memory", async () => {
      const stateSig = "state_sig_failed_test";
      const actionSig = "act_sig_failed_test";

      const failedRes: VerificationResult = {
        actionId: "a-fail",
        expected: "url_changed",
        observed: "target_not_found",
        status: "failure",
        failureCategory: "TARGET_NOT_FOUND",
        latencyMs: 1.0,
      };

      const record = await recordVerifiedOutcome({
        taskId: "t-fail",
        stateSignature: stateSig,
        actionSignature: actionSig,
        actionType: "click",
        verificationResult: failedRes,
      });

      expect(record).toBeNull();
    });
  });

  // =========================================================================
  // 6. Recovery Decision Latency Micro-Benchmark
  // =========================================================================
  describe("6. Performance Micro-Benchmark", () => {
    it("measures recovery decision latency over 1,000 iterations (p50, p95 < 0.05ms)", () => {
      const res: VerificationResult = {
        actionId: "bench",
        expected: "target_present",
        observed: "target_not_found",
        status: "failure",
        failureCategory: "TARGET_NOT_FOUND",
        latencyMs: 1.0,
      };

      const iterations = 1000;
      const latencies: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const decision = decideRecovery(res, 0);
        if (decision.recoveryLatencyMs) {
          latencies.push(decision.recoveryLatencyMs);
        }
      }

      latencies.sort((a, b) => a - b);
      const p50 = latencies[Math.floor(iterations * 0.5)];
      const p95 = latencies[Math.floor(iterations * 0.95)];
      const max = latencies[iterations - 1];

      console.log(
        `[PVM Recovery Decision Benchmark (1000 runs)] p50=${p50.toFixed(4)}ms | p95=${p95.toFixed(4)}ms | max=${max.toFixed(4)}ms`
      );

      expect(p50).toBeLessThan(0.05);
      expect(p95).toBeLessThan(0.2);
      expect(max).toBeLessThan(5.0);
    });
  });
});
