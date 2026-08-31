import { validateAction } from "../action/validator";
import { createDispatch } from "../action/dispatch";
import { fromWireActionResponse, type ActionRequest, type WireActionResponse } from "../action/types";
import { toWireSanitizedContext, type SanitizedContext } from "../privacy/sanitizedContext";
import { resolveElement, resolveTargetSettled, isUsableTarget } from "../perception/domCapture";
import { verifyActionSettled, verifyLevel2Semantic, makeTargetBaseline } from "../pvm/verify";
import type { ActionSnapshot } from "../pvm/verify";
import type { VerificationResult } from "../pvm/types";
import { computeStateSignature, computeActionSignature, recordVerifiedOutcome, fnv1aHash, canonicalizeJson } from "../pvm/memory";
import { sendMessage, type ProxyResponse } from "../messaging/bus";

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
  readonly reason: "server_error" | "validation_failed" | "execution_failed" | "no_progress";
  /**
   * Fine-grained, machine-readable cause code. For "server_error" this is one
   * of: http_<code> | network_error | request_timeout | invalid_json |
   * empty_response | invalid_response_shape | response_body_unreadable. For the
   * other reasons it is the validator / executor message.
   */
  readonly detail: string;
  /** HTTP status from the /reason call, present only for an HTTP-level failure. */
  readonly httpStatus?: number | null;
  /** Safe, slug-shaped error code from the server body, when the proxy recovered one. */
  readonly serverErrorCode?: string;
  /** Bounded, allow-listed detail string from the server body, when available. */
  readonly serverDetail?: string;
}

/** Optional diagnostic fields threaded through from the service-worker proxy. */
export interface StepErrorExtra {
  httpStatus?: number | null;
  serverErrorCode?: string;
  serverDetail?: string;
}

/** Helper so callers don't need to write the discriminant manually. */
export function stepError(
  reason: StepError["reason"],
  detail: string,
  extra?: StepErrorExtra
): StepError {
  return {
    _stepError: true,
    reason,
    detail,
    ...(extra?.httpStatus !== undefined ? { httpStatus: extra.httpStatus } : {}),
    ...(extra?.serverErrorCode ? { serverErrorCode: extra.serverErrorCode } : {}),
    ...(extra?.serverDetail ? { serverDetail: extra.serverDetail } : {}),
  };
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

  if (typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.sendMessage === "function") {
    try {
      const res = (await sendMessage({
        type: "HEALTH_CHECK",
        payload: {
          serverUrl: targetUrl,
          timeoutMs,
        },
      })) as ProxyResponse<{ ok: boolean; status?: string; latencyMs: number }> | undefined;

      if (res && typeof res === "object" && "ok" in res) {
        if (res.ok && res.data) {
          return res.data;
        }
        return {
          ok: false,
          latencyMs: 0,
          error: res.error || res.errorClass || "Health check failed",
        };
      }
    } catch (err) {
      console.warn("[pipeline] health check proxy fallback:", err);
    }
  }

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

  // MV3 Architecture: Content scripts in HTTPS pages cannot make cross-origin / plaintext HTTP
  // network requests due to browser Mixed Content & CORS boundaries. Delegate the network
  // request to the background service worker using host_permissions.
  if (typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.sendMessage === "function") {
    try {
      const res = (await sendMessage({
        type: "REASON_REQUEST",
        payload: {
          payload: wirePayload as unknown as Record<string, unknown>,
          serverUrl,
          timeoutMs,
        },
      })) as ProxyResponse | undefined;

      if (res && typeof res === "object" && "ok" in res) {
        if (!res.ok) {
          console.error(
            `[pipeline] server error via proxy: ${res.errorClass || "unknown"} (${res.error})` +
              ` status=${res.status ?? 0}` +
              (res.serverErrorCode ? ` code=${res.serverErrorCode}` : "") +
              (res.serverDetail ? ` detail=${res.serverDetail}` : "")
          );
          return stepError(
            "server_error",
            res.error || res.errorClass || "network_error",
            {
              httpStatus: res.status ?? null,
              serverErrorCode: res.serverErrorCode,
              serverDetail: res.serverDetail,
            }
          );
        }

        const shapeError = validateWireShape(res.data);
        if (shapeError) {
          console.error(`[pipeline] server response failed shape validation: ${shapeError}`);
          return stepError("server_error", "invalid_response_shape");
        }

        return fromWireActionResponse(res.data as WireActionResponse);
      }
    } catch (msgErr) {
      console.warn("[pipeline] service worker proxy unavailable, falling back to direct fetch:", msgErr);
    }
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
      return stepError("server_error", `http_${response.status}`, { httpStatus: response.status });
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
/**
 * Structural + semantic fingerprint of exactly what the model was shown.
 *
 * Unlike the PVM-memory state signature (ids/roles only, origin-level URL),
 * this deliberately includes accessible labels and value_state, because those
 * are where real progress usually shows up: a cart badge incrementing, a button
 * flipping to "Added", a field filling in, a new control appearing. Without
 * them a page that genuinely changed looked "effectively unchanged" and the
 * same action was requested again.
 *
 * Output is a hash — no raw label text is retained or transmitted.
 */
export function progressStateSignatureFor(sanitized: SanitizedContext): string {
  const els = sanitized.elements
    .map((e) => ({ i: e.elementId, r: e.role, l: e.label ?? null, v: e.valueState ?? null }))
    .sort((a, b) => a.i - b.i);
  return `prog_${fnv1aHash(canonicalizeJson({ o: sanitized.urlOrigin, p: sanitized.page, e: els }))}`;
}

/** The (state, action) pair the no-progress guard compares between steps. */
export interface ProgressSignature {
  state: string;
  action: string;
}

export async function runOneStepTyped(
  sanitized: SanitizedContext,
  isAborted?: () => boolean,
  lastAmbiguous?: ProgressSignature | null
): Promise<StepResult> {
  // ---- Fetch from reasoning server ----
  const fetchResult = await fetchAction(sanitized);
  // ISSUE-11: fetchAction now returns StepError directly on any failure,
  // so we propagate it immediately without re-wrapping.
  if (isStepError(fetchResult)) {
    return fetchResult;
  }
  const action = fetchResult;

  // ---- Repeated-ambiguous guard (pre-dispatch) ----
  // The previous step's effect could not be confirmed (PVM `ambiguous`). If the
  // model now asks for the SAME action against a page whose model-visible state
  // is byte-identical, re-running it cannot produce new information — and for a
  // side-effecting control (an "add" button, a submit) it would repeat a real
  // action the user never asked for twice. Refuse BEFORE dispatch. Any change to
  // the page, the target, or the requested action clears this and proceeds.
  const progress: ProgressSignature = {
    state: progressStateSignatureFor(sanitized),
    action: computeActionSignature({
      action: action.action,
      targetElementId: action.elementId ?? null,
      valueRef: action.valueRef ?? null,
      direction: action.direction ?? null,
      amount: action.amount ?? null,
      url: action.url ?? null,
    }),
  };
  if (
    lastAmbiguous &&
    lastAmbiguous.state === progress.state &&
    lastAmbiguous.action === progress.action
  ) {
    console.warn("[pipeline] refusing to re-dispatch an unconfirmed action on an unchanged page");
    return stepError("no_progress", "identical action re-requested after an unconfirmed (ambiguous) step");
  }

  // ---- Pre-execution live target resolution (Phase 3, steps 6–7) ----
  // The model reasoned over a capture that is now seconds old. Before the
  // validator or executor touch the DOM, re-resolve element-targeted actions
  // against the CURRENT page: if the numeric id went stale because the node
  // was replaced, deterministically re-find the same control by its captured
  // role + accessible name; refuse to act if it vanished or if more than one
  // equivalent now exists. On success the id is stamped back onto the live
  // node so the validator, executor and PVM all operate the same element.
  const targeted =
    (action.action === "click" || action.action === "type" || action.action === "type_secret") &&
    action.elementId != null;
  // The element the model was actually shown. When the id is absent from the
  // context it reasoned over there is no trustworthy role/label for it, so
  // recovery runs in `strict` mode: direct resolution only, never invented from
  // a previous capture's metadata.
  const expectedEl = targeted
    ? sanitized.elements.find((e) => e.elementId === action.elementId)
    : undefined;
  const expected = { role: expectedEl?.role ?? null, label: expectedEl?.label ?? null };
  const strict = targeted && !expectedEl;
  let resolvedTarget: Element | null = null;

  if (targeted) {
    const resolution = await resolveTargetSettled(action.elementId!, expected, { strict });
    if (resolution.status === "missing") {
      console.warn("[pipeline] target lost before execution:", action.elementId, action.action);
      return stepError("validation_failed", strict ? "target_not_in_context" : "target_lost");
    }
    if (resolution.status === "ambiguous") {
      console.warn(
        "[pipeline] target ambiguous before execution:", action.elementId,
        "candidates:", resolution.candidates
      );
      return stepError("validation_failed", "target_ambiguous");
    }
    if (resolution.status === "resolved") {
      resolvedTarget = resolution.element;
      if (resolution.recovered) {
        console.log("[pipeline] recovered stale target via role+label:", action.elementId);
      }
    }
  }

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

  // Pre-execution snapshot — verifyActionSettled compares this to post-execution
  // state. targetBefore is the minimal bounded baseline for async in-page
  // signals (aria flips, on-target label change, a controlled region opening).
  const snapshot: ActionSnapshot = {
    urlBefore: location.href,
    scrollYBefore: (globalThis as unknown as { window?: { scrollY?: number } }).window?.scrollY ?? 0,
    elementValueBefore: snapshotElementValue(action),
    action,
    startedAt: Date.now(),
    targetBefore: action.elementId != null ? makeTargetBaseline(action.elementId) : null,
  };

  // ---- Render/rerender protection ----
  // Validation and baseline capture happen between resolution and execution,
  // and a framework can detach or repurpose the node in that window. Acting on
  // such a node silently does nothing and shows up as an endless run of
  // `ambiguous` steps. Re-check, and re-resolve exactly ONCE — never a loop.
  if (targeted && resolvedTarget && !isUsableTarget(resolvedTarget, expected.role)) {
    console.warn("[pipeline] target changed after resolution — re-resolving once:", action.elementId);
    const again = await resolveTargetSettled(action.elementId!, expected, { strict });
    if (again.status === "missing") {
      return stepError("validation_failed", strict ? "target_not_in_context" : "target_lost");
    }
    if (again.status === "ambiguous") {
      return stepError("validation_failed", "target_ambiguous");
    }
    if (again.status === "resolved") resolvedTarget = again.element;
  }

  // ---- C7 — the loop abandoned this step (step-timeout / task-timeout).
  // Do NOT perform the side-effecting action for a step nobody is waiting on.
  if (isAborted?.()) {
    console.warn("[pipeline] step aborted before execution —", actionId);
    return stepError("execution_failed", "step_aborted");
  }

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
  // Bounded async settle: returns instantly on strong evidence; "no observable
  // change" still resolves to `ambiguous`, never success.
  let result = await verifyActionSettled(actionId, snapshot);

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

  // C10 — attach a (state, action) fingerprint so the task loop can detect a
  // model stuck repeating the same action on an unchanged page. Computed for
  // every non-terminal outcome (verified / ambiguous); the `done` path returned
  // earlier and failures return a StepError, so neither is annotated. These are
  // structural hashes only — no raw values — and PVM ignores them entirely.
  result.progressStateSignature = progress.state;
  result.progressActionSignature = progress.action;

  // Safe target metadata for history. The label is taken from the SANITIZED
  // context, so a sensitive field contributes its redaction token, never a value.
  result.actionType = action.action;
  result.targetElementId = action.elementId ?? null;
  result.targetLabel =
    action.elementId != null
      ? sanitized.elements.find((e) => e.elementId === action.elementId)?.label ?? null
      : null;

  // PVM memory keeps its own, unchanged signature scheme.
  const stateSig = computeStateSignature({
    url: sanitized.urlOrigin,
    title: sanitized.page,
    elements: sanitized.elements,
  });
  const actionSig = progress.action;

  // ---- PVM Memory Learning (Positive Invariant: only verified successes enter memory) ----
  if (result.status === "success") {
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

// ---------------------------------------------------------------------------
// Observable step outcome — diagnostics-preserving view for the task loop
// ---------------------------------------------------------------------------

/**
 * The layer/cause a step failed at, derived losslessly from StepError +
 * VerificationResult. This is what the loop, activeTask and popup carry so a
 * failure is no longer collapsed to "server error or validator rejection".
 */
export type StepFailureReason =
  | "server_unreachable"        // network error reaching /reason
  | "server_timeout"           // /reason did not answer within the fetch budget
  | "server_http_error"        // /reason answered with a non-2xx (see httpStatus / serverErrorCode)
  | "auth_failed"              // API key missing locally, or rejected by the server (HTTP 401/403)
  | "malformed_model_response" // 2xx body was empty / non-JSON / wrong shape
  | "validation_failed"        // local action validator rejected the action
  | "execution_failed"         // executor threw while interacting with the page
  | "verification_failed"      // PVM verified the action did not take effect
  | "no_progress";             // identical action re-requested against an unchanged page

/**
 * Discriminated result the task loop consumes. Mirrors what runOneStepTyped
 * already computes — success / ambiguous / done / typed failure — without
 * discarding the reason the way runOneStep()'s `null` did.
 */
export type StepOutcome =
  | { kind: "verified"; verification: VerificationResult }
  | { kind: "ambiguous"; verification: VerificationResult }
  | { kind: "done"; verification: VerificationResult }
  | {
      kind: "failed";
      reason: StepFailureReason;
      /** Short, safe cause code / message. Never a raw response body. */
      detail: string;
      /** Present when reason === "server_http_error". */
      httpStatus?: number | null;
      /** Safe server slug, when the proxy recovered one. */
      serverErrorCode?: string;
      /** Bounded server detail, when available. */
      serverDetail?: string;
      /** The verification record, when the failure came from PVM. */
      verification?: VerificationResult;
    };

/** Maps a StepError's coarse reason + cause code onto a StepFailureReason. */
export function classifyStepError(e: StepError): Extract<StepOutcome, { kind: "failed" }> {
  if (e.reason === "validation_failed") {
    return { kind: "failed", reason: "validation_failed", detail: e.detail };
  }
  if (e.reason === "execution_failed") {
    return { kind: "failed", reason: "execution_failed", detail: e.detail };
  }
  if (e.reason === "no_progress") {
    return { kind: "failed", reason: "no_progress", detail: e.detail };
  }

  // e.reason === "server_error" — split by the fine-grained cause code.
  const code = e.detail;
  const shared = {
    detail: code,
    httpStatus: e.httpStatus ?? null,
    serverErrorCode: e.serverErrorCode,
    serverDetail: e.serverDetail,
  };
  // Authentication: local key not configured (fast-fail, no HTTP status) or the
  // server rejected the key (HTTP 401/403). A precise client classification —
  // never collapse this into a generic server/model failure.
  if (code === "missing_api_key") {
    return {
      kind: "failed",
      reason: "auth_failed",
      detail: code,
      httpStatus: null,
      serverErrorCode: e.serverErrorCode,
      serverDetail: e.serverDetail,
    };
  }
  if (code === "http_401" || code === "http_403") {
    return {
      kind: "failed",
      reason: "auth_failed",
      ...shared,
      httpStatus: e.httpStatus ?? (code === "http_401" ? 401 : 403),
    };
  }
  if (code === "network_error") {
    return { kind: "failed", reason: "server_unreachable", ...shared };
  }
  if (code === "request_timeout") {
    return { kind: "failed", reason: "server_timeout", ...shared };
  }
  if (code.startsWith("http_")) {
    const parsed = Number(code.slice("http_".length));
    return {
      kind: "failed",
      reason: "server_http_error",
      ...shared,
      httpStatus: e.httpStatus ?? (Number.isFinite(parsed) ? parsed : null),
    };
  }
  // invalid_json | empty_response | invalid_response_shape | response_body_unreadable
  return { kind: "failed", reason: "malformed_model_response", ...shared };
}

/**
 * Runs one step and reports a diagnostics-preserving StepOutcome.
 *
 * Behaviourally identical to runOneStepTyped — it only reshapes the result so
 * the task loop can halt where it always halted while keeping the real reason.
 */
export async function runStepObserved(
  sanitized: SanitizedContext,
  isAborted?: () => boolean,
  lastAmbiguous?: ProgressSignature | null
): Promise<StepOutcome> {
  const typed = await runOneStepTyped(sanitized, isAborted, lastAmbiguous);

  if (isStepError(typed)) {
    return classifyStepError(typed);
  }
  if (typed === null) {
    // runOneStepTyped never returns null in production; treat defensively.
    return { kind: "failed", reason: "malformed_model_response", detail: "empty_result" };
  }
  if (typed.expected === "done") {
    return { kind: "done", verification: typed };
  }
  if (typed.status === "success") {
    return { kind: "verified", verification: typed };
  }
  if (typed.status === "failure") {
    return {
      kind: "failed",
      reason: "verification_failed",
      detail: typed.observed,
      verification: typed,
    };
  }
  return { kind: "ambiguous", verification: typed };
}
