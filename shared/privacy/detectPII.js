/**
 * shared/privacy/detectPII.js
 *
 * Tier-1 DOM-rule PII Detection — Core Logic
 * ===========================================
 * Exports a single function: detectPII(fields)
 *
 * This module is intentionally framework-free and dependency-free.
 * It can be imported directly by:
 *   - extension/   (browser extension, Manifest V3 service worker / content script)
 *   - server/      (Node.js, if server-side pre-scan is needed)
 *
 * No ML, no NER, no network calls. Pure deterministic rule matching.
 *
 * Input schema (FieldDescriptor[]) — defined by Perception module mock until
 * the real DOM state format is available. See shared/privacy/mockDomState.js.
 *
 * Output schema (FieldResult[]) — each input field enriched with:
 *   isPII        {boolean}       — true if any PII signal was matched
 *   piiType      {string|null}   — canonical category (see PII_RULES) or null
 *   matchedRule  {string|null}   — audit string in the canonical format:
 *                                    <kebab-tier-name>:"<matched-value>"
 *                                  Examples:
 *                                    autocomplete:"cc-number"
 *                                    input-type:"email"
 *                                    label-text:"last name"
 *                                    aria-label:"email"
 *                                    aria-role:"searchbox"
 */

import { PII_RULES } from "./piiRules.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a string for comparison: lowercase + trim.
 * Returns empty string for null/undefined input.
 * @param {string|null|undefined} str
 * @returns {string}
 */
function norm(str) {
  return (str ?? "").toLowerCase().trim();
}

/**
 * Check whether `text` contains any of the provided `keywords` as a
 * case-insensitive substring match.
 *
 * @param {string} text        - The haystack (already normalised).
 * @param {string[]} keywords  - The needles (will be normalised internally).
 * @returns {string|null}      - The first matched keyword, or null.
 */
function findKeyword(text, keywords) {
  if (!text) return null;
  for (const kw of keywords) {
    if (text.includes(norm(kw))) return kw;
  }
  return null;
}

/**
 * Check whether `value` exactly matches any token in `tokens` (normalised).
 *
 * Autocomplete values can be space-separated lists, e.g. "shipping email".
 * We split on whitespace and check each token individually.
 *
 * @param {string} value   - The autocomplete attribute value (already normalised).
 * @param {string[]} tokens
 * @returns {string|null}  - The matched token, or null.
 */
function matchAutocomplete(value, tokens) {
  if (!value || value === "off" || value === "on") return null;
  // autocomplete can be a space-separated list: "shipping address-line1"
  const parts = value.split(/\s+/);
  for (const token of tokens) {
    const normToken = norm(token);
    if (parts.includes(normToken)) return token;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Core export
// ---------------------------------------------------------------------------

/**
 * Analyse an array of field descriptors and tag each one with PII metadata.
 *
 * Matching is applied in strict priority order (first match wins):
 *   1. autocomplete attribute value  — most explicit, HTML spec-defined
 *                                       matchedRule: autocomplete:"<token>"
 *   2. input type attribute          — HTML5 semantic types (email, tel, password)
 *                                       matchedRule: input-type:"<type>"
 *   3. label text keywords           — visible label substring match
 *                                       matchedRule: label-text:"<keyword>"
 *   4. aria-label text keywords      — accessible label substring match
 *                                       matchedRule: aria-label:"<keyword>"
 *   5. aria role                     — weakest signal, rarely used
 *                                       matchedRule: aria-role:"<role>"
 *
 * Rules are read from PII_RULES (shared/privacy/piiRules.js).
 * To extend detection, edit that file only — no changes needed here.
 *
 * @param {FieldDescriptor[]} fields - Array of field descriptors from Perception module.
 * @returns {FieldResult[]}          - Same fields, each enriched with isPII / piiType / matchedRule.
 */
export function detectPII(fields) {
  if (!Array.isArray(fields)) {
    throw new TypeError("detectPII: `fields` must be an array of FieldDescriptor objects.");
  }

  return fields.map((field) => {
    // Normalise field attributes once up front
    const autocomplete = norm(field.autocomplete);
    const inputType    = norm(field.type);
    const label        = norm(field.label);
    const ariaLabel    = norm(field.aria?.label);
    const ariaRole     = norm(field.aria?.role);

    // ── Priority 1: autocomplete token (scans ALL rules first) ────────────
    // We do a full pass over all rules at each priority tier before dropping
    // to the next tier. This guarantees that priority-1 of ANY rule beats
    // priority-2 of ANY other rule — regardless of declaration order.
    for (const rule of PII_RULES) {
      const acMatch = matchAutocomplete(autocomplete, rule.autocompleteTokens);
      if (acMatch !== null) {
        return {
          ...field,
          isPII: true,
          piiType: rule.piiType,
          matchedRule: `autocomplete:"${acMatch}"`,
        };
      }
    }

    // ── Priority 2: input type (scans ALL rules) ───────────────────────────
    if (inputType) {
      for (const rule of PII_RULES) {
        if (rule.inputTypes.includes(inputType)) {
          return {
            ...field,
            isPII: true,
            piiType: rule.piiType,
            matchedRule: `input-type:"${inputType}"`,
          };
        }
      }
    }

    // ── Priority 3: label text keyword (scans ALL rules) ──────────────────
    if (label) {
      for (const rule of PII_RULES) {
        const labelKw = findKeyword(label, rule.labelKeywords);
        if (labelKw !== null) {
          return {
            ...field,
            isPII: true,
            piiType: rule.piiType,
            matchedRule: `label-text:"${labelKw}"`,
          };
        }
      }
    }

    // ── Priority 4: aria-label keyword (scans ALL rules) ──────────────────
    if (ariaLabel) {
      for (const rule of PII_RULES) {
        const ariaLabelKw = findKeyword(ariaLabel, rule.labelKeywords);
        if (ariaLabelKw !== null) {
          return {
            ...field,
            isPII: true,
            piiType: rule.piiType,
            matchedRule: `aria-label:"${ariaLabelKw}"`,
          };
        }
      }
    }

    // ── Priority 5: aria role (scans ALL rules) ────────────────────────────
    if (ariaRole) {
      for (const rule of PII_RULES) {
        if (rule.ariaRoles.includes(ariaRole)) {
          return {
            ...field,
            isPII: true,
            piiType: rule.piiType,
            matchedRule: `aria-role:"${ariaRole}"`,
          };
        }
      }
    }

    // No rule matched — field is not PII
    return {
      ...field,
      isPII: false,
      piiType: null,
      matchedRule: null,
    };
  });
}

// ---------------------------------------------------------------------------
// JSDoc typedefs (for IDE autocomplete and documentation)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} FieldDescriptor
 * Describes a single form field as produced by the Perception module.
 * See shared/privacy/mockDomState.js for the mock implementation.
 *
 * @property {string}  id           - Unique field identifier (DOM id or synthetic key)
 * @property {string}  tag          - HTML tag: "input" | "select" | "textarea"
 * @property {string}  [type]       - HTML `type` attribute (e.g. "text", "email", "password")
 * @property {string}  [autocomplete] - HTML `autocomplete` attribute value
 * @property {string}  [label]      - Associated visible label text
 * @property {AriaInfo} [aria]      - ARIA attributes
 */

/**
 * @typedef {Object} AriaInfo
 * @property {string} [label] - Value of aria-label attribute
 * @property {string} [role]  - Value of role attribute
 */

/**
 * @typedef {Object} FieldResult
 * Extends FieldDescriptor with PII detection output.
 *
 * @property {boolean}      isPII       - True if the field was matched to a PII rule
 * @property {string|null}  piiType     - Canonical PII category, or null if not PII
 * @property {string|null}  matchedRule - Debug/audit string describing which signal matched
 */
