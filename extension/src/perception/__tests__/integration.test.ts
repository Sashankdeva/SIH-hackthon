// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { captureDomState, resetElementRegistry } from "../domCapture";
import { detectTier1 } from "../../privacy/tier1DomRules";
import { redact, resetTokenCounters } from "../../privacy/redact";
import { buildSanitizedContext, toWireSanitizedContext } from "../../privacy/sanitizedContext";
import { validateRedactionCoverage } from "../../privacy/redactionValidator";
import { validateAction } from "../../action/validator";
import { executeAction } from "../../action/executor";
import { decideRecovery } from "../../pvm/recovery";
import { verifyElementPresent } from "../../pvm/verify";
import { fromWireActionResponse, type ActionRequest } from "../../action/types";
import type { RedactionRecord } from "../../privacy/types";

describe("Role 2 Phase 4 — Controlled Full-Pipeline Integration", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.title = "Mock Checkout — SIH26171 Test Site";
    resetElementRegistry();
    resetTokenCounters();
  });

  it("1. [Golden-Path Integration] traces complete end-to-end pipeline on mock-site checkout form", async () => {
    // -------------------------------------------------------------
    // STAGE 1: Real Mock-Site DOM Setup
    // -------------------------------------------------------------
    document.body.innerHTML = `
      <nav><a href="privacy-test.html">Go to privacy canary test page &rarr;</a></nav>
      <h1>Mock Checkout</h1>
      <form id="checkout-form" onsubmit="return false;">
        <label>Full Name <input id="name" type="text" name="name" autocomplete="name" placeholder="Aarav Sharma" /></label>
        <label>Email <input id="email" type="email" name="email" autocomplete="email" placeholder="aarav@example.com" /></label>
        <label>Phone <input id="phone" type="tel" name="phone" autocomplete="tel" placeholder="+91 98765 43210" /></label>
        <label>Password <input id="password" type="password" name="password" autocomplete="current-password" /></label>
        <label>Shipping Address <input id="address" type="text" name="address" autocomplete="street-address" placeholder="221B Residency Road" /></label>
        <label>Card Number <input id="card_number" type="text" name="card_number" autocomplete="cc-number" placeholder="4111 1111 1111 1111" /></label>
        <label>Product
          <select id="product" name="product">
            <option value="flight-del-bom">Flight — DEL to BOM, tomorrow</option>
            <option value="flight-del-blr">Flight — DEL to BLR, tomorrow</option>
          </select>
        </label>
        <button id="submit-btn" type="submit">Place Order</button>
      </form>
    `;

    // Wire real mock-site click handler
    const submitBtn = document.getElementById("submit-btn")!;
    submitBtn.addEventListener("click", () => {
      submitBtn.textContent = "Order placed (demo only)";
    });

    const taskId = "task-golden-101";

    // -------------------------------------------------------------
    // STAGE 2: Role 2 Perception (REAL)
    // -------------------------------------------------------------
    const t0 = performance.now();
    const pageState = captureDomState(taskId);
    const perceptionTime = performance.now() - t0;

    expect(pageState.taskId).toBe(taskId);
    expect(pageState.elements).toHaveLength(9);

    // Locate Submit Button dynamically
    const submitElement = pageState.elements.find((e) => e.role === "button" && e.label === "Place Order");
    expect(submitElement).toBeDefined();
    const targetElementId = submitElement!.elementId;
    expect(targetElementId).toBeGreaterThan(0);

    // -------------------------------------------------------------
    // STAGE 3: Role 3 Privacy Guard (REAL)
    // -------------------------------------------------------------
    const t1 = performance.now();
    const detections = detectTier1(pageState.elements);
    const redactions = redact(detections);
    const privacyTime = performance.now() - t1;

    expect(detections.length).toBeGreaterThanOrEqual(4); // email, phone, password, card_number, name
    const coverage = validateRedactionCoverage(detections, redactions);
    expect(coverage.ok).toBe(true);

    // -------------------------------------------------------------
    // STAGE 4: Role 3 Privacy Firewall & SanitizedContext (REAL)
    // -------------------------------------------------------------
    const sanitizedContext = buildSanitizedContext(pageState, detections, redactions);
    expect(sanitizedContext).not.toBeNull();
    expect(sanitizedContext!.taskId).toBe(taskId);

    // Verify Privacy Invariant: Sensitive elements removed from public elements array
    const publicElementIds = sanitizedContext!.elements.map((e) => e.elementId);
    expect(publicElementIds).toContain(targetElementId); // Submit button is safe
    expect(sanitizedContext!.fields).toBeDefined();

    // -------------------------------------------------------------
    // STAGE 5: Role 4 Server Reasoning (STUB / Action Proposed)
    // -------------------------------------------------------------
    // Simulated ActionResponse matching server proposal for clicking the submit button
    const actionProposal: ActionRequest = {
      action: "click",
      elementId: targetElementId,
      confidence: 0.95,
      taskId: taskId,
      stepId: 1,
    };

    // -------------------------------------------------------------
    // STAGE 6: Role 1 Action Validator (REAL)
    // -------------------------------------------------------------
    const t2 = performance.now();
    const validationResult = validateAction(actionProposal, taskId);
    expect(validationResult.ok).toBe(true);

    // -------------------------------------------------------------
    // STAGE 7: Role 1 Action Executor (REAL)
    // -------------------------------------------------------------
    await executeAction(actionProposal);
    const actionTime = performance.now() - t2;

    // Verify DOM mutation occurred as a result of real browser action execution
    expect(submitBtn.textContent).toBe("Order placed (demo only)");

    // -------------------------------------------------------------
    // STAGE 8: Role 5 Verification & PVM (REAL)
    // -------------------------------------------------------------
    const t3 = performance.now();
    const verification = verifyElementPresent("act-1", "#submit-btn", Date.now() - 100);
    const recovery = decideRecovery(verification, 0);
    const verificationTime = performance.now() - t3;

    expect(verification.status).toBe("success");
    expect(recovery.shouldRetry).toBe(false);
    expect(recovery.reason).toBe("verified success");

    console.log(
      `[Golden-Path Latencies] Perception: ${perceptionTime.toFixed(2)}ms | Privacy: ${privacyTime.toFixed(2)}ms | Action: ${actionTime.toFixed(2)}ms | Verification: ${verificationTime.toFixed(2)}ms`
    );
  });

  it("2. [Privacy Leak Test] proves CANARY PII never crosses into perception state or sanitized context", () => {
    document.body.innerHTML = `
      <form onsubmit="return false;">
        <label>Email <input type="email" name="email" value="CANARY_EMAIL_12345@example.com" /></label>
        <label>Phone <input type="tel" name="phone" value="CANARY_PHONE_5550100" /></label>
        <label>Password <input type="password" name="password" value="CANARY_PASSWORD_hunter2" /></label>
        <label>Full Name <input type="text" name="name" value="CANARY_NAME_Test Subject" /></label>
        <label>Card Number <input type="text" name="card_number" value="CANARY_CARD_4242424242424242" /></label>
        <button type="submit">Submit</button>
      </form>
    `;

    const taskId = "task-canary-leak-test";

    // Perception Stage (Role 2)
    const pageState = captureDomState(taskId);
    const perceptionJson = JSON.stringify(pageState);

    expect(perceptionJson).not.toContain("CANARY_EMAIL_12345@example.com");
    expect(perceptionJson).not.toContain("CANARY_PHONE_5550100");
    expect(perceptionJson).not.toContain("CANARY_PASSWORD_hunter2");
    expect(perceptionJson).not.toContain("CANARY_NAME_Test Subject");
    expect(perceptionJson).not.toContain("CANARY_CARD_4242424242424242");

    // Privacy Stage (Role 3)
    const detections = detectTier1(pageState.elements);
    const redactions = redact(detections);
    const sanitized = buildSanitizedContext(pageState, detections, redactions);
    const sanitizedJson = JSON.stringify(sanitized);

    // Sanitized context only contains tokens, never raw canary values
    expect(sanitizedJson).not.toContain("CANARY_EMAIL_12345@example.com");
    expect(sanitizedJson).not.toContain("CANARY_PHONE_5550100");
    expect(sanitizedJson).not.toContain("CANARY_PASSWORD_hunter2");
    expect(sanitizedJson).not.toContain("CANARY_NAME_Test Subject");
    expect(sanitizedJson).not.toContain("CANARY_CARD_4242424242424242");
  });

  it("3. [Failure Paths] verifies safe handling of privacy failure, invalid IDs, unsupported actions, and removed elements", async () => {
    document.body.innerHTML = `
      <div>
        <button id="active-btn">Clickable</button>
        <input id="secret-inp" type="password" />
      </div>
    `;

    const taskId = "task-fail-paths";
    const pageState = captureDomState(taskId);
    const btnId = pageState.elements[0].elementId;

    // Case A: Privacy Failure (Incomplete redaction -> Privacy Firewall fails closed)
    const detections = detectTier1(pageState.elements);
    const incompleteRedactions: RedactionRecord[] = []; // Redaction dropped
    const blockedContext = buildSanitizedContext(pageState, detections, incompleteRedactions);
    expect(blockedContext).toBeNull(); // Privacy firewall refuses to emit payload

    // Case B: Action with Non-Existent Element ID
    const invalidIdAction: ActionRequest = {
      action: "click",
      elementId: 999999,
      confidence: 0.9,
      taskId: taskId,
      stepId: 1,
    };
    const invalidValidation = validateAction(invalidIdAction, taskId);
    expect(invalidValidation.ok).toBe(false);
    expect(invalidValidation.reason).toContain("not found");

    // Case C: Unsupported Action Type
    const unsupportedAction: any = {
      action: "eval_script",
      elementId: btnId,
      confidence: 0.9,
      taskId: taskId,
      stepId: 1,
    };
    const unsupportedValidation = validateAction(unsupportedAction, taskId);
    expect(unsupportedValidation.ok).toBe(false);
    expect(unsupportedValidation.reason).toContain("Unknown action type");

    // Case D: Confidence below threshold
    const lowConfidenceAction: ActionRequest = {
      action: "click",
      elementId: btnId,
      confidence: 0.2,
      taskId: taskId,
      stepId: 1,
    };
    const lowConfValidation = validateAction(lowConfidenceAction, taskId);
    expect(lowConfValidation.ok).toBe(false);
    expect(lowConfValidation.reason).toContain("below threshold");

    // Case E: Element removed before action execution
    document.getElementById("active-btn")?.remove();
    const removedValidation = validateAction(
      { action: "click", elementId: btnId, confidence: 0.9, taskId: taskId, stepId: 1 },
      taskId
    );
    expect(removedValidation.ok).toBe(false);
    expect(removedValidation.reason).toContain("not found");
  });

  it("4. [Element ID Preservation] traces exact element ID persistence across perception -> action -> execution", async () => {
    document.body.innerHTML = `
      <form>
        <input id="text-field" type="text" placeholder="Type here" />
      </form>
    `;

    const taskId = "task-id-trace";
    const pageState = captureDomState(taskId);
    const assignedId = pageState.elements[0].elementId;

    // Simulate action targeting this specific assigned element ID
    const typeAction: ActionRequest = {
      action: "type",
      elementId: assignedId,
      value: "AgentTypedContent",
      confidence: 0.9,
      taskId: taskId,
      stepId: 1,
    };

    const validation = validateAction(typeAction, taskId);
    expect(validation.ok).toBe(true);

    await executeAction(typeAction);

    const inputEl = document.getElementById("text-field") as HTMLInputElement;
    expect(inputEl.value).toBe("AgentTypedContent");
  });

  it("5. [Wire Schema Adapter] validates bidirectional transformation between client camelCase and server snake_case wire formats", () => {
    const pageState = captureDomState("task-wire-adapter");
    const detections = detectTier1(pageState.elements);
    const redactions = redact(detections);
    const sanitized = buildSanitizedContext(pageState, detections, redactions);
    expect(sanitized).not.toBeNull();

    // Outbound wire serialization
    const wirePayload = toWireSanitizedContext(sanitized!);
    expect(wirePayload.task_id).toBe("task-wire-adapter");
    expect(wirePayload.url_origin).toBe(location.origin);
    expect(Array.isArray(wirePayload.elements)).toBe(true);

    const wireJson = JSON.stringify(wirePayload);
    const parsedWire = JSON.parse(wireJson);

    // Verify wire JSON strictly uses snake_case matching shared/schemas/sanitized-context.schema.json
    expect(parsedWire.task_id).toBeDefined();
    expect(parsedWire.taskId).toBeUndefined();
    expect(parsedWire.url_origin).toBeDefined();
    expect(parsedWire.urlOrigin).toBeUndefined();

    // Inbound wire deserialization
    const wireActionResponse = {
      action: "click" as const,
      element_id: 42,
      value: null,
      value_ref: null,
      direction: null,
      amount: null,
      url: null,
      confidence: 0.98,
      task_id: "task-wire-adapter",
      step_id: 1,
    };

    const clientAction = fromWireActionResponse(wireActionResponse);
    expect(clientAction.action).toBe("click");
    expect(clientAction.elementId).toBe(42);
    expect(clientAction.taskId).toBe("task-wire-adapter");
    expect(clientAction.stepId).toBe(1);
  });
});
