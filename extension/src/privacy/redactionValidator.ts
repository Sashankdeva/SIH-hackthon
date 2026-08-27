import type { PrivacyDetection, RedactionRecord } from "./types";

export interface ValidationResult {
  ok: boolean;
  missing: number[]; // elementIds that were detected but never redacted
}

/**
 * Confirms every flagged element actually got a redaction record before
 * a payload is allowed to be built. Day 2 task — see
 * PS26171_Role3_Privacy.pdf. This is what the Privacy Firewall
 * (sanitizedContext.ts) checks before it will emit anything.
 */
export function validateRedactionCoverage(
  detections: PrivacyDetection[],
  redactions: RedactionRecord[]
): ValidationResult {
  const redactedIds = new Set(redactions.map((r) => r.elementId));
  const missing = detections.filter((d) => !redactedIds.has(d.elementId)).map((d) => d.elementId);
  return { ok: missing.length === 0, missing };
}
