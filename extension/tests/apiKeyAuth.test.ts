import test from "node:test";
import assert from "node:assert/strict";

import {
  handleReasonRequest,
  handleCompleteRequest,
  handleHealthCheck,
  getStoredApiKey,
} from "../src/background/index";
import { classifyStepError, stepError } from "../src/content/pipeline";
import { describeStepFailure } from "../src/content/index";

// ---------------------------------------------------------------------------
// Synthetic-only. No real key, password, cookie or token appears in this file.
// Tests assert the X-API-Key header EXISTS / is ABSENT — never its value in a
// way that would print a real secret (the value here is a fixed fake string).
// ---------------------------------------------------------------------------
const FAKE_KEY = "synthetic-key-DO-NOT-USE-0000";
const FAKE_KEY_2 = "synthetic-key-rotated-1111";

type StorageShape = Record<string, unknown>;

interface Harness {
  fetchCalls: Array<{ url: string; headers: Record<string, string>; method: string }>;
  consoleArgs: unknown[];
  setStorage(next: StorageShape): void;
  restore(): void;
}

/**
 * Installs a chrome.storage.local + fetch + console capture harness.
 * `nextResponse` is what the mocked fetch resolves to for every call.
 */
function installHarness(
  initialStorage: StorageShape,
  nextResponse: () => Partial<Response> & { ok: boolean; status: number }
): Harness {
  const g = globalThis as unknown as {
    chrome?: unknown;
    fetch?: unknown;
    console: Console;
  };
  const originalChrome = g.chrome;
  const originalFetch = g.fetch;
  const originalError = g.console.error;
  const originalWarn = g.console.warn;
  const originalLog = g.console.log;

  let storage: StorageShape = { ...initialStorage };
  const fetchCalls: Array<{ url: string; headers: Record<string, string>; method: string }> = [];
  const consoleArgs: unknown[] = [];

  g.chrome = {
    storage: {
      local: {
        get: (keys: string[] | undefined, cb: (res: StorageShape) => void) => {
          if (!keys) return cb({ ...storage });
          const out: StorageShape = {};
          for (const k of keys) if (k in storage) out[k] = storage[k];
          cb(out);
        },
        set: (items: StorageShape, cb?: () => void) => {
          Object.assign(storage, items);
          cb?.();
        },
        remove: (keys: string | string[], cb?: () => void) => {
          for (const k of ([] as string[]).concat(keys)) delete storage[k];
          cb?.();
        },
      },
    },
  };

  g.fetch = (async (url: unknown, init?: RequestInit) => {
    fetchCalls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      method: init?.method ?? "GET",
    });
    return nextResponse() as Response;
  }) as typeof fetch;

  const capture = (...args: unknown[]) => { consoleArgs.push(...args); };
  g.console.error = capture as typeof console.error;
  g.console.warn = capture as typeof console.warn;
  g.console.log = capture as typeof console.log;

  return {
    fetchCalls,
    consoleArgs,
    setStorage(next: StorageShape) { storage = { ...next }; },
    restore() {
      g.chrome = originalChrome;
      g.fetch = originalFetch;
      g.console.error = originalError;
      g.console.warn = originalWarn;
      g.console.log = originalLog;
    },
  };
}

const ok200 = () => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ action: "done", confidence: 1, task_id: "t", step_id: 1 }),
  json: async () => ({ status: "ok" }),
});

// ---------------------------------------------------------------------------
// 1. API key is loaded from extension configuration (apiKey, then userApiKey)
// ---------------------------------------------------------------------------
test("1. getStoredApiKey reads the configured key, with userApiKey as fallback", async () => {
  const h = installHarness({ apiKey: FAKE_KEY }, ok200);
  try {
    assert.equal(await getStoredApiKey(), FAKE_KEY);
    h.setStorage({ userApiKey: FAKE_KEY_2 });
    assert.equal(await getStoredApiKey(), FAKE_KEY_2);
    h.setStorage({});
    assert.equal(await getStoredApiKey(), null);
  } finally {
    h.restore();
  }
});

// ---------------------------------------------------------------------------
// 2. /reason receives the X-API-Key header
// ---------------------------------------------------------------------------
test("2. handleReasonRequest attaches X-API-Key to the outbound /reason request", async () => {
  const h = installHarness({ apiKey: FAKE_KEY }, ok200);
  try {
    const res = await handleReasonRequest({ task_id: "t" }, "http://26.39.161.6:8787/reason");
    assert.equal(res.ok, true);
    assert.equal(h.fetchCalls.length, 1);
    assert.equal(h.fetchCalls[0].url, "http://26.39.161.6:8787/reason");
    assert.equal(h.fetchCalls[0].headers["X-API-Key"], FAKE_KEY);
  } finally {
    h.restore();
  }
});

// ---------------------------------------------------------------------------
// 3. Missing key fails safely — no network request
// ---------------------------------------------------------------------------
test("3. handleReasonRequest fails fast (auth_error) with no key configured", async () => {
  const h = installHarness({}, ok200);
  try {
    const res = await handleReasonRequest({ task_id: "t" }, "http://26.39.161.6:8787/reason");
    assert.equal(h.fetchCalls.length, 0, "no unauthenticated request");
    assert.equal(res.ok, false);
    assert.equal(res.errorClass, "auth_error");
    assert.equal(res.error, "missing_api_key");
    assert.equal(res.status, 0);
  } finally {
    h.restore();
  }
});

// ---------------------------------------------------------------------------
// 4. Empty / whitespace key fails safely (treated as not configured)
// ---------------------------------------------------------------------------
test("4. whitespace-only key is treated as missing and fails fast", async () => {
  const h = installHarness({ apiKey: "   " }, ok200);
  try {
    assert.equal(await getStoredApiKey(), null);
    const res = await handleReasonRequest({ task_id: "t" }, "http://26.39.161.6:8787/reason");
    assert.equal(h.fetchCalls.length, 0);
    assert.equal(res.errorClass, "auth_error");
    assert.equal(res.error, "missing_api_key");
  } finally {
    h.restore();
  }
});

// ---------------------------------------------------------------------------
// 5. A bogus / empty header is never fabricated
// ---------------------------------------------------------------------------
test("5. no empty X-API-Key header is ever sent", async () => {
  const h = installHarness({}, ok200);
  try {
    await handleReasonRequest({ task_id: "t" }, "http://26.39.161.6:8787/reason");
    // Fast-fail path: nothing sent at all.
    assert.equal(h.fetchCalls.length, 0);

    // With a real key it is present and correct; with none it must be absent,
    // never "".
    h.setStorage({ apiKey: FAKE_KEY });
    await handleReasonRequest({ task_id: "t" }, "http://26.39.161.6:8787/reason");
    assert.equal(h.fetchCalls.length, 1);
    const sent = h.fetchCalls[0].headers;
    assert.equal(sent["X-API-Key"], FAKE_KEY);
    assert.notEqual(sent["X-API-Key"], "");
  } finally {
    h.restore();
  }
});

// ---------------------------------------------------------------------------
// 6. The key never appears in console output
// ---------------------------------------------------------------------------
test("6. API key never appears in logs or error output", async () => {
  // Server rejects the key -> background logs an error. The key must not be in it.
  const h = installHarness({ apiKey: FAKE_KEY }, () => ({
    ok: false,
    status: 401,
    statusText: "Unauthorized",
    text: async () => JSON.stringify({ error: "unauthorized", detail: "missing or invalid X-API-Key header" }),
  }));
  try {
    const res = await handleReasonRequest({ task_id: "t" }, "http://26.39.161.6:8787/reason");
    assert.equal(res.status, 401);
    const blob = h.consoleArgs.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" | ");
    assert.equal(blob.includes(FAKE_KEY), false, "synthetic key leaked into console output");
  } finally {
    h.restore();
  }
});

// ---------------------------------------------------------------------------
// 7. /health behaviour is unchanged — no key attached
// ---------------------------------------------------------------------------
test("7. handleHealthCheck sends GET /health with no X-API-Key even when a key is configured", async () => {
  const h = installHarness({ apiKey: FAKE_KEY }, () => ({
    ok: true,
    status: 200,
    json: async () => ({ status: "ok" }),
  }));
  try {
    const res = await handleHealthCheck("http://26.39.161.6:8787/reason");
    assert.equal(res.ok, true);
    assert.equal(h.fetchCalls.length, 1);
    assert.match(h.fetchCalls[0].url, /\/health$/);
    assert.equal(h.fetchCalls[0].method, "GET");
    assert.equal(h.fetchCalls[0].headers["X-API-Key"], undefined);
  } finally {
    h.restore();
  }
});

// ---------------------------------------------------------------------------
// 8. /complete helper attaches the key when used, fails fast when not configured
// ---------------------------------------------------------------------------
test("8. handleCompleteRequest attaches X-API-Key when used; fails fast without a key", async () => {
  const h = installHarness({ apiKey: FAKE_KEY }, ok200);
  try {
    const res = await handleCompleteRequest({ task_id: "t" }, "http://26.39.161.6:8787/reason");
    assert.equal(res.ok, true);
    assert.equal(h.fetchCalls.length, 1);
    assert.match(h.fetchCalls[0].url, /\/complete$/);
    assert.equal(h.fetchCalls[0].headers["X-API-Key"], FAKE_KEY);

    h.setStorage({});
    const res2 = await handleCompleteRequest({ task_id: "t" }, "http://26.39.161.6:8787/reason");
    assert.equal(h.fetchCalls.length, 1, "no further request without a key");
    assert.equal(res2.errorClass, "auth_error");
    assert.equal(res2.error, "missing_api_key");
  } finally {
    h.restore();
  }
});

// ---------------------------------------------------------------------------
// 9. Server URL + API key configuration persists
// ---------------------------------------------------------------------------
test("9. serverUrl and apiKey round-trip through chrome.storage.local", async () => {
  const h = installHarness({}, ok200);
  try {
    const g = globalThis as unknown as { chrome: { storage: { local: {
      set: (i: StorageShape, cb?: () => void) => void;
      get: (k: string[], cb: (r: StorageShape) => void) => void;
    } } } };
    await new Promise<void>((r) =>
      g.chrome.storage.local.set({ serverUrl: "http://26.39.161.6:8787/reason", apiKey: FAKE_KEY }, r)
    );
    const read = await new Promise<StorageShape>((r) =>
      g.chrome.storage.local.get(["serverUrl", "apiKey"], r)
    );
    assert.equal(read.serverUrl, "http://26.39.161.6:8787/reason");
    assert.equal(read.apiKey, FAKE_KEY);
    assert.equal(await getStoredApiKey(), FAKE_KEY);
  } finally {
    h.restore();
  }
});

// ---------------------------------------------------------------------------
// 10. Changing the key changes future requests (no stale caching)
// ---------------------------------------------------------------------------
test("10. rotating the stored key is reflected on the very next request", async () => {
  const h = installHarness({ apiKey: FAKE_KEY }, ok200);
  try {
    await handleReasonRequest({ task_id: "t" }, "http://26.39.161.6:8787/reason");
    assert.equal(h.fetchCalls[0].headers["X-API-Key"], FAKE_KEY);

    h.setStorage({ apiKey: FAKE_KEY_2 });
    await handleReasonRequest({ task_id: "t" }, "http://26.39.161.6:8787/reason");
    assert.equal(h.fetchCalls[1].headers["X-API-Key"], FAKE_KEY_2);
  } finally {
    h.restore();
  }
});

// ---------------------------------------------------------------------------
// 11. 401 / 403 / missing-key are classified as a precise client auth failure
// ---------------------------------------------------------------------------
test("11. classifyStepError maps auth causes to reason 'auth_failed'", () => {
  const missing = classifyStepError(stepError("server_error", "missing_api_key"));
  assert.equal(missing.reason, "auth_failed");
  assert.equal(missing.httpStatus, null);

  const rejected401 = classifyStepError(stepError("server_error", "http_401", { httpStatus: 401 }));
  assert.equal(rejected401.reason, "auth_failed");
  assert.equal(rejected401.httpStatus, 401);

  const rejected403 = classifyStepError(stepError("server_error", "http_403", { httpStatus: 403 }));
  assert.equal(rejected403.reason, "auth_failed");
  assert.equal(rejected403.httpStatus, 403);

  // A different HTTP error is still a generic server_http_error.
  const other = classifyStepError(stepError("server_error", "http_500", { httpStatus: 500 }));
  assert.equal(other.reason, "server_http_error");
});

// ---------------------------------------------------------------------------
// 12. describeStepFailure surfaces auth failures under the reasoning_server
//     stage with an actionable, secret-free message
// ---------------------------------------------------------------------------
test("12. describeStepFailure renders auth_failed without leaking anything sensitive", () => {
  const missing = describeStepFailure(2, {
    kind: "failed",
    reason: "auth_failed",
    detail: "missing_api_key",
    httpStatus: null,
  });
  assert.equal(missing.info.stage, "reasoning_server");
  assert.equal(missing.info.reason, "auth_failed");
  assert.match(missing.summary, /API key/i);
  assert.equal(missing.info.httpStatus, undefined);

  const rejected = describeStepFailure(1, {
    kind: "failed",
    reason: "auth_failed",
    detail: "http_401",
    httpStatus: 401,
    serverErrorCode: "unauthorized",
  });
  assert.equal(rejected.info.stage, "reasoning_server");
  assert.equal(rejected.info.httpStatus, 401);
  assert.match(rejected.summary, /rejected the API key/i);
});
