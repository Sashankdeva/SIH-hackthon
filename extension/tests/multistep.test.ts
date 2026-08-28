/**
 * Focused tests for Stage 3A: Multi-step extension loop.
 *
 * Validates:
 * 1. 3-step task executes exactly 3 actions.
 * 2. Context is re-captured between steps.
 * 3. History contains the previous sanitized steps.
 * 4. `done` terminates without execution.
 * 5. 8-step budget halts.
 * 6. validator rejection halts.
 * 7. verification failure halts.
 * 8. server error halts.
 * 9. raw values/secrets never enter history.
 * 10. existing one-shot behavior remains unchanged (single step execution with runOneStep).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { installFakeDom, serverAction, FakeElement, FakeInputElement } from "./helpers/fakeDom";
import { runTask } from "../src/content/index";
import { runOneStep } from "../src/content/pipeline";
import { storeSecret } from "../src/privacy/secretStore";
import { captureDomState } from "../src/perception/domCapture";
import type { SanitizedContext } from "../src/privacy/sanitizedContext";

test("1. 3-step task executes exactly 3 actions before completing on done", async () => {
  const btn1 = new FakeElement("button", {}, "Step 1 Btn");
  btn1.onClickRemove = true; // DOM changes on click
  const env = installFakeDom([btn1]);

  try {
    const ids = captureDomState("init").elements.map((el) => el.elementId);

    env.respondWith(
      serverAction({ action: "click", element_id: ids[0] }),
      serverAction({ action: "scroll", direction: "down", amount: 100 }),
      serverAction({ action: "done" })
    );

    const res = await runTask("3 step test task");

    assert.equal(res.ok, true);
    assert.match(res.detail, /done after 2 step\(s\)/);
    assert.equal(env.fetchCalls.length, 3, "Should have made 3 server requests (click, scroll, done)");
    assert.equal(btn1.clickCount, 1, "Click executed once");
    assert.equal(env.scrollCalls.length, 1, "Scroll executed once");
  } finally {
    env.restore();
  }
});

test("2. Context is re-captured between steps", async () => {
  const btn1 = new FakeElement("button", {}, "Initial Button");
  const env = installFakeDom([btn1]);

  try {
    env.respondWith((_bodyStr, callIndex) => {
      if (callIndex === 0) {
        // Step 1: dynamically add a second element to DOM during step 1 execution
        env.elements.push(new FakeElement("button", {}, "Dynamically Added Button"));
        return serverAction({ action: "scroll", direction: "down" });
      }
      return serverAction({ action: "done" });
    });

    const res = await runTask("recapture context test");
    assert.equal(res.ok, true);

    assert.equal(env.fetchCalls.length, 2);

    const firstReqBody = JSON.parse(env.fetchCalls[0].body);
    const secondReqBody = JSON.parse(env.fetchCalls[1].body);

    assert.equal(firstReqBody.elements.length, 1);
    assert.equal(secondReqBody.elements.length, 2, "Second request context must reflect newly added DOM element");
  } finally {
    env.restore();
  }
});

test("3. History contains the previous sanitized steps", async () => {
  const btn = new FakeElement("button", {}, "Action Button");
  const env = installFakeDom([btn]);

  try {
    env.respondWith(
      serverAction({ action: "scroll", direction: "down" }),
      serverAction({ action: "done" })
    );

    await runTask("test history");

    assert.equal(env.fetchCalls.length, 2);

    const secondReqBody = JSON.parse(env.fetchCalls[1].body);
    assert.ok(secondReqBody.history, "History should be sent on step 2");
    assert.equal(secondReqBody.history.length, 1);
    assert.equal(secondReqBody.history[0].step, 1);
    assert.equal(secondReqBody.history[0].action, "scroll");
    assert.equal(secondReqBody.history[0].outcome, "success");
  } finally {
    env.restore();
  }
});

test("4. done terminates immediately without browser execution", async () => {
  const btn = new FakeElement("button", {}, "Unused Button");
  const env = installFakeDom([btn]);

  try {
    env.respondWith(serverAction({ action: "done" }));

    const res = await runTask("done immediately");

    assert.equal(res.ok, true);
    assert.match(res.detail, /done after 0 step\(s\)/);
    assert.equal(env.fetchCalls.length, 1);
    assert.equal(btn.clickCount, 0, "No browser action should be executed for done");
  } finally {
    env.restore();
  }
});

test("5. 8-step budget halts execution if done is not emitted", async () => {
  const btn = new FakeElement("button", {}, "Persistent Button");
  const env = installFakeDom([btn]);

  try {
    // Return scroll action continuously (never returns done)
    env.respondWith(serverAction({ action: "scroll", direction: "down" }));

    const res = await runTask("budget test");

    assert.equal(res.ok, false);
    assert.match(res.detail, /Task halted after 8 steps/);
    assert.equal(env.fetchCalls.length, 8, "Must halt at MAX_STEPS (8)");
  } finally {
    env.restore();
  }
});

test("6. Validator rejection halts loop immediately", async () => {
  const btn = new FakeElement("button", {}, "Target Button");
  const env = installFakeDom([btn]);

  try {
    // Return action with bad confidence (< 0.5) causing validator rejection
    env.respondWith(serverAction({ action: "click", element_id: 1, confidence: 0.1 }));

    const res = await runTask("validator rejection test");

    assert.equal(res.ok, false);
    assert.match(res.detail, /failed — server error or validator rejection/);
    assert.equal(env.fetchCalls.length, 1, "Must halt immediately on step 1");
    assert.equal(btn.clickCount, 0);
  } finally {
    env.restore();
  }
});

test("7. Verification failure halts loop immediately", async () => {
  const input = new FakeInputElement("text", { "aria-label": "Test Field" });
  // Make value read-only so type execution fails to change the value, causing value_mismatch verification failure
  Object.defineProperty(input, "value", { get: () => "stubborn value", set: () => {}, configurable: true });

  const env = installFakeDom([input]);

  try {
    const ids = captureDomState("init").elements.map((el) => el.elementId);

    // type expecting "expected value", but element value won't update -> verification failure
    env.respondWith(serverAction({ action: "type", element_id: ids[0], value: "expected value" }));

    const res = await runTask("verification failure test");

    assert.equal(res.ok, false);
    assert.match(res.detail, /verification failed \(value_mismatch\)/);
    assert.equal(env.fetchCalls.length, 1, "Must halt immediately on verification failure");
  } finally {
    env.restore();
  }
});

test("8. Server error (non-200 or network failure) halts loop immediately", async () => {
  const btn = new FakeElement("button", {}, "Target Button");
  const env = installFakeDom([btn]);

  try {
    env.respondWith({ _statusCode: 500, error: "Internal Server Error" });

    const res = await runTask("server error test");

    assert.equal(res.ok, false);
    assert.match(res.detail, /failed — server error or validator rejection/);
    assert.equal(env.fetchCalls.length, 1, "Must halt immediately on server error");
  } finally {
    env.restore();
  }
});

test("9. Raw values and secrets never enter history", async () => {
  const passwordInput = new FakeInputElement("password", { "aria-label": "[PASSWORD_01]" });
  const env = installFakeDom([passwordInput]);

  try {
    storeSecret("[PASSWORD_01]", "super-secret-password-123");
    const ids = captureDomState("init").elements.map((el) => el.elementId);

    env.respondWith(
      serverAction({ action: "type_secret", element_id: ids[0], value_ref: "[PASSWORD_01]" }),
      serverAction({ action: "done" })
    );

    const res = await runTask("secret history test");
    assert.equal(res.ok, true);
    assert.equal(env.fetchCalls.length, 2);

    const secondReqBody = JSON.parse(env.fetchCalls[1].body);
    const historyItem = secondReqBody.history[0];

    assert.ok(historyItem);
    assert.equal(historyItem.action, "type_secret");
    assert.equal(historyItem.outcome, "success");
    // Ensure raw secret text is absent
    const historyStr = JSON.stringify(secondReqBody.history);
    assert.ok(!historyStr.includes("super-secret-password-123"), "Secret value must not appear in history");
    assert.ok(!historyStr.includes("value_ref"), "value_ref key must not appear in StepRecord");
  } finally {
    env.restore();
  }
});





test("10. Existing one-shot behavior (runOneStep) remains unchanged", async () => {
  const btn = new FakeElement("button", {}, "One Shot Button");
  const env = installFakeDom([btn]);

  try {
    const pageState = captureDomState("task-one-shot");

    const context: SanitizedContext = {
      taskId: "task-one-shot",
      task: "single step",
      page: "Fake Page",
      urlOrigin: "http://localhost:8000",
      elements: pageState.elements.map((el) => ({ elementId: el.elementId, role: el.role, label: el.label })),
      fields: {},
    };

    env.respondWith(serverAction({ action: "scroll", direction: "down", amount: 200 }));

    const result = await runOneStep(context);

    assert.ok(result);
    assert.equal(result.status, "success");
    assert.equal(env.fetchCalls.length, 1);
    assert.equal(env.scrollCalls.length, 1);
  } finally {
    env.restore();
  }
});
