/**
 * shared/privacy/detectPII.js
 *
 * Tier-1 DOM-state PII scanner.
 *
 * Phase scope: detection ONLY — no redaction, no network calls,
 * no profile/secret storage touched.
 *
 * Exports:
 *   detectPII(domState) → PiiMatch[]
 *
 * DomState shape expected by this module:
 *   {
 *     fields: {
 *       [fieldName: string]: string   // field name → current value string
 *     }
 *   }
 *
 * This is deliberately a subset of the full CapturedElement/PageState
 * used by extension/src/perception — keeping shared/ dependency-free
 * of TypeScript types. Callers bridge between the two shapes.
 *
 * PiiMatch:
 *   {
 *     value:       string   — the matched text (as found)
 *     field:       string   — the field/node name it was found in
 *     matchedRule: string   — `<rule-id>:"<matched-value>"`
 *                              e.g. `tier1-email:"jane@example.com"`
 *   }
 */

import { ALL_RULES } from "./piiRules.js";

/**
 * Re-creates the RegExp from a rule's pattern with the global flag
 * guaranteed to be set and the lastIndex reset. This is required because
 * RegExp objects with the /g flag are stateful — reusing the same object
 * across calls would advance lastIndex and miss subsequent matches.
 *
 * @param {RegExp} pattern
 * @returns {RegExp}
 */
function freshRegex(pattern) {
  return new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
}

/**
 * Scans a single string value against all PII rules.
 *
 * @param {string} fieldName  — name of the field this value came from
 * @param {string} value      — the raw string to scan
 * @returns {import('./detectPII.js').PiiMatch[]}
 */
function scanValue(fieldName, value) {
  if (!value || typeof value !== "string" || value.trim() === "") return [];

  /** @type {Array<{value: string, field: string, matchedRule: string}>} */
  const matches = [];

  for (const rule of ALL_RULES) {
    const regex = freshRegex(rule.pattern);
    let m;

    while ((m = regex.exec(value)) !== null) {
      const matchedText = m[0].trim();
      if (!matchedText) continue;

      // Apply false-positive guard if the rule declares one.
      if (rule.falsePositiveGuard) {
        if (rule.falsePositiveGuard.test(matchedText)) {
          // Reset lastIndex after test() — guards use non-global patterns.
          rule.falsePositiveGuard.lastIndex = 0;
          continue;
        }
        rule.falsePositiveGuard.lastIndex = 0;
      }

      matches.push({
        value: matchedText,
        field: fieldName,
        // Exact format mandated by the spec: `<rule-id>:"<matched-value>"`
        matchedRule: `${rule.id}:"${matchedText}"`,
      });
    }
  }

  return matches;
}

/**
 * Scans a captured DOM state object and returns all detected PII matches.
 *
 * @param {{ fields: Record<string, string> }} domState
 * @returns {Array<{ value: string, field: string, matchedRule: string }>}
 *
 * @example
 * const matches = detectPII({
 *   fields: {
 *     email: "jane@example.com",
 *     notes: "Call me at 800-555-1234",
 *   }
 * });
 * // → [
 * //     { value: "jane@example.com", field: "email",  matchedRule: 'tier1-email:"jane@example.com"' },
 * //     { value: "800-555-1234",     field: "notes",  matchedRule: 'tier1-phone:"800-555-1234"' },
 * //   ]
 */
export function detectPII(domState) {
  if (!domState || typeof domState !== "object") {
    throw new TypeError("detectPII: domState must be an object with a `fields` map");
  }

  const { fields } = domState;

  if (!fields || typeof fields !== "object") {
    throw new TypeError("detectPII: domState.fields must be a non-null object");
  }

  /** @type {Array<{ value: string, field: string, matchedRule: string }>} */
  const allMatches = [];

  for (const [fieldName, rawValue] of Object.entries(fields)) {
    const value = typeof rawValue === "string" ? rawValue : String(rawValue ?? "");
    const hits = scanValue(fieldName, value);
    allMatches.push(...hits);
  }

  return allMatches;
}
