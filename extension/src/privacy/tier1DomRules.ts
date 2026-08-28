import type { CapturedElement } from "../perception/types";
import type { PrivacyDetection, SensitiveCategory } from "./types";

/**
 * Tier 1 only for this sprint: deterministic rules over input type and
 * label text. Tier 2 (local text-NER) and Tier 3 (visual/face detection)
 * are deferred past Sept 1 — see docs/ARCHITECTURE.md.
 */
const LABEL_KEYWORDS: Array<[RegExp, SensitiveCategory]> = [
  [/pass\s*word/i, "password"],
  [/e-?mail/i, "email"],
  [/phone|mobile/i, "phone"],
  [/full\s*name|your\s*name|first\s*name|last\s*name/i, "person_name"],
  [/address|street|city|postcode|zip|pin\s*code/i, "address"],
  [/aadhaar|passport|ssn|pan\s*card/i, "government_id"],
  [/card\s*number|cvv|expiry/i, "financial"],
];

export function detectTier1(elements: CapturedElement[]): PrivacyDetection[] {
  const detections: PrivacyDetection[] = [];

  for (const el of elements) {
    let category: SensitiveCategory | null = null;

    if (el.inputType === "password") category = "password";
    else if (el.inputType === "email") category = "email";
    else if (el.inputType === "tel") category = "phone";

    if (!category && el.label) {
      for (const [pattern, cat] of LABEL_KEYWORDS) {
        if (pattern.test(el.label)) {
          category = cat;
          break;
        }
      }
    }

    if (category) {
      detections.push({ elementId: el.elementId, category, source: "dom_rule", confidence: 0.9 });
    }
  }

  return detections;
}
