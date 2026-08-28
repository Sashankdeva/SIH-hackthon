/**
 * shared/privacy/mockDomState.js
 *
 * MOCK DOM STATE — Tier-1 PII Detection Development Fixture
 * ==========================================================
 *
 * !! TEMPORARY — REPLACE WHEN PERCEPTION MODULE IS READY !!
 * ---------------------------------------------------------
 * This file provides a static mock of the FieldDescriptor[] array that will
 * eventually be produced at runtime by the Perception module
 * (extension/src/perception/ — not yet built as of Sprint 1).
 *
 * Once Perception's real DOM-traversal output is available:
 *   1. Delete or archive this file.
 *   2. Wire detectPII() directly to the live Perception output.
 *   3. Verify the live output matches the FieldDescriptor schema defined in
 *      shared/privacy/detectPII.js (JSDoc typedef section).
 *
 * Perception module owner: coordinate with Privacy Guard role before changing
 * the FieldDescriptor schema — detectPII.js and these tests depend on it.
 *
 * SCHEMA (FieldDescriptor):
 * {
 *   id           : string   — stable unique key (DOM id or synthetic)
 *   tag          : string   — HTML element tag ("input" | "select" | "textarea")
 *   type         : string   — value of the HTML `type` attribute (for inputs)
 *   autocomplete : string   — value of the HTML `autocomplete` attribute
 *   label        : string   — associated visible label text (from <label>, title, placeholder)
 *   aria         : {
 *     label : string | null — value of aria-label attribute
 *     role  : string | null — value of role attribute
 *   }
 * }
 */

/**
 * Mock field descriptors representing a realistic checkout / account form.
 * Covers all PII categories defined in shared/privacy/piiRules.js.
 *
 * @type {import('./detectPII.js').FieldDescriptor[]}
 */
export const MOCK_DOM_STATE = [
  // ── TRUE POSITIVES — should be flagged ───────────────────────────────────

  // email — matched via input type AND autocomplete AND label
  {
    id: "field-email",
    tag: "input",
    type: "email",
    autocomplete: "email",
    label: "Email address",
    aria: { label: null, role: null },
  },

  // creditcard — matched via autocomplete token "cc-number"
  {
    id: "field-card-number",
    tag: "input",
    type: "text",
    autocomplete: "cc-number",
    label: "Card number",
    aria: { label: null, role: null },
  },

  // password — matched via input type "password"
  {
    id: "field-password",
    tag: "input",
    type: "password",
    autocomplete: "current-password",
    label: "Password",
    aria: { label: null, role: null },
  },

  // phone — matched via input type "tel"
  {
    id: "field-phone",
    tag: "input",
    type: "tel",
    autocomplete: "tel",
    label: "Phone number",
    aria: { label: null, role: null },
  },

  // name — matched via autocomplete "given-name"
  {
    id: "field-first-name",
    tag: "input",
    type: "text",
    autocomplete: "given-name",
    label: "First name",
    aria: { label: null, role: null },
  },

  // name — matched via label keyword "last name"
  {
    id: "field-last-name",
    tag: "input",
    type: "text",
    autocomplete: "off",
    label: "Last name",
    aria: { label: null, role: null },
  },

  // address — matched via autocomplete "street-address"
  {
    id: "field-address",
    tag: "textarea",
    type: "text",
    autocomplete: "street-address",
    label: "Delivery address",
    aria: { label: null, role: null },
  },

  // ssn — matched via label keyword "aadhaar"
  {
    id: "field-aadhaar",
    tag: "input",
    type: "text",
    autocomplete: "off",
    label: "Aadhaar number",
    aria: { label: null, role: null },
  },

  // dob — matched via autocomplete "bday"
  {
    id: "field-dob",
    tag: "input",
    type: "date",
    autocomplete: "bday",
    label: "Date of birth",
    aria: { label: null, role: null },
  },

  // username — matched via autocomplete "username"
  {
    id: "field-username",
    tag: "input",
    type: "text",
    autocomplete: "username",
    label: "Username",
    aria: { label: null, role: null },
  },

  // creditcard — matched via label keyword (no autocomplete signal)
  {
    id: "field-cvv",
    tag: "input",
    type: "text",
    autocomplete: "off",
    label: "CVV",
    aria: { label: null, role: null },
  },

  // phone — matched via label keyword "mobile" (no type or autocomplete signal)
  {
    id: "field-mobile",
    tag: "input",
    type: "text",
    autocomplete: "off",
    label: "Mobile number",
    aria: { label: null, role: null },
  },

  // ssn — matched via label keyword "social security"
  {
    id: "field-ssn",
    tag: "input",
    type: "text",
    autocomplete: "off",
    label: "Social Security Number",
    aria: { label: null, role: null },
  },

  // email — matched via aria-label only (no visible label, no type hint)
  {
    id: "field-aria-email",
    tag: "input",
    type: "text",
    autocomplete: "off",
    label: "",
    aria: { label: "Email address", role: null },
  },

  // ── TRUE NEGATIVES — should NOT be flagged ───────────────────────────────

  // promo code — label contains no PII keywords
  {
    id: "field-promo",
    tag: "input",
    type: "text",
    autocomplete: "off",
    label: "Promo code",
    aria: { label: null, role: null },
  },

  // search field — label "Search" should never flag
  {
    id: "field-search",
    tag: "input",
    type: "search",
    autocomplete: "off",
    label: "Search",
    aria: { label: "Search products", role: "searchbox" },
  },

  // quantity — purely numeric, no PII
  {
    id: "field-qty",
    tag: "input",
    type: "number",
    autocomplete: "off",
    label: "Quantity",
    aria: { label: null, role: "spinbutton" },
  },

  // loyalty points — non-sensitive numeric label
  {
    id: "field-points",
    tag: "input",
    type: "text",
    autocomplete: "off",
    label: "Loyalty points to redeem",
    aria: { label: null, role: null },
  },

  // message / notes — generic textarea
  {
    id: "field-notes",
    tag: "textarea",
    type: "text",
    autocomplete: "off",
    label: "Order notes",
    aria: { label: null, role: null },
  },
];
