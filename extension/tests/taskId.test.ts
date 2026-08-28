/**
 * Foundation tests for per-task taskId and step numbering.
 *
 * These tests prove the multi-step prerequisite properties without
 * implementing multi-step:
 *
 *   1. Two independent tasks on the same page get different taskIds.
 *   2. Steps within one task produce distinguishable actionIds.
 *   3. A second task is NOT blocked by state left over from the first.
 *   4. Existing single-step behavior is preserved end-to-end.
 *
 * The invariants here are checked at the runOneStep boundary because
 * that is where the taskId from SanitizedContext becomes the prefix
 * of the dispatch gate's actionId. The per-task UUID generation lives
 * in content/index.ts (runTask), which cannot be imported in node:test
 * due to Chrome API side effects — so we simulate what runTask does:
 * generate a UUID per call and thread it through SanitizedContext.
 *
 * IMPORTANT: the fake server must echo back the same task_id that the
 * context carries, because the validator enforces
 *   action.taskId === sanitized.taskId
 * This is the exact round-trip check that prevents cross-task hijacking.
 * Tests that use a fresh UUID must pass task_id: taskId to serverAction().
 */

import test from "node:test";
import assert from "node:assert/strict";

import { installFakeDom, serverAction, FakeElement } from "./helpers/fakeDom";
import { captureDomState } from "../src/perception/domCapture";
import { runOneStep } from "../src/content/pipeline";
import { createDispatch } from "../src/action/dispatch";
import type { SanitizedContext } from "../src/privacy/sanitizedContext";
import type { ActionRequest } from "../src/action/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Mirrors what runTask() in content/index.ts does: generates a fresh UUID
 * per call and builds a SanitizedContext that carries it. This is the
 * production pattern — simulated here because index.ts cannot be imported
 * in Node without a Chrome stub.
 */
function makeContext(taskId: string, _elements?: FakeElement[]): { context: SanitizedContext; ids: number[] } {
  const pageState = captureDomState(taskId);
  const ids = pageState.elements.map((el) => el.elementId);
  return {
    ids,
    context: {
      taskId,
      task: "do the thing",
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

/** Returns a UUID exactly as crypto.randomUUID() does in the browser. */
function freshUUID(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// 1. Two tasks on the same page get different taskIds
// ---------------------------------------------------------------------------

test("two tasks on the same page produce different taskIds", () => {
  // No DOM interaction needed — this purely tests UUID generation, which
  // is what runTask() does at the start of each user-submitted task.
  const taskIdA = freshUUID();
  const taskIdB = freshUUID();
  assert.notEqual(taskIdA, taskIdB, "each runTask call must generate a unique UUID");
});

// ---------------------------------------------------------------------------
// 2. Steps within one task have distinguishable actionIds
// ---------------------------------------------------------------------------

test("steps within one task have distinguishable actionIds", async () => {
  const button = new FakeElement("button", {}, "Next");
  const env = installFakeDom([button]);
  try {
    const taskId = freshUUID();
    const { context, ids } = makeContext(taskId, [button]);

    // Step 1 — the fake server echoes the same task_id the context carries.
    env.respondWith(serverAction({ action: "click", element_id: ids[0], step_id: 1, task_id: taskId }));
    const result1 = await runOneStep(context);

    // Step 2 — simulates what a future multi-step loop would do: same task,
    // incremented step_id. The validator accepts this because taskId matches.
    env.respondWith(serverAction({ action: "click", element_id: ids[0], step_id: 2, task_id: taskId }));
    const result2 = await runOneStep(context);

    assert.ok(result1, "step 1 must return a result");
    assert.ok(result2, "step 2 must return a result");

    // actionId format is "${taskId}:${stepId}" — both steps must carry
    // the same task UUID but different step numbers.
    assert.equal(result1.actionId, `${taskId}:1`, "step 1 actionId must be taskId:1");
    assert.equal(result2.actionId, `${taskId}:2`, "step 2 actionId must be taskId:2");
    assert.notEqual(result1.actionId, result2.actionId, "each step must have a unique actionId");

    // Each step reached the page — the dispatch gate is per-runOneStep-call
    // (createDispatch is called fresh inside each runOneStep), so step 2
    // is NOT blocked by step 1's gate.
    assert.equal(button.clickCount, 2, "each step must reach the page exactly once");
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
// 3. A second task is not blocked by state from the first
// ---------------------------------------------------------------------------

test("a second task is not blocked by state from the first", async () => {
  const button = new FakeElement("button", {}, "Place Order");
  const env = installFakeDom([button]);
  try {
    const taskIdA = freshUUID();
    const taskIdB = freshUUID();

    const { context: ctxA, ids: idsA } = makeContext(taskIdA, [button]);
    const { context: ctxB, ids: idsB } = makeContext(taskIdB, [button]);

    // Task A completes. Server echoes task A's taskId.
    env.respondWith(serverAction({ action: "click", element_id: idsA[0], task_id: taskIdA }));
    const resultA = await runOneStep(ctxA);

    // Task B runs with a completely different taskId — must not be gated by
    // task A's dispatch object (which is GC'd — dispatch is local to each call).
    env.respondWith(serverAction({ action: "click", element_id: idsB[0], task_id: taskIdB }));
    const resultB = await runOneStep(ctxB);

    assert.ok(resultA, "task A must complete");
    assert.ok(resultB, "task B must not be blocked by task A's state");

    // Both actionIds must have different taskId prefixes.
    const prefixA = resultA.actionId.split(":")[0];
    const prefixB = resultB.actionId.split(":")[0];
    assert.notEqual(prefixA, prefixB,
      "task A and task B must have different taskId prefixes in their actionIds");

    // Both tasks executed — two independent interactions on the page.
    assert.equal(button.clickCount, 2, "both tasks must execute their action exactly once");
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
// 4. Dispatch gate blocks re-run of the same step within one task
// ---------------------------------------------------------------------------

test("dispatch gate blocks a re-run of the same step within one task", async () => {
  // Frames the double-execution regression in per-task terms: the dispatch
  // gate must refuse a second call even when it carries the same task/step.
  const button = new FakeElement("button", {}, "Submit");
  const env = installFakeDom([button]);
  try {
    const taskId = freshUUID();
    // Populate the element registry so resolveElement can find the button.
    const pageState = captureDomState(taskId);
    const buttonId = pageState.elements[0]?.elementId ?? 1;

    const actionId = `${taskId}:1`;
    const action: ActionRequest = {
      action: "click",
      elementId: buttonId,
      value: null,
      valueRef: null,
      direction: null,
      amount: null,
      url: null,
      confidence: 0.9,
      taskId,
      stepId: 1,
    };

    const dispatch = createDispatch(actionId);
    const first = await dispatch.run(action);
    const second = await dispatch.run(action);

    assert.equal(first, true, "first execution must proceed");
    assert.equal(second, false, "second execution of the same step must be blocked");
    assert.equal(button.clickCount, 1, "the page must receive exactly one interaction");
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
// 5. taskId uniqueness: N sequential calls all differ
// ---------------------------------------------------------------------------

test("N sequential task launches produce N distinct taskIds", () => {
  const N = 20;
  const ids = Array.from({ length: N }, () => freshUUID());
  const unique = new Set(ids);
  assert.equal(unique.size, N, `all ${N} taskIds must be unique`);
});

// ---------------------------------------------------------------------------
// 6. Single-step end-to-end: taskId flows from context through to actionId
// ---------------------------------------------------------------------------

test("taskId in SanitizedContext is the prefix of the returned actionId", async () => {
  const button = new FakeElement("button", {}, "Go");
  const env = installFakeDom([button]);
  try {
    const taskId = freshUUID();
    const { context, ids } = makeContext(taskId, [button]);

    // Server echoes the same task_id with step_id: 3.
    env.respondWith(serverAction({ action: "click", element_id: ids[0], step_id: 3, task_id: taskId }));

    const result = await runOneStep(context);

    assert.ok(result, "runOneStep must return a result");
    assert.ok(
      result.actionId.startsWith(taskId),
      `actionId "${result.actionId}" must start with the task's UUID "${taskId}"`
    );
    assert.equal(result.actionId, `${taskId}:3`, "actionId must be taskId:stepId");
  } finally {
    env.restore();
  }
});
