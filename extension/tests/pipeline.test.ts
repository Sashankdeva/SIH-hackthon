/**
 * Regression tests for the single-execution contract.
 *
 * ONE action returned by the server must produce EXACTLY ONE browser
 * interaction. This was previously untrue: runOneStep re-entered itself
 * whenever verification came back "ambiguous", and verifyUrlChanged
 * returns "ambiguous" for every action that does not change the URL — so
 * click, type, type_secret, scroll, keypress and wait all executed
 * twice. A click on "Place Order" placed two orders.
 *
 * Each test below fails with a count of 2 against that old code, and the
 * server-call assertions fail too, because the retry re-ran fetch as
 * well. Nothing here stubs the executor: the assertions read side
 * effects off the fake DOM, so they measure what the page actually
 * received.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { installFakeDom, serverAction, FakeElement, FakeInputElement } from "./helpers/fakeDom";
import type { FakeEnv } from "./helpers/fakeDom";
import { captureDomState } from "../src/perception/domCapture";
import { runOneStep } from "../src/content/pipeline";
import { createDispatch } from "../src/action/dispatch";
import { storeSecret } from "../src/privacy/secretStore";
import type { SanitizedContext } from "../src/privacy/sanitizedContext";
import type { ActionRequest } from "../src/action/types";

const TASK_ID = "task-under-test";

interface Harness {
  env: FakeEnv;
  context: SanitizedContext;
  /** Registered element ids, in the order the elements were given. */
  ids: number[];
}

/**
 * Installs the fake page, registers its elements through the real
 * captureDomState (so resolveElement can find them later, exactly as it
 * does in the browser) and builds a matching sanitized context.
 */
function setup(elements: FakeElement[]): Harness {
  const env = installFakeDom(elements);
  const pageState = captureDomState(TASK_ID);
  const ids = pageState.elements.map((el) => el.elementId);

  return {
    env,
    ids,
    context: {
      taskId: TASK_ID,
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

test("click executes exactly once", async () => {
  const button = new FakeElement("button", {}, "Place Order");
  const { env, context, ids } = setup([button]);
  try {
    env.respondWith(serverAction({ action: "click", element_id: ids[0] }));

    const result = await runOneStep(context);

    assert.equal(button.clickCount, 1, "Place Order must be clicked exactly once");
    assert.equal(env.fetchCalls.length, 1, "the server must be asked exactly once");
    assert.equal(result?.status, "ambiguous", "a click that changes no URL is unverifiable, not failed");
  } finally {
    env.restore();
  }
});

test("type executes exactly once", async () => {
  const field = new FakeInputElement("text", { "aria-label": "Search" });
  const { env, context, ids } = setup([field]);
  try {
    env.respondWith(serverAction({ action: "type", element_id: ids[0], value: "hello world" }));

    await runOneStep(context);

    assert.equal(field.countDispatched("input"), 1, "exactly one input event must reach the field");
    assert.equal(field.value, "hello world");
    assert.equal(env.fetchCalls.length, 1);
  } finally {
    env.restore();
  }
});

test("type_secret executes exactly once and keeps the secret local", async () => {
  const field = new FakeInputElement("password", { "aria-label": "[PASSWORD_01]" });
  const { env, context, ids } = setup([field]);
  try {
    storeSecret("[PASSWORD_01]", "correct-horse-battery");
    env.respondWith(
      serverAction({ action: "type_secret", element_id: ids[0], value_ref: "[PASSWORD_01]" })
    );

    await runOneStep(context);

    assert.equal(field.countDispatched("input"), 1, "the password field must be filled exactly once");
    assert.equal(field.value, "correct-horse-battery");
    assert.equal(env.fetchCalls.length, 1);
    assert.ok(
      !env.fetchCalls.some((c) => c.body.includes("correct-horse-battery")),
      "the real secret must never appear in an outbound request"
    );
  } finally {
    env.restore();
  }
});

test("scroll executes exactly once", async () => {
  const { env, context } = setup([new FakeElement("button", {}, "Anything")]);
  try {
    env.respondWith(serverAction({ action: "scroll", direction: "down", amount: 300 }));

    await runOneStep(context);

    assert.equal(env.scrollCalls.length, 1, "the page must be scrolled exactly once");
    assert.equal(env.scrollCalls[0].top, 300);
  } finally {
    env.restore();
  }
});

test("wait executes exactly once", async () => {
  const { env, context } = setup([new FakeElement("button", {}, "Anything")]);
  try {
    env.respondWith(serverAction({ action: "wait", amount: 250 }));

    await runOneStep(context);

    const waits = env.timeouts.filter((ms) => ms === 250);
    assert.equal(waits.length, 1, "exactly one 250ms wait must be scheduled");
  } finally {
    env.restore();
  }
});

test("navigate executes exactly once", async () => {
  const { env, context } = setup([new FakeElement("a", { href: "/next" }, "Next")]);
  try {
    env.respondWith(serverAction({ action: "navigate", url: "http://localhost:8000/next" }));

    const result = await runOneStep(context);

    assert.equal(env.navigations.length, 1, "exactly one navigation must be triggered");
    assert.equal(env.navigations[0], "http://localhost:8000/next");
    assert.equal(env.href, "http://localhost:8000/next");
    assert.equal(result?.status, "success", "a URL change is the one outcome verification can confirm");
    assert.equal(env.fetchCalls.length, 1);
  } finally {
    env.restore();
  }
});

test("keypress executes exactly once", async () => {
  const field = new FakeInputElement("text", { "aria-label": "Search" });
  const { env, context } = setup([field]);
  try {
    (globalThis as unknown as { document: { activeElement: FakeElement } }).document.activeElement = field;
    env.respondWith(serverAction({ action: "keypress", value: "Enter" }));

    await runOneStep(context);

    assert.equal(field.countDispatched("keydown"), 1, "exactly one keydown must be dispatched");
  } finally {
    env.restore();
  }
});

test("verification still runs after execution", async () => {
  const button = new FakeElement("button", {}, "Submit");
  const { env, context, ids } = setup([button]);
  try {
    env.respondWith(serverAction({ action: "click", element_id: ids[0], step_id: 7 }));

    const result = await runOneStep(context);

    assert.ok(result, "runOneStep must return a verification result");
    assert.equal(result.actionId, `${TASK_ID}:7`);
    assert.equal(result.expected, "click_effect");
    assert.ok(typeof result.latencyMs === "number");
  } finally {
    env.restore();
  }
});

test("a rejected action executes nothing", async () => {
  const button = new FakeElement("button", {}, "Place Order");
  const { env, context, ids } = setup([button]);
  try {
    // Below MIN_CONFIDENCE — the validator must stop this before the executor.
    env.respondWith(serverAction({ action: "click", element_id: ids[0], confidence: 0.1 }));

    const result = await runOneStep(context);

    assert.equal(button.clickCount, 0, "a rejected action must never reach the page");
    assert.equal(result, null);
  } finally {
    env.restore();
  }
});

test("two separate tasks on the same page each execute once", async () => {
  // taskId is page-scoped and the server always sends step_id 1, so a
  // naive "have I run taskId:stepId before?" ledger would silently
  // swallow the user's second task. The gate is per server response for
  // exactly this reason.
  const button = new FakeElement("button", {}, "Add to cart");
  const { env, context, ids } = setup([button]);
  try {
    env.respondWith(serverAction({ action: "click", element_id: ids[0] }));

    await runOneStep(context);
    await runOneStep(context);

    assert.equal(button.clickCount, 2, "two user-initiated tasks are two legitimate clicks");
    assert.equal(env.fetchCalls.length, 2);
  } finally {
    env.restore();
  }
});

test("the dispatch gate refuses a second execution of the same action", async () => {
  const button = new FakeElement("button", {}, "Place Order");
  const { env, ids } = setup([button]);
  try {
    const action: ActionRequest = {
      action: "click",
      elementId: ids[0],
      value: null,
      valueRef: null,
      direction: null,
      amount: null,
      url: null,
      confidence: 0.9,
      taskId: TASK_ID,
      stepId: 1,
    };

    const dispatch = createDispatch(`${TASK_ID}:1`);
    assert.equal(await dispatch.run(action), true, "the first call executes");
    assert.equal(await dispatch.run(action), false, "the second call is refused");
    assert.equal(await dispatch.run(action), false);

    assert.equal(button.clickCount, 1, "a refused dispatch must not reach the page");
    assert.equal(dispatch.executed, true);
  } finally {
    env.restore();
  }
});

test("the dispatch gate refuses a concurrent second execution", async () => {
  // `wait` and `type_secret` both await, so a gate that only flips its
  // flag after execution would let a second call slip in mid-flight.
  const { env } = setup([new FakeElement("button", {}, "Anything")]);
  try {
    const action: ActionRequest = {
      action: "wait",
      elementId: null,
      value: null,
      valueRef: null,
      direction: null,
      amount: 120,
      url: null,
      confidence: 0.9,
      taskId: TASK_ID,
      stepId: 1,
    };

    const dispatch = createDispatch(`${TASK_ID}:1`);
    const [first, second] = await Promise.all([dispatch.run(action), dispatch.run(action)]);

    assert.equal(first, true);
    assert.equal(second, false, "the in-flight second call must be refused");
    assert.equal(env.timeouts.filter((ms) => ms === 120).length, 1);
  } finally {
    env.restore();
  }
});

// ======================================================================
// Per-action verification tests
// ======================================================================

test("click reports success when URL changes", async () => {
  const link = new FakeElement("a", { href: "/next" }, "Next");
  const { env, context, ids } = setup([link]);
  try {
    env.respondWith(serverAction({ action: "click", element_id: ids[0] }));
    // Make the fake click trigger a URL change.
    link.click = function () {
      this.clickCount++;
      (globalThis as unknown as { location: { href: string } }).location.href = "http://localhost:8000/clicked";
    };

    const result = await runOneStep(context);

    assert.ok(result);
    assert.equal(result.status, "success");
    assert.equal(result.observed, "url_changed");
    assert.equal(link.clickCount, 1);
  } finally {
    env.restore();
  }
});

test("click reports success when element disappears", async () => {
  const button = new FakeElement("button", {}, "Close Modal");
  button.onClickRemove = true;
  const { env, context, ids } = setup([button]);
  try {
    env.respondWith(serverAction({ action: "click", element_id: ids[0] }));

    const result = await runOneStep(context);

    assert.ok(result);
    assert.equal(result.status, "success");
    assert.equal(result.observed, "element_removed");
    assert.equal(button.clickCount, 1);
  } finally {
    env.restore();
  }
});

test("click reports ambiguous when nothing observable changes", async () => {
  const button = new FakeElement("button", {}, "Track Event");
  const { env, context, ids } = setup([button]);
  try {
    env.respondWith(serverAction({ action: "click", element_id: ids[0] }));

    const result = await runOneStep(context);

    assert.ok(result);
    assert.equal(result.status, "ambiguous");
    assert.equal(result.observed, "no_observable_change");
    assert.equal(button.clickCount, 1);
  } finally {
    env.restore();
  }
});

test("type reports success when value matches", async () => {
  const field = new FakeInputElement("text", { "aria-label": "Username" });
  const { env, context, ids } = setup([field]);
  try {
    env.respondWith(serverAction({ action: "type", element_id: ids[0], value: "alice" }));

    const result = await runOneStep(context);

    assert.ok(result);
    assert.equal(result.status, "success");
    assert.equal(result.observed, "value_matches");
    assert.equal(field.value, "alice");
  } finally {
    env.restore();
  }
});

test("type reports failure when value doesn't match", async () => {
  const field = new FakeInputElement("text", { "aria-label": "Username" });
  const { env, context, ids } = setup([field]);
  try {
    env.respondWith(serverAction({ action: "type", element_id: ids[0], value: "alice" }));
    // Simulate a controlled input that resets the value.
    const origDispatch = field.dispatchEvent.bind(field);
    field.dispatchEvent = function (event: { type: string }) {
      origDispatch(event);
      // Controlled input resets value on input event.
      if (event.type === "input") field.value = "";
      return true;
    };

    const result = await runOneStep(context);

    assert.ok(result);
    assert.equal(result.status, "failure");
    assert.equal(result.observed, "value_mismatch");
  } finally {
    env.restore();
  }
});

test("type_secret reports success when value changes", async () => {
  const field = new FakeInputElement("password", { "aria-label": "[PASSWORD_01]" });
  const { env, context, ids } = setup([field]);
  try {
    storeSecret("[PASSWORD_01]", "s3cret-value");
    env.respondWith(
      serverAction({ action: "type_secret", element_id: ids[0], value_ref: "[PASSWORD_01]" })
    );

    const result = await runOneStep(context);

    assert.ok(result);
    assert.equal(result.status, "success");
    assert.equal(result.observed, "value_changed");
  } finally {
    env.restore();
  }
});

test("type_secret observed field never contains the secret", async () => {
  const field = new FakeInputElement("password", { "aria-label": "[PASSWORD_01]" });
  const { env, context, ids } = setup([field]);
  try {
    const secret = "super-sensitive-password-42";
    storeSecret("[PASSWORD_01]", secret);
    env.respondWith(
      serverAction({ action: "type_secret", element_id: ids[0], value_ref: "[PASSWORD_01]" })
    );

    const result = await runOneStep(context);

    assert.ok(result);
    // The observed field must NEVER contain the actual secret value.
    assert.ok(
      !result.observed.includes(secret),
      "the actual secret must never appear in the verification result"
    );
    assert.ok(
      !result.expected.includes(secret),
      "the actual secret must never appear in the expected field"
    );
  } finally {
    env.restore();
  }
});

test("scroll reports success when scrollY changes", async () => {
  const { env, context } = setup([new FakeElement("button", {}, "Anything")]);
  try {
    env.respondWith(serverAction({ action: "scroll", direction: "down", amount: 300 }));

    const result = await runOneStep(context);

    assert.ok(result);
    assert.equal(result.status, "success");
    assert.equal(result.observed, "scroll_changed");
    assert.equal(env.scrollY, 300);
  } finally {
    env.restore();
  }
});

test("scroll reports ambiguous when scrollY unchanged", async () => {
  const { env, context } = setup([new FakeElement("button", {}, "Anything")]);
  try {
    env.respondWith(serverAction({ action: "scroll", direction: "down", amount: 300 }));
    // Override scrollBy to NOT update scrollY (simulates already-at-bottom).
    const w = (globalThis as unknown as { window: { scrollBy: (opts: unknown) => void; scrollY: number } }).window;
    w.scrollBy = () => {
      // Scroll requested but page doesn't move — scrollY stays at 0.
      env.scrollCalls.push({ top: 300 });
    };

    const result = await runOneStep(context);

    assert.ok(result);
    assert.equal(result.status, "ambiguous");
    assert.equal(result.observed, "scroll_unchanged");
  } finally {
    env.restore();
  }
});

test("wait reports success unconditionally", async () => {
  const { env, context } = setup([new FakeElement("button", {}, "Anything")]);
  try {
    env.respondWith(serverAction({ action: "wait", amount: 100 }));

    const result = await runOneStep(context);

    assert.ok(result);
    assert.equal(result.status, "success");
    assert.equal(result.expected, "wait_completed");
    assert.equal(result.observed, "wait_completed");
  } finally {
    env.restore();
  }
});
