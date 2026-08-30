import type { CapturedElement } from "../perception/types";
import type { PrivacyDetection, SensitiveCategory } from "./types";

/**
 * Tier 1 DOM-rule PII detection: deterministic rules over input type,
 * accessible label, and placeholder metadata.
 *
 * Precedence:
 * 1. High-confidence HTML inputType (password, email, tel).
 * 2. Accessible label keywords.
 * 3. Input placeholder keywords.
 */
const LABEL_KEYWORDS: Array<[RegExp, SensitiveCategory]> = [
  [/pass\s*word|pwd|passcode|\bpin\b(?!\s*code)/i, "password"],
  [/e\s*-?\s*mail/i, "email"],
  [/phone|mobile|cell|contact\s*(?:no|number)|telephone/i, "phone"],
  [/full\s*name|your\s*name|first\s*name|last\s*name|\bfname\b|\blname\b|customer\s*name/i, "person_name"],
  [/(?<!e\s*-?\s*mail\s*)address|street|city|postcode|zip(?:\s*code)?|pin\s*code|postal\s*code|state|country/i, "address"],
  [/aadhaar|passport|\bssn\b|social\s*security|pan\s*card|\bpan\b|permanent\s*account\s*number|government\s*id|gov\s*id|voter\s*id|driving\s*licen[sc]e|national\s*id/i, "government_id"],
  [/card\s*number|credit\s*card|debit\s*card|payment\s*card|card\s*details|\bcvv\b|\bcvc\b|expiry|exp\s*date|card\s*holder|account\s*number|routing\s*number|\biban\b|\bifsc\b/i, "financial"],
];

function matchCategory(text: string | null | undefined): SensitiveCategory | null {
  if (!text || typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  for (const [pattern, cat] of LABEL_KEYWORDS) {
    if (pattern.test(trimmed)) {
      return cat;
    }
  }
  return null;
}

export function detectTier1(elements: CapturedElement[]): PrivacyDetection[] {
  if (!Array.isArray(elements)) return [];
  const detections: PrivacyDetection[] = [];
  const seenIds = new Set<number>();

  for (const el of elements) {
    if (!el || typeof el.elementId !== "number") continue;
    if (seenIds.has(el.elementId)) continue;

    let category: SensitiveCategory | null = null;

    // 1. High-confidence inputType detection
    if (el.inputType === "password") category = "password";
    else if (el.inputType === "email") category = "email";
    else if (el.inputType === "tel") category = "phone";

    // 2. Accessible label keyword inspection
    if (!category && el.label) {
      category = matchCategory(el.label);
    }

    // 3. Placeholder keyword inspection (Supported DOM metadata)
    if (!category && el.placeholder) {
      category = matchCategory(el.placeholder);
    }

    if (category) {
      seenIds.add(el.elementId);
      detections.push({
        elementId: el.elementId,
        category,
        source: "dom_rule",
        confidence: el.inputType ? 1.0 : 0.9,
      });
    }
  }

  return detections;
}
