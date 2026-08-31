/**
 * C10 — task-loop no-progress guard.
 *
 * A model that keeps requesting the SAME action against an UNCHANGED page is
 * stuck on a non-terminal step; the loop must stop safely with a typed
 * `no_progress` failure instead of grinding to MAX_STEPS. A step that changes
 * either the page state or the action resets the streak, so legitimate repeated
 * navigation is unaffected. Nothing here converts ambiguous/failure into success
 * or marks a task complete without the existing `done` condition.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { installFakeDom, serverAction, FakeElement } from "./helpers/fakeDom";
import { runTask, getActiveTask, NO_PROGRESS_LIMIT, MAX_STEPS } from "../src/content/index";

test("1. distinct actions each step → loop continues to done", async () => {
  const env = installFakeDom([new FakeElement("button", {}, "Btn")]);
  try {
    env.respondWith(
      serverAction({ action: "scroll", direction: "down", amount: 100 }),
      serverAction({ action: "scroll", direction: "down", amount: 250 }),
      serverAction({ action: "scroll", direction: "up", amount: 80 }),
      serverAction({ action: "done" })
    );
    const res = await runTask("distinct steps");
    assert.equal(res.ok, true);
    assert.equal(env.fetchCalls.length, 4);
    assert.equal((await getActiveTask())?.status, "completed");
  } finally {
    env.restore();
  }
});

test("2. same action on an unchanged page → typed no_progress failure, not MAX_STEPS", async () => {
  const env = installFakeDom([new FakeElement("button", {}, "Btn")]);
  try {
    env.respondWith(serverAction({ action: "scroll", direction: "down", amount: 100 })); // identical every call
    const res = await runTask("stuck repeat");

    assert.equal(res.ok, false);
    assert.match(res.detail, /made no progress/i);
    assert.equal(
      env.fetchCalls.length,
      NO_PROGRESS_LIMIT,
      "halts on the Nth identical step, well before MAX_STEPS"
    );
    assert.ok(NO_PROGRESS_LIMIT < MAX_STEPS);

    const active = await getActiveTask();
    assert.equal(active?.status, "failed");
    assert.notEqual(active?.status, "completed");
    assert.equal(active?.failure?.stage, "task_loop");
    assert.equal(active?.failure?.reason, "no_progress");
  } finally {
    env.restore();
  }
});

test("3. repeated action is allowed while the page state keeps changing", async () => {
  const env = installFakeDom([new FakeElement("button", {}, "Btn")]);
  try {
    env.respondWith((_body, i) => {
      if (i < 4) {
        env.elements.push(new FakeElement("button", {}, `Added ${i}`)); // state changes every step
        return serverAction({ action: "scroll", direction: "down", amount: 100 }); // SAME action
      }
      return serverAction({ action: "done" });
    });
    const res = await runTask("changing page, same action");
    assert.equal(res.ok, true, "identical action is fine because the page state advanced each step");
    assert.equal((await getActiveTask())?.status, "completed");
  } finally {
    env.restore();
  }
});

test("4. done → immediate terminal completion", async () => {
  const env = installFakeDom([new FakeElement("button", {}, "Btn")]);
  try {
    env.respondWith(serverAction({ action: "done" }));
    const res = await runTask("done now");
    assert.equal(res.ok, true);
    assert.equal(env.fetchCalls.length, 1);
    assert.equal((await getActiveTask())?.status, "completed");
  } finally {
    env.restore();
  }
});

test("5. done still wins after a sub-threshold repeat streak; completed is not overwritten", async () => {
  const env = installFakeDom([new FakeElement("button", {}, "Btn")]);
  try {
    // Two identical steps (streak below the limit), then done.
    env.respondWith(
      serverAction({ action: "scroll", direction: "down", amount: 100 }),
      serverAction({ action: "scroll", direction: "down", amount: 100 }),
      serverAction({ action: "done" })
    );
    const res = await runTask("near-miss then done");
    assert.equal(res.ok, true);

    const active = await getActiveTask();
    assert.equal(active?.status, "completed");
    assert.equal(active?.failure, undefined, "no no_progress failure was recorded");
  } finally {
    env.restore();
  }
});

test("6. genuine progress but never done → still halts at MAX_STEPS, not early", async () => {
  const env = installFakeDom([new FakeElement("button", {}, "Btn")]);
  try {
    env.respondWith((_body, i) => {
      env.elements.push(new FakeElement("button", {}, `X${i}`));
      return serverAction({ action: "scroll", direction: "down", amount: 100 + i });
    });
    const res = await runTask("progress, no done");
    assert.equal(res.ok, false);
    assert.match(res.detail, new RegExp(`halted after ${MAX_STEPS} steps`));
    assert.equal(env.fetchCalls.length, MAX_STEPS);
  } finally {
    env.restore();
  }
});

test("7. a repeated ambiguous step ends as no_progress failure — never success", async () => {
  const env = installFakeDom([new FakeElement("button", {}, "Btn")]);
  try {
    env.respondWith(serverAction({ action: "scroll", direction: "down", amount: 100 }));
    const res = await runTask("ambiguous repeat");

    assert.equal(res.ok, false);
    const active = await getActiveTask();
    assert.equal(active?.status, "failed");
    assert.notEqual(active?.status, "completed");
    for (const h of active?.history ?? []) {
      assert.ok(["success", "failure", "ambiguous"].includes(h.outcome));
    }
  } finally {
    env.restore();
  }
});
