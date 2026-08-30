import { validateAction } from "../action/validator";
import { createDispatch } from "../action/dispatch";
import { fromWireActionResponse, type ActionRequest, type WireActionResponse } from "../action/types";
import { toWireSanitizedContext, type SanitizedContext } from "../privacy/sanitizedContext";
import { resolveElement } from "../perception/domCapture";
import { verifyAction, verifyLevel2Semantic } from "../pvm/verify";
import type { ActionSnapshot } from "../pvm/verify";
import type { VerificationResult } from "../pvm/types";
import { computeStateSignature, computeActionSignature, recordVerifiedOutcome } from "../pvm/memory";

// ---------------------------------------------------------------------------
// Phase 6 — StepError: structured failure carrier
// ---------------------------------------------------------------------------

/**
 * Returned by runOneStep when a failure has a specific, distinguishable root
 * cause that the agent loop should surface as a precise termination reason.
 *
 * Using a branded discriminant (`_stepError: true`) keeps the return type
 * backwards-compatible with injectable test mocks that still return
 * `VerificationResult | null` — neither of those shapes has this property.
 */
export interface StepError {
  readonly _stepError: true;
  /** Maps 1-to-1 to AgentLoopTerminationReason in agentLoop.ts */
  readonly reason: "server_error" | "validation_failed" | "execution_failed";
  /** Human-readable detail for logging / popup display. */
  readonly detail: string;
}

/** Helper so callers don't need to write the discriminant manually. */
export function stepError(
  reason: StepError["reason"],
  detail: string
): StepError {
  return { _stepError: true, reason, detail };
}

/** Type guard — true for StepError objects, false for VerificationResult / null. */
export function isStepError(v: unknown): v is StepError {
  return typeof v === "object" && v !== null && (v as StepError)._stepError === true;
}

/** The full result type of runOneStep — VerificationResult, StepError, or null. */
export type StepResult = VerificationResult | StepError | null;

export const DEFAULT_SERVER_URL = "http://127.0.0.1:8787/reason";
export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

/**
 * Normalizes user-entered or stored server URLs into a canonical format.
 * - Trims whitespace
 * - Adds http:// scheme if missing
 * - Replaces empty/root path with /reason
 * - Preserves explicit custom paths while guaranteeing /reason suffix
 */
export function normalizeServerUrl(url?: string): string {
  if (!url || typeof url !== "string") {
    return DEFAULT_SERVER_URL;
  }
  let trimmed = url.trim();
  if (!trimmed) {
    return DEFAULT_SERVER_URL;
  }

  // Prepend scheme if missing (e.g. "127.0.0.1:8787" or "192.168.1.100:8787")
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

/**
 * ISSUE-11: Validates the raw JSON value returned by the server
 * is structurally compatible with WireActionResponse before the
 * unchecked cast. Rejects responses with:
 *   - non-object shapes
 *   - missing required fields (action, confidence, task_id, step_id)
 *   - wrong types on those fields
 *
 * Returns a short diagnostic string on failure, or null on success.
 * Never logs or exposes the full raw response to avoid leaking
 * unexpected server content.
 */
function validateWireShape(raw: unknown): string | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return "response is not a JSON object";
  }
  const r = raw as Record<string, unknown>;
  if (typeof r["action"] !== "string") {
    return 'missing or non-string "action" field';
  }
  if (typeof r["confidence"] !== "number") {
    return 'missing or non-number "confidence" field';
  }
  if (typeof r["task_id"] !== "string") {
    return 'missing or non-string "task_id" field';
  }
  if (typeof r["step_id"] !== "number") {
    return 'missing or non-number "step_id" field';
  }
  return null;
}

export async function fetchAction(
  sanitized: SanitizedContext,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS
): Promise<ActionRequest | StepError> {
  const serverUrl = await getServerUrl();

  const wirePayload = toWireSanitizedContext(sanitized);
  const bodyJson = JSON.stringify(wirePayload);

  const sha256 = await sha256Hex(bodyJson);
  // ISSUE-08 invariant: only the SHA-256 hash is persisted to chrome.storage.local,
  // never the full payload JSON (latestPayloadJson must NOT be stored).
  // The console.log below is a debug-only audit trail visible in DevTools;
  // it is NOT written to any persistent storage.
  console.log(`%c[privacy-proof] outbound payload SHA-256: ${sha256}`, "font-weight:bold");
  console.log("[privacy-proof] exact bytes sent:", bodyJson);
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    // Store SHA-256 hash only — proof of what was sent, without raw payload retention.
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

    // ISSUE-11: HTTP error — classify by status code only. Do NOT log the
    // raw body: it may be an HTML error page, internal stack trace, or
    // other sensitive server content. The status code is sufficient for
    // diagnostics.
    if (!response.ok) {
      console.error(`[pipeline] server rejected request: HTTP ${response.status}`);
      return stepError("server_error", `http_${response.status}`);
    }

    // ISSUE-11: Read the raw body as text first so we can detect an empty
    // body before attempting JSON.parse (which would throw a cryptic error
    // whose message can leak partial response content in some runtimes).
    let rawText: string;
    try {
      rawText = await response.text();
    } catch (textErr) {
      console.error("[pipeline] failed to read response body:", textErr instanceof Error ? textErr.message : "unknown");
      return stepError("server_error", "response_body_unreadable");
    }

    if (!rawText || !rawText.trim()) {
      console.error("[pipeline] server returned an empty response body (HTTP 200)");
      return stepError("server_error", "empty_response");
    }

    // ISSUE-11: Parse JSON with explicit error isolation. The parse-error
    // message is intentionally suppressed to prevent leaking partial
    // response content. We log only the failure class.
    let raw: unknown;
    try {
      raw = JSON.parse(rawText);
    } catch {
      console.error("[pipeline] server response is not valid JSON");
      return stepError("server_error", "invalid_json");
    }

    // ISSUE-11: Validate wire shape before the TypeScript cast.
    // Prevents a structurally invalid response from silently reaching
    // fromWireActionResponse and producing a malformed ActionRequest
    // that might partially pass validation (e.g. an action field of
    // the right type but wrong value, or missing required fields).
    const shapeError = validateWireShape(raw);
    if (shapeError) {
      console.error(`[pipeline] server response failed shape validation: ${shapeError}`);
      return stepError("server_error", `invalid_response_shape`);
    }

    return fromWireActionResponse(raw as WireActionResponse);
  } catch (err) {
    clearTimeout(timeoutId);
    // AbortController fires with reason "Fetch action timeout" (string or DOMException).
    const isTimeout =
      (err instanceof Error && err.name === "AbortError") ||
      (typeof err === "string" && err.includes("timeout"));
    if (isTimeout) {
      console.error("[pipeline] request timed out after", timeoutMs, "ms");
      return stepError("server_error", "request_timeout");
    }
    // Network-level failure (DNS, connection refused, etc.)
    console.error("[pipeline] network error reaching", serverUrl, ":", err instanceof Error ? err.message : "unknown");
    return stepError("server_error", "network_error");
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
 * Phase 6 — typed one-step runner used by the agent loop.
 *
 * Returns StepResult (VerificationResult | StepError | null) so the loop can
 * surface precise termination reasons ("validation_failed", "execution_failed",
 * "server_error") rather than collapsing all failures to a bare null.
 *
 * The real pipeline (fetch → validate → execute → verify → escalation → learning) lives here.
 * All existing modules are reused; execution throws are caught as typed StepErrors.
 */
export async function runOneStepTyped(sanitized: SanitizedContext): Promise<StepResult> {
  // ---- Fetch from reasoning server ----
  const fetchResult = await fetchAction(sanitized);
  // ISSUE-11: fetchAction now returns StepError directly on any failure,
  // so we propagate it immediately without re-wrapping.
  if (isStepError(fetchResult)) {
    return fetchResult;
  }
  const action = fetchResult;

  // ---- Existing validator — never execute on a rejected action ----
  const validation = validateAction(action, sanitized.taskId);
  if (!validation.ok) {
    console.warn("[pipeline] action rejected by validator:", validation.reason, action);
    return stepError(
      "validation_failed",
      `Validator rejected action (${action.action}): ${validation.reason}`
    );
  }

  const actionId = `${sanitized.taskId}:${action.stepId}`;

  // 'done' is a bare terminal signal — no browser interaction, no dispatch gate.
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

  // ---- One-gate executor — catch throws so the loop gets a clean StepError ----
  // dispatch.run() calls executeAction() which interacts with the browser DOM.
  // Any uncaught throw (e.g. DOM exception, permission denied) is an
  // execution_failed — the agent loop must not crash or retry the same action.
  const dispatch = createDispatch(actionId);
  try {
    await dispatch.run(action);
  } catch (execErr) {
    console.error("[pipeline] execution error for", actionId, ":", execErr);
    return stepError(
      "execution_failed",
      `Browser execution threw for action ${action.action}: ${String(execErr)}`
    );
  }

  // ---- Level-1 Snapshot-Based Deterministic Verification (exactly once) ----
  let result = verifyAction(actionId, snapshot);

  // ---- Level 2/3 Escalation — invoked only when L1 is non-success ----
  if (result.status !== "success") {
    const selector = action.elementId != null
      ? `[data-privy-id="${action.elementId}"]`
      : null;

    // Level 2 — Semantic escalation for type actions where text content matches
    if (selector && action.action === "type" && action.value) {
      const l2Result = verifyLevel2Semantic(actionId, selector, {
        expectedTextPattern: action.value,
      });
      if (l2Result.status === "success") {
        result = {
          ...l2Result,
          l1LatencyMs: result.latencyMs,
          l2LatencyMs: l2Result.latencyMs,
          escalatedFromLevel: "L1",
          evidence: [...(result.evidence || []), ...(l2Result.evidence || [])],
        };
      }
    }
  }

  console.log("[pipeline] verification:", result);

  // ---- PVM Memory Learning (Positive Invariant: only verified successes enter memory) ----
  if (result.status === "success") {
    const stateSig = computeStateSignature({
      url: sanitized.urlOrigin,
      title: sanitized.page,
      elements: sanitized.elements,
    });
    const actionSig = computeActionSignature({
      action: action.action,
      targetElementId: action.elementId ?? null,
      valueRef: action.valueRef ?? null,
      direction: action.direction ?? null,
      amount: action.amount ?? null,
      url: action.url ?? null,
    });

    recordVerifiedOutcome({
      taskId: sanitized.taskId,
      stateSignature: stateSig,
      actionSignature: actionSig,
      actionType: action.action,
      targetElementId: action.elementId ?? null,
      verificationResult: result,
      confidence: action.confidence,
      taskScope: sanitized.task,
    }).catch((err) => {
      console.warn("[pipeline] PVM memory persistence error (non-fatal):", err instanceof Error ? err.message : String(err));
    });
  }

  return result;
}

/**
 * Backwards-compatible one-step runner used by pipeline.test.ts and any
 * caller that expects `VerificationResult | null`.
 *
 * Delegates to runOneStepTyped and converts StepError → null so existing
 * callers are unaffected by the Phase 6 type change.
 */
export async function runOneStep(sanitized: SanitizedContext): Promise<VerificationResult | null> {
  const result = await runOneStepTyped(sanitized);
  if (isStepError(result)) {
    return null;
  }
  return result;
}
