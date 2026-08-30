import { validateAction } from "../action/validator";
import { createDispatch } from "../action/dispatch";
import { fromWireActionResponse, type ActionRequest, type WireActionResponse } from "../action/types";
import { toWireSanitizedContext, type SanitizedContext } from "../privacy/sanitizedContext";
import { resolveElement } from "../perception/domCapture";
import { verifyAction } from "../pvm/verify";
import type { ActionSnapshot } from "../pvm/verify";
import type { VerificationResult } from "../pvm/types";

export const DEFAULT_SERVER_URL = "http://127.0.0.1:8787/reason";
export const DEFAULT_FETCH_TIMEOUT_MS = 18_000;

/**
 * Normalizes and validates a server URL.
 * Supports both local development (http://127.0.0.1:8787/reason) and
 * LAN-hosted endpoints (http://192.168.x.x:8787/reason).
 * Ensures safe HTTP/HTTPS schemes and auto-appends /reason if omitted.
 */
export function normalizeServerUrl(rawUrl?: string | null): string {
  if (!rawUrl || typeof rawUrl !== "string") {
    return DEFAULT_SERVER_URL;
  }
  let trimmed = rawUrl.trim();
  if (!trimmed) {
    return DEFAULT_SERVER_URL;
  }

  // Prepend http:// if scheme is missing
  if (!/^https?:\/\//i.test(trimmed)) {
    // Reject dangerous or non-http schemes
    if (/^[a-zA-Z0-9_-]+:/i.test(trimmed)) {
      console.warn("[pipeline] rejected non-http scheme in server URL:", trimmed);
      return DEFAULT_SERVER_URL;
    }
    trimmed = `http://${trimmed}`;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      console.warn("[pipeline] unsupported protocol:", parsed.protocol);
      return DEFAULT_SERVER_URL;
    }
    let pathname = parsed.pathname.replace(/\/+$/, "");
    if (!pathname || pathname === "/") {
      pathname = "/reason";
    } else if (!pathname.endsWith("/reason")) {
      pathname = `${pathname}/reason`;
    }
    parsed.pathname = pathname;
    return parsed.toString();
  } catch (err) {
    console.warn("[pipeline] invalid server URL syntax:", trimmed, err);
    return DEFAULT_SERVER_URL;
  }
}

/**
 * Derives the base /health endpoint from any configured /reason URL.
 */
export function getHealthEndpoint(serverUrl: string): string {
  try {
    const parsed = new URL(normalizeServerUrl(serverUrl));
    parsed.pathname = "/health";
    return parsed.toString();
  } catch {
    return "http://127.0.0.1:8787/health";
  }
}

/**
 * Non-invasive health check against the remote FastAPI server.
 * Never transmits user data, page content, or PII.
 */
export async function checkServerHealth(
  serverUrl?: string,
  timeoutMs: number = 4000
): Promise<{ ok: boolean; status?: string; latencyMs: number; error?: string }> {
  const targetUrl = getHealthEndpoint(serverUrl || (await getServerUrl()));
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("Health check timeout"), timeoutMs);

  try {
    const response = await fetch(targetUrl, {
      method: "GET",
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const latencyMs = Date.now() - startedAt;

    if (!response.ok) {
      return {
        ok: false,
        latencyMs,
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    const data = (await response.json()) as { status?: string };
    return {
      ok: data?.status === "ok",
      status: data?.status ?? "ok",
      latencyMs,
    };
  } catch (err) {
    clearTimeout(timeout);
    const latencyMs = Date.now() - startedAt;
    return {
      ok: false,
      latencyMs,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Reads the server URL from chrome.storage.local (key "serverUrl", set
 * via the popup), falling back to localhost.
 */
export async function getServerUrl(): Promise<string> {
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
 * SHA-256 of the exact bytes about to be sent, computed client-side
 * with the browser's own crypto API.
 */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function fetchAction(
  sanitized: SanitizedContext,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS
): Promise<ActionRequest | null> {
  const serverUrl = await getServerUrl();

  const wirePayload = toWireSanitizedContext(sanitized);
  const bodyJson = JSON.stringify(wirePayload);

  const sha256 = await sha256Hex(bodyJson);
  console.log(`%c[privacy-proof] outbound payload SHA-256: ${sha256}`, "font-weight:bold");
  console.log("[privacy-proof] exact bytes sent:", bodyJson);
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    await chrome.storage.local.set({ latestPayloadSha256: sha256 });
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort("Fetch action timeout"), timeoutMs);

  try {
    const response = await fetch(serverUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: bodyJson,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      console.error(
        `[pipeline] server rejected request (HTTP ${response.status}):`,
        errText
      );
      return null;
    }
    const raw = (await response.json()) as WireActionResponse;
    return fromWireActionResponse(raw);
  } catch (err) {
    clearTimeout(timeoutId);
    console.error("[pipeline] could not reach the server at", serverUrl, ":", err);
    return null;
  }
}

/**
 * Reads the target element's current value before execution, so the
 * verifier can compare it to the post-execution value. Only relevant
 * for type / type_secret — everything else returns null.
 */
function snapshotElementValue(action: ActionRequest): string | null {
  if (action.action !== "type" && action.action !== "type_secret") return null;
  if (action.elementId == null) return null;
  const el = resolveElement(action.elementId) as HTMLInputElement | null;
  return el?.value ?? null;
}

/**
 * The full fetch -> validate -> execute -> verify flow for ONE
 * server-proposed action. This is the wiring that connects every
 * already-built module into one working flow — see
 * docs/ARCHITECTURE.md's pipeline diagram.
 *
 * Exactly one action is executed per call, and it is executed exactly
 * once. There is deliberately no retry here: this function used to
 * re-enter itself when verification came back "ambiguous", which
 * re-ran fetch, validate AND execute, so every non-navigating action
 * was performed twice. verifyUrlChanged returns "ambiguous" for
 * anything that doesn't change the URL, so that path was the normal
 * case, not an edge case.
 *
 * "Ambiguous" means the verifier could not tell what happened — it is
 * not evidence that the action didn't land, and repeating a side effect
 * on the strength of it is unsafe for exactly the actions that matter
 * most (submit, purchase, send). Retry is therefore left to a caller
 * that can re-capture page state and ask for fresh reasoning;
 * pvm/recovery.ts still holds that policy and is intentionally not
 * consulted here, because this function cannot re-derive state.
 */
export async function runOneStep(sanitized: SanitizedContext): Promise<VerificationResult | null> {
  const action = await fetchAction(sanitized);
  if (!action) return null;

  const validation = validateAction(action, sanitized.taskId);
  if (!validation.ok) {
    console.warn("[pipeline] action rejected by validator:", validation.reason, action);
    return null;
  }

  const actionId = `${sanitized.taskId}:${action.stepId}`;

  // 'done' is a bare terminal signal — no browser interaction, no dispatch gate.
  // The loop in content/index.ts checks result.expected === "done" to terminate.
  if (action.action === "done") {
    const result: VerificationResult = {
      actionId,
      expected: "done",
      observed: "done",
      status: "success",
      latencyMs: 0,
    };
    console.log("[pipeline] done signal received — task complete");
    return result;
  }

  // Pre-execution snapshot — verifyAction compares this to post-execution state.
  const snapshot: ActionSnapshot = {
    urlBefore: location.href,
    scrollYBefore: (globalThis as unknown as { window?: { scrollY?: number } }).window?.scrollY ?? 0,
    elementValueBefore: snapshotElementValue(action),
    action,
    startedAt: Date.now(),
  };

  // One gate per server response — see action/dispatch.ts.
  const dispatch = createDispatch(actionId);
  await dispatch.run(action);

  // Per-action verification — see pvm/verify.ts.
  // Runs after execution and reports; it never triggers another execution.
  const result = verifyAction(actionId, snapshot);
  console.log("[pipeline] verification:", result);

  return result;
}
