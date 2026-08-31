import { captureDomState } from "../perception/domCapture";
import type { VisionAssetUrls } from "../perception/faceDetector";
import type { PageState } from "../perception/types";
import { detectTier1 } from "../privacy/tier1DomRules";
import { redact } from "../privacy/redact";
import { buildSanitizedContext } from "../privacy/sanitizedContext";
import type { StepRecord } from "../privacy/sanitizedContext";
import type { PrivacyDetection, RedactionRecord } from "../privacy/types";
import { sendMessage, onMessage } from "../messaging/bus";
import { runStepObserved, type StepOutcome, type ProgressSignature } from "./pipeline";
import type { VerificationResult } from "../pvm/types";
import { cleanupSession } from "../action/session";
import { clearLocalSecrets } from "../action/secretStore";
import type { ActiveTaskState, TaskFailureInfo, TaskStatus } from "../action/types";

/**
 * Stable identifier for this content-script lifetime — used only for the
 * page-load privacy scan and PAGE_STATE message. Never sent to the
 * server as a task identifier. Each user-submitted task gets its own
 * UUID generated inside runTask() below.
 */
let pageSessionId = crypto.randomUUID();

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
    if (typeof document !== "undefined" && typeof document.querySelectorAll === "function") {
      const imgCount = document.querySelectorAll("img").length;
      if (imgCount === 0) {
        resolve({ detections: [], redactions: [] });
        return;
      }
    }

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
export const MAX_STEPS = 16;

/**
 * C10 — no-progress guard. If the model requests the SAME action against the
 * SAME page state (identical url + title + interactive-element set) this many
 * times in a row, the task is stuck repeating a non-terminal step and is
 * stopped with a typed `no_progress` failure instead of grinding to MAX_STEPS.
 * A step whose page state OR action differs from the previous one resets the
 * streak, so legitimate repeated navigation (each click changing the page)
 * is unaffected.
 */
export const NO_PROGRESS_LIMIT = 3;

/** Maximum total wall-clock time for a task, in milliseconds. */
export const TASK_TIMEOUT_MS = 120_000;

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

/** Hard upper bound on waiting for a navigated page to expose its controls. */
export const CAPTURE_SETTLE_MS = 2_000;
/** Gap between settle observations. */
const CAPTURE_POLL_MS = 120;

/**
 * Only a document that reports "loading" is treated as not-ready. "interactive"
 * already means the DOM is parsed and controls exist, and an environment that
 * does not report readyState at all must not block the settle loop — the
 * interactive-control count below is the signal that actually matters.
 */
const documentIsReady = (): boolean => {
  if (typeof document === "undefined") return true;
  const rs = (document as { readyState?: string }).readyState;
  return rs === undefined || rs !== "loading";
};

const sleepMs = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Capture that tolerates a page still settling after a navigation.
 *
 * A navigating action (following a link, submitting a search, a new-tab
 * handover, an SPA route change) leaves the NEXT step capturing a document that
 * has not yet built its interactive DOM. That produced an EMPTY element list,
 * the model had nothing to target, and the step was spent on a `wait` or a bad
 * click before the page was re-captured — burning the step budget before the
 * task could finish.
 *
 * Generic and bounded:
 *   - a ready document that already exposes controls returns IMMEDIATELY, so a
 *     settled page pays no delay at all;
 *   - otherwise the capture is retried until the document reports ready AND
 *     exposes at least one interactive control AND that count repeats once, so
 *     a list is not grabbed halfway through being built;
 *   - the whole loop is capped by CAPTURE_SETTLE_MS and always returns the most
 *     recent capture, so a page that genuinely has no controls falls through to
 *     exactly the previous behaviour.
 *
 * No fixed sleeps, no hostname/URL rules, no element names — only document
 * readiness and interactive-control count, which every site has. The returned
 * capture is always from the CURRENT document, with that document's own
 * element ids.
 */
export async function captureSettledPage(taskId: string): Promise<PageAnalysis | null> {
  let latest = await captureCurrentPage(taskId);
  let lastCount = latest?.pageState.elements.length ?? 0;

  // Fast path — already settled, no delay.
  if (documentIsReady() && lastCount > 0) return latest;

  const deadline = Date.now() + CAPTURE_SETTLE_MS;
  let repeats = 0;

  while (Date.now() < deadline) {
    await sleepMs(CAPTURE_POLL_MS);
    const next = await captureCurrentPage(taskId);
    if (next) latest = next;
    const count = next?.pageState.elements.length ?? 0;

    // Still settling: document not ready, or no controls exposed yet.
    if (!documentIsReady() || count === 0) {
      lastCount = count;
      repeats = 0;
      continue;
    }
    repeats = count === lastCount ? repeats + 1 : 0;
    lastCount = count;
    if (repeats >= 1) return latest; // ready, non-empty, and stable
  }

  // Bounded settle elapsed — hand back the freshest capture we have. A page
  // genuinely without controls keeps the existing safe behaviour.
  return latest;
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
// Failure description — turns a typed StepOutcome failure into a safe, bounded
// popup string + the structured record persisted on activeTask.failure.
// Exported for tests.
// ---------------------------------------------------------------------------

const STEP_FAILURE_STAGE: Record<string, TaskFailureInfo["stage"]> = {
  server_unreachable: "reasoning_server",
  server_timeout: "reasoning_server",
  server_http_error: "reasoning_server",
  auth_failed: "reasoning_server",
  malformed_model_response: "model_response",
  validation_failed: "action_validation",
  execution_failed: "action_execution",
  verification_failed: "verification",
  no_progress: "task_loop",
};

export function describeStepFailure(
  stepNumber: number,
  outcome: Extract<StepOutcome, { kind: "failed" }>
): { summary: string; info: TaskFailureInfo } {
  const reason = outcome.reason;
  const stage = STEP_FAILURE_STAGE[reason] ?? "task_loop";
  const httpStatus = outcome.httpStatus ?? null;
  const serverErrorCode = outcome.serverErrorCode;

  const label =
    reason === "server_unreachable" ? "reasoning server unreachable"
    : reason === "server_timeout" ? "reasoning server timed out"
    : reason === "server_http_error"
      ? `reasoning server returned ${httpStatus != null ? `HTTP ${httpStatus}` : "an HTTP error"}` +
        (serverErrorCode ? ` (${serverErrorCode})` : "")
    : reason === "auth_failed"
      ? (outcome.detail === "missing_api_key"
          ? "no API key configured — set it in the extension settings"
          : `reasoning server rejected the API key${httpStatus != null ? ` (HTTP ${httpStatus})` : ""}`)
    : reason === "no_progress" ? "the same action was requested again on an unchanged page"
    : reason === "malformed_model_response" ? "model response was malformed"
    : reason === "validation_failed" ? "action failed local validation"
    : reason === "execution_failed" ? "action could not be executed"
    : "step failed";

  const summary =
    `Step ${stepNumber} failed — ${label}.` +
    (outcome.detail && outcome.detail !== label ? ` (${outcome.detail})` : "");

  const info: TaskFailureInfo = {
    stage,
    reason,
    step: stepNumber,
    at: Date.now(),
  };
  if (outcome.detail) info.detail = outcome.detail;
  if (stage === "reasoning_server" && httpStatus != null) info.httpStatus = httpStatus;
  if (serverErrorCode) info.serverErrorCode = serverErrorCode;

  return { summary, info };
}

let isExecutingTaskLoop = false;
let currentRunningTask: ActiveTaskState | null = null;

const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["completed", "failed", "cancelled"]);
const isTerminalStatus = (s: TaskStatus): boolean => TERMINAL_STATUSES.has(s);

/**
 * C7 — shape guard for a stored activeTask record. A malformed / partially
 * written / foreign-shaped record must FAIL SAFE (be discarded) rather than be
 * fed into the loop where a NaN stepNumber or a non-array history would throw
 * or behave unpredictably.
 */
export function isValidActiveTask(x: unknown): x is ActiveTaskState {
  if (!x || typeof x !== "object") return false;
  const t = x as Record<string, unknown>;
  return (
    typeof t.taskId === "string" && t.taskId.length > 0 &&
    typeof t.task === "string" &&
    typeof t.taskStartedAt === "number" && Number.isFinite(t.taskStartedAt) &&
    typeof t.stepNumber === "number" && Number.isFinite(t.stepNumber) && t.stepNumber >= 1 &&
    Array.isArray(t.history) &&
    (t.status === "active" || t.status === "navigating" || t.status === "completed" ||
      t.status === "failed" || t.status === "cancelled") &&
    typeof t.updatedAt === "number" && Number.isFinite(t.updatedAt) &&
    (t.pendingStep === undefined || (typeof t.pendingStep === "number" && Number.isFinite(t.pendingStep)))
  );
}

export async function getActiveTask(): Promise<ActiveTaskState | null> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return null;
  return new Promise((resolve) => {
    chrome.storage.local.get(["activeTask"], (result) => {
      const raw = result?.activeTask;
      if (raw == null) {
        resolve(null);
        return;
      }
      if (!isValidActiveTask(raw)) {
        console.warn("[content] discarding malformed activeTask record");
        chrome.storage.local.remove(["activeTask"], () => resolve(null));
        return;
      }
      resolve(raw);
    });
  });
}

/**
 * Fix #34: Checks chrome.runtime.lastError after the storage write.
 * Rejects the promise on quota exceeded or any other storage failure so
 * callers know the state was NOT persisted — cross-page continuation must
 * not silently proceed with stale or missing storage records.
 *
 * Privacy: only the error message is logged, never task content.
 */
export async function setActiveTask(state: ActiveTaskState): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return;
  return new Promise((resolve, reject) => {
    // C7 — monotonic guard: a stale write from a dying/previous document must
    // not clobber a newer step/status written by the current owner. Applies
    // ONLY to the same taskId; a brand-new task (new id) always writes.
    chrome.storage.local.get(["activeTask"], (prevWrap) => {
      const prev = prevWrap?.activeTask as Partial<ActiveTaskState> | undefined;
      if (prev && prev.taskId === state.taskId && typeof prev.status === "string") {
        if (isTerminalStatus(prev.status as TaskStatus) && !isTerminalStatus(state.status)) {
          console.warn("[content] refused stale write: would revive terminal task", state.taskId);
          resolve();
          return;
        }
        if (
          typeof prev.stepNumber === "number" &&
          Number.isFinite(prev.stepNumber) &&
          prev.stepNumber > state.stepNumber &&
          !isTerminalStatus(state.status)
        ) {
          console.warn(
            "[content] refused stale write: stepNumber", state.stepNumber, "<", prev.stepNumber, "for", state.taskId
          );
          resolve();
          return;
        }
      }
      chrome.storage.local.set({ activeTask: state }, () => {
        const err = chrome.runtime.lastError;
        if (err) {
          // Do not log state contents — error message only.
          reject(new Error(`[content] activeTask storage write failed: ${err.message ?? "unknown storage error"}`));
          return;
        }
        resolve();
      });
    });
  });
}

export async function clearActiveTask(): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return;
  return new Promise((resolve) => {
    chrome.storage.local.remove(["activeTask"], () => resolve());
  });
}

/**
 * Asks the background service worker for the ID of the tab this content
 * script is running in.  Content scripts have no direct API for their
 * own tab ID; the background always knows via sender.tab.id.
 *
 * Returns null when chrome is unavailable (e.g. tests without a full
 * Chrome mock) or when the background cannot resolve the tab.
 */
export async function getCurrentTabId(): Promise<number | null> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return null;
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_TAB_ID" }) as { tabId?: number | null } | undefined;
    return res?.tabId ?? null;
  } catch {
    return null;
  }
}

/**
 * Executes or continues the multi-step agent loop using the durable active task state.
 */
/**
 * Thin wrapper around setActiveTask that converts storage failures into
 * an early-return signal, preventing the loop from continuing with state
 * it believes was persisted but wasn't.
 */
async function persistTask(
  activeTask: ActiveTaskState,
  label: string
): Promise<boolean> {
  try {
    await setActiveTask(activeTask);
    return true;
  } catch (storageErr) {
    console.error(
      `[content] storage write failed at "${label}":`,
      storageErr instanceof Error ? storageErr.message : "quota exceeded or unavailable"
    );
    return false;
  }
}

export async function runTaskLoop(activeTask: ActiveTaskState): Promise<{ ok: boolean; detail: string }> {
  if (isExecutingTaskLoop) {
    console.log("[content] task loop already executing in this document");
    return { ok: false, detail: "Task already in progress." };
  }
  // C7 §8 — a terminal task must never (re-)enter the loop. This guards a
  // deferred resume that fires after the task has already completed/failed:
  // `done` does not advance stepNumber, so `while (stepNumber <= MAX_STEPS)`
  // alone would re-process it.
  if (isTerminalStatus(activeTask.status)) {
    console.log("[content] runTaskLoop skipped — task already", activeTask.status);
    return {
      ok: activeTask.status === "completed",
      detail: activeTask.lastDetail ?? `Task already ${activeTask.status}.`,
    };
  }

  isExecutingTaskLoop = true;
  currentRunningTask = activeTask;

  const taskId = activeTask.taskId;
  const task = activeTask.task;

  try {
    // C7 — reconcile an interrupted step. `pendingStep` was DISPATCHED by a
    // previous document but its outcome was never recorded. Never re-run it:
    // record the outcome as unknown/ambiguous (PVM invariant — never assume
    // success) and advance past it. A terminal task is never revived here.
    if (
      !isTerminalStatus(activeTask.status) &&
      typeof activeTask.pendingStep === "number" &&
      activeTask.pendingStep >= activeTask.stepNumber
    ) {
      const n = activeTask.pendingStep;
      console.warn("[content] reconciling interrupted step", n, "— recording ambiguous, not re-executing");
      activeTask.history.push(buildStepRecord(n, "unknown", null, null, "ambiguous"));
      activeTask.stepNumber = n + 1;
      delete activeTask.pendingStep;
      activeTask.status = "active";
      activeTask.updatedAt = Date.now();
      await persistTask(activeTask, "reconcile-interrupted-step");
    }

    // C12 — this document's own tab. Used to detect a new-tab handover: when an
    // executed action opens a NEW tab, the background tab watcher re-points the
    // task at it and this loop must stop driving so the old tab cannot re-issue
    // the same action.
    const myTabId = await getCurrentTabId();

    // C10 — no-progress tracking. Carries the (state, action) fingerprint of the
    // previous verified/ambiguous step so a run of identical ones can be caught.
    // Set only after a step whose effect PVM could NOT confirm. The next step
    // refuses to re-dispatch the identical action against an identical page.
    let lastAmbiguous: ProgressSignature | null = null;
    let lastProgressState: string | undefined;
    let lastProgressAction: string | undefined;
    let noProgressStreak = 0;

    while (activeTask.stepNumber <= MAX_STEPS && !isTerminalStatus(activeTask.status)) {
      const stepNumber = activeTask.stepNumber;
      activeTask.status = "active";
      const elapsed = Date.now() - activeTask.taskStartedAt;
      if (elapsed >= TASK_TIMEOUT_MS) {
        console.warn("[content] task budget exhausted after", elapsed, "ms");
        const detail = `Task timed out after ${elapsed}ms (limit ${TASK_TIMEOUT_MS}ms).`;
        activeTask.status = "failed";
        activeTask.lastDetail = detail;
        activeTask.updatedAt = Date.now();
        await persistTask(activeTask, "timeout");
        return { ok: false, detail };
      }

      // Fresh DOM capture on current page
      const capture = await captureSettledPage(taskId);
      if (!capture) {
        const detail = "DOM capture failed — cannot reason on a blank page.";
        activeTask.status = "failed";
        activeTask.lastDetail = detail;
        activeTask.updatedAt = Date.now();
        await persistTask(activeTask, "dom-capture-failed");
        return { ok: false, detail };
      }
      const { pageState, domDetections, domRedactions } = capture;

      // Privacy Firewall
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
        const detail = "Blocked by Privacy Firewall — nothing was sent.";
        activeTask.status = "failed";
        activeTask.lastDetail = detail;
        activeTask.updatedAt = Date.now();
        await persistTask(activeTask, "privacy-firewall-blocked");
        return { ok: false, detail };
      }

      // Attach accumulated history so the model sees past steps across all pages
      const context = {
        ...firewall.context,
        history: activeTask.history.length > 0 ? [...activeTask.history] : undefined,
      };

      console.log(
        "[content] step", stepNumber, "/ context elements:", context.elements.length,
        "history:", activeTask.history.length
      );

      // C7 — mark this step DISPATCHED before any side-effecting work, so a
      // lifecycle interruption is reconciled (not re-executed) on resume. If the
      // marker cannot be persisted, fail safe rather than run a step whose
      // interruption could not be detected later.
      activeTask.pendingStep = stepNumber;
      activeTask.updatedAt = Date.now();
      const dispatchPersisted = await persistTask(activeTask, `step-${stepNumber}-dispatch`);
      if (!dispatchPersisted) {
        const detail = `Storage write failed before step ${stepNumber} — halting to avoid an untracked action.`;
        activeTask.status = "failed";
        activeTask.lastDetail = detail;
        activeTask.failure = { stage: "task_loop", reason: "storage_failed", step: stepNumber, at: Date.now() };
        await persistTask(activeTask, `step-${stepNumber}-dispatch-fail`);
        return { ok: false, detail };
      }

      // Per-step timeout — race the diagnostics-preserving step runner against
      // the step budget. `null` means the runner did not settle in time.
      // C7 — when the step budget fires, `stepAborted` is flipped so the
      // still-running pipeline call does NOT execute an action for a step the
      // loop has already abandoned.
      let outcome: StepOutcome | null = null;
      let stepTimerId: ReturnType<typeof setTimeout> | undefined;
      let stepAborted = false;
      try {
        const stepTimeoutPromise = new Promise<null>((resolve) => {
          stepTimerId = setTimeout(() => {
            stepAborted = true;
            resolve(null);
          }, STEP_TIMEOUT_MS);
        });
        outcome = await Promise.race([
          runStepObserved(context, () => stepAborted, lastAmbiguous),
          stepTimeoutPromise,
        ]);
      } finally {
        clearTimeout(stepTimerId);
      }

      // Step-timeout: runner exceeded STEP_TIMEOUT_MS. Halts, same as before —
      // but now recorded as a distinct, typed reason instead of the generic string.
      if (outcome === null) {
        console.warn("[content] step", stepNumber, "timed out after", STEP_TIMEOUT_MS, "ms — halting");
        const detail = `Step ${stepNumber} timed out after ${STEP_TIMEOUT_MS}ms.`;
        delete activeTask.pendingStep;
        activeTask.status = "failed";
        activeTask.lastDetail = detail;
        activeTask.failure = {
          stage: "task_loop",
          reason: "step_timeout",
          detail: `exceeded ${STEP_TIMEOUT_MS}ms`,
          step: stepNumber,
          at: Date.now(),
        };
        activeTask.updatedAt = Date.now();
        await persistTask(activeTask, "step-timeout");
        return { ok: false, detail };
      }

      // C7 — the step outcome is now known; it is no longer "in flight". Clear
      // the dispatch marker so a later resume does not mistake a resolved step
      // for an interrupted one.
      delete activeTask.pendingStep;

      // Done signal (unchanged behaviour).
      if (outcome.kind === "done") {
        console.log("[content] task complete (done) after", stepNumber - 1, "action(s)");
        await sendMessage({ type: "ACTION_RESULT", payload: outcome.verification });
        const detail = `Task complete — done after ${stepNumber - 1} step(s).`;
        activeTask.status = "completed";
        activeTask.lastDetail = detail;
        activeTask.updatedAt = Date.now();
        await persistTask(activeTask, "done");
        return { ok: true, detail };
      }

      // PVM verification failure halts (unchanged message + behaviour), now also
      // recorded as structured diagnostics.
      if (outcome.kind === "failed" && outcome.reason === "verification_failed") {
        const observed = outcome.verification?.observed ?? outcome.detail;
        console.warn("[content] step", stepNumber, "verification failed:", observed);
        if (outcome.verification) {
          await sendMessage({ type: "ACTION_RESULT", payload: outcome.verification });
        }
        const detail = `Step ${stepNumber} verification failed (${observed}) — halting.`;
        activeTask.status = "failed";
        activeTask.lastDetail = detail;
        activeTask.failure = {
          stage: "verification",
          reason: "verification_failed",
          detail: observed,
          step: stepNumber,
          at: Date.now(),
        };
        activeTask.updatedAt = Date.now();
        await persistTask(activeTask, "verification-failed");
        return { ok: false, detail };
      }

      // Typed failure (server / model-response / validation / execution). Halts
      // exactly where the loop used to halt on a bare `null` — but the real
      // reason is preserved in `lastDetail` and `activeTask.failure`.
      if (outcome.kind === "failed") {
        const failure = describeStepFailure(stepNumber, outcome);
        console.warn(
          "[content] step", stepNumber, "failed —",
          failure.info.stage, "/", failure.info.reason,
          failure.info.httpStatus != null ? `(HTTP ${failure.info.httpStatus})` : "",
          failure.info.serverErrorCode ? `[${failure.info.serverErrorCode}]` : "",
          "—", outcome.detail
        );
        activeTask.status = "failed";
        activeTask.lastDetail = failure.summary;
        activeTask.failure = failure.info;
        activeTask.updatedAt = Date.now();
        await persistTask(activeTask, "step-failed");
        return { ok: false, detail: failure.summary };
      }

      // verified | ambiguous — record sanitized history and continue.
      const stepResult: VerificationResult = outcome.verification;

      // C10 — no-progress guard. A PVM `success` means "this action produced an
      // effect", NOT "the task is done". If the model keeps asking for the SAME
      // action against the SAME page state (structural fingerprint from
      // pvm/memory.ts — no raw values), it is stuck on a non-terminal step.
      // Stop safely with a typed failure rather than repeating it up to
      // MAX_STEPS. A change in either the page state or the action resets the
      // streak, so legitimate repeated navigation is unaffected. This never
      // turns ambiguous/failure into success and never marks the task complete.
      // Arm the pre-dispatch guard only when the effect was NOT confirmed.
      // A confirmed (success) step clears it, so a legitimately repeated action
      // — click Next, scroll again — is never blocked.
      const sigState: string | undefined = stepResult.progressStateSignature;
      const sigAction: string | undefined = stepResult.progressActionSignature;
      if (stepResult.status !== "success" && sigState && sigAction) {
        lastAmbiguous = { state: sigState, action: sigAction };
      } else {
        lastAmbiguous = null;
      }

      const pState = stepResult.progressStateSignature;
      const pAction = stepResult.progressActionSignature;
      if (pState && pAction) {
        if (pState === lastProgressState && pAction === lastProgressAction) {
          noProgressStreak += 1;
        } else {
          noProgressStreak = 0;
        }
        lastProgressState = pState;
        lastProgressAction = pAction;
        if (noProgressStreak >= NO_PROGRESS_LIMIT - 1) {
          const repeats = noProgressStreak + 1;
          console.warn(
            "[content] no progress — same action on an unchanged page x", repeats, "— halting"
          );
          const detail = "Task made no progress — the same action was requested on an unchanged page.";
          delete activeTask.pendingStep;
          activeTask.status = "failed";
          activeTask.lastDetail = detail;
          activeTask.failure = {
            stage: "task_loop",
            reason: "no_progress",
            detail: `repeated identical (state, action) x${repeats}`,
            step: stepNumber,
            at: Date.now(),
          };
          activeTask.updatedAt = Date.now();
          await persistTask(activeTask, "no-progress");
          return { ok: false, detail };
        }
      }

      // Record sanitized history
      const actionTypeFromExpected =
        stepResult.expected === "wait_completed" ? "wait"
        : stepResult.expected === "click_effect" ? "click"
        : stepResult.expected === "value_matches" ? "type"
        : stepResult.expected === "value_changed" ? "type_secret"
        : stepResult.expected === "scroll_changed" ? "scroll"
        : stepResult.expected === "url_changed" ? "navigate"
        : stepResult.expected === "keypress_effect" ? "keypress"
        : "unknown";

      // Prefer the action the model actually requested; the expected-string
      // mapping is only a fallback (it produced "unknown" for anything outside
      // its table). element_id / element_label come from the sanitized context,
      // so history can finally say WHICH control a step acted on.
      const record = buildStepRecord(
        stepNumber,
        stepResult.actionType ?? actionTypeFromExpected,
        stepResult.targetElementId ?? null,
        stepResult.targetLabel ?? null,
        stepResult.status as "success" | "failure" | "ambiguous"
      );
      activeTask.history.push(record);
      activeTask.stepNumber = stepNumber + 1;
      delete activeTask.pendingStep; // step N recorded — no longer in flight
      activeTask.status = (actionTypeFromExpected === "navigate" || actionTypeFromExpected === "click") ? "navigating" : "active";
      activeTask.updatedAt = Date.now();

      // C12 — adopt a new-tab handover before writing. The action just executed
      // may have opened a new tab, in which case the background watcher already
      // re-pointed the task at it. Re-read the stored tab identity first so this
      // document's write cannot clobber the handover.
      const ownerRecord = await getActiveTask();
      if (
        ownerRecord &&
        ownerRecord.taskId === activeTask.taskId &&
        ownerRecord.tabId != null &&
        ownerRecord.tabId !== activeTask.tabId
      ) {
        activeTask.tabId = ownerRecord.tabId;
      }

      // Persist state to storage BEFORE waiting or proceeding.
      // If the write fails (quota exceeded), halt rather than silently
      // continuing with state the next page cannot safely resume.
      const persisted = await persistTask(activeTask, `step-${stepNumber}`);
      if (!persisted) {
        const detail = `Storage write failed at step ${stepNumber} — cross-page continuation unavailable.`;
        activeTask.status = "failed";
        activeTask.lastDetail = detail;
        await persistTask(activeTask, `step-${stepNumber}-fail`);
        return { ok: false, detail };
      }
      await sendMessage({ type: "ACTION_RESULT", payload: stepResult });
      console.log("[content] step", stepNumber, "complete:", stepResult.status);

      // C12 — the task now belongs to a different tab (the action opened one).
      // Stop driving here: the new tab's content script resumes the SAME taskId
      // with a fresh capture. This is a HANDOVER, not a terminal state — the
      // status is deliberately left non-terminal so the new tab can continue,
      // and no failure is recorded.
      if (myTabId != null && activeTask.tabId != null && activeTask.tabId !== myTabId) {
        console.log(
          "[content] task handed over to tab", activeTask.tabId,
          "— stopping loop in tab", myTabId
        );
        return { ok: false, detail: "Task continued in a new tab." };
      }
    }

    console.warn("[content] step budget exhausted (MAX_STEPS =", MAX_STEPS, ")");
    const detail = `Task halted after ${MAX_STEPS} steps without completion.`;
    activeTask.status = "failed";
    activeTask.lastDetail = detail;
    activeTask.updatedAt = Date.now();
    await persistTask(activeTask, "budget-exhausted");
    return { ok: false, detail };
  } finally {
    isExecutingTaskLoop = false;
    currentRunningTask = null;
    clearLocalSecrets();
    cleanupSession(taskId);
  }
}

/**
 * Runs a new user-submitted task.
 *
 * Fix #32: `tabId` is supplied by the popup (which knows chrome.tabs),
 * recorded in `activeTask`, and used by `checkAndResumeActiveTask` to
 * prevent resuming this task in any other tab.
 */
export async function runTask(task: string, tabId?: number | null): Promise<{ ok: boolean; detail: string }> {
  // C7 — a task loop is already running in THIS document (e.g. popup double-click
  // / a second RUN_TASK). Refuse to start a second one; do not overwrite the
  // active record with a fresh taskId that would never actually run.
  if (isExecutingTaskLoop) {
    console.log("[content] runTask ignored — a task loop is already executing in this document");
    return { ok: false, detail: "A task is already running." };
  }

  const resolvedTabId = tabId ?? await getCurrentTabId();
  const activeTask: ActiveTaskState = {
    taskId: crypto.randomUUID(),
    task,
    taskStartedAt: Date.now(),
    stepNumber: 1,
    history: [],
    status: "active",
    updatedAt: Date.now(),
    tabId: resolvedTabId ?? null,
  };
  await setActiveTask(activeTask);
  console.log("[content] task started, taskId:", activeTask.taskId, "tabId:", activeTask.tabId);
  return runTaskLoop(activeTask);
}

/**
 * Checks if a cross-page task was in progress and automatically resumes it
 * on the current document.
 *
 * Fix #32: Tab-ownership guard — only resume when `activeTask.tabId`
 * matches this document's tab.  Prevents an orphaned activeTask (left by
 * a closed or crashed tab) from hijacking an unrelated tab's DOM.
 *
 * If `activeTask.tabId` is null (old record created before this fix) the
 * guard is relaxed so pre-existing tasks can still complete rather than
 * being silently dropped.
 */
export async function checkAndResumeActiveTask(): Promise<void> {
  const activeTask = await getActiveTask();
  if (!activeTask) return;
  // Terminal state can never resume (C7 §8).
  if (activeTask.status !== "active" && activeTask.status !== "navigating") return;

  // C7 §5 — expire a dead / over-budget task BEFORE the tab-ownership check, so
  // an orphan left by a closed or crashed tab is cleaned up by whichever tab
  // next observes it — not left "active" in storage forever.
  const elapsed = Date.now() - activeTask.taskStartedAt;
  if (elapsed >= TASK_TIMEOUT_MS || activeTask.stepNumber > MAX_STEPS) {
    activeTask.status = "failed";
    activeTask.lastDetail =
      elapsed >= TASK_TIMEOUT_MS ? "Task timed out across navigations." : "Step budget exhausted.";
    activeTask.updatedAt = Date.now();
    await persistTask(activeTask, "resume-expired");
    return;
  }
  // Orphan: the owning loop is gone — `updatedAt` has not moved for longer than
  // a whole task budget while the task still claims to be running.
  const sinceUpdate = Date.now() - (activeTask.updatedAt ?? activeTask.taskStartedAt);
  if (sinceUpdate >= TASK_TIMEOUT_MS) {
    activeTask.status = "failed";
    activeTask.lastDetail = "Task expired — no progress from its owner.";
    activeTask.failure = {
      stage: "task_loop",
      reason: "orphaned_task",
      step: activeTask.stepNumber,
      at: Date.now(),
    };
    activeTask.updatedAt = Date.now();
    await persistTask(activeTask, "resume-orphaned");
    return;
  }

  // Tab-ownership check: refuse to RESUME in the wrong tab. A within-budget task
  // legitimately running in its own tab is left untouched.
  if (activeTask.tabId != null) {
    const currentTabId = await getCurrentTabId();
    if (currentTabId != null && currentTabId !== activeTask.tabId) {
      console.log(
        "[content] skipping task resume — tab mismatch:",
        "expected", activeTask.tabId, "got", currentTabId
      );
      return;
    }
  }

  console.log("[content] resuming cross-page task:", activeTask.taskId, "at step", activeTask.stepNumber);
  const resumingTaskId = activeTask.taskId;
  setTimeout(() => {
    // C7 — re-read the CURRENT persisted state before resuming. During the delay
    // the task may have completed, failed, expired, or been replaced by a new
    // one (different taskId). Never resume a stale or terminal snapshot.
    void (async () => {
      const fresh = await getActiveTask();
      if (
        !fresh ||
        fresh.taskId !== resumingTaskId ||
        (fresh.status !== "active" && fresh.status !== "navigating")
      ) {
        console.log("[content] deferred resume aborted — task changed/terminal");
        return;
      }
      runTaskLoop(fresh).catch((err) => {
        console.error("[content] resumed cross-page task failed:", err);
      });
    })();
  }, 250);
}

// ---------------------------------------------------------------------------
// Boot: redact on page load; listen for RUN_TASK from popup
// ---------------------------------------------------------------------------

/**
 * BFCache restoration handler: called when the page is restored from the
 * Back/Forward Cache (event.persisted === true).
 * Refreshes pageSessionId and re-runs page perception and privacy analysis.
 */
export function handlePageShow(event: { persisted?: boolean }): Promise<PageAnalysis> | null {
  if (event?.persisted) {
    console.log("[content] page restored from BFCache (persisted: true) — refreshing page perception & privacy report");
    pageSessionId = crypto.randomUUID();
    analysisPromise = analysePage();
    analysisPromise.catch((err) => console.error("[content] BFCache page re-analysis failed:", err));
    return analysisPromise;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Lifecycle deduplication guard (Fix #5)
// ---------------------------------------------------------------------------
//
// checkAndResumeActiveTask() must fire EXACTLY ONCE per page lifetime:
//
//   Normal page load:
//     The content script is injected at document_idle. By the time our
//     module runs, the browser has already dispatched `pageshow` (which
//     fires after `load`). If we register a pageshow listener AND call
//     checkAndResumeActiveTask() directly in module init, the listener
//     will fire `pageshow` a second time and trigger a duplicate resume.
//     Solution: track whether the resume has already been attempted with
//     `hasAttemptedResume` and skip subsequent calls from `pageshow` on
//     the same document lifetime.
//
//   BFCache restoration (pageshow.persisted === true):
//     The module is NOT re-evaluated (the JS context is frozen and thawed).
//     The module-init call is NOT repeated. `pageshow` fires with
//     persisted=true — that is the only trigger, and the flag is reset so
//     the single pageshow handler resumes once cleanly.
//
let hasAttemptedResume = false;

// Redact immediately on load; reasoning waits for an explicit task.
if (typeof document !== "undefined" && typeof chrome !== "undefined" && chrome?.runtime?.onMessage) {
  analysisPromise = analysePage();
  analysisPromise.catch((err) => console.error("[content] page analysis failed", err));

  onMessage((message) => {
    if (message.type !== "RUN_TASK") return;
    const payload = message.payload as { task: string; tabId?: number | null };
    // Fix A: Detach the multi-step task loop from the request/response channel.
    // Starting the task asynchronously allows the message port to close immediately,
    // preventing cross-page navigation from severing an in-flight message channel.
    runTask(payload.task, payload.tabId ?? null).catch((err) => {
      console.error("[content] task loop failed:", err);
    });
    return Promise.resolve({ ok: true, detail: "Task started." });
  });

  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("pagehide", () => {
      // Fix B: Mark the active task as 'navigating' when the document unloads
      // so the popup and next-page resume handler know a navigation transition is occurring.
      if (isExecutingTaskLoop && currentRunningTask && currentRunningTask.status === "active") {
        currentRunningTask.status = "navigating";
        currentRunningTask.updatedAt = Date.now();
        if (typeof chrome !== "undefined" && chrome.storage?.local?.set) {
          chrome.storage.local.set({ activeTask: currentRunningTask });
        }
      }
    });

    window.addEventListener("pageshow", (event) => {
      if (event.persisted) {
        // BFCache restore: refresh analysis and reset the resume guard so
        // this single pageshow fires the resume once.
        handlePageShow(event);
        hasAttemptedResume = false;
      }
      if (!hasAttemptedResume) {
        hasAttemptedResume = true;
        checkAndResumeActiveTask();
      }
    });
  }

  // Module-init resume for normal page loads where pageshow has already
  // fired before our listener was registered (document_idle timing).
  if (!hasAttemptedResume) {
    hasAttemptedResume = true;
    checkAndResumeActiveTask();
  }
}

