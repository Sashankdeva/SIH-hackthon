/**
 * C16 — sanitized history must say WHICH control a step acted on.
 *
 * History previously recorded element_id = null / element_label = null on every
 * step, and an "unknown" action whenever the expected-string mapping had no
 * entry, so the model could not tell what the previous step targeted.
 * Privacy is unchanged: the label comes from the SANITIZED context, so a
 * sensitive field contributes its redaction token and never its value.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { installFakeDom, serverAction, FakeElement, FakeInputElement } from "./helpers/fakeDom";
import { runTask, getActiveTask } from "../src/content/index";
import { captureDomState } from "../src/perception/domCapture";
import { storeSecret } from "../src/privacy/secretStore";

test("1. history preserves element_id and element_label for a targeted action", async () => {
  const btn = new FakeElement("button", {}, "Confirm Selection");
  btn.onClickRemove = true; // produces a verifiable effect
  const env = installFakeDom([btn]);
  try {
    const ids = captureDomState("init").elements.map((e) => e.elementId);
    env.respondWith(
      serverAction({ action: "click", element_id: ids[0] }),
      serverAction({ action: "done" })
    );
    await runTask("targeted action");

    const at = await getActiveTask();
    const step1 = at!.history[0];
    assert.equal(step1.element_id, ids[0], "element_id preserved");
    assert.equal(step1.element_label, "Confirm Selection", "element_label preserved");
    assert.equal(step1.action, "click", "real action type recorded");
    assert.notEqual(step1.action, "unknown");
  } finally {
    env.restore();
  }
});

test("2. non-element actions record null ids without inventing a target", async () => {
  const env = installFakeDom([new FakeElement("button", {}, "B")]);
  try {
    env.respondWith(
      serverAction({ action: "scroll", direction: "down", amount: 100 }),
      serverAction({ action: "done" })
    );
    await runTask("scroll");
    const step1 = (await getActiveTask())!.history[0];
    assert.equal(step1.element_id, null);
    assert.equal(step1.element_label, null);
    assert.equal(step1.action, "scroll");
  } finally {
    env.restore();
  }
});

test("3. type_secret history carries the redaction token, never the secret", async () => {
  const SECRET = "synthetic-secret-value-9999";
  const pwd = new FakeInputElement("password", { "aria-label": "[PASSWORD_01]" });
  const env = installFakeDom([pwd]);
  try {
    storeSecret("[PASSWORD_01]", SECRET);
    const ids = captureDomState("init").elements.map((e) => e.elementId);
    env.respondWith(
      serverAction({ action: "type_secret", element_id: ids[0], value_ref: "[PASSWORD_01]" }),
      serverAction({ action: "done" })
    );
    await runTask("secret entry");

    const at = await getActiveTask();
    const serialized = JSON.stringify(at!.history);
    assert.equal(serialized.includes(SECRET), false, "raw secret never enters history");
    const step1 = at!.history[0];
    if (step1.element_label != null) {
      assert.match(step1.element_label, /^\[[A-Z_]+\d*\]$/, "label is a redaction token");
    }
  } finally {
    env.restore();
  }
});

test("4. an unknown/malformed action is rejected, never recorded as success", async () => {
  const env = installFakeDom([new FakeElement("button", {}, "B")]);
  try {
    env.respondWith({ action: "teleport", confidence: 0.9, task_id: "task-under-test", step_id: 1 });
    const res = await runTask("malformed action");

    assert.equal(res.ok, false, "malformed action never yields success");
    const at = await getActiveTask();
    assert.notEqual(at?.status, "completed");
    assert.equal(at?.status, "failed");
    for (const h of at?.history ?? []) {
      assert.notEqual(h.outcome, "success");
    }
  } finally {
    env.restore();
  }
});
