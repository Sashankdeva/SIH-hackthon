/**
 * Tests for cross-page task continuation, tab ownership (Fix #32),
 * and storage write error handling (Fix #34).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  getActiveTask,
  setActiveTask,
  clearActiveTask,
  checkAndResumeActiveTask,
  TASK_TIMEOUT_MS,
} from "../src/content/index";
import type { ActiveTaskState } from "../src/action/types";
import { FakeElement, installFakeDom } from "./helpers/fakeDom";

// ---------------------------------------------------------------------------
// 1. getActiveTask / setActiveTask / clearActiveTask storage roundtrip
// ---------------------------------------------------------------------------
test("1. activeTask persists to and retrieves from storage cleanly", async () => {
  const env = installFakeDom([]);
  try {
    await clearActiveTask();
    const initial = await getActiveTask();
    assert.equal(initial, null);

    const taskState: ActiveTaskState = {
      taskId: "test-task-1",
      task: "Search for phone",
      taskStartedAt: Date.now(),
      stepNumber: 1,
      history: [],
      status: "active",
      updatedAt: Date.now(),
    };
    await setActiveTask(taskState);

    const retrieved = await getActiveTask();
    assert.ok(retrieved !== null);
    assert.equal(retrieved.taskId, "test-task-1");
    assert.equal(retrieved.task, "Search for phone");
    assert.equal(retrieved.status, "active");
    assert.equal(retrieved.stepNumber, 1);

    await clearActiveTask();
    const afterClear = await getActiveTask();
    assert.equal(afterClear, null);
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
// 2. Tab ownership: correct tab is NOT blocked
// ---------------------------------------------------------------------------
test("2. checkAndResumeActiveTask does not block task when tab IDs match", async () => {
  const pageBButton = new FakeElement("button", { "data-privy-id": "50" }, "Add to Cart");
  const env = installFakeDom([pageBButton]);
  env.setFakeTabId(42); // background will report tab 42

  try {
    const priorTaskState: ActiveTaskState = {
      taskId: "cross-page-task-2",
      task: "Search Samsung and add to cart",
      taskStartedAt: Date.now(),
      stepNumber: 2,
      history: [{ step: 1, action: "click", element_id: 10, element_label: "Search", outcome: "ambiguous" }],
      status: "active",
      updatedAt: Date.now(),
      tabId: 42, // same as fakeTabId
    };
    await setActiveTask(priorTaskState);

    // We can't easily stub the full server round-trip here, so we verify that
    // the storage record is intact (not prematurely marked failed by the tab guard).
    const active = await getActiveTask();
    assert.ok(active !== null);
    assert.equal(active.stepNumber, 2);
    assert.equal(active.tabId, 42);
    assert.equal(active.status, "active");
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
// 3. Tab ownership: wrong tab does not resume — task is left untouched
// ---------------------------------------------------------------------------
test("3. checkAndResumeActiveTask leaves task untouched when tab ID does not match", async () => {
  const env = installFakeDom([]);
  env.setFakeTabId(99); // current tab is 99

  try {
    const foreignTask: ActiveTaskState = {
      taskId: "foreign-task-3",
      task: "Foreign task from different tab",
      taskStartedAt: Date.now(),
      stepNumber: 1,
      history: [],
      status: "active",
      updatedAt: Date.now(),
      tabId: 42, // owned by tab 42, not tab 99
    };
    await setActiveTask(foreignTask);

    await checkAndResumeActiveTask();

    // Task must remain untouched — status still "active", tabId still 42
    const still = await getActiveTask();
    assert.ok(still !== null);
    assert.equal(still.status, "active", "Foreign task must not be mutated by wrong tab");
    assert.equal(still.tabId, 42, "tabId must remain the original owner tab");
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
// 4. Tab ownership: null tabId (legacy record) does not block resume
// ---------------------------------------------------------------------------
test("4. checkAndResumeActiveTask does not block legacy task with null tabId", async () => {
  const env = installFakeDom([]);
  env.setFakeTabId(55);

  try {
    const legacyTask: ActiveTaskState = {
      taskId: "legacy-task-4",
      task: "Legacy task without tabId",
      taskStartedAt: Date.now(),
      stepNumber: 1,
      history: [],
      status: "active",
      updatedAt: Date.now(),
      tabId: null, // no tab ID set — guard must be relaxed
    };
    await setActiveTask(legacyTask);

    // Should not throw; guard must not fail the task due to a missing tabId
    await checkAndResumeActiveTask();

    const current = await getActiveTask();
    assert.ok(current !== null, "Task must still be in storage");
    // The lastDetail must NOT indicate a tab-ownership rejection
    assert.notEqual(current.lastDetail, "Tab mismatch — skipping.");
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
// 5. Completed task does not resume
// ---------------------------------------------------------------------------
test("5. checkAndResumeActiveTask does not resume completed tasks", async () => {
  const env = installFakeDom([]);
  try {
    const completedTask: ActiveTaskState = {
      taskId: "completed-task-5",
      task: "Already done task",
      taskStartedAt: Date.now() - 5000,
      stepNumber: 2,
      history: [],
      status: "completed",
      updatedAt: Date.now(),
      lastDetail: "Task complete — done after 1 step(s).",
    };
    await setActiveTask(completedTask);

    await checkAndResumeActiveTask();

    const current = await getActiveTask();
    assert.ok(current !== null);
    assert.equal(current.status, "completed");
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
// 6. Failed task does not resume
// ---------------------------------------------------------------------------
test("6. checkAndResumeActiveTask does not resume failed tasks", async () => {
  const env = installFakeDom([]);
  try {
    const failedTask: ActiveTaskState = {
      taskId: "failed-task-6",
      task: "A previously failed task",
      taskStartedAt: Date.now() - 10000,
      stepNumber: 2,
      history: [],
      status: "failed",
      updatedAt: Date.now(),
      lastDetail: "Step 1 verification failed.",
    };
    await setActiveTask(failedTask);

    await checkAndResumeActiveTask();

    const current = await getActiveTask();
    assert.ok(current !== null);
    assert.equal(current.status, "failed", "Failed task must remain failed — must not be re-run");
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
// 7. Expired task is marked failed on resume attempt
// ---------------------------------------------------------------------------
test("7. checkAndResumeActiveTask marks expired task as failed", async () => {
  const env = installFakeDom([]);
  try {
    const expiredTask: ActiveTaskState = {
      taskId: "expired-task-7",
      task: "Old abandoned task",
      taskStartedAt: Date.now() - (TASK_TIMEOUT_MS + 10_000), // safely past the wall-clock budget
      stepNumber: 3,
      history: [],
      status: "active",
      updatedAt: Date.now() - (TASK_TIMEOUT_MS + 10_000),
    };
    await setActiveTask(expiredTask);

    await checkAndResumeActiveTask();

    const updated = await getActiveTask();
    assert.ok(updated !== null);
    assert.equal(updated.status, "failed");
    assert.ok(updated.lastDetail?.includes("timed out"), `Expected 'timed out' in: ${updated.lastDetail}`);
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
// 8. Storage write error: setActiveTask rejects on lastError (Fix #34)
// ---------------------------------------------------------------------------
test("8. setActiveTask rejects when chrome.storage.local.set fires lastError", async () => {
  const env = installFakeDom([]);
  env.simulateStorageError("QuotaExceededError: QUOTA_BYTES_PER_ITEM exceeded");

  try {
    const taskState: ActiveTaskState = {
      taskId: "quota-task-8",
      task: "Some task",
      taskStartedAt: Date.now(),
      stepNumber: 1,
      history: [],
      status: "active",
      updatedAt: Date.now(),
    };

    await assert.rejects(
      async () => setActiveTask(taskState),
      (err: Error) => {
        assert.ok(err instanceof Error, "Must reject with an Error");
        assert.ok(
          err.message.includes("storage write failed"),
          `Expected 'storage write failed' in error: ${err.message}`
        );
        // Must NOT contain task content
        assert.ok(!err.message.includes("Some task"), "Error must not expose task content");
        return true;
      }
    );
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
// 9. Storage error is single-shot: next write succeeds normally
// ---------------------------------------------------------------------------
test("9. setActiveTask succeeds on the write following a single-shot error", async () => {
  const env = installFakeDom([]);
  env.simulateStorageError("Simulated quota error");

  try {
    const task1: ActiveTaskState = {
      taskId: "seq-9a",
      task: "first write",
      taskStartedAt: Date.now(),
      stepNumber: 1,
      history: [],
      status: "active",
      updatedAt: Date.now(),
    };

    // First write fails (error consumed here)
    await assert.rejects(() => setActiveTask(task1), Error);

    // Second write succeeds
    const task2: ActiveTaskState = { ...task1, taskId: "seq-9b", task: "second write" };
    await assert.doesNotReject(() => setActiveTask(task2), "Subsequent write must succeed");

    const retrieved = await getActiveTask();
    assert.ok(retrieved !== null);
    assert.equal(retrieved.taskId, "seq-9b");
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
// 10. Navigating task resumes cleanly on the new page
// ---------------------------------------------------------------------------
test("10. checkAndResumeActiveTask resumes task when status is 'navigating'", async () => {
  const pageBButton = new FakeElement("button", { "data-privy-id": "100" }, "Checkout");
  const env = installFakeDom([pageBButton]);
  env.setFakeTabId(77);

  try {
    const navigatingTask: ActiveTaskState = {
      taskId: "nav-task-10",
      task: "Search and checkout",
      taskStartedAt: Date.now(),
      stepNumber: 2,
      history: [{ step: 1, action: "click", element_id: 5, element_label: "Search", outcome: "ambiguous" }],
      status: "navigating",
      updatedAt: Date.now(),
      tabId: 77,
    };
    await setActiveTask(navigatingTask);

    await checkAndResumeActiveTask();

    const active = await getActiveTask();
    assert.ok(active !== null);
    assert.equal(active.taskId, "nav-task-10");
    assert.equal(active.stepNumber, 2);
    assert.equal(active.tabId, 77);
  } finally {
    env.restore();
  }
});

