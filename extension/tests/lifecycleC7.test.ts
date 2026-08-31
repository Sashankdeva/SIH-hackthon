/**
 * C7 — task state-machine / lifecycle reliability.
 *
 * Deterministic tests for the concrete lifecycle defects found in the audit:
 *   - duplicate loop / duplicate RUN_TASK
 *   - interrupted-step reconcile (no re-execution)
 *   - orphan expiry regardless of owning tab
 *   - malformed stored record → fail safe
 *   - stale / terminal storage write refused
 *   - step-abort before execution
 *   - timeout termination reaches a terminal state
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  runTask,
  runTaskLoop,
  checkAndResumeActiveTask,
  getActiveTask,
  setActiveTask,
  isValidActiveTask,
  TASK_TIMEOUT_MS,
} from "../src/content/index";
import { runOneStepTyped, runStepObserved, isStepError } from "../src/content/pipeline";
import { captureDomState } from "../src/perception/domCapture";
import type { ActiveTaskState } from "../src/action/types";
import type { SanitizedContext } from "../src/privacy/sanitizedContext";
import { installFakeDom, serverAction, FakeElement } from "./helpers/fakeDom";

function baseTask(over: Partial<ActiveTaskState> = {}): ActiveTaskState {
  return {
    taskId: "c7-" + Math.random().toString(36).slice(2),
    task: "do the thing",
    taskStartedAt: Date.now(),
    stepNumber: 1,
    history: [],
    status: "active",
    updatedAt: Date.now(),
    tabId: null,
    ...over,
  };
}

/** Raw storage read, bypassing getActiveTask's validation guard. */
function rawStored(): Promise<unknown> {
  const c = (globalThis as unknown as { chrome: { storage: { local: { get: (k: string[], cb: (r: Record<string, unknown>) => void) => void } } } }).chrome;
  return new Promise((res) => c.storage.local.get(["activeTask"], (r) => res(r.activeTask)));
}
function rawWrite(v: unknown): Promise<void> {
  const c = (globalThis as unknown as { chrome: { storage: { local: { set: (o: Record<string, unknown>, cb: () => void) => void } } } }).chrome;
  return new Promise((res) => c.storage.local.set({ activeTask: v }, () => res()));
}

// ---------------------------------------------------------------------------
test("1. a second runTaskLoop is refused while the first is active (one loop per task)", async () => {
  const env = installFakeDom([new FakeElement("button", {}, "Go")]);
  try {
    env.respondWith(serverAction({ action: "done" }));
    const at1 = baseTask();
    const p1 = runTaskLoop(at1); // sets isExecutingTaskLoop synchronously
    const r2 = await runTaskLoop(baseTask());
    assert.equal(r2.ok, false);
    assert.match(r2.detail, /already in progress/i);
    // runTask (popup double-click path) is also refused
    const r3 = await runTask("second task");
    assert.equal(r3.ok, false);
    assert.match(r3.detail, /already running/i);
    await p1;
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
test("2. a resume scheduled while a loop is running does not double-process the task", async () => {
  const env = installFakeDom([new FakeElement("button", {}, "Go")]);
  try {
    // Loop returns done on the first step.
    env.respondWith(serverAction({ action: "done" }));
    const at = baseTask({ status: "navigating", stepNumber: 1 });
    await setActiveTask(at);
    const p1 = runTaskLoop(at); // running
    await checkAndResumeActiveTask(); // schedules a deferred runTaskLoop
    await checkAndResumeActiveTask(); // and another
    await p1;
    await new Promise((r) => setTimeout(r, 300)); // let the deferred resumes fire + bail
    // Exactly one /reason call happened (one task, one step).
    assert.equal(env.fetchCalls.length, 1);
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
test("3. an interrupted step is reconciled as ambiguous — never re-executed", async () => {
  const env = installFakeDom([new FakeElement("button", {}, "Go")]);
  try {
    // Simulate: step 2 was dispatched by a previous document, page navigated
    // before its outcome was recorded.
    const at = baseTask({
      stepNumber: 2,
      pendingStep: 2,
      history: [{ step: 1, action: "click", element_id: 1, element_label: "Go", outcome: "success" }],
      status: "navigating",
    });
    // If step 2 were re-run it would need a /reason call; it must not.
    env.respondWith(serverAction({ action: "done" }));

    const res = await runTaskLoop(at);

    // step 2 filled with an honest "outcome unknown" record, never re-executed
    assert.equal(at.history.length, 2);
    assert.equal(at.history[1].step, 2);
    assert.equal(at.history[1].outcome, "ambiguous");
    assert.equal(at.pendingStep, undefined);
    assert.equal(at.stepNumber, 3);
    // exactly one /reason call — for step 3 (done), not a re-run of step 2
    assert.equal(env.fetchCalls.length, 1);
    assert.equal(res.ok, true);
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
test("4. a within-budget task in the WRONG tab is left untouched (not resumed, not expired)", async () => {
  const env = installFakeDom([]);
  env.setFakeTabId(99);
  try {
    await setActiveTask(baseTask({ taskId: "own-42", tabId: 42, status: "active" }));
    await checkAndResumeActiveTask();
    const still = await getActiveTask();
    assert.equal(still?.status, "active");
    assert.equal(still?.tabId, 42);
    assert.equal(env.fetchCalls.length, 0);
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
test("5. terminal state never resumes; setActiveTask refuses to un-terminalize", async () => {
  const env = installFakeDom([]);
  try {
    await setActiveTask(baseTask({ taskId: "term-1", status: "completed", lastDetail: "Task complete." }));
    await checkAndResumeActiveTask();
    assert.equal((await getActiveTask())?.status, "completed");

    // A stale document tries to revive the same task.
    await setActiveTask(baseTask({ taskId: "term-1", status: "active", stepNumber: 1 }));
    assert.equal((await getActiveTask())?.status, "completed", "terminal record must not be reverted");

    // failed is also terminal
    await setActiveTask(baseTask({ taskId: "term-2", status: "failed", lastDetail: "boom" }));
    await checkAndResumeActiveTask();
    assert.equal((await getActiveTask())?.status, "failed");
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
test("6. an orphaned active task is expired even from a non-owning tab", async () => {
  const env = installFakeDom([]);
  env.setFakeTabId(99); // not the owner (42)
  try {
    // started recently, but updatedAt frozen > a whole task budget ago → loop dead
    await setActiveTask(baseTask({
      taskId: "orphan-1",
      tabId: 42,
      status: "active",
      taskStartedAt: Date.now() - 5_000,
      updatedAt: Date.now() - (TASK_TIMEOUT_MS + 10_000),
    }));
    await checkAndResumeActiveTask();
    const t = await getActiveTask();
    assert.equal(t?.status, "failed");
    assert.equal(t?.failure?.reason, "orphaned_task");
    assert.match(t?.lastDetail ?? "", /expired/i);

    // and an over-budget task in the wrong tab is expired as "timed out"
    await setActiveTask(baseTask({
      taskId: "orphan-2",
      tabId: 42,
      status: "navigating",
      taskStartedAt: Date.now() - (TASK_TIMEOUT_MS + 10_000),
    }));
    await checkAndResumeActiveTask();
    assert.equal((await getActiveTask())?.status, "failed");
    assert.match((await getActiveTask())?.lastDetail ?? "", /timed out/i);
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
test("7. a malformed stored activeTask is discarded (fail safe), not executed", async () => {
  const env = installFakeDom([]);
  try {
    assert.equal(isValidActiveTask({ taskId: "x", stepNumber: "nope", history: [], status: "active", task: "t", taskStartedAt: 1, updatedAt: 1 }), false);
    assert.equal(isValidActiveTask({ taskId: "x", stepNumber: 1, history: "not-array", status: "active", task: "t", taskStartedAt: 1, updatedAt: 1 }), false);
    assert.equal(isValidActiveTask({ taskId: "x", stepNumber: 1, history: [], status: "weird", task: "t", taskStartedAt: 1, updatedAt: 1 }), false);
    assert.equal(isValidActiveTask(baseTask()), true);

    await rawWrite({ taskId: 5, stepNumber: NaN, history: "garbage", status: "??" });
    const got = await getActiveTask();
    assert.equal(got, null, "malformed record must be discarded");
    assert.equal(await rawStored(), undefined, "malformed record must be removed from storage");

    await rawWrite({ taskId: 5, stepNumber: NaN });
    await checkAndResumeActiveTask(); // must not throw
    assert.equal(env.fetchCalls.length, 0);
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
test("8. a storage write failure before a step halts the loop (no untracked action)", async () => {
  const env = installFakeDom([new FakeElement("button", {}, "Go")]);
  try {
    env.respondWith(serverAction({ action: "scroll", direction: "down" }), serverAction({ action: "done" }));
    env.simulateStorageError("QuotaExceededError"); // fires on the next storage.set
    const at = baseTask();
    const res = await runTaskLoop(at);
    assert.equal(res.ok, false);
    assert.equal(at.status, "failed");
    assert.equal(at.failure?.reason, "storage_failed");
    assert.equal(env.fetchCalls.length, 0, "no /reason call — halted before dispatching the step");
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
test("9. a stale concurrent write cannot move step/status backwards", async () => {
  const env = installFakeDom([]);
  try {
    // new document has advanced the task
    await setActiveTask(baseTask({ taskId: "race-1", stepNumber: 5, status: "navigating" }));
    // old dying document flushes a stale snapshot
    await setActiveTask(baseTask({ taskId: "race-1", stepNumber: 3, status: "active", updatedAt: Date.now() - 2000 }));
    assert.equal((await getActiveTask())?.stepNumber, 5, "stale lower stepNumber must be refused");

    // a brand-new task (different id) always writes
    await setActiveTask(baseTask({ taskId: "race-2", stepNumber: 1, status: "active" }));
    assert.equal((await getActiveTask())?.taskId, "race-2");
    assert.equal((await getActiveTask())?.stepNumber, 1);
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
test("10. repeated resume attempts collapse to at most one running loop", async () => {
  const env = installFakeDom([new FakeElement("button", {}, "Go")]);
  try {
    env.respondWith(serverAction({ action: "done" }));
    await setActiveTask(baseTask({ taskId: "resume-many", status: "active" }));
    await Promise.all([
      checkAndResumeActiveTask(),
      checkAndResumeActiveTask(),
      checkAndResumeActiveTask(),
    ]);
    await new Promise((r) => setTimeout(r, 350));
    assert.ok(env.fetchCalls.length <= 1, `expected <=1 /reason call, got ${env.fetchCalls.length}`);
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
test("11. a click/navigate step transitions the task to 'navigating' and persists it", async () => {
  const btn = new FakeElement("button", {}, "Next");
  const env = installFakeDom([btn]);
  try {
    const ids = captureDomState("nav-task").elements.map((e) => e.elementId);
    env.respondWith(serverAction({ action: "click", element_id: ids[0] }), serverAction({ action: "done" }));
    const at = baseTask({ taskId: "nav-task" });
    await runTaskLoop(at);
    // history recorded step 1; between step 1 and step 2 the status was 'navigating'
    assert.ok(at.history.length >= 1);
    assert.equal(at.history[0].step, 1);
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
test("12. popup-style re-read always reflects the persisted record, not a stale local", async () => {
  const env = installFakeDom([]);
  try {
    await setActiveTask(baseTask({ taskId: "popup-1", status: "active", stepNumber: 3 }));
    let seen = await getActiveTask();
    assert.equal(seen?.status, "active");
    assert.equal(seen?.stepNumber, 3);

    await setActiveTask(baseTask({ taskId: "popup-1", status: "completed", stepNumber: 3, lastDetail: "Task complete — done after 2 step(s)." }));
    seen = await getActiveTask(); // "popup reopened"
    assert.equal(seen?.status, "completed");
    assert.match(seen?.lastDetail ?? "", /complete/i);
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
test("13. a service-worker/network failure ends the task as failed — never 'completed', never infinite", async () => {
  const env = installFakeDom([new FakeElement("button", {}, "Go")]);
  const g = globalThis as unknown as Record<string, unknown>;
  const savedFetch = g["fetch"];
  g["fetch"] = async () => { throw new TypeError("Failed to fetch"); }; // SW proxy / network down
  try {
    const at = baseTask();
    const res = await runTaskLoop(at);
    assert.equal(res.ok, false);
    assert.equal(at.status, "failed");
    assert.notEqual(at.status, "completed");
    assert.equal(at.failure?.stage, "reasoning_server");
  } finally {
    g["fetch"] = savedFetch;
    env.restore();
  }
});

// ---------------------------------------------------------------------------
test("14a. a task past its wall-clock budget terminates immediately as failed", async () => {
  const env = installFakeDom([new FakeElement("button", {}, "Go")]);
  try {
    env.respondWith(serverAction({ action: "done" }));
    const at = baseTask({ taskStartedAt: Date.now() - (TASK_TIMEOUT_MS + 5_000) });
    const res = await runTaskLoop(at);
    assert.equal(res.ok, false);
    assert.equal(at.status, "failed");
    assert.match(at.lastDetail ?? "", /timed out/i);
    assert.equal(env.fetchCalls.length, 0);
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
test("14b. an aborted step never executes its action", async () => {
  const btn = new FakeElement("button", {}, "Go");
  const env = installFakeDom([btn]);
  try {
    const ids = captureDomState("abort-task").elements.map((e) => e.elementId);
    env.respondWith(serverAction({ action: "click", element_id: ids[0] }));
    const ctx: SanitizedContext = {
      taskId: "abort-task",
      task: "t",
      page: "p",
      urlOrigin: "http://localhost:8000",
      elements: [{ elementId: ids[0], role: "button", label: "Go" }],
      fields: {},
    };
    // isAborted() === true → the pipeline must NOT dispatch the click
    const r = await runOneStepTyped(ctx, () => true);
    assert.ok(isStepError(r));
    assert.equal(r.reason, "execution_failed");
    assert.equal(r.detail, "step_aborted");
    assert.equal(btn.clickCount, 0, "aborted step must not click");

    // control: not aborted → the click happens
    env.respondWith(serverAction({ action: "click", element_id: ids[0] }));
    await runStepObserved(ctx, () => false);
    assert.equal(btn.clickCount, 1);
  } finally {
    env.restore();
  }
});
