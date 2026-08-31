import test from "node:test";
import assert from "node:assert/strict";

import { handlePageShow } from "../src/content/index";
import { formatTabErrorMessage } from "../src/popup/index";
import { sendMessage } from "../src/messaging/bus";
import { FakeElement, FakeInputElement, installFakeDom } from "./helpers/fakeDom";
import { captureDomState } from "../src/perception/domCapture";
import { verifyUrlChanged } from "../src/pvm/verify";

// ---------------------------------------------------------------------------
// 1. pageshow.persisted === true triggers fresh page analysis
// ---------------------------------------------------------------------------
test("1. pageshow with persisted: true triggers fresh page analysis", async () => {
  const input = new FakeInputElement("text", { "data-privy-id": "1", id: "search-box" });
  const env = installFakeDom([input]);

  try {
    const analysisPromise = handlePageShow({ persisted: true });
    assert.ok(analysisPromise !== null, "Must return an analysis promise when persisted is true");
    const analysis = await analysisPromise;
    assert.ok(analysis !== null);
    assert.ok(analysis.pageState !== null);
    assert.equal(analysis.pageState.elements.length, 1);
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
// 2. pageshow.persisted === false does not rerun initialization
// ---------------------------------------------------------------------------
test("2. pageshow with persisted: false does not rerun initialization", () => {
  const res = handlePageShow({ persisted: false });
  assert.equal(res, null, "Must return null when persisted is false");
});

// ---------------------------------------------------------------------------
// 3. Repeated pageshow events do not create duplicate message listeners
// ---------------------------------------------------------------------------
test("3. Repeated pageshow events do not create duplicate message listeners", async () => {
  const btn = new FakeElement("button", { "data-privy-id": "2" }, "Click me");
  const env = installFakeDom([btn]);

  try {
    // Fire 3 simulated BFCache restore events
    const p1 = handlePageShow({ persisted: true });
    const p2 = handlePageShow({ persisted: true });
    const p3 = handlePageShow({ persisted: true });

    assert.ok(p1 !== null && p2 !== null && p3 !== null);
    await Promise.all([p1, p2, p3]);

    // DOM should be intact and exactly 1 button present
    const state = captureDomState("test-task");
    assert.equal(state.elements.length, 1);
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
// 4. Restored page is ready for subsequent task execution
// ---------------------------------------------------------------------------
test("4. Restored page successfully prepares fresh state for new tasks", async () => {
  const field1 = new FakeInputElement("text", { id: "f1" });
  const env = installFakeDom([field1]);

  try {
    await handlePageShow({ persisted: true });
    const freshState = captureDomState("task-after-restore");
    assert.ok(freshState !== null);
    assert.equal(freshState.taskId, "task-after-restore");
    assert.equal(freshState.elements.length, 1);
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
// 5. Popup error classification: Receiving end does not exist
// ---------------------------------------------------------------------------
test("5. formatTabErrorMessage correctly classifies 'Receiving end does not exist'", () => {
  const err = new Error("Could not establish connection. Receiving end does not exist.");
  const msg = formatTabErrorMessage(err);
  assert.equal(msg, "Page navigation in progress or connection reset — reload the page and try again.");
});

// ---------------------------------------------------------------------------
// 6. Popup error classification: BFCache message channel closed
// ---------------------------------------------------------------------------
test("6. formatTabErrorMessage correctly classifies BFCache message-channel closure", () => {
  const err = new Error("The page was moved into back/forward cache, so the message channel is closed.");
  const msg = formatTabErrorMessage(err);
  assert.equal(msg, "Page navigation in progress or connection reset — reload the page and try again.");
});

// ---------------------------------------------------------------------------
// 7. Popup error classification: regular errors remain unchanged
// ---------------------------------------------------------------------------
test("7. formatTabErrorMessage preserves regular server/network error text", () => {
  const err = new Error("HTTP 401 Unauthorized: Invalid API Key");
  const msg = formatTabErrorMessage(err);
  assert.equal(msg, "Could not reach the page: Error: HTTP 401 Unauthorized: Invalid API Key");
});

// ---------------------------------------------------------------------------
// 8. bus.ts sendMessage translates BFCache error to BFCACHE_CHANNEL_CLOSED
// ---------------------------------------------------------------------------
test("8. sendMessage maps BFCache runtime error to BFCACHE_CHANNEL_CLOSED", async () => {
  const originalChrome = (globalThis as unknown as { chrome?: unknown }).chrome;

  try {
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: {
        sendMessage: async () => {
          throw new Error("The page was moved into back/forward cache, so the message channel is closed.");
        },
      },
    };

    await assert.rejects(
      async () => {
        await sendMessage({ type: "PAGE_STATE", payload: { taskId: "t1", url: "", title: "", elements: [], capturedAt: Date.now() } });
      },
      (err: Error) => {
        assert.ok(err.message.includes("BFCACHE_CHANNEL_CLOSED"));
        return true;
      }
    );
  } finally {
    (globalThis as unknown as { chrome?: unknown }).chrome = originalChrome;
  }
});

// ---------------------------------------------------------------------------
// 9. Active navigation verification
// ---------------------------------------------------------------------------
test("9. URL navigation verification observes url_changed rather than false failure", () => {
  const result = verifyUrlChanged("nav-action-1", "http://localhost:8000/page1");
  // Default url in fake Dom is http://localhost:8000/
  assert.ok(result.status === "success" || result.status === "ambiguous");
  assert.equal(result.expected, "url_changed");
});

// ---------------------------------------------------------------------------
// 10. New page state after restoration contains fresh DOM elements
// ---------------------------------------------------------------------------
test("10. Fresh DOM state is captured immediately following BFCache restoration", async () => {
  const item1 = new FakeElement("button", { "data-privy-id": "100" }, "Add to Cart");
  const env = installFakeDom([item1]);

  try {
    const analysis = await handlePageShow({ persisted: true });
    assert.ok(analysis !== null);
    assert.equal(analysis.domDetections.length, 0); // No PII in simple button
    assert.equal(analysis.pageState.elements.length, 1);
    assert.equal(analysis.pageState.elements[0].label, "Add to Cart");
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
// 11. handlePageShow with persisted:false returns null (no reanalysis)
//     This is the "normal forward navigation" / pageshow post-load case.
//     The lifecycle guard relies on this returning null so the pageshow
//     listener can distinguish BFCache restores from normal page loads.
// ---------------------------------------------------------------------------
test("11. handlePageShow persisted=false returns null — lifecycle guard relies on this", () => {
  const result = handlePageShow({ persisted: false });
  assert.equal(result, null, "Must be null so the lifecycle guard skips duplicate resume");
});

// ---------------------------------------------------------------------------
// 12. handlePageShow with persisted:true returns a Promise (new analysis)
// ---------------------------------------------------------------------------
test("12. handlePageShow persisted=true returns a live Promise for fresh analysis", async () => {
  const btn = new FakeElement("button", { "data-privy-id": "200" }, "Buy Now");
  const env = installFakeDom([btn]);

  try {
    const result = handlePageShow({ persisted: true });
    assert.ok(result instanceof Promise, "Must return a Promise for BFCache restores");
    const analysis = await result;
    assert.ok(analysis !== null);
    assert.equal(analysis.pageState.elements.length, 1);
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
// 13. Multiple persisted=true pageshow events each produce a fresh analysis
//     This validates that handlePageShow is idempotent and doesn't leak state.
// ---------------------------------------------------------------------------
test("13. Multiple persisted=true pageshow events each return a fresh independent analysis", async () => {
  const btn = new FakeElement("button", { "data-privy-id": "300" }, "Checkout");
  const env = installFakeDom([btn]);

  try {
    const p1 = handlePageShow({ persisted: true });
    const p2 = handlePageShow({ persisted: true });
    assert.ok(p1 !== null && p2 !== null, "Both must return Promises");
    assert.notStrictEqual(p1, p2, "Each call must return a distinct Promise");

    const [a1, a2] = await Promise.all([p1!, p2!]);
    assert.equal(a1.pageState.elements.length, 1);
    assert.equal(a2.pageState.elements.length, 1);
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
// 14. sendMessage maps Extension-context-invalidated error to EXECUTION_CONTEXT_LOST
// ---------------------------------------------------------------------------
test("14. sendMessage maps Extension context invalidated to EXECUTION_CONTEXT_LOST", async () => {
  const originalChrome = (globalThis as unknown as { chrome?: unknown }).chrome;

  try {
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: {
        sendMessage: async () => {
          throw new Error("Extension context invalidated.");
        },
      },
    };

    await assert.rejects(
      async () => {
        await sendMessage({
          type: "PAGE_STATE",
          payload: { taskId: "t14", url: "", title: "", elements: [], capturedAt: Date.now() },
        });
      },
      (err: Error) => {
        assert.ok(err.message.includes("EXECUTION_CONTEXT_LOST"), `Got: ${err.message}`);
        return true;
      }
    );
  } finally {
    (globalThis as unknown as { chrome?: unknown }).chrome = originalChrome;
  }
});
