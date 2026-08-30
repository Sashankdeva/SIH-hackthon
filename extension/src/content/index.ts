import { captureDomState } from "../perception/domCapture";
import type { VisionAssetUrls } from "../perception/faceDetector";
import type { PageState } from "../perception/types";
import { detectTier1 } from "../privacy/tier1DomRules";
import { redact } from "../privacy/redact";
import { buildSanitizedContext } from "../privacy/sanitizedContext";
import type { StepRecord } from "../privacy/sanitizedContext";
import type { PrivacyDetection, RedactionRecord } from "../privacy/types";
import { sendMessage, onMessage } from "../messaging/bus";
import { runOneStep } from "./pipeline";
import { cleanupSession } from "../action/session";
import { clearLocalSecrets } from "../action/secretStore";

/**
 * Stable identifier for this content-script lifetime — used only for the
 * page-load privacy scan and PAGE_STATE message. Never sent to the
 * server as a task identifier. Each user-submitted task gets its own
 * UUID generated inside runTask() below.
 */
const pageSessionId = crypto.randomUUID();

interface VisionResultDetail {
  imageIndex: number;
  faceCount: number;
  latencyMs: number;
}

const VISION_TIMEOUT_MS = 15000;

/**
 * Local vision processing pass — PS26171's other required component
 * alongside DOM/A11y capture. The actual detection + on-page redaction
 * happens in a SEPARATE main-world content script (vision-main/index.ts)
 * — see the architecture note at the top of perception/faceDetector.ts
 * for why. This function only hands over the extension resource URLs
 * (chrome.runtime.getURL, only available here in the isolated world)
 * and listens for primitive result metadata to fold into the same
 * PrivacyReport the popup already displays. Never touches the
 * sanitized payload sent to the server — images were never part of
 * that schema.
 */
/**
 * Runs on page load to detect faces and other visual PII using the
 * vision-main content script (main world, ORT + ONNX model).
 *
 * Event listener protocol (ISSUE-15 analysis):
 *
 *   privyvision:vision-result  — emitted ONCE PER IMAGE BATCH by vision-main.
 *     Multiple legitimate events may fire (one per <img> batch on the page)
 *     before the final vision-done event. This is by design: the model
 *     processes images in parallel and reports results as they complete.
 *     Therefore onResult CANNOT use { once: true } — it must stay registered
 *     until finish() is called.
 *
 *   privyvision:vision-done    — emitted ONCE when all images are processed.
 *     Uses { once: true } because it is a terminal signal. Triggers finish().
 *
 *   timeout                    — fires finish() if vision-done never arrives
 *     (e.g. vision-main not injected, all images cross-origin).
 *
 * Lifecycle invariant:
 *   finish() is idempotent (settles only once via `settled` guard).
 *   Both listeners AND the timeout are always removed inside finish() —
 *   guaranteeing no stale listener and no duplicate settlement regardless of
 *   which trigger fires first (vision-done, timeout, or rapid results).
 */
function runVisualDetection(): Promise<{ detections: PrivacyDetection[]; redactions: RedactionRecord[] }> {
  return new Promise((resolve) => {
    const detections: PrivacyDetection[] = [];
    const redactions: RedactionRecord[] = [];
    let syntheticId = -1;
    let settled = false;

    function finish() {
      // Idempotent: the `settled` flag prevents duplicate settlement regardless
      // of whether vision-done, timeout, or a late onResult call triggers finish.
      if (settled) return;
      settled = true;
      // Always remove both listeners — prevents any stale onResult callback
      // from accumulating detections after the promise has resolved.
      document.removeEventListener("privyvision:vision-result", onResult as EventListener);
      document.removeEventListener("privyvision:vision-done", onDone);
      clearTimeout(timeout);
      resolve({ detections, redactions });
    }

    // onResult intentionally does NOT use { once: true } — see protocol note above.
    // It accumulates face detections across multiple batch events until finish() fires.
    function onResult(event: Event) {
      const { faceCount } = (event as CustomEvent<VisionResultDetail>).detail;
      for (let i = 0; i < faceCount; i++) {
        const elementId = syntheticId--;
        detections.push({ elementId, category: "face", source: "visual", confidence: 1 });
        redactions.push({ elementId, category: "face", method: "blackout", token: `[FACE_${Math.abs(elementId)}]` });
      }
    }

    function onDone() {
      finish();
    }

    document.addEventListener("privyvision:vision-result", onResult as EventListener);
    document.addEventListener("privyvision:vision-done", onDone, { once: true });

    // If vision-main isn't loaded (e.g. manifest not reloaded after an
    // update) or every image is cross-origin, don't block the rest of
    // the pipeline forever waiting for a "done" event that never comes.
    const timeout = setTimeout(finish, VISION_TIMEOUT_MS);

    const urls: VisionAssetUrls = {
      ort: chrome.runtime.getURL("dist/ort.all.min.js"),
      model: chrome.runtime.getURL("dist/models/face-detector.onnx"),
      wasmBase: chrome.runtime.getURL("dist/"),
    };
    document.dispatchEvent(new CustomEvent("privyvision:init-vision", { detail: urls }));
  });
}

/**
 * Perception + redaction state from page load, kept so a later task can
 * reuse it without re-scanning. Content scripts live as long as the page
 * does, so module scope is safe here (unlike the MV3 service worker).
 */
interface PageAnalysis {
  pageState: PageState;
  domDetections: PrivacyDetection[];
  domRedactions: RedactionRecord[];
}
let analysisPromise: Promise<PageAnalysis> | null = null;

/**
 * Runs on page load, unconditionally, with no task and no network call.
 *
 * Privacy protection must not wait for the user to ask for something —
 * faces get blacked out and sensitive fields get tokenised the moment
 * the page is readable. Reasoning and action are a separate, explicitly
 * user-triggered step (see runTask) so the agent never acts on a goal
 * nobody gave it.
 */
async function analysePage(): Promise<PageAnalysis> {
  const pageState = captureDomState(pageSessionId);
  await sendMessage({ type: "PAGE_STATE", payload: pageState });

  const domDetections = detectTier1(pageState.elements);
  const domRedactions = redact(domDetections);

  const { detections: visualDetections, redactions: visualRedactions } = await runVisualDetection();

  await sendMessage({
    type: "PRIVACY_REPORT",
    payload: {
      taskId: pageSessionId,
      detections: [...domDetections, ...visualDetections],
      redactions: [...domRedactions, ...visualRedactions],
    },
  });

  return { pageState, domDetections, domRedactions };
}

// ---------------------------------------------------------------------------
// Multi-step loop budgets
// ---------------------------------------------------------------------------

/** Maximum browser interactions per user-submitted task. */
export const MAX_STEPS = 8;

/** Maximum total wall-clock time for a task, in milliseconds. */
export const TASK_TIMEOUT_MS = 60_000;

/** Maximum time to wait for a single step (server + execute + verify), in ms. */
export const STEP_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Per-step DOM capture helper (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Re-captures the live DOM and re-runs tier-1 privacy detection, giving
 * back a fresh PageAnalysis. Called before EVERY server call so the model
 * always sees the current page — not the page at task-start.
 *
 * We do NOT re-run visual (face) detection here: that scan is expensive,
 * the face blackout from page load still applies in CSS, and faces are
 * never part of the server payload anyway. Only DOM elements need to be
 * live for the model to target them correctly.
 */
export async function captureCurrentPage(taskId: string): Promise<PageAnalysis | null> {
  try {
    const pageState = captureDomState(taskId);
    const domDetections = detectTier1(pageState.elements);
    const domRedactions = redact(domDetections);
    return { pageState, domDetections, domRedactions };
  } catch (err) {
    console.error("[content] DOM capture failed:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// StepRecord builder — privacy boundary (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Builds a sanitized StepRecord from a completed step.
 *
 * Privacy invariant: only structural metadata flows into history.
 *   ALLOWED:   step number, action type, element_id, element_label
 *              (as it appeared in the sanitized context), outcome.
 *   FORBIDDEN: value (raw typed text), valueRef resolved content,
 *              full URLs with query params, any secret.
 *
 * The element_label comes from the sanitized context — it is already
 * a redaction token for sensitive fields, so it is safe to include.
 */
export function buildStepRecord(
  stepNumber: number,
  actionType: string,
  elementId: number | null | undefined,
  elementLabel: string | null | undefined,
  outcome: "success" | "failure" | "ambiguous"
): StepRecord {
  return {
    step: stepNumber,
    action: actionType,
    element_id: elementId ?? null,
    element_label: elementLabel ?? null,
    outcome,
  };
}

// ---------------------------------------------------------------------------
// Main multi-step loop (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Runs only when the user submits a task from the popup.
 *
 * Orchestrates a capture → reason → validate → execute → verify → record
 * loop up to MAX_STEPS times within TASK_TIMEOUT_MS. The server sees the
 * current page state on every call. The server is stateless — all context
 * for future steps comes from the sanitized history the extension builds
 * and sends back.
 *
 * Termination conditions:
 *   done signal  → task succeeded, model says it's done.
 *   null result  → server/network error or validator rejection → halt.
 *   failure      → verification failed (action did not land) → halt.
 *   budget       → MAX_STEPS or TASK_TIMEOUT_MS exceeded → halt.
 */
export async function runTask(task: string): Promise<{ ok: boolean; detail: string }> {
  // One UUID per user-submitted task.
  const taskId = crypto.randomUUID();
  const taskStartedAt = Date.now();

  console.log("[content] task started:", task, "taskId:", taskId);

  // Accumulates sanitized step summaries to send back in each context.
  const history: StepRecord[] = [];

  try {
    for (let stepNumber = 1; stepNumber <= MAX_STEPS; stepNumber++) {
      // ---- Total budget check ----
      const elapsed = Date.now() - taskStartedAt;
      if (elapsed >= TASK_TIMEOUT_MS) {
        console.warn("[content] task budget exhausted after", elapsed, "ms");
        return { ok: false, detail: `Task timed out after ${elapsed}ms (limit ${TASK_TIMEOUT_MS}ms).` };
      }

      // ---- Fresh DOM capture ----
      const capture = await captureCurrentPage(taskId);
      if (!capture) {
        return { ok: false, detail: "DOM capture failed — cannot reason on a blank page." };
      }
      const { pageState, domDetections, domRedactions } = capture;

      // ---- Privacy Firewall ----
      const firewall = buildSanitizedContext(
        { ...pageState, taskId },
        domDetections,
        domRedactions,
        task
      );
      if (!firewall.ok) {
        console.error("[content] Privacy Firewall blocked step", stepNumber, firewall.missingElementIds);
        await sendMessage({
          type: "PRIVACY_BLOCKED",
          payload: { taskId, missingElementIds: firewall.missingElementIds },
        });
        return { ok: false, detail: "Blocked by Privacy Firewall — nothing was sent." };
      }

      // Attach accumulated history so the model sees what has already happened.
      const context = { ...firewall.context, history: history.length > 0 ? [...history] : undefined };

      console.log(
        "[content] step", stepNumber, "/ context elements:", context.elements.length,
        "history:", history.length
      );

      // ---- Per-step timeout (ISSUE-04: timer always cleared in finally) ----
      let stepResult: Awaited<ReturnType<typeof runOneStep>> = null;
      let stepTimerId: ReturnType<typeof setTimeout> | undefined;
      try {
        const stepTimeoutPromise = new Promise<null>((resolve) => {
          stepTimerId = setTimeout(() => resolve(null), STEP_TIMEOUT_MS);
        });
        const stepRunPromise = runOneStep(context);
        stepResult = await Promise.race([stepRunPromise, stepTimeoutPromise]);
      } finally {
        clearTimeout(stepTimerId);
      }

      if (stepResult === null) {
        console.warn("[content] step", stepNumber, "returned null — halting");
        return {
          ok: false,
          detail: `Step ${stepNumber} failed — server error or validator rejection.`,
        };
      }

      // ---- done: model signals task is complete ----
      if (stepResult.expected === "done") {
        console.log("[content] task complete (done) after", stepNumber - 1, "action(s)");
        await sendMessage({ type: "ACTION_RESULT", payload: stepResult });
        return { ok: true, detail: `Task complete — done after ${stepNumber - 1} step(s).` };
      }

      // ---- Verification failure halts ----
      if (stepResult.status === "failure") {
        console.warn("[content] step", stepNumber, "verification failed:", stepResult.observed);
        await sendMessage({ type: "ACTION_RESULT", payload: stepResult });
        return {
          ok: false,
          detail: `Step ${stepNumber} verification failed (${stepResult.observed}) — halting.`,
        };
      }

      // ---- Record sanitized history ----
      const actionTypeFromExpected =
        stepResult.expected === "wait_completed" ? "wait"
        : stepResult.expected === "click_effect" ? "click"
        : stepResult.expected === "value_matches" ? "type"
        : stepResult.expected === "value_changed" ? "type_secret"
        : stepResult.expected === "scroll_changed" ? "scroll"
        : stepResult.expected === "url_changed" ? "navigate"
        : stepResult.expected === "keypress_effect" ? "keypress"
        : "unknown";

      const record = buildStepRecord(
        stepNumber,
        actionTypeFromExpected,
        null,
        null,
        stepResult.status as "success" | "failure" | "ambiguous"
      );
      history.push(record);

      await sendMessage({ type: "ACTION_RESULT", payload: stepResult });
      console.log("[content] step", stepNumber, "complete:", stepResult.status);
    }

    // Exhausted step budget without done.
    console.warn("[content] step budget exhausted (MAX_STEPS =", MAX_STEPS, ")");
    return {
      ok: false,
      detail: `Task halted after ${MAX_STEPS} steps without completion.`,
    };
  } finally {
    // ISSUE-05: Clear all in-memory secrets on every task exit path
    // (success, failure, exception, early return, timeout, cancellation).
    // Prevents cross-task secret retention within a single page visit.
    clearLocalSecrets();
    cleanupSession(taskId);
  }
}

// ---------------------------------------------------------------------------
// Boot: redact on page load; listen for RUN_TASK from popup
// ---------------------------------------------------------------------------

// Redact immediately on load; reasoning waits for an explicit task.
if (typeof document !== "undefined" && typeof chrome !== "undefined" && chrome?.runtime?.onMessage) {
  analysisPromise = analysePage();
  analysisPromise.catch((err) => console.error("[content] page analysis failed", err));

  onMessage((message) => {
    if (message.type !== "RUN_TASK") return;
    return runTask(message.payload.task).catch((err) => {
      console.error("[content] task failed", err);
      return { ok: false, detail: String(err) };
    });
  });
}

