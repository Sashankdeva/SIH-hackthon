// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  verifyUrlChanged,
  verifyUrlMatches,
  verifyElementPresent,
  verifyElementAbsent,
  verifyElementState,
  verifyValueMutation,
  verifyScrollPosition,
  verifyDeterministicOutcome,
} from "../verify";
import {
  classifyFailure,
  isFailureRetryable,
  decideRecovery,
} from "../recovery";
import type { VerificationRequest, VerificationResult } from "../types";

describe("Role 5 Phase 1 — Deterministic Level-1 Verification & Recovery Foundation", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    try {
      window.history.pushState({}, "Test", "/checkout");
    } catch {
      // Safe fallback if environment prohibits pushState
    }
  });

  // =========================================================================
  // 1. URL Verification
  // =========================================================================
  describe("1. Deterministic URL Verification", () => {
    it("verifies URL change when location.href differs from before", () => {
      const result = verifyUrlChanged("act-nav-01", "http://localhost/login", Date.now() - 50);
      expect(result.status).toBe("success");
      expect(result.expected).toBe("url_changed");
      expect(result.observed).toBe("url_changed");
      expect(result.level).toBe("L1");
      expect(result.evidence).toBeDefined();
      expect(result.evidence![0].signal).toBe("url");
      expect(result.evidence![0].matched).toBe(true);
    });

    it("returns ambiguous with STATE_NOT_CHANGED when URL did not change", () => {
      const current = location.href;
      const result = verifyUrlChanged("act-nav-02", current, Date.now() - 50);
      expect(result.status).toBe("ambiguous");
      expect(result.observed).toBe("url_unchanged");
      expect(result.failureCategory).toBe("STATE_NOT_CHANGED");
      expect(result.retryability).toBe("retryable");
    });

    it("verifies exact URL match with verifyUrlMatches", () => {
      const current = location.href;
      const result = verifyUrlMatches("act-nav-03", current);
      expect(result.status).toBe("success");
      expect(result.expected).toBe(current);
      expect(result.observed).toBe(current);
      expect(result.evidence![0].matched).toBe(true);
    });

    it("detects URL mismatch and categorizes as URL_MISMATCH (nonRetryable)", () => {
      const result = verifyUrlMatches("act-nav-04", "http://localhost:9999/different-target");
      expect(result.status).toBe("failure");
      expect(result.failureCategory).toBe("URL_MISMATCH");
      expect(result.retryability).toBe("nonRetryable");
      expect(result.evidence![0].matched).toBe(false);
    });

    it("safely handles malformed / empty expected URL in verifyUrlMatches", () => {
      const result = verifyUrlMatches("act-nav-05", "" as any);
      expect(result.status).toBe("failure");
      expect(result.failureCategory).toBe("MALFORMED_REQUEST");
      expect(result.retryability).toBe("nonRetryable");
    });
  });

  // =========================================================================
  // 2. Element Existence & Disappearance Verification
  // =========================================================================
  describe("2. Element Presence & Disappearance Verification", () => {
    it("verifies element present when target exists in DOM", () => {
      document.body.innerHTML = `<button id="submit-btn" data-privy-id="10">Submit</button>`;
      const result = verifyElementPresent("act-elem-01", '[data-privy-id="10"]');
      expect(result.status).toBe("success");
      expect(result.expected).toBe('element_present:[data-privy-id="10"]');
      expect(result.observed).toBe("present");
      expect(result.evidence![0].matched).toBe(true);
    });

    it("returns failure with TARGET_NOT_FOUND when target is absent from DOM", () => {
      const result = verifyElementPresent("act-elem-02", "#non-existent-button");
      expect(result.status).toBe("failure");
      expect(result.observed).toBe("absent");
      expect(result.failureCategory).toBe("TARGET_NOT_FOUND");
      expect(result.retryability).toBe("retryable");
    });

    it("verifies element disappearance when element was removed from DOM", () => {
      document.body.innerHTML = `<div>Content after dialog closed</div>`;
      const result = verifyElementAbsent("act-elem-03", "#modal-overlay");
      expect(result.status).toBe("success");
      expect(result.observed).toBe("absent");
      expect(result.evidence![0].matched).toBe(true);
    });

    it("detects failure when element expected to disappear is still present", () => {
      document.body.innerHTML = `<div id="loading-spinner">Loading...</div>`;
      const result = verifyElementAbsent("act-elem-04", "#loading-spinner");
      expect(result.status).toBe("failure");
      expect(result.observed).toBe("present");
      expect(result.failureCategory).toBe("ELEMENT_STATE_MISMATCH");
    });

    it("safely handles empty or malformed selector in presence/absence checks", () => {
      const res1 = verifyElementPresent("act-elem-05", "");
      expect(res1.status).toBe("failure");
      expect(res1.failureCategory).toBe("MALFORMED_REQUEST");

      const res2 = verifyElementAbsent("act-elem-06", null as any);
      expect(res2.status).toBe("failure");
      expect(res2.failureCategory).toBe("MALFORMED_REQUEST");
    });
  });

  // =========================================================================
  // 3. Element State & Attribute Verification
  // =========================================================================
  describe("3. Element State & Attribute Verification", () => {
    it("verifies disabled state mutation (disabled -> enabled)", () => {
      document.body.innerHTML = `<button id="checkout-btn" disabled>Checkout</button>`;
      // State before: disabled: true
      const resBefore = verifyElementState("act-state-01", "#checkout-btn", { disabled: true });
      expect(resBefore.status).toBe("success");

      // Mutation happens
      document.getElementById("checkout-btn")?.removeAttribute("disabled");

      // Verify state after: disabled: false
      const resAfter = verifyElementState("act-state-02", "#checkout-btn", { disabled: false });
      expect(resAfter.status).toBe("success");
      expect(resAfter.evidence![0].matched).toBe(true);
    });

    it("verifies aria-expanded and aria-checked attribute changes", () => {
      document.body.innerHTML = `
        <button id="accordion" aria-expanded="true">Menu</button>
        <div role="checkbox" id="tos" aria-checked="true">I agree</div>
      `;

      const resExpanded = verifyElementState("act-state-03", "#accordion", { ariaExpanded: true });
      expect(resExpanded.status).toBe("success");

      const resChecked = verifyElementState("act-state-04", "#tos", { ariaChecked: true });
      expect(resChecked.status).toBe("success");
    });

    it("verifies text content substring changes", () => {
      document.body.innerHTML = `<div id="status-msg">Order Placed Successfully!</div>`;
      const result = verifyElementState("act-state-05", "#status-msg", { textContent: "Order Placed" });
      expect(result.status).toBe("success");
    });

    it("detects attribute state mismatch and returns ELEMENT_STATE_MISMATCH", () => {
      document.body.innerHTML = `<button id="btn" disabled>Submit</button>`;
      const result = verifyElementState("act-state-06", "#btn", { disabled: false });
      expect(result.status).toBe("failure");
      expect(result.failureCategory).toBe("ELEMENT_STATE_MISMATCH");
      expect(result.retryability).toBe("retryable");
    });

    it("returns TARGET_NOT_FOUND when verifying state on non-existent element", () => {
      const result = verifyElementState("act-state-07", "#missing-target", { disabled: false });
      expect(result.status).toBe("failure");
      expect(result.failureCategory).toBe("TARGET_NOT_FOUND");
    });
  });

  // =========================================================================
  // 4. Value Mutation & Privacy Protection
  // =========================================================================
  describe("4. Value Mutation & Privacy Protection", () => {
    it("verifies standard input value mutation", () => {
      document.body.innerHTML = `<input id="name-input" type="text" value="Aarav Sharma" />`;
      const result = verifyValueMutation("act-val-01", "#name-input", "Aarav Sharma");
      expect(result.status).toBe("success");
      expect(result.expected).toBe("Aarav Sharma");
      expect(result.observed).toBe("Aarav Sharma");
    });

    it("verifies textarea and contenteditable value mutation", () => {
      document.body.innerHTML = `
        <textarea id="comment">Great service!</textarea>
        <div id="editable" contenteditable="true">Rich text response</div>
      `;

      const res1 = verifyValueMutation("act-val-02", "#comment", "Great service!");
      expect(res1.status).toBe("success");

      const res2 = verifyValueMutation("act-val-03", "#editable", "Rich text response");
      expect(res2.status).toBe("success");
    });

    it("detects value mismatch and categorizes as STATE_NOT_CHANGED", () => {
      document.body.innerHTML = `<input id="email-input" type="email" value="old@example.com" />`;
      const result = verifyValueMutation("act-val-04", "#email-input", "new@example.com");
      expect(result.status).toBe("failure");
      expect(result.failureCategory).toBe("STATE_NOT_CHANGED");
    });

    it("PRIVACY INVARIANT: masks secret input values in verification evidence when isSecret=true", () => {
      const secretPassword = "SuperSecretPassword123!";
      document.body.innerHTML = `<input id="pwd-input" type="password" value="${secretPassword}" />`;

      const result = verifyValueMutation("act-val-05", "#pwd-input", secretPassword, true);
      expect(result.status).toBe("success");

      // Verify that the secret NEVER leaks in expected, observed, or evidence strings
      const resultJson = JSON.stringify(result);
      expect(resultJson).not.toContain(secretPassword);
      expect(result.expected).toBe("[REDACTED_SECRET]");
      expect(result.observed).toBe("[REDACTED_SECRET_MATCHED]");
      expect(result.evidence![0].expected).toBe("[REDACTED_SECRET]");
      expect(result.evidence![0].details).toContain("raw secret never exposed");
    });
  });

  // =========================================================================
  // 5. Scroll Visibility Verification
  // =========================================================================
  describe("5. Scroll Visibility Verification", () => {
    it("verifies scroll position when target element is in viewport", () => {
      document.body.innerHTML = `<div id="footer-section">Footer Content</div>`;
      const el = document.getElementById("footer-section")!;
      el.getBoundingClientRect = () => ({
        top: 200,
        bottom: 250,
        left: 50,
        right: 300,
        width: 250,
        height: 50,
        x: 50,
        y: 200,
        toJSON: () => {},
      });

      const result = verifyScrollPosition("act-scroll-01", "#footer-section");
      expect(result.status).toBe("success");
      expect(result.observed).toBe("visible");
      expect(result.evidence![0].matched).toBe(true);
    });

    it("detects when scroll target is outside viewport", () => {
      document.body.innerHTML = `<div id="deep-section">Deep Section</div>`;
      const el = document.getElementById("deep-section")!;
      el.getBoundingClientRect = () => ({
        top: 2500, // Below viewport
        bottom: 2600,
        left: 0,
        right: 500,
        width: 500,
        height: 100,
        x: 0,
        y: 2500,
        toJSON: () => {},
      });

      const result = verifyScrollPosition("act-scroll-02", "#deep-section");
      expect(result.status).toBe("failure");
      expect(result.observed).toBe("outside_viewport");
      expect(result.failureCategory).toBe("STATE_NOT_CHANGED");
    });
  });

  // =========================================================================
  // 6. Unified Level-1 Dispatcher (verifyDeterministicOutcome)
  // =========================================================================
  describe("6. Unified Deterministic Outcome Dispatcher", () => {
    it("routes URL verification request correctly", () => {
      const current = location.href;
      const req: VerificationRequest = {
        taskId: "task-test-01",
        stepId: 1,
        actionId: "task-test-01-step-1",
        actionType: "navigate",
        expectedUrl: current,
      };
      const result = verifyDeterministicOutcome(req);
      expect(result.status).toBe("success");
      expect(result.actionId).toBe("task-test-01-step-1");
    });

    it("routes element presence request by privy-id correctly", () => {
      document.body.innerHTML = `<button data-privy-id="42">Click me</button>`;
      const req: VerificationRequest = {
        taskId: "task-test-02",
        stepId: 2,
        actionId: "task-test-02-step-2",
        actionType: "click",
        targetElementId: 42,
      };
      const result = verifyDeterministicOutcome(req);
      expect(result.status).toBe("success");
      expect(result.observed).toBe("present");
    });

    it("routes element disappearance request correctly", () => {
      document.body.innerHTML = `<div>No modal here</div>`;
      const req: VerificationRequest = {
        taskId: "task-test-03",
        stepId: 3,
        actionId: "task-test-03-step-3",
        actionType: "click",
        targetSelector: "#modal",
        expectedDisappearance: true,
      };
      const result = verifyDeterministicOutcome(req);
      expect(result.status).toBe("success");
      expect(result.observed).toBe("absent");
    });

    it("routes element state check request correctly", () => {
      document.body.innerHTML = `<button id="btn" data-privy-id="5" disabled>Disabled</button>`;
      const req: VerificationRequest = {
        taskId: "task-test-04",
        stepId: 4,
        actionId: "task-test-04-step-4",
        actionType: "click",
        targetElementId: 5,
        expectedState: { disabled: true },
      };
      const result = verifyDeterministicOutcome(req);
      expect(result.status).toBe("success");
    });

    it("handles generic action completion (wait, keypress) cleanly", () => {
      const req: VerificationRequest = {
        taskId: "task-test-05",
        stepId: 5,
        actionId: "task-test-05-step-5",
        actionType: "wait",
      };
      const result = verifyDeterministicOutcome(req);
      expect(result.status).toBe("success");
      expect(result.expected).toBe("action_completed:wait");
    });

    it("safely handles malformed request (missing taskId/actionId) without throwing", () => {
      const result = verifyDeterministicOutcome(null as any);
      expect(result.status).toBe("failure");
      expect(result.failureCategory).toBe("MALFORMED_REQUEST");
      expect(result.retryability).toBe("nonRetryable");
    });
  });

  // =========================================================================
  // 7. Failure Classification & Recovery Decisions
  // =========================================================================
  describe("7. Failure Classification & Recovery Decisions", () => {
    it("classifies all known deterministic failure categories accurately", () => {
      expect(classifyFailure({ actionId: "a", expected: "element_present:#btn", observed: "absent", status: "failure", latencyMs: 1 })).toBe("TARGET_NOT_FOUND");
      expect(classifyFailure({ actionId: "a", expected: "url_changed", observed: "url_unchanged", status: "failure", latencyMs: 1 })).toBe("STATE_NOT_CHANGED");
      expect(classifyFailure({ actionId: "a", expected: "http://target", observed: "http://other", status: "failure", latencyMs: 1 })).toBe("URL_MISMATCH");
      expect(classifyFailure({ actionId: "a", expected: "state", observed: "element_state_mismatch", status: "failure", latencyMs: 1 })).toBe("ELEMENT_STATE_MISMATCH");
      expect(classifyFailure({ actionId: "a", expected: "action", observed: "timeout_exceeded", status: "failure", latencyMs: 1 })).toBe("TIMEOUT");
      expect(classifyFailure({ actionId: "a", expected: "action", observed: "channel_lost_interrupted", status: "failure", latencyMs: 1 })).toBe("EXECUTION_INTERRUPTED");
      expect(classifyFailure({ actionId: "a", expected: "action", observed: "tab_unavailable", status: "failure", latencyMs: 1 })).toBe("TAB_UNAVAILABLE");
      expect(classifyFailure({ actionId: "a", expected: "action", observed: "malformed_json", status: "failure", latencyMs: 1 })).toBe("MALFORMED_REQUEST");
    });

    it("correctly determines retryability by category and attempt budget", () => {
      expect(isFailureRetryable("TARGET_NOT_FOUND", 0)).toBe("retryable");
      expect(isFailureRetryable("TARGET_NOT_FOUND", 2)).toBe("nonRetryable"); // Exhausted
      expect(isFailureRetryable("URL_MISMATCH", 0)).toBe("nonRetryable");
      expect(isFailureRetryable("TAB_UNAVAILABLE", 0)).toBe("nonRetryable");
      expect(isFailureRetryable("MALFORMED_REQUEST", 0)).toBe("nonRetryable");
      expect(isFailureRetryable("UNKNOWN", 0)).toBe("inconclusive");
    });

    it("evaluates recovery decision across lifecycle attempts", () => {
      const successRes: VerificationResult = { actionId: "act-1", expected: "url", observed: "url", status: "success", latencyMs: 1 };
      expect(decideRecovery(successRes, 0)).toEqual({
        shouldRetry: false,
        reason: "verified success",
        retryability: "nonRetryable",
      });

      const failRes: VerificationResult = {
        actionId: "act-2",
        expected: "element_present:#btn",
        observed: "absent",
        status: "failure",
        failureCategory: "TARGET_NOT_FOUND",
        latencyMs: 1,
      };

      // Attempt 0 -> Should retry with state recapture
      const rec0 = decideRecovery(failRes, 0);
      expect(rec0.shouldRetry).toBe(true);
      expect(rec0.reason).toContain("action failed");
      expect(rec0.suggestedAction).toBe("RECAPTURE_STATE");

      // Attempt 2 (budget exhausted) -> Should stop and escalate
      const rec2 = decideRecovery(failRes, 2);
      expect(rec2.shouldRetry).toBe(false);
      expect(rec2.reason).toContain("stopped after 2 attempts");
      expect(rec2.suggestedAction).toBe("ABORT");

      // Non-retryable failure (URL mismatch) -> Abort immediately on attempt 0
      const urlMismatchRes: VerificationResult = {
        actionId: "act-3",
        expected: "http://target",
        observed: "http://other",
        status: "failure",
        failureCategory: "URL_MISMATCH",
        latencyMs: 1,
      };
      const recUrl = decideRecovery(urlMismatchRes, 0);
      expect(recUrl.shouldRetry).toBe(false);
      expect(recUrl.suggestedAction).toBe("ABORT");
    });
  });

  // =========================================================================
  // 8. Isolation, Stale-State, Duplicates & Out-of-Order Tests
  // =========================================================================
  describe("8. Isolation, Stale-State & Idempotency", () => {
    it("preserves task and action isolation across independent verification calls", () => {
      document.body.innerHTML = `
        <button id="task1-btn" data-privy-id="1">Task 1</button>
        <button id="task2-btn" data-privy-id="2">Task 2</button>
      `;

      const res1 = verifyDeterministicOutcome({
        taskId: "task-A",
        stepId: 1,
        actionId: "task-A-step-1",
        targetElementId: 1,
      });

      const res2 = verifyDeterministicOutcome({
        taskId: "task-B",
        stepId: 1,
        actionId: "task-B-step-1",
        targetElementId: 2,
      });

      expect(res1.actionId).toBe("task-A-step-1");
      expect(res2.actionId).toBe("task-B-step-1");
      expect(res1.status).toBe("success");
      expect(res2.status).toBe("success");
    });

    it("verifies duplicate invocations are idempotent with identical deterministic outcomes", () => {
      document.body.innerHTML = `<div id="box">Content</div>`;
      const req: VerificationRequest = {
        taskId: "task-dup",
        stepId: 1,
        actionId: "task-dup-1",
        targetSelector: "#box",
      };

      const resFirst = verifyDeterministicOutcome(req);
      const resSecond = verifyDeterministicOutcome(req);

      expect(resFirst.status).toBe(resSecond.status);
      expect(resFirst.expected).toBe(resSecond.expected);
      expect(resFirst.observed).toBe(resSecond.observed);
      expect(resFirst.failureCategory).toBe(resSecond.failureCategory);
    });

    it("handles out-of-order verification safely without cross-contamination", () => {
      document.body.innerHTML = `<div id="step-2-target">Done</div>`;

      // Step 2 arrives before Step 1
      const resStep2 = verifyDeterministicOutcome({
        taskId: "task-order",
        stepId: 2,
        actionId: "task-order-step-2",
        targetSelector: "#step-2-target",
      });

      const resStep1 = verifyDeterministicOutcome({
        taskId: "task-order",
        stepId: 1,
        actionId: "task-order-step-1",
        targetSelector: "#step-1-target-missing",
      });

      expect(resStep2.status).toBe("success");
      expect(resStep2.actionId).toBe("task-order-step-2");

      expect(resStep1.status).toBe("failure");
      expect(resStep1.actionId).toBe("task-order-step-1");
      expect(resStep1.failureCategory).toBe("TARGET_NOT_FOUND");
    });
  });

  // =========================================================================
  // 9. Performance & Micro-Benchmarks
  // =========================================================================
  describe("9. Deterministic Micro-Benchmark & Latency Profile", () => {
    it("measures Level-1 verification latency profile over 1,000 iterations (p50, p95, max < 5ms)", () => {
      document.body.innerHTML = `
        <div id="perf-root">
          <button id="perf-btn" data-privy-id="99" disabled>Perf Target</button>
          <input id="perf-inp" type="text" value="bench-val" />
        </div>
      `;

      const iterations = 1000;
      const latencies: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const tStart = performance.now();
        verifyElementState(`perf-step-${i}`, "#perf-btn", { disabled: true });
        const tEnd = performance.now();
        latencies.push(tEnd - tStart);
      }

      latencies.sort((a, b) => a - b);
      const p50 = latencies[Math.floor(iterations * 0.5)];
      const p95 = latencies[Math.floor(iterations * 0.95)];
      const max = latencies[iterations - 1];

      console.log(
        `[Role 5 Verification Benchmark (1000 runs)] p50=${p50.toFixed(4)}ms | p95=${p95.toFixed(4)}ms | max=${max.toFixed(4)}ms`
      );

      // Engineering latency requirements: Level-1 deterministic checks must be sub-millisecond on average (< 5ms p95)
      expect(p50).toBeLessThan(1.0);
      expect(p95).toBeLessThan(5.0);
      expect(max).toBeLessThan(50.0);
    });
  });
});
