import type { PrivacyDetection, RedactionRecord } from "./types";

let tokenCounters: Record<string, number> = {};

function nextToken(category: string, counters: Record<string, number>): string {
  counters[category] = (counters[category] ?? 0) + 1;
  return `[${category.toUpperCase()}_${String(counters[category]).padStart(2, "0")}]`;
}

/**
 * Deterministic redaction only — never delegated to a model.
 * Every detection becomes exactly one redaction record.
 * Uses deterministic indexing per category so repeated independent scans
 * produce consistent token sequences ([CATEGORY_01], [CATEGORY_02], ...).
 */
export function redact(
  detections: PrivacyDetection[],
  options?: { preserveCounters?: boolean }
): RedactionRecord[] {
  if (!Array.isArray(detections)) return [];

  if (!options?.preserveCounters) {
    tokenCounters = {};
  }

  const seenIds = new Set<number>();
  const records: RedactionRecord[] = [];

  for (const d of detections) {
    if (!d || typeof d.elementId !== "number" || !d.category) continue;
    if (seenIds.has(d.elementId)) continue;
    seenIds.add(d.elementId);

    records.push({
      elementId: d.elementId,
      category: d.category,
      method: d.category === "password" ? "blackout" : "semantic_token",
      token: nextToken(d.category, tokenCounters),
    });
  }

  return records;
}

export function resetTokenCounters(): void {
  tokenCounters = {};
}

export function getCurrentTokenCounters(): Record<string, number> {
  return { ...tokenCounters };
}
