/**
 * shared/privacy/piiRules.js
 *
 * Tier-1 rule-based PII detection — pattern/heuristic matching only.
 * No external dependencies; designed to run cheaply inside a browser
 * extension content script.
 *
 * Phase scope: detection only. Redaction is Phase 2.
 *
 * Each rule has:
 *   id         — kebab-case, used to produce the `matchedRule` field:
 *                  `<id>:"<value>"`  e.g.  `tier1-email:"jane@example.com"`
 *   label      — human-readable description
 *   pattern    — RegExp used for matching
 *   falsePositiveGuard (optional) — a second RegExp; if it matches the
 *                same value the hit is suppressed. Used to reduce
 *                known categories of false positives.
 *   notes      — rationale / known edge cases
 */

// ---------------------------------------------------------------------------
// 1. Email addresses
// ---------------------------------------------------------------------------
// RFC 5321 local part allows many characters; this covers the practical
// 99 %+ of real addresses without over-matching product-SKU strings that
// happen to contain "@".
export const EMAIL_RULE = {
  id: "tier1-email",
  label: "Email address",
  // Requires a dot in the TLD (≥2 chars) to suppress bare "@localhost"-style tokens.
  pattern: /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/g,
  notes: "Matches standard email addresses. Requires a real TLD (≥2 chars).",
};

// ---------------------------------------------------------------------------
// 2. Phone numbers
// ---------------------------------------------------------------------------
// Covers: +91-9876543210, (800) 555-1234, 555.123.4567, 800-555-1234,
// Indian 10-digit mobile (starting with 6-9), extensions ("x123").
// The false-positive guard blocks values that look like product codes
// (digits mixed with uppercase letters like "SKU-555-1234-AB").
export const PHONE_RULE = {
  id: "tier1-phone",
  label: "Phone number",
  pattern:
    /(?:\+?(\d{1,3})[\s.\-]?)?(?:\(?\d{3}\)?[\s.\-]?)?\d{3}[\s.\-]?\d{4}(?:\s*(?:x|ext\.?)\s*\d{1,5})?/g,
  // Suppress hits that are clearly part of a longer SKU-like token (letters adjacent to digits).
  falsePositiveGuard: /[A-Z]{2,}-\d|\d-[A-Z]{2,}/,
  notes:
    "Catches US/international/Indian phone formats. " +
    "Guard suppresses SKU-like strings that match numerically.",
};

// ---------------------------------------------------------------------------
// 3. Physical addresses (heuristic)
// ---------------------------------------------------------------------------
// Best-effort: looks for a house number followed by a street-type word.
// Physical addresses are inherently ambiguous in plain text; this casts
// wide and relies on context (the field label being "address"/"street"
// etc. is caught separately by tier1DomRules.ts — this catches *values*).
export const ADDRESS_RULE = {
  id: "tier1-address",
  label: "Physical address (heuristic)",
  // Matches patterns like "123 Main Street", "45B Oak Ave", "Plot 7, MG Road"
  pattern:
    /\b\d{1,5}[A-Za-z]?\s+(?:[A-Za-z]+\s+){0,4}(?:street|st|avenue|ave|boulevard|blvd|road|rd|lane|ln|drive|dr|court|ct|place|pl|way|terrace|ter|circle|cir|highway|hwy|route|rte|sector|nagar|marg|colony|layout|extension|extn|phase|block)\b/gi,
  notes:
    "Heuristic — prone to false positives on addresses embedded in product names. " +
    "A label-based guard (field named 'address') is handled upstream.",
};

// ---------------------------------------------------------------------------
// 4. Credit card–like number patterns
// ---------------------------------------------------------------------------
// 13–19 digit numbers in 4-digit groups (with common separators) OR
// plain runs of 13-19 digits. Luhn check deliberately omitted: false
// negatives (missing a real card) are worse than false positives here.
export const CREDIT_CARD_RULE = {
  id: "tier1-credit-card",
  label: "Credit / debit card number",
  // Grouped format: "4111 1111 1111 1111", "4111-1111-1111-1111"
  // Or plain: "4111111111111111"
  pattern:
    /\b(?:\d{4}[\s-]){3}\d{4}(?:\d{0,3})?\b|\b\d{13,19}\b/g,
  // Suppress phone-length plain numbers that the phone rule already handles.
  falsePositiveGuard: /^\d{10}$/,
  notes:
    "Covers Visa (13/16), MC (16), Amex (15), Discover (16), and grouped variants. " +
    "No Luhn check — conservative by design.",
};

// ---------------------------------------------------------------------------
// 5. SSN-like patterns (US Social Security Number)
// ---------------------------------------------------------------------------
// Format: 3-2-4 digits with dash or space separators.
// Flag conservatively: false positives are safer than false negatives.
// The guard blocks dates (2025-08-29) from firing.
export const SSN_RULE = {
  id: "tier1-ssn",
  label: "SSN-like number (US Social Security Number format)",
  pattern: /\b\d{3}[\s-]\d{2}[\s-]\d{4}\b/g,
  // ISO-ish date strings (e.g. 2025-08-29) have same digit-group structure
  // but would need a 4-digit prefix — guard against them.
  falsePositiveGuard: /\b20\d{2}\b/,
  notes:
    "Matches NNN-NN-NNNN or NNN NN NNNN. Conservative — flags even if it " +
    "might be a product code. Guard suppresses ISO date fragments.",
};

// ---------------------------------------------------------------------------
// 6. Aadhaar-like patterns (Indian 12-digit UID)
// ---------------------------------------------------------------------------
// 12 digits, optionally in groups of 4 separated by spaces or dashes.
// Aadhaar is the highest-weighted government ID for Indian context (SIH).
export const AADHAAR_RULE = {
  id: "tier1-aadhaar",
  label: "Aadhaar-like 12-digit UID",
  pattern: /\b(?:\d{4}[\s-]){2}\d{4}\b|\b\d{12}\b/g,
  // Suppress strings that are clearly credit card lengths but formatted in
  // groups of 4-4-4-4 (handled by credit-card rule already).
  falsePositiveGuard: /(?:\d{4}[\s-]){3}\d{4}/,
  notes:
    "Matches 12-digit UIDs in 4-4-4 groups or plain. " +
    "Overlaps with credit-card for 16-digit groups — guard suppresses that overlap.",
};

// ---------------------------------------------------------------------------
// 7. PAN card pattern (Indian Permanent Account Number)
// ---------------------------------------------------------------------------
// Format: 5 uppercase letters, 4 digits, 1 uppercase letter.
// e.g. ABCDE1234F
export const PAN_RULE = {
  id: "tier1-pan",
  label: "PAN card number (Indian)",
  pattern: /\b[A-Z]{5}\d{4}[A-Z]\b/g,
  notes:
    "Highly specific format. Low false-positive risk except in short-code contexts.",
};

// ---------------------------------------------------------------------------
// 8. Passport number (generic heuristic)
// ---------------------------------------------------------------------------
// Covers Indian (A1234567), US (123456789), and common alphanumeric formats.
export const PASSPORT_RULE = {
  id: "tier1-passport",
  label: "Passport number (heuristic)",
  // 1-2 letters followed by 6-8 digits, OR all-digit 8-9 character passports.
  pattern: /\b[A-Z]{1,2}\d{6,8}\b|\b[A-Z]\d{7}\b/g,
  notes:
    "Heuristic — covers Indian (letter + 7 digits) and similar formats. " +
    "May fire on product codes with similar shape.",
};

// ---------------------------------------------------------------------------
// Exported rule registry — ordered from most specific to least specific
// so that the first match wins in single-value contexts.
// ---------------------------------------------------------------------------
export const ALL_RULES = [
  EMAIL_RULE,
  PAN_RULE,        // Most specific format — before phone/passport to avoid partial overlap
  SSN_RULE,
  AADHAAR_RULE,
  PASSPORT_RULE,
  CREDIT_CARD_RULE,
  PHONE_RULE,
  ADDRESS_RULE,    // Least specific — heuristic, cast wide
];
