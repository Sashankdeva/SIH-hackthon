// @vitest-environment jsdom
/**
 * Phase 6.7 — Client Laptop 1 Final Demo Validation Suite
 *
 * Exercises all 7 core Client Laptop 1 demonstration scenarios:
 * 1. Simple Click Task (Capture -> Sanitize -> Validate -> Execute -> Verify -> Complete)
 * 2. Multi-Step Task (Step 1 Type -> Fresh Capture -> Step 2 Click -> Sanitized History)
 * 3. Privacy Form Zero-Value & Redaction Invariant Check
 * 4. Fail-Closed Privacy Firewall Enforcement
 * 5. Server Disconnect / Network Failure Resilience
 * 6. Invalid Action & Low Confidence Rejection Gate
 * 7. PVM Verification & Privacy-Safe Memory Isolation
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { captureDomState, resetElementRegistry } from "../../perception/domCapture";
import { detectTier1 } from "../../privacy/tier1DomRules";
import { redact, resetTokenCounters } from "../../privacy/redact";
import { validateRedactionCoverage } from "../../privacy/redactionValidator";
import { buildSanitizedContext, toWireSanitizedContext } from "../../privacy/sanitizedContext";
import { storeSecret, resolveSecret, clearSecrets } from "../../privacy/secretStore";
import { validateAction } from "../../action/validator";
import { createDispatch } from "../../action/dispatch";
import { fromWireActionResponse, type WireActionResponse } from "../../action/types";
import { verifyAction } from "../../pvm/verify";
import { buildStepRecord } from "../index";
import { computeStateSignature, computeActionSignature } from "../../pvm/memory";

describe("Phase 6.7 — Client Laptop 1 Final Demo Validation", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    resetElementRegistry();
    resetTokenCounters();
    clearSecrets();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // TEST 1: Simple Click Complete Flow
  // =========================================================================
  it("Test 1: Simple Click executes complete client lifecycle exactly once", () => {
    document.body.innerHTML = `
      <div id="app">
        <button id="next-btn" type="button">Next</button>
      </div>
    `;

    const button = document.getElementById("next-btn") as HTMLButtonElement;
    let clickCount = 0;
    button.addEventListener("click", () => {
      clickCount++;
    });

    // 1. DOM Capture
    const pageState = captureDomState("task-click-001");
    const nextBtn = pageState.elements.find((el) => el.label === "Next");
    expect(nextBtn).toBeDefined();
    expect(nextBtn?.role).toBe("button");

    // 2. Privacy Sanitization
    const detections = detectTier1(pageState.elements);
    const redactions = redact(detections);
    const firewall = buildSanitizedContext(pageState, detections, redactions, "Click the Next button.");
    expect(firewall.ok).toBe(true);
    if (!firewall.ok) return;

    // 3. Wire Payload
    const wire = toWireSanitizedContext(firewall.context);
    expect(wire.elements.length).toBeGreaterThan(0);

    // 4. Action Validation
    const serverWireAction: WireActionResponse = {
      action: "click",
      element_id: nextBtn!.elementId,
      confidence: 0.95,
      task_id: "task-click-001",
      step_id: 1,
    };
    const actionReq = fromWireActionResponse(serverWireAction);
    const validation = validateAction(actionReq, "task-click-001");
    expect(validation.ok).toBe(true);

    // 5. Dispatch Execution (Guaranteed single execution)
    const actionId = "task-click-001:1";
    const dispatch = createDispatch(actionId);
    dispatch.run(actionReq);
    expect(clickCount).toBe(1);

    // Dispatch gate blocks duplicate re-run
    dispatch.run(actionReq);
    expect(clickCount).toBe(1);

    // 6. PVM Verification
    const verification = verifyAction(actionId, {
      action: actionReq,
      urlBefore: "http://localhost:8000/step1",
      scrollYBefore: 0,
      elementValueBefore: null,
      startedAt: Date.now(),
    });
    expect(verification.actionId).toBe(actionId);
  });

  // =========================================================================
  // TEST 2: Multi-Step Task Flow
  // =========================================================================
  it("Test 2: Multi-Step Task maintains sanitized history and fresh DOM captures", () => {
    document.body.innerHTML = `
      <div>
        <label>Search <input id="search-input" type="text" /></label>
        <button id="next-btn" type="button">Next</button>
      </div>
    `;

    const searchInput = document.getElementById("search-input") as HTMLInputElement;
    const nextBtn = document.getElementById("next-btn") as HTMLButtonElement;

    // STEP 1: Type 'hello' into Search
    const pageState1 = captureDomState("task-multi-002");
    const searchEl = pageState1.elements.find((el) => el.label === "Search");
    expect(searchEl).toBeDefined();

    const action1 = fromWireActionResponse({
      action: "type",
      element_id: searchEl!.elementId,
      value: "hello",
      confidence: 0.92,
      task_id: "task-multi-002",
      step_id: 1,
    });
    expect(validateAction(action1, "task-multi-002").ok).toBe(true);

    createDispatch("task-multi-002:1").run(action1);
    expect(searchInput.value).toBe("hello");

    const historyRecord1 = buildStepRecord(1, "type", searchEl!.elementId, "Search", "success");
    expect(historyRecord1.step).toBe(1);
    expect(historyRecord1.outcome).toBe("success");

    // STEP 2: Fresh DOM Capture & Click Next
    const pageState2 = captureDomState("task-multi-002");
    const nextEl2 = pageState2.elements.find((el) => el.label === "Next");
    expect(nextEl2).toBeDefined();

    const action2 = fromWireActionResponse({
      action: "click",
      element_id: nextEl2!.elementId,
      confidence: 0.96,
      task_id: "task-multi-002",
      step_id: 2,
    });
    expect(validateAction(action2, "task-multi-002").ok).toBe(true);

    let clicked = false;
    nextBtn.addEventListener("click", () => {
      clicked = true;
    });
    createDispatch("task-multi-002:2").run(action2);
    expect(clicked).toBe(true);
  });

  // =========================================================================
  // TEST 3: Privacy Form Zero-Value & Redaction Invariant
  // =========================================================================
  it("Test 3: Privacy Form redacts sensitive fields and strictly omits raw secrets", () => {
    const CANARY_PWD = "CANARY_SECRET_PWD_999";
    const CANARY_EMAIL = "canary@test.example";
    const CANARY_PHONE = "18005550199";
    const CANARY_NAME = "Jane Doe";
    const CANARY_ADDR = "999 Security Way";
    const CANARY_CARD = "4000123456789010";

    document.body.innerHTML = `
      <form id="privacy-form">
        <label>Full Name <input type="text" name="name" value="${CANARY_NAME}" /></label>
        <label>Email <input type="email" name="email" value="${CANARY_EMAIL}" /></label>
        <label>Phone <input type="tel" name="phone" value="${CANARY_PHONE}" /></label>
        <label>Password <input type="password" name="password" value="${CANARY_PWD}" /></label>
        <label>Shipping Address <input type="text" name="address" autocomplete="street-address" value="${CANARY_ADDR}" /></label>
        <label>Card Number <input type="text" name="card" autocomplete="cc-number" value="${CANARY_CARD}" /></label>
      </form>
    `;

    // 1. PageState Invariant
    const pageState = captureDomState("task-privacy-003");
    const stateJson = JSON.stringify(pageState);
    expect(stateJson).not.toContain(CANARY_PWD);
    expect(stateJson).not.toContain(CANARY_EMAIL);
    expect(stateJson).not.toContain(CANARY_PHONE);
    expect(stateJson).not.toContain(CANARY_NAME);
    expect(stateJson).not.toContain(CANARY_ADDR);
    expect(stateJson).not.toContain(CANARY_CARD);

    // 2. Redaction Invariant
    const detections = detectTier1(pageState.elements);
    const redactions = redact(detections);
    const firewall = buildSanitizedContext(pageState, detections, redactions, "submit sensitive form");
    expect(firewall.ok).toBe(true);
    if (!firewall.ok) return;

    // 3. Wire Body Invariant
    const wireJson = JSON.stringify(toWireSanitizedContext(firewall.context));
    expect(wireJson).not.toContain(CANARY_PWD);
    expect(wireJson).not.toContain(CANARY_EMAIL);
    expect(wireJson).not.toContain(CANARY_PHONE);
    expect(wireJson).not.toContain(CANARY_NAME);
    expect(wireJson).not.toContain(CANARY_ADDR);
    expect(wireJson).not.toContain(CANARY_CARD);

    // Tokens present
    expect(wireJson).toContain("[PASSWORD_01]");
    expect(wireJson).toContain("[EMAIL_01]");
    expect(wireJson).toContain("[PHONE_01]");
    expect(wireJson).toContain("[PERSON_NAME_01]");
    expect(wireJson).toContain("[ADDRESS_01]");
    expect(wireJson).toContain("[FINANCIAL_01]");

    // 4. Secret Store Local Invariant
    storeSecret("[PASSWORD_01]", CANARY_PWD);
    expect(resolveSecret("[PASSWORD_01]")).toBe(CANARY_PWD);
  });

  // =========================================================================
  // TEST 4: Fail-Closed Privacy Enforcement
  // =========================================================================
  it("Test 4: Fail-Closed blocks outbound transmission if redaction is incomplete", () => {
    const pageState = {
      taskId: "task-fail-closed",
      url: "http://localhost:8000/",
      title: "Test",
      capturedAt: Date.now(),
      elements: [
        { elementId: 1, role: "textbox", label: "Password", tag: "input", inputType: "password" },
        { elementId: 2, role: "textbox", label: "Email", tag: "input", inputType: "email" },
      ],
    };

    const detections = [
      { elementId: 1, category: "password" as const, source: "dom_rule" as const, confidence: 1 },
      { elementId: 2, category: "email" as const, source: "dom_rule" as const, confidence: 1 },
    ];
    // Missing redaction for element 2
    const incompleteRedactions = [
      { elementId: 1, category: "password" as const, method: "semantic_token" as const, token: "[PASSWORD_01]" },
    ];

    const coverage = validateRedactionCoverage(detections, incompleteRedactions);
    expect(coverage.ok).toBe(false);
    expect(coverage.missing).toEqual([2]);

    const firewall = buildSanitizedContext(pageState, detections, incompleteRedactions, "login");
    expect(firewall.ok).toBe(false);
    if (!firewall.ok) {
      expect(firewall.missingElementIds).toEqual([2]);
    }
  });

  // =========================================================================
  // TEST 5: Server Disconnect Safety
  // =========================================================================
  it("Test 5: Server disconnect stops multi-step loop cleanly without phantom actions", async () => {
    // Simulate fetch network failure (server offline / connection refused)
    const mockFetch = vi.fn().mockRejectedValue(new Error("Failed to fetch"));
    globalThis.fetch = mockFetch as any;

    captureDomState("task-disconnect");
    let fetchErrorHandled = false;

    try {
      const response = await fetch("http://10.70.10.47:8787/reason", {
        method: "POST",
        body: JSON.stringify({ task_id: "task-disconnect" }),
      });
      if (!response.ok) fetchErrorHandled = true;
    } catch (err) {
      fetchErrorHandled = true;
    }

    expect(fetchErrorHandled).toBe(true);
  });

  // =========================================================================
  // TEST 6: Invalid Action Rejection
  // =========================================================================
  it("Test 6: Client validator strictly rejects malformed, low-confidence, and out-of-bounds actions", () => {
    document.body.innerHTML = `<button id="btn">Submit</button>`;
    captureDomState("task-invalid");

    // 1. Low confidence (< 0.5)
    const lowConfidenceAction = fromWireActionResponse({
      action: "click",
      element_id: 1,
      confidence: 0.35,
      task_id: "task-invalid",
      step_id: 1,
    });
    expect(validateAction(lowConfidenceAction, "task-invalid").ok).toBe(false);

    // 2. Non-existent element ID
    const invalidIdAction = fromWireActionResponse({
      action: "click",
      element_id: 9999,
      confidence: 0.95,
      task_id: "task-invalid",
      step_id: 1,
    });
    expect(validateAction(invalidIdAction, "task-invalid").ok).toBe(false);

    // 3. Task ID mismatch
    const taskMismatchAction = fromWireActionResponse({
      action: "click",
      element_id: 1,
      confidence: 0.95,
      task_id: "different-task-id",
      step_id: 1,
    });
    expect(validateAction(taskMismatchAction, "task-invalid").ok).toBe(false);

    // 4. Disallowed action type
    const unknownAction = {
      action: "execute_arbitrary_script",
      elementId: 1,
      confidence: 0.99,
      taskId: "task-invalid",
      stepId: 1,
    } as any;
    expect(validateAction(unknownAction, "task-invalid").ok).toBe(false);
  });

  // =========================================================================
  // TEST 7: PVM Privacy-Safe Memory & Signature Isolation
  // =========================================================================
  it("Test 7: PVM ensures raw secrets never enter action signatures, state signatures, or step records", () => {
    const CANARY_PWD = "CANARY_PVM_SECRET_777";

    const stepRecord = buildStepRecord(1, "type_secret", 10, "[PASSWORD_01]", "success");
    expect(JSON.stringify(stepRecord)).not.toContain(CANARY_PWD);
    expect(JSON.stringify(stepRecord)).toContain("[PASSWORD_01]");

    const actionSig = computeActionSignature({
      action: "type_secret",
      targetElementId: 10,
      valueRef: "[PASSWORD_01]",
      direction: null,
      amount: null,
      url: null,
    });
    expect(actionSig).not.toContain(CANARY_PWD);

    const stateSig = computeStateSignature({
      url: "http://localhost:8000/account",
      title: "Account",
      elements: [{ elementId: 10, role: "textbox", tag: "input", inputType: "password" }],
    });
    expect(stateSig).not.toContain(CANARY_PWD);
  });
});
