/**
 * C15 — repeated-ambiguous guard.
 *
 * PVM `ambiguous` means "effect could not be confirmed". It must not become
 * task success, but it must also not mean "run the exact same action again":
 * for a side-effecting control (an "add" button, a submit) that repeats a real
 * action the user never asked for. The guard refuses BEFORE dispatch, and only
 * when the model-visible page state AND the requested action are both identical.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { installFakeDom, serverAction, FakeElement } from "./helpers/fakeDom";
import { runTask, getActiveTask, MAX_STEPS } from "../src/content/index";
import { captureDomState } from "../src/perception/domCapture";

test("1. ambiguous + unchanged state + same action → not re-dispatched, halts typed", async () => {
  const btn = new FakeElement("button", {}, "Add to cart"); // click has no observable effect
  const env = installFakeDom([btn]);
  try {
    const ids = captureDomState("init").elements.map((e) => e.elementId);
    env.respondWith(serverAction({ action: "click", element_id: ids[0] }));

    const res = await runTask("repeat ambiguous");

    assert.equal(res.ok, false);
    // The action is executed ONCE; the identical repeat is refused pre-dispatch.
    assert.equal(btn.clickCount, 1, "side-effecting action executed exactly once");
    assert.ok(env.fetchCalls.length < MAX_STEPS, "halts well before the step budget");

    const at = await getActiveTask();
    assert.equal(at?.status, "failed");
    assert.notEqual(at?.status, "completed");
    assert.equal(at?.failure?.reason, "no_progress");
  } finally {
    env.restore();
  }
});

test("2. ambiguous + page state changed → the same action may run again", async () => {
  const btn = new FakeElement("button", {}, "Next");
  const env = installFakeDom([btn]);
  try {
    const ids = captureDomState("init").elements.map((e) => e.elementId);
    env.respondWith((_b, i) => {
      if (i < 3) {
        env.elements.push(new FakeElement("button", {}, `Added ${i}`)); // real page change
        return serverAction({ action: "click", element_id: ids[0] });
      }
      return serverAction({ action: "done" });
    });

    const res = await runTask("changing page, same action");
    assert.equal(res.ok, true, "repeated action allowed while the page keeps changing");
    assert.ok(btn.clickCount >= 3, "each legitimate repeat really executed");
    assert.equal((await getActiveTask())?.status, "completed");
  } finally {
    env.restore();
  }
});

test("3. ambiguous + different next action → continues normally", async () => {
  const btn = new FakeElement("button", {}, "Add");
  const env = installFakeDom([btn]);
  try {
    const ids = captureDomState("init").elements.map((e) => e.elementId);
    env.respondWith(
      serverAction({ action: "click", element_id: ids[0] }),
      serverAction({ action: "scroll", direction: "down", amount: 100 }),
      serverAction({ action: "done" })
    );
    const res = await runTask("different next action");
    assert.equal(res.ok, true);
    assert.equal((await getActiveTask())?.status, "completed");
  } finally {
    env.restore();
  }
});

test("4. repeated scroll with a real page change stays allowed", async () => {
  const env = installFakeDom([new FakeElement("button", {}, "B")]);
  try {
    env.respondWith((_b, i) => {
      if (i < 3) {
        env.elements.push(new FakeElement("button", {}, `Lazy ${i}`)); // content loads in
        return serverAction({ action: "scroll", direction: "down", amount: 100 });
      }
      return serverAction({ action: "done" });
    });
    const res = await runTask("scroll with change");
    assert.equal(res.ok, true);
  } finally {
    env.restore();
  }
});

test("5. successful actions are never blocked, even when identical and unchanged", async () => {
  // A click that removes its target verifies as success → guard stays disarmed.
  const env = installFakeDom([new FakeElement("button", {}, "S0")]);
  try {
    env.respondWith((_b, i) => {
      if (i < 3) {
        const b = new FakeElement("button", {}, `S${i + 1}`);
        b.onClickRemove = true;
        env.elements.push(b);
        return serverAction({ action: "scroll", direction: "down", amount: 50 + i });
      }
      return serverAction({ action: "done" });
    });
    const res = await runTask("successful repeats");
    assert.equal(res.ok, true);
    assert.equal((await getActiveTask())?.status, "completed");
  } finally {
    env.restore();
  }
});

test("6. done still terminates immediately (guard never blocks completion)", async () => {
  const env = installFakeDom([new FakeElement("button", {}, "B")]);
  try {
    env.respondWith(serverAction({ action: "done" }));
    const res = await runTask("done");
    assert.equal(res.ok, true);
    assert.equal((await getActiveTask())?.status, "completed");
  } finally {
    env.restore();
  }
});

test("7. a validator rejection still halts with its own reason, not no_progress", async () => {
  const env = installFakeDom([new FakeElement("button", {}, "B")]);
  try {
    env.respondWith(serverAction({ action: "click", element_id: 1, confidence: 0.1 }));
    const res = await runTask("validator rejection");
    assert.equal(res.ok, false);
    const at = await getActiveTask();
    assert.equal(at?.failure?.reason, "validation_failed");
    assert.notEqual(at?.failure?.reason, "no_progress");
  } finally {
    env.restore();
  }
});

test("8. MAX_STEPS behaviour unchanged when every step makes real progress", async () => {
  const env = installFakeDom([new FakeElement("button", {}, "B")]);
  try {
    env.respondWith((_b, i) => {
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
