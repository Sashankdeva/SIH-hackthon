import {
  onMessage,
  type ProxyResponse,
  type ReasonRequestPayload,
  type CompleteRequestPayload,
  type HealthCheckPayload,
} from "../messaging/bus";
import { normalizeServerUrl, getHealthEndpoint, DEFAULT_SERVER_URL } from "../content/pipeline";

/**
 * Reads the server URL from chrome.storage.local (key "serverUrl"),
 * falling back to the canonical DEFAULT_SERVER_URL.
 */
export async function getStoredServerUrl(): Promise<string> {
  return new Promise((resolve) => {
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      resolve(DEFAULT_SERVER_URL);
      return;
    }
    chrome.storage.local.get(["serverUrl"], (result) => {
      resolve(normalizeServerUrl(result?.serverUrl as string | undefined));
    });
  });
}

/**
 * Reads the configured API key from chrome.storage.local (key "apiKey" or "userApiKey").
 * Returns null if not configured or empty.
 */
export async function getStoredApiKey(): Promise<string | null> {
  return new Promise((resolve) => {
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      resolve(null);
      return;
    }
    chrome.storage.local.get(["apiKey", "userApiKey"], (result) => {
      const raw = (result?.apiKey ?? result?.userApiKey) as string | undefined;
      if (raw && typeof raw === "string" && raw.trim()) {
        resolve(raw.trim());
      } else {
        resolve(null);
      }
    });
  });
}

/**
 * HTTP error statuses we surface as a stable normalized slug (`http_<code>`).
 * Anything outside this set collapses to the generic `http_error` so an
 * unexpected status can never turn into an unbounded string in the UI.
 */
const KNOWN_HTTP_ERROR_STATUSES = new Set([
  400, 401, 403, 404, 408, 409, 410, 413, 415, 422, 429, 500, 502, 503, 504,
]);

/** Server error slugs we are willing to forward a bounded `detail` string for. */
const DETAIL_ALLOWED_SERVER_CODES = new Set(["invalid_request", "action_rejected"]);

/** Hard cap on any server-provided detail string that reaches the UI. */
const MAX_SERVER_DETAIL_CHARS = 300;

/** Largest error body we will even attempt to parse (HTML error pages are ignored). */
const MAX_ERROR_BODY_CHARS = 4096;

/** `http_401` / `http_422` / … for known statuses, else `http_error`. */
export function normalizeHttpErrorCode(status: number): string {
  return KNOWN_HTTP_ERROR_STATUSES.has(status) ? `http_${status}` : "http_error";
}

/**
 * Extracts a SAFE, bounded error representation from a server error body
 * without ever forwarding the raw body.
 *
 *   code   — the server's `error` field, only when it is a short slug
 *            (/^[a-z0-9_]{1,40}$/). Enum-shaped values carry no user data.
 *   detail — the server's `detail` field, only when `code` is allow-listed,
 *            whitespace-collapsed and truncated to MAX_SERVER_DETAIL_CHARS.
 *
 * Anything unexpected (non-JSON, array, oversized, free-form `error`) yields
 * an empty result — callers fall back to the normalized `http_<code>` slug.
 */
export function extractSafeServerError(bodyText: string | null | undefined): {
  code?: string;
  detail?: string;
} {
  if (!bodyText || bodyText.length > MAX_ERROR_BODY_CHARS) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const rec = parsed as Record<string, unknown>;
  const rawCode = rec["error"];
  if (typeof rawCode !== "string" || !/^[a-z0-9_]{1,40}$/.test(rawCode)) return {};
  const out: { code?: string; detail?: string } = { code: rawCode };
  if (DETAIL_ALLOWED_SERVER_CODES.has(rawCode) && typeof rec["detail"] === "string") {
    const trimmed = rec["detail"].replace(/\s+/g, " ").trim().slice(0, MAX_SERVER_DETAIL_CHARS);
    if (trimmed) out.detail = trimmed;
  }
  return out;
}

/**
 * Executes a remote JSON POST request under the service worker's host_permissions context,
 * bypassing webpage CORS and Mixed Content (HTTPS -> HTTP) restrictions.
 * Never logs raw request bodies, API keys, or raw server stack traces.
 */
export async function executeRemoteJsonPost(
  targetUrl: string,
  payload: Record<string, unknown>,
  apiKey?: string | null,
  timeoutMs: number = 10_000
): Promise<ProxyResponse> {
  const bodyJson = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey && typeof apiKey === "string" && apiKey.trim()) {
    headers["X-API-Key"] = apiKey.trim();
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort("Fetch timeout"), timeoutMs);

  try {
    const response = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: bodyJson,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      const status = response.status;
      // Preserve the HTTP status and a bounded/allow-listed error representation.
      // Best-effort read of the error body ONLY to recover a safe server error
      // slug + detail — the raw body is never forwarded.
      let safe: { code?: string; detail?: string } = {};
      try {
        safe = extractSafeServerError(await response.text());
      } catch {
        // Unreadable body — the normalized http_<code> slug is enough.
      }
      console.error(
        `[background] server rejected request: HTTP ${status}` +
          (safe.code ? ` (${safe.code})` : "")
      );
      const proxyError: ProxyResponse = {
        ok: false,
        status,
        // A 401/403 from the reasoning server is an authentication failure —
        // classify it distinctly so the client surfaces "check the API key"
        // rather than a generic HTTP/model error. `error` keeps the stable
        // `http_<code>` slug so existing status-based diagnostics are unchanged.
        errorClass: status === 401 || status === 403 ? "auth_error" : "http_error",
        error: normalizeHttpErrorCode(status),
      };
      if (safe.code) proxyError.serverErrorCode = safe.code;
      if (safe.detail) proxyError.serverDetail = safe.detail;
      return proxyError;
    }

    let rawText: string;
    try {
      rawText = await response.text();
    } catch (textErr) {
      console.error("[background] failed to read response body:", textErr instanceof Error ? textErr.message : "unknown");
      return {
        ok: false,
        status: response.status,
        errorClass: "server_error",
        error: "response_body_unreadable",
      };
    }

    if (!rawText || !rawText.trim()) {
      console.error("[background] server returned an empty response body (HTTP 200)");
      return {
        ok: false,
        status: response.status,
        errorClass: "empty_response",
        error: "empty_response",
      };
    }

    let rawJson: unknown;
    try {
      rawJson = JSON.parse(rawText);
    } catch {
      console.error("[background] server response is not valid JSON");
      return {
        ok: false,
        status: response.status,
        errorClass: "invalid_json",
        error: "invalid_json",
      };
    }

    return {
      ok: true,
      status: response.status,
      data: rawJson,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const isTimeout =
      (err instanceof Error && err.name === "AbortError") ||
      (typeof err === "string" && err.includes("timeout"));
    if (isTimeout) {
      console.error("[background] request timed out after", timeoutMs, "ms");
      return {
        ok: false,
        status: 0,
        errorClass: "request_timeout",
        error: "request_timeout",
      };
    }
    console.error("[background] network error reaching server:", err instanceof Error ? err.message : "unknown");
    return {
      ok: false,
      status: 0,
      errorClass: "network_error",
      error: "network_error",
    };
  }
}

/**
 * Handles REASON_REQUEST: fetches /reason on configured server.
 */
export async function handleReasonRequest(
  payload: Record<string, unknown>,
  customServerUrl?: string,
  timeoutMs: number = 10_000
): Promise<ProxyResponse> {
  const serverUrl = customServerUrl
    ? normalizeServerUrl(customServerUrl)
    : await getStoredServerUrl();
  const apiKey = await getStoredApiKey();

  // The frozen server enforces X-API-Key on /reason. If no key is configured,
  // fail HERE — before any network request — with a typed client-configuration
  // error. Never send an unauthenticated request and never fabricate an empty
  // header: that would only produce an opaque 401 and could mask a real config
  // problem as a server fault.
  if (!apiKey) {
    return {
      ok: false,
      status: 0,
      errorClass: "auth_error",
      error: "missing_api_key",
    };
  }

  return executeRemoteJsonPost(serverUrl, payload, apiKey, timeoutMs);
}

/**
 * Handles COMPLETE_REQUEST: fetches /complete on configured server.
 */
export async function handleCompleteRequest(
  payload: Record<string, unknown>,
  customServerUrl?: string,
  timeoutMs: number = 10_000
): Promise<ProxyResponse> {
  const baseUrl = customServerUrl
    ? normalizeServerUrl(customServerUrl)
    : await getStoredServerUrl();
  const completeUrl = baseUrl.replace(/\/reason\/?$/, "/complete");
  const apiKey = await getStoredApiKey();

  // Same authenticated boundary as /reason — fail fast on a missing key rather
  // than downgrading to an unauthenticated request. (The client does not call
  // /complete today; this keeps the shared helper correct if it ever does.)
  if (!apiKey) {
    return {
      ok: false,
      status: 0,
      errorClass: "auth_error",
      error: "missing_api_key",
    };
  }

  return executeRemoteJsonPost(completeUrl, payload, apiKey, timeoutMs);
}

/**
 * Handles HEALTH_CHECK: fetches /health on configured server.
 */
export async function handleHealthCheck(
  customServerUrl?: string,
  timeoutMs: number = 4_000
): Promise<ProxyResponse<{ ok: boolean; status?: string; latencyMs: number }>> {
  const baseUrl = customServerUrl
    ? normalizeServerUrl(customServerUrl)
    : await getStoredServerUrl();
  const healthUrl = getHealthEndpoint(baseUrl);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort("Health check timeout"), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(healthUrl, {
      method: "GET",
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const latencyMs = Date.now() - startedAt;

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        errorClass: "http_error",
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    const data = (await response.json()) as { status?: string };
    return {
      ok: data?.status === "ok",
      status: 200,
      data: {
        ok: data?.status === "ok",
        status: data?.status ?? "ok",
        latencyMs,
      },
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const isTimeout =
      (err instanceof Error && err.name === "AbortError") ||
      (typeof err === "string" && err.includes("timeout"));
    return {
      ok: false,
      status: 0,
      errorClass: isTimeout ? "request_timeout" : "network_error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * MV3 service workers are torn down after ~30s idle and wake with no
 * memory — never hold state in module-level variables here beyond a
 * single message-handling tick. Anything that must persist (for the
 * popup to read) goes to chrome.storage.local, not a variable in this
 * file. See PS26171_Role1_Extension.pdf, Day 2.
 */
onMessage((message, sender) => {
  if (!message || typeof message !== "object" || !("type" in message)) {
    return Promise.resolve({ ack: false, reason: "malformed message" });
  }

  switch (message.type) {
    case "PAGE_STATE":
      console.log("[background] page state from tab", sender.tab?.id, message.payload);
      return Promise.resolve({ ack: true });

    case "PRIVACY_REPORT":
      console.log("[background] privacy report", message.payload);
      return chrome.storage.local.set({
        latestPrivacyReport: message.payload,
        latestStatus: "allowed",
        updatedAt: Date.now(),
      });

    case "PRIVACY_BLOCKED":
      console.warn("[background] privacy firewall blocked a page", message.payload);
      return chrome.storage.local.set({
        latestStatus: "blocked",
        // ISSUE-17: store only missingElementIds — taskId is not read by the popup
        // and storing it is unnecessary structural metadata retention.
        latestBlockedPayload: { missingElementIds: (message.payload as { taskId: string; missingElementIds: number[] }).missingElementIds },
        updatedAt: Date.now(),
      });

    case "ACTION_REQUEST":
      console.log("[background] action request", message.payload);
      return Promise.resolve({ ack: true });

    case "ACTION_RESULT":
      console.log("[background] verification result", message.payload);
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        return chrome.storage.local.set({
          latestVerification: message.payload,
          updatedAt: Date.now(),
        }).then(() => ({ ack: true }));
      }
      return Promise.resolve({ ack: true });

    case "LIFECYCLE_EVENT":
      console.log("[background] lifecycle event from tab", sender.tab?.id, message.payload);
      return Promise.resolve({ ack: true, event: message.payload?.event });

    case "REASON_REQUEST": {
      const p = message.payload as ReasonRequestPayload;
      return handleReasonRequest(p.payload, p.serverUrl, p.timeoutMs);
    }

    case "COMPLETE_REQUEST": {
      const p = message.payload as CompleteRequestPayload;
      return handleCompleteRequest(p.payload, p.serverUrl, p.timeoutMs);
    }

    case "HEALTH_CHECK": {
      const p = message.payload as HealthCheckPayload;
      return handleHealthCheck(p.serverUrl, p.timeoutMs);
    }

    case "GET_TAB_ID":
      return Promise.resolve({ tabId: sender.tab?.id ?? null });

    default:
      return Promise.resolve({ ack: false, reason: "unknown message type" });
  }
});

/**
 * New-tab navigation handover.
 *
 * A click on a control with target="_blank" (or any control that calls
 * window.open) opens a NEW tab and leaves the original document untouched.
 * The task loop lives in the ORIGINAL tab's content script, so without this
 * the loop keeps running there, PVM correctly sees no change on the old page,
 * and the model re-issues the same click — spawning another tab every step
 * until the step budget is gone.
 *
 * When a tab is opened BY the tab that currently owns a live task, the task is
 * re-pointed at the new tab: the old tab's loop notices it no longer owns the
 * task and stops driving, and the new tab's content script resumes the SAME
 * taskId with a fresh capture. Entirely structural — this reads `openerTabId`
 * only, never a URL, hostname, or page content.
 */
export function handleTaskOpenedNewTab(openerTabId: number, newTabId: number): void {
  chrome.storage.local.get(["activeTask"], (res) => {
    const at = res?.activeTask as
      | { taskId?: string; status?: string; tabId?: number | null }
      | undefined;
    if (!at || typeof at !== "object" || typeof at.taskId !== "string") return;
    // Only a live task hands over; terminal tasks are never revived here.
    if (at.status !== "active" && at.status !== "navigating") return;
    // Only the tab that currently owns the task may hand it over.
    if (at.tabId == null || at.tabId !== openerTabId) return;

    const updated = { ...at, tabId: newTabId, status: "navigating", updatedAt: Date.now() };
    chrome.storage.local.set({ activeTask: updated }, () => {
      if (chrome.runtime.lastError) {
        console.error("[background] new-tab handover write failed:", chrome.runtime.lastError.message);
        return;
      }
      console.log("[background] task handed over from tab", openerTabId, "to new tab", newTabId);
    });
  });
}

if (typeof chrome !== "undefined" && chrome.tabs?.onCreated?.addListener) {
  chrome.tabs.onCreated.addListener((tab) => {
    const openerTabId = tab.openerTabId;
    const newTabId = tab.id;
    if (openerTabId == null || newTabId == null) return;
    handleTaskOpenedNewTab(openerTabId, newTabId);
  });
}

console.log("PrivyVision background service worker started.");
