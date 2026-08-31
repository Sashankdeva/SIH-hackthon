/**
 * C12 — new-tab navigation handover.
 *
 * A click with target="_blank" opens a NEW tab and leaves the original document
 * untouched. Without a handover the loop keeps driving the OLD tab, PVM sees no
 * change there, and the model re-issues the same click — one new tab per step
 * until the budget is gone ("Task halted after 8 steps without completion").
 *
 * These cover both halves: the background watcher that re-points the task, and
 * the loop-side ownership check that makes the old tab stop driving.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { installFakeDom, serverAction, FakeElement } from "./helpers/fakeDom";
import { runTask, getActiveTask, MAX_STEPS } from "../src/content/index";
import { captureDomState } from "../src/perception/domCapture";
import { handleTaskOpenedNewTab } from "../src/background/index";

const OLD_TAB = 101;
const NEW_TAB = 202;

/** Reads activeTask straight out of the fake chrome.storage.local. */
async function stored(): Promise<Record<string, unknown> | null> {
  const g = globalThis as unknown as {
    chrome: { storage: { local: { get: (k: string[], cb: (r: Record<string, unknown>) => void) => void } } };
  };
  return new Promise((res) =>
    g.chrome.storage.local.get(["activeTask"], (r) => res((r?.activeTask as Record<string, unknown>) ?? null))
  );
}

// ---------------------------------------------------------------------------
// Background watcher — who may hand a task over, and to whom
// ---------------------------------------------------------------------------

test("1. new tab opened BY the task's tab re-points the task at it (same taskId)", async () => {
  const env = installFakeDom([new FakeElement("button", {}, "Btn")]);
  env.setFakeTabId(OLD_TAB);
  try {
    env.respondWith(serverAction({ action: "done" }));
    await runTask("handover", OLD_TAB);
    const before = await stored();
    // put it back into a live state to model "mid-task"
    const g = globalThis as unknown as { chrome: { storage: { local: { set: (i: object, cb?: () => void) => void } } } };
    await new Promise<void>((r) =>
      g.chrome.storage.local.set({ activeTask: { ...before, status: "navigating" } }, r)
    );

    handleTaskOpenedNewTab(OLD_TAB, NEW_TAB);
    await new Promise((r) => setTimeout(r, 20));

    const after = await stored();
    assert.equal(after?.tabId, NEW_TAB, "task now points at the new tab");
    assert.equal(after?.taskId, before?.taskId, "same taskId — no second task");
    assert.equal(after?.status, "navigating");
    assert.deepEqual(after?.history, before?.history, "history not duplicated");
  } finally {
    env.restore();
  }
});

test("2. a tab opened by an UNRELATED tab never steals the task", async () => {
  const env = installFakeDom([new FakeElement("button", {}, "Btn")]);
  env.setFakeTabId(OLD_TAB);
  try {
    env.respondWith(serverAction({ action: "done" }));
    await runTask("unrelated", OLD_TAB);
    const g = globalThis as unknown as { chrome: { storage: { local: { set: (i: object, cb?: () => void) => void } } } };
    const before = await stored();
    await new Promise<void>((r) => g.chrome.storage.local.set({ activeTask: { ...before, status: "active" } }, r));

    handleTaskOpenedNewTab(999, 777); // opener is not the task's tab
    await new Promise((r) => setTimeout(r, 20));

    assert.equal((await stored())?.tabId, OLD_TAB, "unchanged");
  } finally {
    env.restore();
  }
});

test("3. a terminal task is never revived by a new tab", async () => {
  const env = installFakeDom([new FakeElement("button", {}, "Btn")]);
  env.setFakeTabId(OLD_TAB);
  try {
    env.respondWith(serverAction({ action: "done" }));
    await runTask("terminal", OLD_TAB);
    assert.equal((await getActiveTask())?.status, "completed");

    handleTaskOpenedNewTab(OLD_TAB, NEW_TAB);
    await new Promise((r) => setTimeout(r, 20));

    const after = await stored();
    assert.equal(after?.status, "completed", "still completed");
    assert.equal(after?.tabId, OLD_TAB, "terminal task not re-pointed");
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
// Loop side — the old tab must stop driving
// ---------------------------------------------------------------------------

test("4. old tab stops after its action opens a new tab — exactly one click, no tab spam", async () => {
  const link = new FakeElement("a", { href: "/p" }, "Product");
  const env = installFakeDom([link]);
  env.setFakeTabId(OLD_TAB);
  try {
    // Every step asks for the same click. The first click "opens a new tab":
    // the background watcher re-points the task while the step is in flight.
    const ids = captureDomState("init").elements.map((e) => e.elementId);
    env.respondWith((_body, i) => {
      // The watcher fires during this step, as it would when the click opens a
      // tab. Called synchronously so it cannot leak into a later test.
      if (i === 0) handleTaskOpenedNewTab(OLD_TAB, NEW_TAB);
      return serverAction({ action: "click", element_id: ids[0] });
    });

    const res = await runTask("open product", OLD_TAB);

    assert.equal(res.ok, false);
    assert.match(res.detail, /continued in a new tab/i);
    assert.equal(env.fetchCalls.length, 1, "old tab issued exactly ONE action, not MAX_STEPS");
    assert.ok(env.fetchCalls.length < MAX_STEPS);

    const at = await getActiveTask();
    assert.equal(at?.tabId, NEW_TAB, "task points at the new tab");
    assert.notEqual(at?.status, "completed", "handover is not completion");
    assert.notEqual(at?.status, "failed", "handover is not a failure");
    assert.equal(at?.failure, undefined, "no failure recorded for a handover");
    assert.equal(at?.history?.length, 1, "the one executed step is recorded once");
  } finally {
    env.restore();
  }
});

test("5. same-tab navigation is completely unaffected (no handover, task completes)", async () => {
  const env = installFakeDom([new FakeElement("button", {}, "Go")]);
  env.setFakeTabId(OLD_TAB);
  try {
    env.respondWith(
      serverAction({ action: "scroll", direction: "down", amount: 100 }),
      serverAction({ action: "done" })
    );
    const res = await runTask("same tab", OLD_TAB);

    assert.equal(res.ok, true, "ordinary same-tab flow still completes");
    const at = await getActiveTask();
    assert.equal(at?.status, "completed");
    assert.equal(at?.tabId, OLD_TAB, "tab identity unchanged");
  } finally {
    env.restore();
  }
});

test("6. handover leaves a resumable state — non-terminal, same taskId, step preserved", async () => {
  const env = installFakeDom([new FakeElement("a", { href: "/p" }, "Product")]);
  env.setFakeTabId(OLD_TAB);
  try {
    const ids = captureDomState("init").elements.map((e) => e.elementId);
    env.respondWith((_body, i) => {
      if (i === 0) handleTaskOpenedNewTab(OLD_TAB, NEW_TAB);
      return serverAction({ action: "click", element_id: ids[0] });
    });
    const before = await getActiveTask();
    await runTask("resumable", OLD_TAB);

    const at = await getActiveTask();
    assert.ok(at, "activeTask still present for the new tab to pick up");
    assert.ok(["active", "navigating"].includes(at!.status), "non-terminal so the new tab can resume");
    assert.equal(at!.stepNumber, 2, "step advanced exactly once");
    assert.notEqual(at!.taskId, before?.taskId ?? null);
  } finally {
    env.restore();
  }
});

test("7. a second handover cannot fork the task into multiple tabs", async () => {
  const env = installFakeDom([new FakeElement("a", { href: "/p" }, "Product")]);
  env.setFakeTabId(OLD_TAB);
  try {
    const ids = captureDomState("init").elements.map((e) => e.elementId);
    env.respondWith((_body, i) => {
      if (i === 0) handleTaskOpenedNewTab(OLD_TAB, NEW_TAB);
      return serverAction({ action: "click", element_id: ids[0] });
    });
    await runTask("no fork", OLD_TAB);

    // The old tab is no longer the owner, so it can never hand over again.
    handleTaskOpenedNewTab(OLD_TAB, 303);
    await new Promise((r) => setTimeout(r, 20));

    const at = await getActiveTask();
    assert.equal(at?.tabId, NEW_TAB, "still exactly one task tab");
  } finally {
    env.restore();
  }
});
