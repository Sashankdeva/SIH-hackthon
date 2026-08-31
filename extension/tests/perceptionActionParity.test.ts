/**
 * Phase 3 — perception/action parity, exercised through the LIVE pipeline
 * (runOneStepTyped) with the fake DOM harness.
 *
 * Focus: the pre-execution target-resolution step wired into pipeline.ts —
 * stale ids are recovered, vanished / ambiguous targets fail safe as typed
 * validation failures, and PVM is never coerced into a false success.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { installFakeDom, serverAction, FakeElement, FakeInputElement } from "./helpers/fakeDom";
import { runOneStepTyped, isStepError } from "../src/content/pipeline";
import { captureDomState } from "../src/perception/domCapture";
import type { SanitizedContext } from "../src/privacy/sanitizedContext";

function ctx(elements: Array<{ elementId: number; role: string; label: string | null }>): SanitizedContext {
  return {
    taskId: "parity-task",
    task: "do the thing",
    page: "Fake Page",
    urlOrigin: "http://localhost:8000",
    elements,
    fields: {},
  };
}

test("stale id recovered: node replaced by an equivalent one before execution", async () => {
  const original = new FakeElement("button", {}, "Confirm");
  const env = installFakeDom([original]);
  try {
    const [{ elementId, role, label }] = captureDomState("parity-task").elements;

    // SPA re-render between capture and execution: same role + label, new node.
    const replacement = new FakeElement("button", {}, "Confirm");
    env.elements.splice(0, env.elements.length, replacement);

    env.respondWith(serverAction({ action: "click", element_id: elementId }));
    const result = await runOneStepTyped(ctx([{ elementId, role, label }]));

    assert.ok(!isStepError(result), "recovered target must not be a StepError");
    assert.equal(replacement.clickCount, 1, "the equivalent replacement node was clicked");
    assert.equal(original.clickCount, 0);
  } finally {
    env.restore();
  }
});

test("vanished target fails safe as a typed validation failure (no execution)", async () => {
  const btn = new FakeElement("button", {}, "Remove");
  const env = installFakeDom([btn]);
  try {
    const [{ elementId, role, label }] = captureDomState("parity-task").elements;
    env.elements.splice(0, env.elements.length); // target disappears entirely

    env.respondWith(serverAction({ action: "click", element_id: elementId }));
    const result = await runOneStepTyped(ctx([{ elementId, role, label }]));

    assert.ok(isStepError(result), "vanished target must halt");
    assert.equal(result.reason, "validation_failed");
    assert.equal(result.detail, "target_lost");
  } finally {
    env.restore();
  }
});

test("ambiguous target (two equivalents) fails safe — never guesses", async () => {
  const btn = new FakeElement("button", {}, "Add to cart");
  const env = installFakeDom([btn]);
  try {
    const [{ elementId, role, label }] = captureDomState("parity-task").elements;
    env.elements.splice(
      0, env.elements.length,
      new FakeElement("button", {}, "Add to cart"),
      new FakeElement("button", {}, "Add to cart"),
    );

    env.respondWith(serverAction({ action: "click", element_id: elementId }));
    const result = await runOneStepTyped(ctx([{ elementId, role, label }]));

    assert.ok(isStepError(result));
    assert.equal(result.reason, "validation_failed");
    assert.equal(result.detail, "target_ambiguous");
  } finally {
    env.restore();
  }
});

test("relabelled-but-same node still executes (identity beats label drift)", async () => {
  const btn = new FakeElement("button", {}, "Add to cart");
  const env = installFakeDom([btn]);
  try {
    const [{ elementId, role, label }] = captureDomState("parity-task").elements;
    btn.textContent = "Added"; // same node, new label

    env.respondWith(serverAction({ action: "click", element_id: elementId }));
    const result = await runOneStepTyped(ctx([{ elementId, role, label }]));

    assert.ok(!isStepError(result));
    assert.equal(btn.clickCount, 1);
  } finally {
    env.restore();
  }
});

test("type into a native <select> chooses the option and PVM verifies it locally", async () => {
  const select = new FakeElement("select", {}, "Size");
  // minimal option surface the executor + verifier read
  const options = [
    { value: "s", textContent: "Small", selected: false, getAttribute: (k: string) => (k === "value" ? "s" : null) },
    { value: "m", textContent: "Medium", selected: false, getAttribute: (k: string) => (k === "value" ? "m" : null) },
  ];
  (select as unknown as { options: unknown[] }).options = options;
  (select as unknown as { selectedOptions: unknown[] }).selectedOptions = [];
  Object.defineProperty(select, "value", {
    get() { return (this as { _v?: string })._v ?? "s"; },
    set(v: string) {
      (this as { _v?: string })._v = v;
      const chosen = options.find((o) => o.value === v);
      (select as unknown as { selectedOptions: unknown[] }).selectedOptions = chosen ? [chosen] : [];
    },
    configurable: true,
  });

  const env = installFakeDom([select as unknown as FakeElement]);
  try {
    const captured = captureDomState("parity-task").elements[0];
    assert.equal(captured.role, "combobox");

    env.respondWith(serverAction({ action: "type", element_id: captured.elementId, value: "Medium" }));
    const result = await runOneStepTyped(
      ctx([{ elementId: captured.elementId, role: captured.role, label: captured.label }])
    );

    assert.ok(result !== null && !isStepError(result), "select type must not be a StepError");
    assert.equal(result.status, "success");
    assert.equal(result.observed, "option_selected");
    assert.equal((select as unknown as { value: string }).value, "m");
  } finally {
    env.restore();
  }
});

test("type into a plain <input> is unchanged by the select path", async () => {
  const input = new FakeInputElement("text", { "aria-label": "Query" });
  const env = installFakeDom([input]);
  try {
    const captured = captureDomState("parity-task").elements[0];
    assert.equal(captured.role, "textbox");

    env.respondWith(serverAction({ action: "type", element_id: captured.elementId, value: "hello world" }));
    const result = await runOneStepTyped(
      ctx([{ elementId: captured.elementId, role: captured.role, label: captured.label }])
    );

    assert.ok(result !== null && !isStepError(result));
    assert.equal(result.status, "success");
    assert.equal(input.value, "hello world");
  } finally {
    env.restore();
  }
});
