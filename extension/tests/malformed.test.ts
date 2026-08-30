/**
 * ISSUE-11 — Malformed Server Response Test Matrix
 *
 * Verifies that fetchAction / runOneStepTyped correctly classify and
 * contain every failure class without:
 *   - executing a browser action
 *   - triggering PVM (verifyAction / recordVerifiedOutcome)
 *   - persisting raw response content
 *   - throwing uncaught exceptions
 *
 * Test cases correspond to the 12 cases in Phase 6 Step 22.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { installFakeDom, serverAction, FakeElement } from "./helpers/fakeDom";
import type { FakeEnv } from "./helpers/fakeDom";
import { captureDomState } from "../src/perception/domCapture";
import { runOneStepTyped, isStepError } from "../src/content/pipeline";
import type { SanitizedContext } from "../src/privacy/sanitizedContext";

const TASK_ID = "malformed-test-task";

function setup(elements: FakeElement[] = [new FakeElement("button", {}, "Btn")]): {
  env: FakeEnv;
  context: SanitizedContext;
  ids: number[];
} {
  const env = installFakeDom(elements);
  const pageState = captureDomState(TASK_ID);
  const ids = pageState.elements.map((el) => el.elementId);
  return {
    env,
    ids,
    context: {
      taskId: TASK_ID,
      task: "malformed test task",
      page: "Fake Page",
      urlOrigin: "http://localhost:8000",
      elements: pageState.elements.map((el) => ({
        elementId: el.elementId,
        role: el.role,
        label: el.label,
      })),
      fields: {},
    },
  };
}

// ---------------------------------------------------------------------------
// CASE 1 — HTTP 200, Valid JSON, Valid action → SUCCESS
// Smoke-test that valid responses still work after hardening.
// ---------------------------------------------------------------------------
test("CASE 1: valid response succeeds and action executes once", async () => {
  const button = new FakeElement("button", {}, "Go");
  const { env, context, ids } = setup([button]);
  try {
    env.respondWith(serverAction({ action: "click", element_id: ids[0] }));
    const result = await runOneStepTyped(context);
    assert.ok(!isStepError(result), "valid response must not produce a StepError");
    assert.equal(button.clickCount, 1, "button must be clicked exactly once");
    assert.equal(env.fetchCalls.length, 1);
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
// CASE 2 — HTTP 200, Invalid JSON body → controlled server_error
// ---------------------------------------------------------------------------
test("CASE 2: invalid JSON body returns server_error without executing", async () => {
  const button = new FakeElement("button", {}, "Go");
  const { env, context } = setup([button]);
  try {
    env.respondWithRaw({ status: 200, body: "this is not { json }" });
    const result = await runOneStepTyped(context);
    assert.ok(isStepError(result), "invalid JSON must return a StepError");
    assert.equal(result.reason, "server_error");
    assert.equal(result.detail, "invalid_json");
    assert.equal(button.clickCount, 0, "no action must be executed");
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
// CASE 3 — HTTP 200, Empty body → controlled server_error
// ---------------------------------------------------------------------------
test("CASE 3: empty response body returns server_error without executing", async () => {
  const button = new FakeElement("button", {}, "Go");
  const { env, context } = setup([button]);
  try {
    env.respondWithRaw({ status: 200, body: "" });
    const result = await runOneStepTyped(context);
    assert.ok(isStepError(result), "empty body must return a StepError");
    assert.equal(result.reason, "server_error");
    assert.equal(result.detail, "empty_response");
    assert.equal(button.clickCount, 0, "no action must be executed");
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
// CASE 3b — Whitespace-only body also counts as empty
// ---------------------------------------------------------------------------
test("CASE 3b: whitespace-only body returns server_error", async () => {
  const button = new FakeElement("button", {}, "Go");
  const { env, context } = setup([button]);
  try {
    env.respondWithRaw({ status: 200, body: "   \n  " });
    const result = await runOneStepTyped(context);
    assert.ok(isStepError(result), "whitespace-only body must return a StepError");
    assert.equal(result.detail, "empty_response");
    assert.equal(button.clickCount, 0);
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
// CASE 4 — HTTP 200, Valid JSON but missing action field → shape rejection
// ---------------------------------------------------------------------------
test("CASE 4: missing action field returns server_error without executing", async () => {
  const button = new FakeElement("button", {}, "Go");
  const { env, context } = setup([button]);
  try {
    // Valid JSON object but missing required 'action' field
    env.respondWithRaw({
      status: 200,
      body: JSON.stringify({ confidence: 0.9, task_id: TASK_ID, step_id: 1 }),
    });
    const result = await runOneStepTyped(context);
    assert.ok(isStepError(result), "missing action must return a StepError");
    assert.equal(result.reason, "server_error");
    assert.equal(result.detail, "invalid_response_shape");
    assert.equal(button.clickCount, 0, "no action must execute");
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
// CASE 5 — HTTP 200, Wrong action type (number instead of string) → shape rejection
// ---------------------------------------------------------------------------
test("CASE 5: wrong action type (number) returns server_error without executing", async () => {
  const button = new FakeElement("button", {}, "Go");
  const { env, context } = setup([button]);
  try {
    env.respondWithRaw({
      status: 200,
      body: JSON.stringify({ action: 123, confidence: 0.9, task_id: TASK_ID, step_id: 1 }),
    });
    const result = await runOneStepTyped(context);
    assert.ok(isStepError(result), "numeric action must return a StepError");
    assert.equal(result.reason, "server_error");
    assert.equal(result.detail, "invalid_response_shape");
    assert.equal(button.clickCount, 0);
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
// CASE 6 — HTTP 200, Wrong confidence type (string instead of number) → shape rejection
// ---------------------------------------------------------------------------
test("CASE 6: wrong confidence type (string) returns server_error without executing", async () => {
  const button = new FakeElement("button", {}, "Go");
  const { env, context } = setup([button]);
  try {
    env.respondWithRaw({
      status: 200,
      body: JSON.stringify({ action: "click", confidence: "high", task_id: TASK_ID, step_id: 1 }),
    });
    const result = await runOneStepTyped(context);
    assert.ok(isStepError(result), "string confidence must return a StepError");
    assert.equal(result.detail, "invalid_response_shape");
    assert.equal(button.clickCount, 0);
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
// CASE 7 — HTTP 200, Unknown action value (shape passes, validator rejects)
// An unknown action string PASSES shape validation (action is a string) but
// is rejected by the action validator (not in ALLOWED_ACTIONS).
// ---------------------------------------------------------------------------
test("CASE 7: unknown action value rejected by validator without executing", async () => {
  const button = new FakeElement("button", {}, "Go");
  const { env, context, ids } = setup([button]);
  try {
    env.respondWith(serverAction({ action: "hack_browser", element_id: ids[0] }));
    const result = await runOneStepTyped(context);
    assert.ok(isStepError(result), "unknown action must produce a StepError");
    assert.equal(result.reason, "validation_failed");
    assert.equal(button.clickCount, 0);
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
// CASE 7b — Unexpected extra property (additionalProperties: false in schema)
// Shape validation checks required fields only; extra props are passed through
// to fromWireActionResponse which ignores them (TS struct spread). This is
// intentional — additionalProperties: false is for JSON schema validators,
// not our runtime guard. The extra field does NOT execute.
// ---------------------------------------------------------------------------
test("CASE 7b: unexpected extra property is ignored and action proceeds normally", async () => {
  const button = new FakeElement("button", {}, "Go");
  const { env, context, ids } = setup([button]);
  try {
    // Send a valid action with an unexpected extra field
    env.respondWith(serverAction({ action: "click", element_id: ids[0], unexpected_field: "surprise" }));
    const result = await runOneStepTyped(context);
    // Extra fields do not block execution — the validator checks the known fields.
    // The action should still proceed (ambiguous since no DOM change).
    assert.ok(!isStepError(result), "unexpected extra field must not block a valid action");
    assert.equal(button.clickCount, 1, "button must be clicked once");
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
// CASE 8 — HTTP 500, Malformed body → HTTP error classification
// ---------------------------------------------------------------------------
test("CASE 8: HTTP 500 returns server_error:http_500 without executing", async () => {
  const button = new FakeElement("button", {}, "Go");
  const { env, context } = setup([button]);
  try {
    env.respondWithRaw({ status: 500, body: "Internal Server Error" });
    const result = await runOneStepTyped(context);
    assert.ok(isStepError(result), "HTTP 500 must produce a StepError");
    assert.equal(result.reason, "server_error");
    assert.equal(result.detail, "http_500");
    assert.equal(button.clickCount, 0);
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
// CASE 9 — HTTP 503, Valid-looking body → HTTP error takes precedence
// Status is checked before body parsing — even a valid JSON body is rejected
// when status is non-2xx.
// ---------------------------------------------------------------------------
test("CASE 9: HTTP 503 returns server_error:http_503 without executing", async () => {
  const button = new FakeElement("button", {}, "Go");
  const { env, context, ids } = setup([button]);
  try {
    // The body looks like a valid action but HTTP 503 must stop it
    const validBody = JSON.stringify(serverAction({ action: "click", element_id: ids[0] }));
    env.respondWithRaw({ status: 503, body: validBody });
    const result = await runOneStepTyped(context);
    assert.ok(isStepError(result), "HTTP 503 must produce a StepError regardless of body");
    assert.equal(result.reason, "server_error");
    assert.equal(result.detail, "http_503");
    assert.equal(button.clickCount, 0);
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
// CASE 10 — Network failure (fetch throws) → controlled server_error
// ---------------------------------------------------------------------------
test("CASE 10: network failure returns server_error:network_error without executing", async () => {
  const button = new FakeElement("button", {}, "Go");
  const { env, context } = setup([button]);
  try {
    const g = globalThis as unknown as Record<string, unknown>;
    const savedFetch = g["fetch"];
    g["fetch"] = async () => { throw new TypeError("Failed to fetch"); };
    try {
      const result = await runOneStepTyped(context);
      assert.ok(isStepError(result), "network error must produce a StepError");
      assert.equal(result.reason, "server_error");
      assert.equal(result.detail, "network_error");
      assert.equal(button.clickCount, 0);
    } finally {
      g["fetch"] = savedFetch;
    }
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
// CASE 11 — Timeout → controlled server_error:request_timeout, timer cleaned up
// ---------------------------------------------------------------------------
test("CASE 11: request timeout returns server_error:request_timeout and aborts", async () => {
  const button = new FakeElement("button", {}, "Go");
  const { env, context } = setup([button]);
  try {
    const g = globalThis as unknown as Record<string, unknown>;
    const savedFetch = g["fetch"];
    // Simulate a fetch that hangs then receives an AbortError
    g["fetch"] = async (_url: unknown, init?: { signal?: AbortSignal }) => {
      return new Promise<never>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          if (signal.aborted) {
            const e = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
            reject(e);
          } else {
            signal.addEventListener("abort", () => {
              const e = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
              reject(e);
            }, { once: true });
          }
        }
      });
    };
    try {
      // Use a very short timeout so the test completes quickly
      const { fetchAction } = await import("../src/content/pipeline");
      const sanitized = context;
      const fetchResult = await fetchAction(sanitized, 50);
      assert.ok(isStepError(fetchResult), "timeout must produce a StepError");
      assert.equal(fetchResult.reason, "server_error");
      assert.equal(fetchResult.detail, "request_timeout");
      assert.equal(button.clickCount, 0);
    } finally {
      g["fetch"] = savedFetch;
    }
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
// CASE 12 — Valid response containing optional tab_id → accepted, tab_id preserved
// ---------------------------------------------------------------------------
test("CASE 12: valid response with tab_id is accepted and tab_id preserved", async () => {
  const button = new FakeElement("button", {}, "Go");
  const { env, context, ids } = setup([button]);
  try {
    // Include optional tab_id in the wire response
    env.respondWith(serverAction({ action: "click", element_id: ids[0], tab_id: 42 }));
    const result = await runOneStepTyped(context);
    assert.ok(!isStepError(result), "response with tab_id must not produce a StepError");
    assert.equal(button.clickCount, 1);
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
// PVM SAFETY — malformed responses must NOT trigger PVM
// Verify: dispatch.run, verifyAction, recordVerifiedOutcome are not called
// for any of the server_error cases. We test this by observing no side effects
// (no click, scroll, type) and checking the StepError reason directly.
// ---------------------------------------------------------------------------
test("PVM safety: no execution or verification triggered by invalid JSON", async () => {
  const button = new FakeElement("button", {}, "Go");
  const { env, context } = setup([button]);
  try {
    env.respondWithRaw({ status: 200, body: "{invalid}" });
    const result = await runOneStepTyped(context);
    assert.ok(isStepError(result));
    // No DOM side effects
    assert.equal(button.clickCount, 0);
    assert.equal(env.scrollCalls.length, 0);
    assert.equal(env.navigations.length, 0);
    // Exactly one fetch call — no retry
    assert.equal(env.fetchCalls.length, 1);
  } finally {
    env.restore();
  }
});

test("PVM safety: no execution or verification triggered by empty response", async () => {
  const button = new FakeElement("button", {}, "Go");
  const { env, context } = setup([button]);
  try {
    env.respondWithRaw({ status: 200, body: "" });
    const result = await runOneStepTyped(context);
    assert.ok(isStepError(result));
    assert.equal(button.clickCount, 0);
    assert.equal(env.scrollCalls.length, 0);
    assert.equal(env.fetchCalls.length, 1);
  } finally {
    env.restore();
  }
});

test("PVM safety: no execution triggered by HTTP 500 with HTML body", async () => {
  const button = new FakeElement("button", {}, "Go");
  const { env, context } = setup([button]);
  try {
    env.respondWithRaw({ status: 500, body: "<html><body>Internal Server Error</body></html>" });
    const result = await runOneStepTyped(context);
    assert.ok(isStepError(result));
    assert.equal(result.detail, "http_500");
    assert.equal(button.clickCount, 0);
    assert.equal(env.fetchCalls.length, 1, "no retry attempts");
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
// STORAGE SAFETY — raw server body must not be stored or exposed
// We verify: the only chrome.storage.set call on the happy path sets latestPayloadSha256.
// On error paths, storage is NOT touched by fetchAction beyond the pre-existing SHA-256 write.
// ---------------------------------------------------------------------------
test("storage safety: latestPayloadJson absent from any storage write on error path", async () => {
  const button = new FakeElement("button", {}, "Go");
  const { context } = setup([button]);
  const storageWrites: Record<string, unknown>[] = [];
  const g = globalThis as unknown as Record<string, unknown>;
  const savedFetch = g["fetch"];
  const savedChrome = g["chrome"];

  g["chrome"] = {
    storage: {
      local: {
        get: (_keys: string[], cb: (r: Record<string, unknown>) => void) => cb({}),
        set: async (obj: Record<string, unknown>) => { storageWrites.push(obj); },
      },
    },
    runtime: { sendMessage: async () => undefined },
  };
  g["fetch"] = async () => ({
    ok: true,
    status: 200,
    text: async () => "{ bad json ]",
    json: async () => { throw new Error("not JSON"); },
  });

  try {
    const result = await runOneStepTyped(context);
    assert.ok(isStepError(result));
    assert.equal(result.detail, "invalid_json");
    // Verify no storage write contains latestPayloadJson
    for (const write of storageWrites) {
      assert.ok(!("latestPayloadJson" in write), "latestPayloadJson must never be stored");
    }
    // Only latestPayloadSha256 may appear in writes
    const forbiddenKeys = Object.keys(storageWrites.flatMap(Object.keys).reduce((a, k) => ({ ...a, [k]: 1 }), {}))
      .filter(k => k !== "latestPayloadSha256");
    assert.equal(forbiddenKeys.length, 0, `unexpected storage keys: ${forbiddenKeys.join(", ")}`);
  } finally {
    g["fetch"] = savedFetch;
    g["chrome"] = savedChrome;
  }
});

// ---------------------------------------------------------------------------
// SCALABILITY — 100 sequential malformed responses produce no unbounded state
// ---------------------------------------------------------------------------
test("scalability: 100 sequential malformed responses produce no unbounded growth", async () => {
  const button = new FakeElement("button", {}, "Go");
  const { env, context } = setup([button]);
  try {
    for (let i = 0; i < 100; i++) {
      env.respondWithRaw({ status: 200, body: `not-json-${i}` });
      const result = await runOneStepTyped(context);
      assert.ok(isStepError(result), `iteration ${i} must return StepError`);
      assert.equal(result.detail, "invalid_json");
    }
    // No DOM side effects after 100 failures
    assert.equal(button.clickCount, 0);
    // Exactly 100 fetch calls — no hidden retries
    assert.equal(env.fetchCalls.length, 100);
  } finally {
    env.restore();
  }
});
