import { validateAction } from "../action/validator";
import { createDispatch } from "../action/dispatch";
import type { ActionRequest } from "../action/types";
import type { SanitizedContext } from "../privacy/sanitizedContext";
import { resolveElement } from "../perception/domCapture";
import { verifyAction } from "../pvm/verify";
import type { ActionSnapshot } from "../pvm/verify";
import type { VerificationResult } from "../pvm/types";

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

/** Raw wire shape the server actually returns — snake_case, mirrors shared/schemas/action.schema.json. */
interface RawActionResponse {
  action: ActionRequest["action"];
  element_id: number | null;
  value: string | null;
  value_ref: string | null;
  direction: ActionRequest["direction"];
  amount: number | null;
  url: string | null;
  confidence: number;
  task_id: string;
  step_id: number;
}

function toActionRequest(raw: RawActionResponse): ActionRequest {
  return {
    action: raw.action,
    elementId: raw.element_id,
    value: raw.value,
    valueRef: raw.value_ref,
    direction: raw.direction,
    amount: raw.amount,
    url: raw.url,
    confidence: raw.confidence,
    taskId: raw.task_id,
    stepId: raw.step_id,
  };
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

  // Build the outbound payload in snake_case (server schema).
  // history is included only when non-empty, so the first-step payload
  // is byte-for-byte identical to the previous single-step shape.
  const historyPayload =
    sanitized.history && sanitized.history.length > 0 ? sanitized.history : undefined;

  const bodyJson = JSON.stringify({
    task_id: sanitized.taskId,
    task: sanitized.task,
    page: sanitized.page,
    url_origin: sanitized.urlOrigin,
    elements: sanitized.elements.map((el) => ({ element_id: el.elementId, role: el.role, label: el.label })),
    fields: sanitized.fields,
    ...(historyPayload !== undefined ? { history: historyPayload } : {}),
  });

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
    const raw = (await response.json()) as RawActionResponse;
    return toActionRequest(raw);
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
