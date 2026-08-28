/**
 * shared/privacy/redactValue.js
 *
 * Phase 2 — Deterministic Redaction Renderer
 * ===========================================
 * Consumes the output of detectPII() and returns a new array of field objects
 * in which every PII field's value is replaced with a type-specific placeholder.
 *
 * Key guarantees:
 *   - DETERMINISTIC: identical input always produces identical output. No
 *     randomness, no timestamps, no run-dependent state in the mask strings.
 *   - IMMUTABLE: original field objects are never mutated. All returns are
 *     shallow-cloned objects with only `value` overwritten.
 *   - ZERO DEPENDENCIES: plain ES module, usable in both browser extension
 *     (Manifest V3) and Node.js (server/) without a bundler.
 *
 * Exports:
 *   redactValue(value, piiType)       → string   (low-level, single-value helper)
 *   redactFields(detectedFields)      → object[] (high-level, full-array pipeline)
 *
 * DO NOT modify detectPII.js or piiRules.js from this file.
 * This module is a consumer of their output, not a modifier.
 *
 * See shared/privacy/README.md → "Phase 2: Redaction Renderer" for the mask
 * naming convention and how to add a mask for a new piiType.
 */

// ---------------------------------------------------------------------------
// Redaction mask map
// ---------------------------------------------------------------------------

/**
 * Maps every canonical piiType string (defined in piiRules.js) to its
 * deterministic placeholder mask.
 *
 * Naming convention: [REDACTED_<PIITYPE_UPPERCASE>]
 *   - Square brackets signal machine-generated content to downstream consumers.
 *   - "REDACTED" is the fixed verb — consistent across all types.
 *   - The suffix matches the piiType in UPPER_SNAKE_CASE.
 *
 * HOW TO ADD A NEW MASK:
 *   1. Add a new piiType entry to piiRules.js first (see README.md).
 *   2. Add the corresponding entry here, following the naming convention:
 *        "your-new-type": "[REDACTED_YOUR_NEW_TYPE]"
 *   3. Add a test in tests/privacy/redactValue.test.js.
 *   4. Done — redactFields() picks it up automatically.
 *
 * @type {Record<string, string>}
 */
export const REDACTION_MASKS = Object.freeze({
  email:      "[REDACTED_EMAIL]",
  password:   "[REDACTED_PASSWORD]",
  phone:      "[REDACTED_PHONE]",
  creditcard: "[REDACTED_CARD]",
  name:       "[REDACTED_NAME]",
  address:    "[REDACTED_ADDRESS]",
  ssn:        "[REDACTED_SSN]",
  dob:        "[REDACTED_DOB]",
  username:   "[REDACTED_USERNAME]",
});

/**
 * Fallback mask used when piiType is truthy but has no entry in REDACTION_MASKS.
 * This prevents a future piiType addition from silently leaking a raw value
 * simply because someone forgot to add it to REDACTION_MASKS.
 *
 * The mask deliberately encodes the unknown piiType so the audit trail can
 * still identify which rule fired.
 *
 * @param {string} piiType
 * @returns {string}
 */
function fallbackMask(piiType) {
  return `[REDACTED_UNKNOWN:${String(piiType).toUpperCase()}]`;
}

// ---------------------------------------------------------------------------
// Low-level helper — redact a single value
// ---------------------------------------------------------------------------

/**
 * Return the redaction mask for a given piiType, or the original value if
 * piiType is null/undefined (i.e., the field is not PII).
 *
 * This is the single authoritative place where piiType → mask resolution
 * happens. Both redactFields() and external callers use this function.
 *
 * @param {string|null|undefined} value   - The raw field value to potentially mask.
 * @param {string|null|undefined} piiType - The canonical PII category from detectPII().
 * @returns {string|null|undefined}        - The mask string, or the original value unchanged.
 *
 * @example
 * redactValue("john@example.com", "email");    // → "[REDACTED_EMAIL]"
 * redactValue("+91-9876543210",   "phone");    // → "[REDACTED_PHONE]"
 * redactValue("PROMO2024",        null);       // → "PROMO2024"  (unchanged)
 * redactValue(undefined,          "email");    // → "[REDACTED_EMAIL]"  (value is masked regardless)
 */
export function redactValue(value, piiType) {
  // Not PII — return original value completely untouched.
  if (!piiType) return value;

  // Known piiType — return its deterministic mask.
  if (Object.prototype.hasOwnProperty.call(REDACTION_MASKS, piiType)) {
    return REDACTION_MASKS[piiType];
  }

  // Unknown piiType — return a safe fallback that still signals redaction
  // occurred and records the piiType in the mask for audit purposes.
  return fallbackMask(piiType);
}

// ---------------------------------------------------------------------------
// High-level pipeline — redact an array of detected fields
// ---------------------------------------------------------------------------

/**
 * Accept the array output of detectPII() and return a new array in which
 * every field that has isPII: true has its `value` replaced by the
 * appropriate deterministic mask.
 *
 * Fields with isPII: false are passed through as new shallow-cloned objects
 * (still non-mutating) with all properties unchanged.
 *
 * The `isPII`, `piiType`, and `matchedRule` audit properties written by
 * detectPII() are preserved on every output object — they are metadata, not
 * PII themselves.
 *
 * @param {FieldResult[]} detectedFields - Output array from detectPII().
 * @returns {RedactedField[]}            - New array; originals are never mutated.
 *
 * @throws {TypeError} if detectedFields is not an array.
 *
 * @example
 * const detected = detectPII(fields);
 * const redacted = redactFields(detected);
 * // redacted[n].value → mask string or original value
 * // detected[n]       → unchanged (no mutation)
 */
export function redactFields(detectedFields) {
  if (!Array.isArray(detectedFields)) {
    throw new TypeError(
      "redactFields: `detectedFields` must be an array (the output of detectPII())."
    );
  }

  return detectedFields.map((field) => {
    // Always return a new object — never mutate the original.
    return {
      ...field,
      value: redactValue(field.value, field.isPII ? field.piiType : null),
    };
  });
}

// ---------------------------------------------------------------------------
// JSDoc typedefs
// ---------------------------------------------------------------------------

/**
 * @typedef {import('./detectPII.js').FieldResult} FieldResult
 * The enriched field object produced by detectPII(). This is the expected
 * input type for redactFields().
 */

/**
 * @typedef {Object} RedactedField
 * The output of redactFields(). Identical to FieldResult but with `value`
 * replaced by a deterministic redaction mask for PII fields.
 *
 * @property {string|null|undefined} value      - Redacted mask, or original value for non-PII.
 * @property {boolean}               isPII      - Preserved from detectPII() output.
 * @property {string|null}           piiType    - Preserved from detectPII() output.
 * @property {string|null}           matchedRule- Preserved from detectPII() output.
 */
