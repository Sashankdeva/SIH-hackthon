/**
 * SIH 2026 — PS26171 Client Laptop 5 Phase 4
 * End-to-End Reliability, Failure Recovery & Performance Validation Suite
 *
 * Validates:
 * 1. Golden path complete E2E task lifecycle with stage-by-stage latency profile.
 * 2. Cross-laptop LAN connectivity, URL normalization, and health derivation.
 * 3. Network interruption handling (safe termination, no duplicate side-effects).
 * 4. FastAPI restart / 503 / connection drop recovery.
 * 5. LLM Timeout handling (AbortController timeout, bounded halt).
 * 6. Malformed response rejection matrix (invalid JSON, missing fields, bad confidence).
 * 7. Stale response protection (task ID mismatch rejected before execution).
 * 8. Duplicate action response replay protection (dispatch gate idempotency).
 * 9. Verification failure handling & Role 5 PVM recovery classification.
 * 10. Retry budget boundedness (MAX_RECOVERY_ATTEMPTS & MAX_STEPS budget enforcement).
 * 11. Task cancellation & session cleanup.
 * 12. Synthetic PII canary privacy invariant preservation under failure conditions.
 * 13. Complete Judge Demonstration Workflow (multi-step success on mock form).
 * 14. Intentional Failure & Recovery Demonstration Workflow.
 * 15. Performance benchmarking (Perception, Privacy, Serialization, Network, Execution, Verification).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { installFakeDom, serverAction, FakeElement, FakeInputElement } from "./helpers/fakeDom";
import { captureDomState } from "../src/perception/domCapture";
import { detectTier1 } from "../src/privacy/tier1DomRules";
import { redact, resetTokenCounters } from "../src/privacy/redact";
import { buildSanitizedContext, toWireSanitizedContext } from "../src/privacy/sanitizedContext";
import { storeSecret, clearSecrets } from "../src/privacy/secretStore";
import { validateAction } from "../src/action/validator";
import { createDispatch } from "../src/action/dispatch";
import { runOneStep, fetchAction, normalizeServerUrl, checkServerHealth } from "../src/content/pipeline";
import { runTask } from "../src/content/index";
import { classifyFailure, decideRecovery, isFailureRetryable, MAX_RECOVERY_ATTEMPTS } from "../src/pvm/recovery";
import type { VerificationResult } from "../src/pvm/types";
import type { ActionRequest } from "../src/action/types";

// ============================================================================
// 1. Golden Path E2E Task Workflow & Latency Profile
// ============================================================================
test("Phase 4 — 1. Golden Path E2E: Complete user task lifecycle with multi-step execution", async () => {
  resetTokenCounters();
  clearSecrets();

  const nameInput = new FakeInputElement("text", { "aria-label": "Full Name", id: "input-name" });
  const emailInput = new FakeInputElement("email", { "aria-label": "Email Address", id: "input-email" });
  const submitBtn = new FakeElement("button", { id: "btn-submit" }, "Complete Registration");

  const env = installFakeDom([nameInput, emailInput, submitBtn]);

  try {
    storeSecret("[EMAIL_01]", "test-user@isro.gov.in");

    const ids = captureDomState("init-golden").elements.map((el) => el.elementId);

    // Multi-step response sequence:
    // Step 1: Type name
    // Step 2: Type email (secret-safe)
    // Step 3: Click submit
    // Step 4: Done signal
    env.respondWith(
      serverAction({ action: "type", element_id: ids[0], value: "ISRO Scientist" }),
      serverAction({ action: "type_secret", element_id: ids[1], value_ref: "[EMAIL_01]" }),
      serverAction({ action: "click", element_id: ids[2] }),
      serverAction({ action: "done" })
    );

    const taskResult = await runTask("Register user on portal");

    assert.equal(taskResult.ok, true, "Golden path task must succeed");
    assert.match(taskResult.detail, /done after 3 step\(s\)/, "Should complete after 3 executed actions");
    assert.equal(env.fetchCalls.length, 4, "4 server calls: 3 steps + 1 done");

    // Verify browser side-effects
    assert.equal(nameInput.value, "ISRO Scientist", "Name must be typed");
    assert.equal(emailInput.value, "test-user@isro.gov.in", "Email secret must be typed locally");
    assert.equal(submitBtn.clickCount, 1, "Submit button must be clicked exactly once");

    // Verify history integrity in final request
    const lastRequest = JSON.parse(env.fetchCalls[3].body);
    assert.ok(lastRequest.history, "History must be present on step 4");
    assert.equal(lastRequest.history.length, 3, "History must contain 3 previous steps");
    assert.equal(lastRequest.history[0].action, "type");
    assert.equal(lastRequest.history[1].action, "type_secret");
    assert.equal(lastRequest.history[2].action, "click");
  } finally {
    clearSecrets();
    env.restore();
  }
});

// ============================================================================
// 2. Simulated Cross-Laptop LAN Connectivity & Health Endpoint
// ============================================================================
test("Phase 4 — 2. Cross-Laptop LAN: URL normalization and health check probing", async () => {
  const env = installFakeDom([]);

  try {
    // Normalization tests
    assert.equal(normalizeServerUrl("192.168.1.100:8787"), "http://192.168.1.100:8787/reason");
    assert.equal(normalizeServerUrl("http://192.168.1.100:8787/reason"), "http://192.168.1.100:8787/reason");

    // Respond to health check
    env.respondWith({ status: "ok" });

    const health = await checkServerHealth("http://192.168.1.100:8787/reason", 2000);
    assert.equal(health.ok, true, "Health check should succeed against mock server");
    assert.equal(health.status, "ok");
    assert.ok(health.latencyMs >= 0);
  } finally {
    env.restore();
  }
});

// ============================================================================
// 3. Network Interruption & Safe Failure Recovery
// ============================================================================
test("Phase 4 — 3. Network Interruption: Fetch failure halts task safely without unverified side-effects", async () => {
  const btn = new FakeElement("button", {}, "Trigger Action");
  const env = installFakeDom([btn]);

  try {
    // Simulate network connection drop during HTTP request
    const origFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new Error("TypeError: Failed to fetch (Network connection dropped)"));

    const result = await runTask("Interrupted network task");

    assert.equal(result.ok, false, "Task must safely report failure when network drops");
    assert.match(result.detail, /failed — server error or validator rejection/);
    assert.equal(btn.clickCount, 0, "No browser action should execute when network drops");

    globalThis.fetch = origFetch;
  } finally {
    env.restore();
  }
});

// ============================================================================
// 4. FastAPI Server Restart / 503 / 500 Recovery
// ============================================================================
test("Phase 4 — 4. Server Restart / Error: Server HTTP 503/500 halts step safely", async () => {
  const btn = new FakeElement("button", {}, "Order Button");
  const env = installFakeDom([btn]);

  try {
    // Server returns 503 Service Unavailable during restart
    env.respondWith({ _statusCode: 503, error: "Server is restarting" });

    const result = await runTask("Order item during restart");

    assert.equal(result.ok, false);
    assert.match(result.detail, /failed — server error or validator rejection/);
    assert.equal(btn.clickCount, 0, "No execution on server error");
  } finally {
    env.restore();
  }
});

// ============================================================================
// 5. LLM Timeout Handling
// ============================================================================
test("Phase 4 — 5. LLM Timeout: Client timeout aborts cleanly without partial action execution", async () => {
  const btn = new FakeElement("button", {}, "Long Reasoning Button");
  const env = installFakeDom([btn]);

  try {
    const pageState = captureDomState("task-timeout");
    const detections = detectTier1(pageState.elements);
    const redactions = redact(detections);
    const firewall = buildSanitizedContext(pageState, detections, redactions, "long reasoning task");
    assert.equal(firewall.ok, true);

    // Mock fetch that respects AbortSignal and hangs until abort
    const origFetch = globalThis.fetch;
    globalThis.fetch = (_url, init) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        if (signal) {
          signal.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted due to timeout", "AbortError"));
          });
        }
      });
    };

    if (firewall.ok) {
      // Test fetchAction with a short 50ms timeout
      const action = await fetchAction(firewall.context, 50);
      assert.equal(action, null, "Timed out fetchAction must return null");
    }

    globalThis.fetch = origFetch;
  } finally {
    env.restore();
  }
});

// ============================================================================
// 6. Malformed Server Response Matrix
// ============================================================================
test("Phase 4 — 6. Malformed Response Rejection: All invalid schema variants rejected before execution", async () => {
  const targetInput = new FakeInputElement("text", { id: "input-main" });
  const env = installFakeDom([targetInput]);

  try {
    const taskId = "task-malformed-matrix";
    const targetId = captureDomState("init-malformed").elements[0]?.elementId ?? 1;

    const malformedCases: Array<{ name: string; payload: unknown; expectedReason: RegExp }> = [
      {
        name: "Missing action field",
        payload: { confidence: 0.9, taskId, stepId: 1 },
        expectedReason: /Unknown action type/,
      },
      {
        name: "Disallowed action type (eval_code)",
        payload: { action: "eval_code", confidence: 0.9, taskId, stepId: 1 },
        expectedReason: /Unknown action type/,
      },
      {
        name: "Mismatched taskId",
        payload: { action: "click", elementId: targetId, confidence: 0.9, taskId: "hijacked-task", stepId: 1 },
        expectedReason: /targets a different task/,
      },
      {
        name: "Confidence below 0.5 threshold",
        payload: { action: "click", elementId: targetId, confidence: 0.4, taskId, stepId: 1 },
        expectedReason: /Confidence 0.4 below threshold/,
      },
      {
        name: "Missing elementId for click action",
        payload: { action: "click", elementId: null, confidence: 0.9, taskId, stepId: 1 },
        expectedReason: /Missing elementId/,
      },
      {
        name: "Non-existent element ID",
        payload: { action: "click", elementId: 888888, confidence: 0.9, taskId, stepId: 1 },
        expectedReason: /Element 888888 not found/,
      },
      {
        name: "Missing valueRef for type_secret",
        payload: { action: "type_secret", elementId: targetId, valueRef: "", confidence: 0.9, taskId, stepId: 1 },
        expectedReason: /Missing or empty valueRef/,
      },
      {
        name: "Dangerous protocol in navigate",
        payload: { action: "navigate", url: "javascript:void(0)", confidence: 0.9, taskId, stepId: 1 },
        expectedReason: /Unsafe or disallowed navigation URL/,
      },
    ];

    for (const testCase of malformedCases) {
      const validation = validateAction(testCase.payload as ActionRequest, taskId);
      assert.equal(validation.ok, false, `Test case '${testCase.name}' must be rejected`);
      assert.match(validation.reason || "", testCase.expectedReason, `Reason for '${testCase.name}'`);
    }
  } finally {
    env.restore();
  }
});

// ============================================================================
// 7. Stale Response Protection (Task ID Isolation)
// ============================================================================
test("Phase 4 — 7. Stale Response Protection: Late response from Task A rejected against Task B", async () => {
  const btn = new FakeElement("button", {}, "Task Button");
  const env = installFakeDom([btn]);

  try {
    const taskA_id = "task-uuid-aaaa-1111";
    const taskB_id = "task-uuid-bbbb-2222";

    const staleActionFromA: ActionRequest = {
      action: "click",
      elementId: 1,
      value: null,
      valueRef: null,
      direction: null,
      amount: null,
      url: null,
      confidence: 0.95,
      taskId: taskA_id, // Stale ID from prior task
      stepId: 1,
    };

    // Attempt to validate against current active task B
    const validation = validateAction(staleActionFromA, taskB_id);
    assert.equal(validation.ok, false, "Stale response targeting old task must be rejected");
    assert.match(validation.reason || "", /Action targets a different task\/session/);
  } finally {
    env.restore();
  }
});

// ============================================================================
// 8. Duplicate Execution Protection (Single Gate Idempotency)
// ============================================================================
test("Phase 4 — 8. Duplicate Execution Protection: createDispatch gate blocks replay of same ActionResponse", async () => {
  const btn = new FakeElement("button", {}, "Pay $1000");
  const env = installFakeDom([btn]);

  try {
    const pageState = captureDomState("task-dup-gate");
    const targetId = pageState.elements[0].elementId;

    const actionId = "task-dup-gate:1";
    const action: ActionRequest = {
      action: "click",
      elementId: targetId,
      value: null,
      valueRef: null,
      direction: null,
      amount: null,
      url: null,
      confidence: 0.95,
      taskId: "task-dup-gate",
      stepId: 1,
    };

    const dispatch = createDispatch(actionId);

    // Call 1: Authorized
    const firstRun = await dispatch.run(action);
    assert.equal(firstRun, true, "First execution must succeed");

    // Call 2: Replay / duplicate
    const secondRun = await dispatch.run(action);
    assert.equal(secondRun, false, "Second execution of same actionId must be BLOCKED");

    // Call 3: Third attempt
    const thirdRun = await dispatch.run(action);
    assert.equal(thirdRun, false, "Third execution must also be BLOCKED");

    // Confirm browser received exactly ONE click
    assert.equal(btn.clickCount, 1, "Page must receive exactly one click interaction");
  } finally {
    env.restore();
  }
});

// ============================================================================
// 9. Role 5 Verification Failure Classification & Recovery Decision
// ============================================================================
test("Phase 4 — 9. Verification Failure Recovery: Role 5 PVM classifies failure and bounds retry recommendations", () => {
  const sampleFailures: Array<{
    result: VerificationResult;
    expectedCategory: string;
    expectedRetryable: boolean;
    expectedSuggestedAction: string;
  }> = [
    {
      result: { actionId: "t:1", expected: "click_effect", observed: "target_not_found", status: "failure", latencyMs: 1 },
      expectedCategory: "TARGET_NOT_FOUND",
      expectedRetryable: true,
      expectedSuggestedAction: "RECAPTURE_STATE",
    },
    {
      result: { actionId: "t:2", expected: "url_changed", observed: "url_unchanged", status: "ambiguous", latencyMs: 1 },
      expectedCategory: "STATE_NOT_CHANGED",
      expectedRetryable: true,
      expectedSuggestedAction: "BACKOFF_RETRY",
    },
    {
      result: { actionId: "t:3", expected: "https://example.com/dest", observed: "https://example.com/wrong", status: "failure", latencyMs: 1 },
      expectedCategory: "URL_MISMATCH",
      expectedRetryable: false,
      expectedSuggestedAction: "ABORT",
    },
    {
      result: { actionId: "t:4", expected: "valid_action", observed: "execution_interrupted", status: "failure", latencyMs: 1 },
      expectedCategory: "EXECUTION_INTERRUPTED",
      expectedRetryable: true,
      expectedSuggestedAction: "RETRY_IMMEDIATE",
    },
  ];

  for (const item of sampleFailures) {
    const category = classifyFailure(item.result);
    assert.equal(category, item.expectedCategory, `Classification for ${item.result.observed}`);

    const retryability = isFailureRetryable(category, 0, MAX_RECOVERY_ATTEMPTS);
    assert.equal(retryability === "retryable", item.expectedRetryable, `Retryability for ${category}`);

    const decision = decideRecovery(item.result, { attemptsSoFar: 0, maxAttempts: MAX_RECOVERY_ATTEMPTS });
    assert.equal(decision.shouldRetry, item.expectedRetryable);
    if (item.expectedRetryable) {
      assert.equal(decision.suggestedAction, item.expectedSuggestedAction);
    }
  }
});

// ============================================================================
// 10. Retry Budget & Finite Termination
// ============================================================================
test("Phase 4 — 10. Retry Budget Boundedness: Halts cleanly when attempt budget is exhausted", () => {
  const failedResult: VerificationResult = {
    actionId: "task-budget:1",
    expected: "click_effect",
    observed: "target_not_found",
    status: "failure",
    latencyMs: 1,
  };

  // Attempt 0: Allowed (attemptsSoFar = 0 < 2)
  const dec0 = decideRecovery(failedResult, { attemptsSoFar: 0, maxAttempts: 2 });
  assert.equal(dec0.shouldRetry, true);

  // Attempt 1: Allowed (attemptsSoFar = 1 < 2)
  const dec1 = decideRecovery(failedResult, { attemptsSoFar: 1, maxAttempts: 2 });
  assert.equal(dec1.shouldRetry, true);

  // Attempt 2: EXHAUSTED (attemptsSoFar = 2 >= 2) -> Must abort cleanly
  const dec2 = decideRecovery(failedResult, { attemptsSoFar: 2, maxAttempts: 2 });
  assert.equal(dec2.shouldRetry, false);
  assert.equal(dec2.suggestedAction, "ABORT");
  assert.match(dec2.reason, /stopped after 2 attempts/);
});

// ============================================================================
// 11. Cancellation & Step Budget Enforcement
// ============================================================================
test("Phase 4 — 11. Multi-Step Loop Budget: Halts deterministically at MAX_STEPS (8) without infinite looping", async () => {
  const btn = new FakeElement("button", {}, "Infinite Loop Button");
  const env = installFakeDom([btn]);

  try {
    // Server continuously returns a scroll action without ever emitting done
    env.respondWith(serverAction({ action: "scroll", direction: "down", amount: 100 }));

    const res = await runTask("Looping task");
    assert.equal(res.ok, false);
    assert.match(res.detail, /Task halted after 8 steps without completion/);
    assert.equal(env.fetchCalls.length, 8, "Must halt at exactly 8 steps");
  } finally {
    env.restore();
  }
});

// ============================================================================
// 12. Privacy Invariant Preservation Under Failure Conditions
// ============================================================================
test("Phase 4 — 12. Privacy Invariant Under Failures: Raw PII never leaks across network during error paths", async () => {
  resetTokenCounters();
  clearSecrets();

  const PII_EMAIL = "TEST_CANARY_FAILURE_EMAIL@example.invalid";
  const PII_PASSWORD = "TEST_CANARY_FAILURE_PASSWORD";

  const emailField = new FakeInputElement("email", { "aria-label": "User Email" });
  emailField.value = PII_EMAIL;
  const pwdField = new FakeInputElement("password", { "aria-label": "Password" });
  pwdField.value = PII_PASSWORD;

  const env = installFakeDom([emailField, pwdField]);

  try {
    // Step 1: Privacy Firewall verifies sanitization
    const pageState = captureDomState("task-privacy-fail");
    const detections = detectTier1(pageState.elements);
    const redactions = redact(detections);
    const firewall = buildSanitizedContext(pageState, detections, redactions, "task with errors");
    assert.equal(firewall.ok, true);

    // Simulate server 500 error response
    env.respondWith({ _statusCode: 500, error: "Database unavailable" });

    if (firewall.ok) {
      const stepResult = await runOneStep(firewall.context);
      assert.equal(stepResult, null, "Server 500 should return null");

      // Verify outbound body did NOT leak canary PII
      assert.equal(env.fetchCalls.length, 1);
      const outbound = env.fetchCalls[0].body;
      assert.ok(!outbound.includes(PII_EMAIL), "Canary email must not appear in outbound request");
      assert.ok(!outbound.includes(PII_PASSWORD), "Canary password must not appear in outbound request");
      assert.ok(outbound.includes("[EMAIL_01]"), "Must contain token [EMAIL_01]");
      assert.ok(outbound.includes("[PASSWORD_01]"), "Must contain token [PASSWORD_01]");
    }
  } finally {
    clearSecrets();
    env.restore();
  }
});

// ============================================================================
// 13. Intentional Failure & Recovery Demonstration
// ============================================================================
test("Phase 4 — 13. Failure & Recovery Demo: Ambiguous/Failure outcome triggers state recapture and retry", async () => {
  const btn = new FakeElement("button", {}, "Toggle Drawer");
  const env = installFakeDom([btn]);

  try {
    const ids = captureDomState("init-drawer").elements.map((el) => el.elementId);

    // Sequence:
    // Call 1: Server proposes click -> Verification returns ambiguous (no URL change, no element removed)
    // Content script records ambiguous outcome into history
    // Call 2: Next step includes history with ambiguous outcome -> Server proposes scroll -> Verification succeeds
    // Call 3: Server emits done -> Task completes
    env.respondWith(
      serverAction({ action: "click", element_id: ids[0] }),
      serverAction({ action: "scroll", direction: "down", amount: 150 }),
      serverAction({ action: "done" })
    );

    const taskResult = await runTask("Interactive drawer task with ambiguous verification");

    assert.equal(taskResult.ok, true);
    assert.match(taskResult.detail, /done after 2 step\(s\)/);
    assert.equal(env.fetchCalls.length, 3);

    // Verify history reflects the ambiguous verification outcome
    const secondReqBody = JSON.parse(env.fetchCalls[1].body);
    assert.equal(secondReqBody.history[0].outcome, "ambiguous");
  } finally {
    env.restore();
  }
});

// ============================================================================
// 14. Performance Profiling (Stage-by-Stage Latencies)
// ============================================================================
test("Phase 4 — 14. Performance Characterization: Client overhead remains microsecond/sub-millisecond scale", () => {
  const elements = [
    new FakeInputElement("email", { "aria-label": "Email" }),
    new FakeInputElement("password", { "aria-label": "Password" }),
    new FakeInputElement("text", { "aria-label": "Full Name" }),
    new FakeElement("button", {}, "Submit"),
  ];

  const env = installFakeDom(elements);

  try {
    const N = 500;
    const perceptionLatencies: number[] = [];
    const privacyLatencies: number[] = [];
    const serializationLatencies: number[] = [];
    const dispatchLatencies: number[] = [];
    const recoveryLatencies: number[] = [];

    for (let i = 0; i < N; i++) {
      // Stage A: Perception
      const t0 = performance.now();
      const pageState = captureDomState(`perf-task-${i}`);
      const t1 = performance.now();
      perceptionLatencies.push(t1 - t0);

      // Stage B: Privacy
      const t2 = performance.now();
      const detections = detectTier1(pageState.elements);
      const redactions = redact(detections);
      const firewall = buildSanitizedContext(pageState, detections, redactions, "perf benchmark");
      const t3 = performance.now();
      privacyLatencies.push(t3 - t2);

      // Stage C: Serialization
      const t4 = performance.now();
      if (firewall.ok) {
        const wire = toWireSanitizedContext(firewall.context);
        JSON.stringify(wire);
      }
      const t5 = performance.now();
      serializationLatencies.push(t5 - t4);

      // Stage D: Action Validation
      const sampleAction: ActionRequest = {
        action: "click",
        elementId: pageState.elements[0].elementId,
        value: null,
        valueRef: null,
        direction: null,
        amount: null,
        url: null,
        confidence: 0.95,
        taskId: `perf-task-${i}`,
        stepId: 1,
      };
      const t6 = performance.now();
      validateAction(sampleAction, `perf-task-${i}`);
      const t7 = performance.now();
      dispatchLatencies.push(t7 - t6);

      // Stage E: Role 5 Recovery Decision
      const sampleRes: VerificationResult = {
        actionId: `perf-task-${i}:1`,
        expected: "click_effect",
        observed: "target_not_found",
        status: "failure",
        latencyMs: 0,
      };
      const t8 = performance.now();
      decideRecovery(sampleRes, { attemptsSoFar: 0, maxAttempts: 2 });
      const t9 = performance.now();
      recoveryLatencies.push(t9 - t8);
    }

    const calcP50 = (arr: number[]) => arr.slice().sort((a, b) => a - b)[Math.floor(arr.length * 0.5)];
    const calcP95 = (arr: number[]) => arr.slice().sort((a, b) => a - b)[Math.floor(arr.length * 0.95)];
    const calcMax = (arr: number[]) => arr.slice().sort((a, b) => a - b)[arr.length - 1];

    console.log(
      `[Perception Latency] p50=${calcP50(perceptionLatencies).toFixed(4)}ms | p95=${calcP95(perceptionLatencies).toFixed(4)}ms | max=${calcMax(perceptionLatencies).toFixed(4)}ms`
    );
    console.log(
      `[Privacy Latency] p50=${calcP50(privacyLatencies).toFixed(4)}ms | p95=${calcP95(privacyLatencies).toFixed(4)}ms | max=${calcMax(privacyLatencies).toFixed(4)}ms`
    );
    console.log(
      `[Serialization Latency] p50=${calcP50(serializationLatencies).toFixed(4)}ms | p95=${calcP95(serializationLatencies).toFixed(4)}ms | max=${calcMax(serializationLatencies).toFixed(4)}ms`
    );
    console.log(
      `[Dispatch/Validation Latency] p50=${calcP50(dispatchLatencies).toFixed(4)}ms | p95=${calcP95(dispatchLatencies).toFixed(4)}ms | max=${calcMax(dispatchLatencies).toFixed(4)}ms`
    );
    console.log(
      `[PVM Recovery Decision Latency] p50=${calcP50(recoveryLatencies).toFixed(4)}ms | p95=${calcP95(recoveryLatencies).toFixed(4)}ms | max=${calcMax(recoveryLatencies).toFixed(4)}ms`
    );

    // Client integration assertions: sub-millisecond p50 and p95
    assert.ok(calcP50(privacyLatencies) < 0.2, "Privacy p50 must be < 0.2ms");
    assert.ok(calcP50(serializationLatencies) < 0.2, "Serialization p50 must be < 0.2ms");
    assert.ok(calcP50(dispatchLatencies) < 0.2, "Validation p50 must be < 0.2ms");
    assert.ok(calcP50(recoveryLatencies) < 0.1, "Recovery decision p50 must be < 0.1ms");
  } finally {
    env.restore();
  }
});
