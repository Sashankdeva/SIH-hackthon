/**
 * Tests for Fix #23 — validator.ts must reject type action with
 * null / empty / whitespace-only value, while accepting valid values
 * and leaving type_secret semantics unchanged.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { validateAction } from "../src/action/validator";
import { FakeInputElement, installFakeDom } from "./helpers/fakeDom";

// ---------------------------------------------------------------------------
// 1. type with null value is rejected
// ---------------------------------------------------------------------------
test("1. type with null value is rejected", () => {
  const input = new FakeInputElement("text", { "data-privy-id": "1" });
  const env = installFakeDom([input]);
  try {
    const result = validateAction(
      { action: "type", elementId: 1, value: null, confidence: 0.9, taskId: "t1", stepId: 1 },
      "t1"
    );
    assert.equal(result.ok, false);
    assert.ok(result.reason?.toLowerCase().includes("non-empty"));
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
// 2. type with empty string is rejected
// ---------------------------------------------------------------------------
test("2. type with empty string is rejected", () => {
  const input = new FakeInputElement("text", { "data-privy-id": "2" });
  const env = installFakeDom([input]);
  try {
    const result = validateAction(
      { action: "type", elementId: 2, value: "", confidence: 0.9, taskId: "t2", stepId: 1 },
      "t2"
    );
    assert.equal(result.ok, false);
    assert.ok(result.reason?.toLowerCase().includes("non-empty"));
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
// 3. type with whitespace-only string is rejected
// ---------------------------------------------------------------------------
test("3. type with whitespace-only value is rejected", () => {
  const input = new FakeInputElement("text", { "data-privy-id": "3" });
  const env = installFakeDom([input]);
  try {
    const result = validateAction(
      { action: "type", elementId: 3, value: "   ", confidence: 0.9, taskId: "t3", stepId: 1 },
      "t3"
    );
    assert.equal(result.ok, false);
    assert.ok(result.reason?.toLowerCase().includes("non-empty"));
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
// 4. type with valid non-empty value is accepted
// ---------------------------------------------------------------------------
test("4. type with valid non-empty value passes validation", () => {
  const input = new FakeInputElement("text", { "data-privy-id": "4" });
  const env = installFakeDom([input]);
  try {
    const result = validateAction(
      { action: "type", elementId: 4, value: "Samsung S24 FE", confidence: 0.9, taskId: "t4", stepId: 1 },
      "t4"
    );
    assert.equal(result.ok, true);
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
// 5. type with single-character value passes validation
// ---------------------------------------------------------------------------
test("5. type with single non-space character passes validation", () => {
  const input = new FakeInputElement("text", { "data-privy-id": "5" });
  const env = installFakeDom([input]);
  try {
    const result = validateAction(
      { action: "type", elementId: 5, value: "a", confidence: 0.9, taskId: "t5", stepId: 1 },
      "t5"
    );
    assert.equal(result.ok, true);
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
// 6. type_secret semantics unchanged: valueRef required, value not checked
// ---------------------------------------------------------------------------
test("6. type_secret still requires valueRef and ignores value field", () => {
  const pwdInput = new FakeInputElement("password", { "data-privy-id": "6" });
  const env = installFakeDom([pwdInput]);
  try {
    // type_secret with no valueRef should still be rejected
    const noRef = validateAction(
      { action: "type_secret", elementId: 6, valueRef: null, confidence: 0.9, taskId: "t6", stepId: 1 },
      "t6"
    );
    assert.equal(noRef.ok, false);
    assert.ok(noRef.reason?.toLowerCase().includes("valueref"));

    // type_secret with valueRef and no value is valid
    const withRef = validateAction(
      { action: "type_secret", elementId: 6, valueRef: "[PASSWORD_01]", confidence: 0.9, taskId: "t6", stepId: 1 },
      "t6"
    );
    assert.equal(withRef.ok, true);
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
// 7. type with value that is just a tab character is rejected
// ---------------------------------------------------------------------------
test("7. type with tab-only value is rejected as whitespace-only", () => {
  const input = new FakeInputElement("text", { "data-privy-id": "7" });
  const env = installFakeDom([input]);
  try {
    const result = validateAction(
      { action: "type", elementId: 7, value: "\t\n ", confidence: 0.9, taskId: "t7", stepId: 1 },
      "t7"
    );
    assert.equal(result.ok, false);
    assert.ok(result.reason?.toLowerCase().includes("non-empty"));
  } finally {
    env.restore();
  }
});
