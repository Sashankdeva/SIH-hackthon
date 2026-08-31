import test from "node:test";
import assert from "node:assert/strict";

import {
  verifyAction,
  verifyLevel2Semantic,
  isInputLikeElement,
  type ActionSnapshot,
} from "../src/pvm/verify";
import type { SanitizedContext, StepRecord } from "../src/privacy/sanitizedContext";
import { runOneStepTyped, isStepError } from "../src/content/pipeline";
import { captureDomState } from "../src/perception/domCapture";
import { FakeElement, FakeInputElement, installFakeDom } from "./helpers/fakeDom";

// ---------------------------------------------------------------------------
// 1. isInputLikeElement detection
// ---------------------------------------------------------------------------
test("isInputLikeElement correctly identifies input controls across tags and roles", () => {
  const input = new FakeInputElement("text");
  const textarea = new FakeElement("textarea");
  const select = new FakeElement("select");
  const textboxRole = new FakeElement("div", { role: "textbox" });
  const searchboxRole = new FakeElement("div", { role: "searchbox" });
  const comboboxRole = new FakeElement("div", { role: "combobox" });
  const button = new FakeElement("button");
  const div = new FakeElement("div");

  assert.equal(isInputLikeElement(input as unknown as Element), true);
  assert.equal(isInputLikeElement(textarea as unknown as Element), true);
  assert.equal(isInputLikeElement(select as unknown as Element), true);
  assert.equal(isInputLikeElement(textboxRole as unknown as Element), true);
  assert.equal(isInputLikeElement(searchboxRole as unknown as Element), true);
  assert.equal(isInputLikeElement(comboboxRole as unknown as Element), true);
  assert.equal(isInputLikeElement(button as unknown as Element), false);
  assert.equal(isInputLikeElement(div as unknown as Element), false);
});

// ---------------------------------------------------------------------------
// 2. Click on textbox + unused value -> L2 semantic verification skips textContent
// ---------------------------------------------------------------------------
test("Click on textbox with unused value does NOT report semantic L2 success from textContent", () => {
  const input = new FakeInputElement("text", { "data-privy-id": "10" });
  input.value = "";
  input.textContent = "";

  const l2Result = verifyLevel2Semantic("test-act-1", `[data-privy-id="10"]`, {
    expectedTextPattern: "Samsung S24 FE",
  });

  // Must not succeed based on empty or irrelevant textContent on input
  assert.notEqual(l2Result.status, "success");
});

// ---------------------------------------------------------------------------
// 3. Actual type action -> existing type verification behavior succeeds on value match
// ---------------------------------------------------------------------------
test("Actual type action verifies target value directly and succeeds on value match", () => {
  const input = new FakeInputElement("text");
  const env = installFakeDom([input]);
  const pageState = captureDomState("task-type-1");
  const elementId = pageState.elements[0].elementId;
  input.value = "Samsung S24 FE";

  const snapshot: ActionSnapshot = {
    urlBefore: "http://localhost:8000/",
    scrollYBefore: 0,
    elementValueBefore: "",
    action: {
      action: "type",
      elementId,
      value: "Samsung S24 FE",
      confidence: 1.0,
      taskId: "task-type-1",
      stepId: 1,
    },
    startedAt: Date.now(),
  };

  try {
    const res = verifyAction("task-type-1:1", snapshot);
    assert.equal(res.status, "success");
    assert.equal(res.expected, "value_matches");
    assert.equal(res.observed, "value_matches");
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
// 4. type_secret action -> existing secret verification behavior unchanged
// ---------------------------------------------------------------------------
test("type_secret action verifies value changed without exposing secret", () => {
  const pwdInput = new FakeInputElement("password");
  const env = installFakeDom([pwdInput]);
  const pageState = captureDomState("task-secret-1");
  const elementId = pageState.elements[0].elementId;
  pwdInput.value = "supersecret";

  const snapshot: ActionSnapshot = {
    urlBefore: "http://localhost:8000/",
    scrollYBefore: 0,
    elementValueBefore: "",
    action: {
      action: "type_secret",
      elementId,
      valueRef: "[PASSWORD_01]",
      confidence: 1.0,
      taskId: "task-secret-1",
      stepId: 1,
    },
    startedAt: Date.now(),
  };

  try {
    const res = verifyAction("task-secret-1:1", snapshot);
    assert.equal(res.status, "success");
    assert.equal(res.expected, "value_changed");
    assert.equal(res.observed, "value_changed");
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
// 5. Samsung-style search sequence: click textbox incorrectly -> verifier must NOT record success
// ---------------------------------------------------------------------------
test("Samsung scenario: Qwen returns click on search textbox with value -> outcome is ambiguous/not success", async () => {
  const searchInput = new FakeInputElement("text", {
    role: "textbox",
    "aria-label": "Search for products",
  });
  const searchBtn = new FakeElement("button", {
    "aria-label": "Search",
  }, "Search");

  const elements = [searchInput, searchBtn];
  const env = installFakeDom(elements);
  const pageState = captureDomState("samsung-task-1");
  const inputId = pageState.elements[0].elementId;
  const btnId = pageState.elements[1].elementId;

  // Mock server returning click on textbox with unused value "Samsung S24 FE"
  env.respondWith({
    action: "click",
    element_id: inputId,
    value: "Samsung S24 FE",
    confidence: 0.95,
    task_id: "samsung-task-1",
    step_id: 1,
  });

  try {
    const context: SanitizedContext = {
      taskId: "samsung-task-1",
      task: "Search for Samsung S24 FE and add it to the cart.",
      page: "Shopping Portal",
      urlOrigin: "http://localhost:8000",
      elements: [
        { elementId: inputId, role: "textbox", label: "Search for products" },
        { elementId: btnId, role: "button", label: "Search" },
      ],
      fields: {},
    };

    const stepResult = await runOneStepTyped(context);

    // Step 1: Must NOT report success! (Should be ambiguous because click did not navigate or remove element)
    assert.ok(stepResult !== null, "stepResult must not be null");
    assert.ok(!isStepError(stepResult), "Must return a VerificationResult, not a StepError");
    assert.notEqual(stepResult.status, "success", "Click on search textbox must NOT receive success status");
    assert.equal(stepResult.status, "ambiguous");
    assert.equal(searchInput.value, "", "Input value remains empty because click does not type");

    // Construct step record for history
    const historyRecord: StepRecord = {
      step: 1,
      action: "click",
      element_id: inputId,
      element_label: "Search for products",
      outcome: stepResult.status,
    };

    // 8. After false/ambiguous verification: history must not contain outcome: "success"
    assert.notEqual(historyRecord.outcome, "success", "History record must NOT claim outcome: success");
    assert.equal(historyRecord.outcome, "ambiguous");
  } finally {
    env.restore();
  }
});
