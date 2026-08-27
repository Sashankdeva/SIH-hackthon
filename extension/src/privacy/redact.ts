import type { PrivacyDetection, RedactionRecord } from "./types";

let tokenCounters: Record<string, number> = {};

function nextToken(category: string): string {
  tokenCounters[category] = (tokenCounters[category] ?? 0) + 1;
  return `[${category.toUpperCase()}_${String(tokenCounters[category]).padStart(2, "0")}]`;
}

/**
 * Deterministic redaction only — never delegated to a model. Every
 * detection becomes exactly one redaction record; nothing is dropped
 * silently, so redactionValidator.ts can prove full coverage before a
 * payload is ever built.
 */
export function redact(detections: PrivacyDetection[]): RedactionRecord[] {
  return detections.map((d) => ({
    elementId: d.elementId,
    category: d.category,
    method: d.category === "password" ? "blackout" : "semantic_token",
    token: nextToken(d.category),
  }));
}

export function resetTokenCounters(): void {
  tokenCounters = {};
}
