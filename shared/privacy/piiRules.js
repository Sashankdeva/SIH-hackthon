/**
 * shared/privacy/piiRules.js
 *
 * Tier-1 DOM-rule PII Detection — Rule Configuration
 * =====================================================
 * This file is PURE CONFIG — no logic lives here.
 * Add, remove, or modify entries freely; detectPII.js picks them up automatically.
 *
 * Rule structure per PII category:
 * {
 *   piiType: string           — canonical PII category name returned in results
 *   inputTypes: string[]      — HTML input `type` attribute values that signal this PII
 *   autocompleteTokens: string[] — HTML autocomplete attribute values (full or prefix match)
 *   labelKeywords: string[]   — case-insensitive substrings to match in label / aria-label text
 *   ariaRoles: string[]       — ARIA roles that suggest this PII (rare but included for coverage)
 * }
 *
 * Matching priority (applied in detectPII.js in this order, first match wins):
 *   1. autocomplete token  — most explicit signal, spec-defined
 *   2. input type          — HTML5 semantic type
 *   3. label keyword       — visible text match
 *   4. aria-label keyword  — accessible label text match
 *   5. aria role           — ARIA role hint (weakest signal)
 *
 * HOW TO ADD A NEW RULE:
 *   1. Add a new entry object to the PII_RULES array below.
 *   2. Pick a unique, lowercase `piiType` string (e.g. "passport").
 *   3. Fill in as many signal arrays as you can — leave empty arrays [] for unused ones.
 *   4. That's it. No changes to detectPII.js needed.
 *
 * See shared/privacy/README.md for the full extension guide.
 */

/** @type {Array<PiiRule>} */
export const PII_RULES = [
  // --- Email ----------------------------------------------------------------
  {
    piiType: "email",
    inputTypes: ["email"],
    autocompleteTokens: ["email"],
    labelKeywords: ["email", "e-mail", "electronic mail"],
    ariaRoles: [],
  },

  // --- Password -------------------------------------------------------------
  {
    piiType: "password",
    inputTypes: ["password"],
    autocompleteTokens: [
      "current-password",
      "new-password",
      "one-time-code", // OTP is also sensitive
    ],
    labelKeywords: ["password", "passphrase", "pin", "passcode", "otp", "one-time"],
    ariaRoles: [],
  },

  // --- Phone / Telephone ----------------------------------------------------
  {
    piiType: "phone",
    inputTypes: ["tel"],
    autocompleteTokens: [
      "tel",
      "tel-national",
      "tel-area-code",
      "tel-local",
      "tel-extension",
      "tel-country-code",
    ],
    labelKeywords: [
      "phone",
      "mobile",
      "cell",
      "telephone",
      "contact number",
      "whatsapp",
      "fax",
    ],
    ariaRoles: [],
  },

  // --- Credit / Debit Card --------------------------------------------------
  {
    piiType: "creditcard",
    inputTypes: [],
    autocompleteTokens: [
      "cc-number",
      "cc-name",
      "cc-given-name",
      "cc-additional-name",
      "cc-family-name",
      "cc-exp",
      "cc-exp-month",
      "cc-exp-year",
      "cc-csc",
      "cc-type",
    ],
    labelKeywords: [
      "card number",
      "card no",
      "credit card",
      "debit card",
      "cvv",
      "cvc",
      "csc",
      "card expiry",
      "expiration date",
      "expiry date",
      "cardholder",
      "card holder",
    ],
    ariaRoles: [],
  },

  // --- Full Name ------------------------------------------------------------
  {
    piiType: "name",
    inputTypes: [],
    autocompleteTokens: [
      "name",
      "given-name",
      "additional-name",
      "family-name",
      "honorific-prefix",
      "honorific-suffix",
      "nickname",
    ],
    labelKeywords: [
      "full name",
      "first name",
      "last name",
      "surname",
      "given name",
      "family name",
      "middle name",
      "legal name",
      "display name",
      "your name",
    ],
    ariaRoles: [],
  },

  // --- Physical Address -----------------------------------------------------
  {
    piiType: "address",
    inputTypes: [],
    autocompleteTokens: [
      "street-address",
      "address-line1",
      "address-line2",
      "address-line3",
      "address-level1", // state/province
      "address-level2", // city/town
      "address-level3",
      "address-level4",
      "country",
      "country-name",
      "postal-code",
    ],
    labelKeywords: [
      "address",
      "street",
      "city",
      "state",
      "province",
      "zip code",
      "postal code",
      "pincode",
      "pin code",
      "country",
      "locality",
      "district",
      "apartment",
      "flat",
      "house number",
    ],
    ariaRoles: [],
  },

  // --- SSN / National ID ----------------------------------------------------
  {
    piiType: "ssn",
    inputTypes: [],
    autocompleteTokens: [], // No standard autocomplete token for SSN
    labelKeywords: [
      "ssn",
      "social security",
      "national id",
      "national identification",
      "national insurance",
      "aadhaar",
      "aadhar",
      "pan number",
      "pan card",
      "passport number",
      "driving licence",
      "driver license",
      "voter id",
      "tax id",
      "tin",
      "ein",
      "identity number",
    ],
    ariaRoles: [],
  },

  // --- Date of Birth --------------------------------------------------------
  {
    piiType: "dob",
    inputTypes: [],
    autocompleteTokens: ["bday", "bday-day", "bday-month", "bday-year"],
    labelKeywords: [
      "date of birth",
      "birth date",
      "birthday",
      "dob",
      "born on",
    ],
    ariaRoles: [],
  },

  // --- Username / Account ---------------------------------------------------
  {
    piiType: "username",
    inputTypes: [],
    autocompleteTokens: ["username"],
    labelKeywords: [
      "username",
      "user name",
      "user id",
      "login id",
      "account name",
      "screen name",
    ],
    ariaRoles: [],
  },
];

/**
 * @typedef {Object} PiiRule
 * @property {string}   piiType             - Canonical PII category identifier
 * @property {string[]} inputTypes          - HTML input type values (e.g. "email", "tel")
 * @property {string[]} autocompleteTokens  - HTML autocomplete attribute tokens
 * @property {string[]} labelKeywords       - Case-insensitive label text keywords
 * @property {string[]} ariaRoles           - ARIA role values
 */
