import type { PageState, ValueState } from "../perception/types";
import type { RedactionRecord } from "./types";
import { validateRedactionCoverage } from "./redactionValidator";
import type { PrivacyDetection } from "./types";
import { resolveElement, captureBudgetSignals } from "../perception/domCapture";
import { budgetElements, DEFAULT_BUDGET } from "../perception/elementBudget";
import { storeSecret } from "./secretStore";

/**
 * Sanitized summary of one completed step, appended to history before
 * the next server call. Mirrors the StepRecord definition in
 * shared/schemas/sanitized-context.schema.json.
 *
 * Privacy contract — MUST NOT appear here:
 *   - raw typed values (the `value` field from executor)
 *   - secrets or resolved value_ref contents
 *   - full URLs with query params that may contain PII
 *
 * SAFE to include:
 *   - step number, action type
 *   - element_id and element_label as they appeared in the context
 *     (redaction tokens like [EMAIL_01] carry no real value)
 *   - PVM verification outcome
 */
export interface StepRecord {
  step: number;
  action: string;
  element_id: number | null;
  element_label: string | null;
  outcome: "success" | "failure" | "ambiguous";
}

/** Mirrors shared/schemas/sanitized-context.schema.json — keep both in sync. */
export interface SanitizedContext {
  taskId: string;
  /** What the user typed they want done. Never empty — the agent doesn't run without one. */
  task: string;
  page: string;
  urlOrigin: string;
  /**
   * Current in-page route (path only — never query string or fragment, which
   * are the parts that carry identifiers and tracking data). SPAs frequently
   * leave `document.title` stale after a client-side navigation, so `page`
   * alone can describe the PREVIOUS view; the path is the authoritative signal
   * for which view is actually on screen. Omitted when unavailable.
   */
  routeHint?: string;
  elements: Array<{
    elementId: number;
    role: string;
    label: string | null;
    /**
     * Safe occupancy of an editable control ("empty" | "nonempty" | "redacted").
     * Present only for editable controls. NEVER the value itself — the raw text
     * of any field is not part of this contract in any form.
     */
    valueState?: ValueState;
  }>;
  fields: Record<string, string>;
  /**
   * Sanitized history of steps already completed in this task.
   * Absent or empty on the first step. The server is stateless —
   * the extension builds and sends this; nothing is stored server-side.
   */
  history?: StepRecord[];
}

/**
 * Reads the real value out of a password field and stores it locally,
 * keyed by its redaction token, so a later `type_secret` action can
 * resolve it without the value ever having been part of the outbound
 * payload. See extension/src/privacy/secretStore.ts.
 */
function captureSecrets(redactions: RedactionRecord[]): void {
  for (const r of redactions) {
    if (r.category !== "password") continue;
    const el = resolveElement(r.elementId) as HTMLInputElement | null;
    if (el && el.value) storeSecret(r.token, el.value);
  }
}


/** Max characters of path sent as the route hint. */
const MAX_ROUTE_HINT = 200;

/**
 * The current path, or undefined when unavailable. Never includes the query
 * string or fragment.
 */
function readRouteHint(): string | undefined {
  try {
    if (typeof location === "undefined") return undefined;
    const path = location.pathname;
    if (typeof path !== "string" || path.length === 0) return undefined;
    return path.slice(0, MAX_ROUTE_HINT);
  } catch {
    return undefined;
  }
}

export type FirewallResult =
  | { ok: true; context: SanitizedContext }
  | { ok: false; missingElementIds: number[] };

/**
 * The Privacy Firewall: the only function allowed to produce a
 * network-bound payload. Refuses to build anything (ok: false) if
 * redaction coverage is incomplete — fail closed, per the project's
 * core invariant. See PS26171_Role3_Privacy.pdf, Day 3.
 */
export function buildSanitizedContext(
  pageState: PageState,
  detections: PrivacyDetection[],
  redactions: RedactionRecord[],
  task: string
): FirewallResult {
  const coverage = validateRedactionCoverage(detections, redactions);
  if (!coverage.ok) {
    console.error("[privacy-firewall] blocked: missing redactions for elements", coverage.missing);
    return { ok: false, missingElementIds: coverage.missing };
  }

  captureSecrets(redactions);

  const redactedIds = new Set(redactions.map((r) => r.elementId));
  const tokenByElement = new Map(redactions.map((r) => [r.elementId, r.token]));

  const fields: Record<string, string> = {};
  for (const el of pageState.elements) {
    if (redactedIds.has(el.elementId)) {
      fields[String(el.elementId)] = tokenByElement.get(el.elementId)!;
    }
  }

  // Phase 4B — element budgeting. Long pages (large e-commerce / search) can
  // carry hundreds of interactive controls; serialising all of them bloats the
  // payload and prompt, slows /reason, and weakens target selection. Keep a
  // deterministic, viewport-aware subset. Redacted (sensitive) fields are
  // always retained. Capture still recorded EVERY control, so element_id and
  // the stale-target resolver stay valid for anything the model targets, and
  // an omitted control simply reappears on the next fresh capture.
  const { kept } = budgetElements(
    pageState.elements,
    captureBudgetSignals(),
    redactedIds,
    DEFAULT_BUDGET
  );

  // Path only, bounded. `location.search` / `location.hash` are deliberately
  // excluded — the existing contract keeps query parameters off the wire.
  const routeHint = readRouteHint();

  const context: SanitizedContext = {
    taskId: pageState.taskId,
    task,
    page: document.title || "unknown",
    urlOrigin: location.origin,
    ...(routeHint ? { routeHint } : {}),
    // Redacted elements STAY in this list — with the label replaced by
    // its token — so the model can see "there's a password field here"
    // (and target it for type_secret) without ever seeing its value.
    // Dropping redacted elements entirely was the earlier bug: the
    // model could never target something it couldn't see existed.
    elements: kept.map((el) => ({
      elementId: el.elementId,
      role: el.role,
      label: redactedIds.has(el.elementId) ? tokenByElement.get(el.elementId)! : el.label,
      // Privacy classification outranks ordinary occupancy: anything the
      // firewall redacted reports "redacted" regardless of whether it is
      // actually empty or filled, so occupancy of a sensitive field is never
      // disclosed. Non-editable elements carry no valueState at all.
      ...(el.valueState
        ? { valueState: (redactedIds.has(el.elementId) ? "redacted" : el.valueState) as ValueState }
        : {}),
    })),
    fields,
  };
  return { ok: true, context };
}

/**
 * Wire format adhering strictly to shared/schemas/sanitized-context.schema.json.
 */
export interface WireSanitizedContext {
  task_id: string;
  task: string;
  page: string;
  url_origin: string;
  route_hint?: string;
  elements: Array<{ element_id: number; role: string; label: string | null; value_state?: ValueState }>;
  fields: Record<string, string>;
  history?: StepRecord[];
}

/**
 * Converts internal camelCase SanitizedContext to snake_case wire payload.
 * Adheres strictly to shared/schemas/sanitized-context.schema.json.
 */
export function toWireSanitizedContext(context: SanitizedContext): WireSanitizedContext {
  const wire: WireSanitizedContext = {
    task_id: context.taskId,
    task: context.task,
    page: context.page,
    url_origin: context.urlOrigin,
    ...(context.routeHint ? { route_hint: context.routeHint } : {}),
    // `value_state` is emitted only when present; `value` is never sent.
    elements: context.elements.map((el) => ({
      element_id: el.elementId,
      role: el.role,
      label: el.label,
      ...(el.valueState ? { value_state: el.valueState } : {}),
    })),
    fields: context.fields,
  };

  if (context.history && context.history.length > 0) {
    wire.history = context.history;
  }

  return wire;
}
