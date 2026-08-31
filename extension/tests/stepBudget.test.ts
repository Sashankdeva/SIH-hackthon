/**
 * C17 — bounded step budget.
 *
 * Real multi-step tasks (search → results → product → purchase) need more than
 * the original 8 steps, but the budget must stay a hard bound and must not
 * become a way to hide repeated no-progress actions.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { installFakeDom, serverAction, FakeElement } from "./helpers/fakeDom";
import { runTask, getActiveTask, MAX_STEPS, NO_PROGRESS_LIMIT, TASK_TIMEOUT_MS } from "../src/content/index";

test("1. the budget is larger than the old 8 but still bounded", () => {
  assert.ok(MAX_STEPS >= 16, "enough steps for a real multi-step task");
  assert.ok(Number.isFinite(MAX_STEPS) && MAX_STEPS <= 32, "still a hard upper bound");
  assert.ok(NO_PROGRESS_LIMIT < MAX_STEPS, "no-progress halts well before the budget");
  // The wall clock must not make the step budget unreachable.
  assert.ok(TASK_TIMEOUT_MS >= MAX_STEPS * 4000, "wall clock allows the full budget");
});

test("2. a legitimate 12-step task (>8) now completes", async () => {
  const env = installFakeDom([new FakeElement("button", {}, "B")]);
  try {
    env.respondWith((_b, i) => {
      if (i < 11) {
        env.elements.push(new FakeElement("button", {}, `Step ${i}`)); // real progress each step
        return serverAction({ action: "scroll", direction: "down", amount: 100 + i });
      }
      return serverAction({ action: "done" });
    });
    const res = await runTask("twelve step task");
    assert.equal(res.ok, true, "a 12-step task can now finish");
    assert.equal(env.fetchCalls.length, 12);
    assert.equal((await getActiveTask())?.status, "completed");
  } finally {
    env.restore();
  }
});

test("3. no-progress still stops repeated identical actions long before the budget", async () => {
  const env = installFakeDom([new FakeElement("button", {}, "B")]);
  try {
    env.respondWith(serverAction({ action: "scroll", direction: "down", amount: 100 }));
    const res = await runTask("stuck");
    assert.equal(res.ok, false);
    assert.match(res.detail, /made no progress/i);
    assert.equal(env.fetchCalls.length, NO_PROGRESS_LIMIT);
    assert.ok(env.fetchCalls.length < MAX_STEPS, "the bigger budget did not hide the repeat");
    assert.equal((await getActiveTask())?.failure?.reason, "no_progress");
  } finally {
    env.restore();
  }
});

test("4. done still terminates immediately", async () => {
  const env = installFakeDom([new FakeElement("button", {}, "B")]);
  try {
    env.respondWith(serverAction({ action: "done" }));
    const res = await runTask("done");
    assert.equal(res.ok, true);
    assert.equal(env.fetchCalls.length, 1);
    assert.equal((await getActiveTask())?.status, "completed");
  } finally {
    env.restore();
  }
});

test("5. MAX_STEPS is still a hard upper bound when progress never ends", async () => {
  const env = installFakeDom([new FakeElement("button", {}, "B")]);
  try {
    env.respondWith((_b, i) => {
      env.elements.push(new FakeElement("button", {}, `X${i}`));
      return serverAction({ action: "scroll", direction: "down", amount: 100 + i });
    });
    const res = await runTask("never done");
    assert.equal(res.ok, false);
    assert.match(res.detail, new RegExp(`halted after ${MAX_STEPS} steps`));
    assert.equal(env.fetchCalls.length, MAX_STEPS, "never exceeds the budget");
    assert.equal((await getActiveTask())?.status, "failed");
  } finally {
    env.restore();
  }
});

test("6. short tasks are completely unchanged", async () => {
  const env = installFakeDom([new FakeElement("button", {}, "B")]);
  try {
    env.respondWith(
      serverAction({ action: "scroll", direction: "down", amount: 100 }),
      serverAction({ action: "done" })
    );
    const res = await runTask("short task");
    assert.equal(res.ok, true);
    assert.equal(env.fetchCalls.length, 2, "no extra steps consumed");
    assert.match(res.detail, /done after 1 step\(s\)/);
  } finally {
    env.restore();
  }
});

test("7. a failing step still halts immediately, not at the budget", async () => {
  const env = installFakeDom([new FakeElement("button", {}, "B")]);
  try {
    env.respondWith({ _statusCode: 500, error: "Internal Server Error" });
    const res = await runTask("server error");
    assert.equal(res.ok, false);
    assert.equal(env.fetchCalls.length, 1, "halts on the failure, not after MAX_STEPS");
    assert.equal((await getActiveTask())?.failure?.stage, "reasoning_server");
  } finally {
    env.restore();
  }
});
