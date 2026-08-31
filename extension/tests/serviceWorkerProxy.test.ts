import test from "node:test";
import assert from "node:assert/strict";

import {
  handleReasonRequest,
  handleCompleteRequest,
  handleHealthCheck,
  getStoredApiKey,
  getStoredServerUrl,
} from "../src/background/index";
import { fetchAction } from "../src/content/pipeline";
import type { SanitizedContext } from "../src/privacy/sanitizedContext";
import type { ProxyResponse } from "../src/messaging/bus";

const sampleContext: SanitizedContext = {
  taskId: "proxy-test-task",
  task: "test proxy",
  page: "Test Page",
  urlOrigin: "https://maya.adityauniversity.in",
  elements: [{ elementId: 1, role: "button", label: "Submit" }],
  fields: {},
};

// Default environment for the proxy tests: a configured (synthetic) API key so
// handleReasonRequest / handleCompleteRequest reach the network path being
// classified. Tests that specifically exercise storage (missing key, custom
// key, direct-proxy) override `globalThis.chrome` inside their own try/finally.
// Installed per-test and torn down after so nothing leaks into sibling test
// files sharing the same `node --test` process.
const SYNTHETIC_PROXY_KEY = "synthetic-proxy-test-key";
const chromeSlot = globalThis as unknown as { chrome?: unknown };
let chromeBeforeSuite: unknown;

test.beforeEach(() => {
  chromeBeforeSuite = chromeSlot.chrome;
  chromeSlot.chrome = {
    storage: {
      local: {
        get: (_keys: unknown, cb: (res: Record<string, unknown>) => void) =>
          cb({ apiKey: SYNTHETIC_PROXY_KEY }),
      },
    },
  };
});

test.afterEach(() => {
  chromeSlot.chrome = chromeBeforeSuite;
});

// ---------------------------------------------------------------------------
// 1. REASON_REQUEST -> fetch /reason
// ---------------------------------------------------------------------------
test("1. REASON_REQUEST executes fetch to /reason endpoint with exact payload", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; headers: HeadersInit; body: string }> = [];

  try {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        headers: init?.headers ?? {},
        body: String(init?.body ?? ""),
      });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          action: "click",
          element_id: 1,
          confidence: 0.95,
          task_id: "proxy-test-task",
          step_id: 1,
        }),
      } as Response;
    }) as typeof fetch;

    const res = await handleReasonRequest(
      { task_id: "proxy-test-task", elements: [] },
      "http://26.39.161.6:8787/reason",
      5000
    );

    assert.equal(res.ok, true);
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://26.39.161.6:8787/reason");
    const body = JSON.parse(calls[0].body);
    assert.equal(body.task_id, "proxy-test-task");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 2. COMPLETE_REQUEST -> fetch /complete
// ---------------------------------------------------------------------------
test("2. COMPLETE_REQUEST executes fetch to /complete endpoint", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];

  try {
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, message: "done" }),
      } as Response;
    }) as typeof fetch;

    const res = await handleCompleteRequest(
      { task_id: "proxy-test-task" },
      "http://26.39.161.6:8787/reason",
      5000
    );

    assert.equal(res.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0], "http://26.39.161.6:8787/complete");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 3. API key added when configured
// ---------------------------------------------------------------------------
test("3. API key is attached to X-API-Key header when configured in storage", async () => {
  const originalFetch = globalThis.fetch;
  const originalChrome = (globalThis as unknown as { chrome?: unknown }).chrome;
  const headersSent: Record<string, string>[] = [];

  try {
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: {
          get: (_keys: string[], cb: (res: Record<string, unknown>) => void) => {
            cb({ apiKey: "secret-key-12345", serverUrl: "http://26.39.161.6:8787/reason" });
          },
        },
      },
    };

    assert.equal(await getStoredApiKey(), "secret-key-12345");
    assert.equal(await getStoredServerUrl(), "http://26.39.161.6:8787/reason");

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      headersSent.push((init?.headers ?? {}) as Record<string, string>);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ action: "done", confidence: 1, task_id: "t1", step_id: 1 }),
      } as Response;
    }) as typeof fetch;

    const res = await handleReasonRequest({ task_id: "t1" });

    assert.equal(res.ok, true);
    assert.equal(headersSent.length, 1);
    assert.equal(headersSent[0]["X-API-Key"], "secret-key-12345");
  } finally {
    globalThis.fetch = originalFetch;
    (globalThis as unknown as { chrome?: unknown }).chrome = originalChrome;
  }
});

// ---------------------------------------------------------------------------
// 4. Missing API key fails fast — no unauthenticated request is sent
// ---------------------------------------------------------------------------
test("4. handleReasonRequest fails fast with auth_error when no key is configured (no network call)", async () => {
  const originalFetch = globalThis.fetch;
  const originalChrome = (globalThis as unknown as { chrome?: unknown }).chrome;
  let fetchCalls = 0;

  try {
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: {
          get: (_keys: string[], cb: (res: Record<string, unknown>) => void) => {
            cb({});
          },
        },
      },
    };

    assert.equal(await getStoredApiKey(), null);

    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return { ok: true, status: 200, text: async () => "{}" } as Response;
    }) as typeof fetch;

    const res = await handleReasonRequest({ task_id: "t1" });

    // Fails at the client boundary — the frozen server never sees an
    // unauthenticated request, and no empty X-API-Key header is fabricated.
    assert.equal(fetchCalls, 0, "must not make a network request without a key");
    assert.equal(res.ok, false);
    assert.equal(res.status, 0);
    assert.equal(res.errorClass, "auth_error");
    assert.equal(res.error, "missing_api_key");
  } finally {
    globalThis.fetch = originalFetch;
    (globalThis as unknown as { chrome?: unknown }).chrome = originalChrome;
  }
});

// ---------------------------------------------------------------------------
// 5. 401 propagated correctly
// ---------------------------------------------------------------------------
test("5. HTTP 401 Unauthorized is classified as http_401 error", async () => {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => "Invalid API Key",
    } as Response)) as typeof fetch;

    const res = await handleReasonRequest({ task_id: "t1" }, "http://26.39.161.6:8787/reason");

    assert.equal(res.ok, false);
    assert.equal(res.status, 401);
    assert.equal(res.error, "http_401");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 6. 422 propagated correctly
// ---------------------------------------------------------------------------
test("6. HTTP 422 Unprocessable Entity is classified as http_422 error", async () => {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 422,
      statusText: "Unprocessable Entity",
      text: async () => "Missing field",
    } as Response)) as typeof fetch;

    const res = await handleReasonRequest({ task_id: "t1" }, "http://26.39.161.6:8787/reason");

    assert.equal(res.ok, false);
    assert.equal(res.status, 422);
    assert.equal(res.error, "http_422");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 7. 502 propagated correctly
// ---------------------------------------------------------------------------
test("7. HTTP 502 Bad Gateway is classified as http_502 error", async () => {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      text: async () => "Ollama backend unreachable",
    } as Response)) as typeof fetch;

    const res = await handleReasonRequest({ task_id: "t1" }, "http://26.39.161.6:8787/reason");

    assert.equal(res.ok, false);
    assert.equal(res.status, 502);
    assert.equal(res.error, "http_502");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 8. 503 propagated correctly
// ---------------------------------------------------------------------------
test("8. HTTP 503 Service Unavailable is classified as http_503 error", async () => {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      text: async () => "Overloaded",
    } as Response)) as typeof fetch;

    const res = await handleReasonRequest({ task_id: "t1" }, "http://26.39.161.6:8787/reason");

    assert.equal(res.ok, false);
    assert.equal(res.status, 503);
    assert.equal(res.error, "http_503");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 9. network failure
// ---------------------------------------------------------------------------
test("9. Network connection failure returns network_error class", async () => {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;

    const res = await handleReasonRequest({ task_id: "t1" }, "http://26.39.161.6:8787/reason");

    assert.equal(res.ok, false);
    assert.equal(res.errorClass, "network_error");
    assert.equal(res.error, "network_error");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 10. timeout
// ---------------------------------------------------------------------------
test("10. Request timeout returns request_timeout class", async () => {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = (async () => {
      const err = new Error("Fetch action timeout");
      err.name = "AbortError";
      throw err;
    }) as typeof fetch;

    const res = await handleReasonRequest({ task_id: "t1" }, "http://26.39.161.6:8787/reason", 100);

    assert.equal(res.ok, false);
    assert.equal(res.errorClass, "request_timeout");
    assert.equal(res.error, "request_timeout");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 11. malformed service-worker response
// ---------------------------------------------------------------------------
test("11. Invalid JSON or empty response is safely contained as invalid_json / empty_response", async () => {
  const originalFetch = globalThis.fetch;

  try {
    // Empty body
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      text: async () => "  ",
    } as Response)) as typeof fetch;

    const emptyRes = await handleReasonRequest({ task_id: "t1" }, "http://26.39.161.6:8787/reason");
    assert.equal(emptyRes.ok, false);
    assert.equal(emptyRes.errorClass, "empty_response");

    // Invalid JSON
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      text: async () => "<html>500 Internal Error</html>",
    } as Response)) as typeof fetch;

    const invalidJsonRes = await handleReasonRequest({ task_id: "t1" }, "http://26.39.161.6:8787/reason");
    assert.equal(invalidJsonRes.ok, false);
    assert.equal(invalidJsonRes.errorClass, "invalid_json");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 12. Health check proxying
// ---------------------------------------------------------------------------
test("12. Health check proxy routes GET /health correctly", async () => {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = (async (url: string | URL | Request) => {
      assert.equal(String(url), "http://26.39.161.6:8787/health");
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: "ok" }),
      } as Response;
    }) as typeof fetch;

    const res = await handleHealthCheck("http://26.39.161.6:8787/reason");
    assert.equal(res.ok, true);
    assert.equal(res.data?.ok, true);
    assert.equal(res.data?.status, "ok");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 13. sanitized payload preserved exactly
// ---------------------------------------------------------------------------
test("13. Content script sends sanitized context via REASON_REQUEST and does not fetch directly", async () => {
  const originalFetch = globalThis.fetch;
  const originalChrome = (globalThis as unknown as { chrome?: unknown }).chrome;
  let directFetchCalled = false;
  const sentMessages: Array<{ type: string; payload: { payload: unknown } }> = [];

  try {
    globalThis.fetch = (async () => {
      directFetchCalled = true;
      throw new Error("Content script must not call fetch directly when proxy is active!");
    }) as typeof fetch;

    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: {
          get: (_keys: string[], cb: (res: Record<string, unknown>) => void) => cb({}),
          set: async () => undefined,
        },
      },
      runtime: {
        sendMessage: async (msg: { type: string; payload: { payload: unknown } }) => {
          sentMessages.push(msg);
          if (msg.type === "REASON_REQUEST") {
            const resp: ProxyResponse = {
              ok: true,
              status: 200,
              data: {
                action: "click",
                element_id: 1,
                confidence: 0.9,
                task_id: "proxy-test-task",
                step_id: 1,
              },
            };
            return resp;
          }
          return { ack: true };
        },
      },
    };

    const actionResult = await fetchAction(sampleContext);

    assert.equal(directFetchCalled, false, "Direct fetch must NOT be called by content script");
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].type, "REASON_REQUEST");
    assert.equal((actionResult as { action: string }).action, "click");
    assert.equal((actionResult as { elementId: number }).elementId, 1);
  } finally {
    globalThis.fetch = originalFetch;
    (globalThis as unknown as { chrome?: unknown }).chrome = originalChrome;
  }
});
