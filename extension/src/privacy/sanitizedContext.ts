import type { PageState } from "../perception/types";
import type { RedactionRecord } from "./types";
import { validateRedactionCoverage } from "./redactionValidator";
import type { PrivacyDetection } from "./types";
import { resolveElement } from "../perception/domCapture";
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
  elements: Array<{ elementId: number; role: string; label: string | null }>;
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


export type FirewallResult =
  | { ok: true; context: SanitizedContext }
  | { ok: false; missingElementIds: number[] };

/**
 * Sanitizes page title string to ensure raw PII (emails, phone numbers,
 * cards, government IDs) does not leak via document.title into the outbound
 * SanitizedContext 'page' field.
 */
export function sanitizePageTitle(rawTitle: string): string {
  if (!rawTitle || typeof rawTitle !== "string") return "unknown";
  let sanitized = rawTitle;
  // Redact email addresses
  sanitized = sanitized.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[EMAIL]");
  // Redact 13-19 digit card numbers
  sanitized = sanitized.replace(/\b(?:\d[ -]*?){13,19}\b/g, "[FINANCIAL]");
  // Redact phone numbers
  sanitized = sanitized.replace(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, "[PHONE]");
  // Redact Aadhaar / SSN / PAN identifiers
  sanitized = sanitized.replace(/\b\d{4}\s\d{4}\s\d{4}\b/g, "[GOVERNMENT_ID]");
  sanitized = sanitized.replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[GOVERNMENT_ID]");
  sanitized = sanitized.replace(/\b[A-Z]{5}[0-9]{4}[A-Z]\b/g, "[GOVERNMENT_ID]");
  return sanitized.trim() || "unknown";
}

/**
 * Extracts origin safely from location or page URL, guaranteeing that
 * query parameters and URL paths that may carry PII are never sent.
 */
export function sanitizeOrigin(pageUrl?: string): string {
  if (pageUrl !== undefined && pageUrl !== null) {
    if (typeof pageUrl === "string" && pageUrl.trim()) {
      try {
        const parsed = new URL(pageUrl);
        if (parsed.origin && parsed.origin !== "null") {
          return parsed.origin;
        }
      } catch {
        return "http://localhost";
      }
    }
    return "http://localhost";
  }
  if (typeof location !== "undefined" && location.origin && location.origin !== "null") {
    return location.origin;
  }
  return "http://localhost";
}

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
  if (!pageState || !Array.isArray(pageState.elements)) {
    return { ok: false, missingElementIds: [] };
  }

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
    if (el && typeof el.elementId === "number" && redactedIds.has(el.elementId)) {
      fields[String(el.elementId)] = tokenByElement.get(el.elementId)!;
    }
  }

  const rawTitle = pageState.title || (typeof document !== "undefined" ? document.title : "");
  const page = sanitizePageTitle(rawTitle);
  const urlOrigin = sanitizeOrigin(pageState.url);

  const context: SanitizedContext = {
    taskId: pageState.taskId || "unknown",
    task: task || "",
    page,
    urlOrigin,
    // Redacted elements STAY in this list — with the label replaced by
    // its token — so the model can see "there's a password field here"
    // (and target it for type_secret) without ever seeing its value.
    // Dropping redacted elements entirely was the earlier bug: the
    // model could never target something it couldn't see existed.
    elements: pageState.elements
      .filter((el) => el && typeof el.elementId === "number")
      .map((el) => ({
        elementId: el.elementId,
        role: el.role || "unknown",
        label: redactedIds.has(el.elementId) ? tokenByElement.get(el.elementId)! : (el.label ?? null),
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
  elements: Array<{ element_id: number; role: string; label: string | null }>;
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
    elements: context.elements.map((el) => ({
      element_id: el.elementId,
      role: el.role,
      label: el.label,
    })),
    fields: context.fields,
  };

  if (context.history && context.history.length > 0) {
    wire.history = context.history;
  }

  return wire;
}
