import { validateAction } from "../action/validator";
import { createDispatch } from "../action/dispatch";
import { fromWireActionResponse, type ActionRequest, type WireActionResponse } from "../action/types";
import { toWireSanitizedContext, type SanitizedContext } from "../privacy/sanitizedContext";
import { resolveElement } from "../perception/domCapture";
import { verifyAction } from "../pvm/verify";
import type { ActionSnapshot } from "../pvm/verify";
import type { VerificationResult } from "../pvm/types";

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
function stepError(
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

const DEFAULT_SERVER_URL = "http://127.0.0.1:8787/reason";

/**
 * Reads the server URL from chrome.storage.local (key "serverUrl", set
 * via the popup), falling back to localhost. This is what makes
 * "demo on a laptop with no GPU" possible: point that laptop's
 * serverUrl at the GPU laptop's LAN IP (e.g.
 * "http://192.168.1.23:8787/reason") instead of running Ollama locally.
 *
 * That LAN IP must also be added to manifest.json's host_permissions
 * before rebuilding — Chrome blocks the fetch at the extension level
 * regardless of this setting if the origin isn't permitted. See
 * server/README.md, "Demoing without a local GPU."
 */
async function getServerUrl(): Promise<string> {
  return new Promise((resolve) => {
    chrome.storage.local.get(["serverUrl"], (result) => {
      resolve((result.serverUrl as string | undefined) || DEFAULT_SERVER_URL);
    });
  });
}

/**
 * SHA-256 of the exact bytes about to be sent, computed client-side
 * with the browser's own crypto API — not a claim, a value anyone can
 * recompute. The server independently computes the same hash over what
 * IT received (server/app/middleware.py) and logs it. If the two hashes
 * match, that's proof the payload wasn't altered or substituted in
 * transit; if you (or a skeptical examiner) diff the logged JSON
 * against the console output, that's proof of what it actually
 * contained. This is the client-side half of the demo verification
 * playbook — see docs/DEMO_VERIFICATION.md.
 */
async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function fetchAction(sanitized: SanitizedContext): Promise<ActionRequest | null> {
  const serverUrl = await getServerUrl();

  const wirePayload = toWireSanitizedContext(sanitized);
  const bodyJson = JSON.stringify(wirePayload);

  const sha256 = await sha256Hex(bodyJson);
  console.log(`%c[privacy-proof] outbound payload SHA-256: ${sha256}`, "font-weight:bold");
  console.log("[privacy-proof] exact bytes sent:", bodyJson);
  await chrome.storage.local.set({ latestPayloadSha256: sha256, latestPayloadJson: bodyJson });

  try {
    const response = await fetch(serverUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: bodyJson,
    });
    if (!response.ok) {
      console.error("[pipeline] server rejected the request:", response.status, await response.text());
      return null;
    }
    const raw = (await response.json()) as WireActionResponse;
    return fromWireActionResponse(raw);
  } catch (err) {
    console.error("[pipeline] could not reach the server — is it running at", serverUrl, "?", err);
    return null;
  }
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
 * The real pipeline (fetch → validate → execute → verify) lives here.
 * All existing modules are reused; this function only adds a try/catch
 * around execution and converts null/rejected paths to typed StepErrors.
 */
export async function runOneStepTyped(sanitized: SanitizedContext): Promise<StepResult> {
  // ---- Fetch from reasoning server ----
  const action = await fetchAction(sanitized);
  if (!action) {
    return stepError("server_error", "Could not reach the reasoning server or it returned a non-200 response.");
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

  // ---- Per-action verification — see pvm/verify.ts ----
  const result = verifyAction(actionId, snapshot);
  console.log("[pipeline] verification:", result);

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
    // StepError → null keeps the pre-Phase-6 contract for direct callers.
    // The agent loop uses runOneStepTyped directly to get the precise reason.
    return null;
  }
  return result;
}
