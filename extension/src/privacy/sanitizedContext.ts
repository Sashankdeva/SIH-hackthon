import type { PageState } from "../perception/types";
import type { RedactionRecord } from "./types";
import { validateRedactionCoverage } from "./redactionValidator";
import type { PrivacyDetection } from "./types";

/** Mirrors shared/schemas/sanitized-context.schema.json — keep both in sync. */
export interface SanitizedContext {
  taskId: string;
  page: string;
  urlOrigin: string;
  elements: Array<{ elementId: number; role: string; label: string | null }>;
  fields: Record<string, string>;
}

/**
 * The Privacy Firewall: the only function allowed to produce a
 * network-bound payload. Returns null (and refuses to build anything)
 * if redaction coverage is incomplete — fail closed, per the project's
 * core invariant. See PS26171_Role3_Privacy.pdf, Day 3.
 */
export function buildSanitizedContext(
  pageState: PageState,
  detections: PrivacyDetection[],
  redactions: RedactionRecord[]
): SanitizedContext | null {
  const coverage = validateRedactionCoverage(detections, redactions);
  if (!coverage.ok) {
    console.error("[privacy-firewall] blocked: missing redactions for elements", coverage.missing);
    return null;
  }

  const redactedIds = new Set(redactions.map((r) => r.elementId));
  const tokenByElement = new Map(redactions.map((r) => [r.elementId, r.token]));

  const fields: Record<string, string> = {};
  for (const el of pageState.elements) {
    if (redactedIds.has(el.elementId)) {
      fields[String(el.elementId)] = tokenByElement.get(el.elementId)!;
    }
  }

  return {
    taskId: pageState.taskId,
    page: document.title || "unknown",
    urlOrigin: location.origin,
    elements: pageState.elements
      .filter((el) => !redactedIds.has(el.elementId))
      .map((el) => ({ elementId: el.elementId, role: el.role, label: el.label })),
    fields,
  };
}
