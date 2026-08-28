/**
 * tests/privacy/detectPII.test.js
 *
 * Unit Tests — Tier-1 DOM-rule PII Detection
 * ==========================================
 * Framework: Node.js built-in test runner (node:test + node:assert)
 * No external test library required.
 *
 * Run with:
 *   node --test tests/privacy/detectPII.test.js
 *   node --test --test-reporter=spec tests/privacy/detectPII.test.js
 *
 * Or via npm script (add to package.json):
 *   "test:privacy": "node --test tests/privacy/detectPII.test.js"
 *
 * NOTE ON FILE PLACEMENT:
 * The tests/ README recommends unit tests live next to the code they test.
 * This file lives here instead because it was explicitly placed here for
 * integration into the cross-cutting test suite and to keep the shared/
 * directory import-path-clean. Adjust in a future refactor if needed.
 *
 * Imports use Node.js ESM — requires "type": "module" in the nearest
 * package.json, or run with --input-type=module.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectPII } from "../../shared/privacy/detectPII.js";
import { MOCK_DOM_STATE } from "../../shared/privacy/mockDomState.js";

// ---------------------------------------------------------------------------
// Helper: find a result by field id
// ---------------------------------------------------------------------------
function getResult(results, id) {
  const r = results.find((f) => f.id === id);
  assert.ok(r, `Field with id "${id}" not found in results`);
  return r;
}

// ---------------------------------------------------------------------------
// 1. Input validation
// ---------------------------------------------------------------------------
describe("detectPII — input validation", () => {
  it("throws TypeError when called with a non-array", () => {
    assert.throws(() => detectPII(null),   { name: "TypeError" });
    assert.throws(() => detectPII("bad"),  { name: "TypeError" });
    assert.throws(() => detectPII(42),     { name: "TypeError" });
    assert.throws(() => detectPII({}),     { name: "TypeError" });
  });

  it("returns empty array for empty input", () => {
    const results = detectPII([]);
    assert.deepEqual(results, []);
  });

  it("preserves all original field properties in output", () => {
    const field = {
      id: "f1",
      tag: "input",
      type: "email",
      autocomplete: "email",
      label: "Email",
      aria: { label: null, role: null },
      customProp: "should-survive",
    };
    const [result] = detectPII([field]);
    assert.equal(result.id, "f1");
    assert.equal(result.tag, "input");
    assert.equal(result.customProp, "should-survive");
  });
});

// ---------------------------------------------------------------------------
// 2. True positives — each PII category
// ---------------------------------------------------------------------------
describe("detectPII — true positives via autocomplete", () => {
  it("detects email via autocomplete:email", () => {
    const results = detectPII(MOCK_DOM_STATE);
    const r = getResult(results, "field-email");
    assert.equal(r.isPII, true);
    assert.equal(r.piiType, "email");
    assert.ok(r.matchedRule.startsWith('autocomplete:"'), `Unexpected rule: ${r.matchedRule}`);
  });

  it("detects credit card via autocomplete:cc-number", () => {
    const results = detectPII(MOCK_DOM_STATE);
    const r = getResult(results, "field-card-number");
    assert.equal(r.isPII, true);
    assert.equal(r.piiType, "creditcard");
    assert.equal(r.matchedRule, 'autocomplete:"cc-number"');
  });

  it("detects password via autocomplete:current-password", () => {
    const results = detectPII(MOCK_DOM_STATE);
    const r = getResult(results, "field-password");
    assert.equal(r.isPII, true);
    assert.equal(r.piiType, "password");
  });

  it("detects phone via autocomplete:tel", () => {
    const results = detectPII(MOCK_DOM_STATE);
    const r = getResult(results, "field-phone");
    assert.equal(r.isPII, true);
    assert.equal(r.piiType, "phone");
  });

  it("detects name via autocomplete:given-name", () => {
    const results = detectPII(MOCK_DOM_STATE);
    const r = getResult(results, "field-first-name");
    assert.equal(r.isPII, true);
    assert.equal(r.piiType, "name");
    assert.equal(r.matchedRule, 'autocomplete:"given-name"');
  });

  it("detects address via autocomplete:street-address", () => {
    const results = detectPII(MOCK_DOM_STATE);
    const r = getResult(results, "field-address");
    assert.equal(r.isPII, true);
    assert.equal(r.piiType, "address");
    assert.equal(r.matchedRule, 'autocomplete:"street-address"');
  });

  it("detects date-of-birth via autocomplete:bday", () => {
    const results = detectPII(MOCK_DOM_STATE);
    const r = getResult(results, "field-dob");
    assert.equal(r.isPII, true);
    assert.equal(r.piiType, "dob");
    assert.equal(r.matchedRule, 'autocomplete:"bday"');
  });

  it("detects username via autocomplete:username", () => {
    const results = detectPII(MOCK_DOM_STATE);
    const r = getResult(results, "field-username");
    assert.equal(r.isPII, true);
    assert.equal(r.piiType, "username");
    assert.equal(r.matchedRule, 'autocomplete:"username"');
  });
});

describe("detectPII — true positives via input type", () => {
  it("detects email via type=email even without autocomplete", () => {
    const [result] = detectPII([{
      id: "f", tag: "input", type: "email", autocomplete: "off",
      label: "", aria: {},
    }]);
    assert.equal(result.isPII, true);
    assert.equal(result.piiType, "email");
    assert.equal(result.matchedRule, 'input-type:"email"');
  });

  it("detects password via type=password even without autocomplete", () => {
    const [result] = detectPII([{
      id: "f", tag: "input", type: "password", autocomplete: "off",
      label: "", aria: {},
    }]);
    assert.equal(result.isPII, true);
    assert.equal(result.piiType, "password");
    assert.equal(result.matchedRule, 'input-type:"password"');
  });

  it("detects phone via type=tel even without autocomplete", () => {
    const [result] = detectPII([{
      id: "f", tag: "input", type: "tel", autocomplete: "off",
      label: "", aria: {},
    }]);
    assert.equal(result.isPII, true);
    assert.equal(result.piiType, "phone");
    assert.equal(result.matchedRule, 'input-type:"tel"');
  });
});

describe("detectPII — true positives via label keyword", () => {
  it("detects name via label 'Last name' with autocomplete:off", () => {
    const results = detectPII(MOCK_DOM_STATE);
    const r = getResult(results, "field-last-name");
    assert.equal(r.isPII, true);
    assert.equal(r.piiType, "name");
    assert.ok(r.matchedRule.startsWith('label-text:"'), `Expected label-text rule, got: ${r.matchedRule}`);
  });

  it("detects SSN via label 'Aadhaar number'", () => {
    const results = detectPII(MOCK_DOM_STATE);
    const r = getResult(results, "field-aadhaar");
    assert.equal(r.isPII, true);
    assert.equal(r.piiType, "ssn");
    assert.equal(r.matchedRule, 'label-text:"aadhaar"');
  });

  it("detects SSN via label 'Social Security Number'", () => {
    const results = detectPII(MOCK_DOM_STATE);
    const r = getResult(results, "field-ssn");
    assert.equal(r.isPII, true);
    assert.equal(r.piiType, "ssn");
    assert.equal(r.matchedRule, 'label-text:"social security"');
  });

  it("detects credit card via label 'CVV' with autocomplete:off", () => {
    const results = detectPII(MOCK_DOM_STATE);
    const r = getResult(results, "field-cvv");
    assert.equal(r.isPII, true);
    assert.equal(r.piiType, "creditcard");
  });

  it("detects phone via label 'Mobile number' with autocomplete:off", () => {
    const results = detectPII(MOCK_DOM_STATE);
    const r = getResult(results, "field-mobile");
    assert.equal(r.isPII, true);
    assert.equal(r.piiType, "phone");
  });

  it("detects PII case-insensitively (label 'EMAIL ADDRESS')", () => {
    const [result] = detectPII([{
      id: "f", tag: "input", type: "text", autocomplete: "off",
      label: "EMAIL ADDRESS", aria: {},
    }]);
    assert.equal(result.isPII, true);
    assert.equal(result.piiType, "email");
  });

  it("detects PII with extra surrounding label text ('Enter your full name below')", () => {
    const [result] = detectPII([{
      id: "f", tag: "input", type: "text", autocomplete: "off",
      label: "Enter your full name below", aria: {},
    }]);
    assert.equal(result.isPII, true);
    assert.equal(result.piiType, "name");
  });
});

describe("detectPII — true positives via aria-label", () => {
  it("detects email via aria-label when visible label and type are absent", () => {
    const results = detectPII(MOCK_DOM_STATE);
    const r = getResult(results, "field-aria-email");
    assert.equal(r.isPII, true);
    assert.equal(r.piiType, "email");
    assert.ok(r.matchedRule.startsWith('aria-label:"'), `Expected aria-label rule, got: ${r.matchedRule}`);
  });

  it("detects phone via aria-label", () => {
    const [result] = detectPII([{
      id: "f", tag: "input", type: "text", autocomplete: "off",
      label: "", aria: { label: "Your mobile number", role: null },
    }]);
    assert.equal(result.isPII, true);
    assert.equal(result.piiType, "phone");
    assert.ok(result.matchedRule.startsWith('aria-label:"'));
  });
});

// ---------------------------------------------------------------------------
// 3. True negatives — should NOT be flagged
// ---------------------------------------------------------------------------
describe("detectPII — true negatives", () => {
  it("does NOT flag a promo code field", () => {
    const results = detectPII(MOCK_DOM_STATE);
    const r = getResult(results, "field-promo");
    assert.equal(r.isPII, false);
    assert.equal(r.piiType, null);
    assert.equal(r.matchedRule, null);
  });

  it("does NOT flag a search field", () => {
    const results = detectPII(MOCK_DOM_STATE);
    const r = getResult(results, "field-search");
    assert.equal(r.isPII, false);
    assert.equal(r.piiType, null);
  });

  it("does NOT flag a quantity/numeric field", () => {
    const results = detectPII(MOCK_DOM_STATE);
    const r = getResult(results, "field-qty");
    assert.equal(r.isPII, false);
    assert.equal(r.piiType, null);
  });

  it("does NOT flag a loyalty points field", () => {
    const results = detectPII(MOCK_DOM_STATE);
    const r = getResult(results, "field-points");
    assert.equal(r.isPII, false);
    assert.equal(r.piiType, null);
  });

  it("does NOT flag an order notes textarea", () => {
    const results = detectPII(MOCK_DOM_STATE);
    const r = getResult(results, "field-notes");
    assert.equal(r.isPII, false);
    assert.equal(r.piiType, null);
  });

  it("does NOT flag a field with autocomplete:off and empty label", () => {
    const [result] = detectPII([{
      id: "f", tag: "input", type: "text", autocomplete: "off",
      label: "", aria: {},
    }]);
    assert.equal(result.isPII, false);
    assert.equal(result.piiType, null);
  });

  it("does NOT flag a field labeled 'Country code' for phone (label too ambiguous — state rule)", () => {
    // "country" keyword maps to address, not phone. This verifies specificity.
    const [result] = detectPII([{
      id: "f", tag: "input", type: "text", autocomplete: "off",
      label: "Country", aria: {},
    }]);
    // "country" IS a label keyword for address — so this IS PII.
    // This is intentional: country alone is considered address PII.
    assert.equal(result.isPII, true);
    assert.equal(result.piiType, "address");
  });
});

// ---------------------------------------------------------------------------
// 4. Edge cases
// ---------------------------------------------------------------------------
describe("detectPII — edge cases", () => {
  it("handles missing optional fields gracefully (no aria, no autocomplete)", () => {
    const [result] = detectPII([{ id: "f", tag: "input" }]);
    assert.equal(result.isPII, false);
    assert.equal(result.piiType, null);
  });

  it("handles null aria object gracefully", () => {
    const [result] = detectPII([{
      id: "f", tag: "input", type: "text", autocomplete: "off",
      label: "Something", aria: null,
    }]);
    // "Something" matches no PII rule
    assert.equal(result.isPII, false);
  });

  it("handles multi-token autocomplete ('shipping email')", () => {
    const [result] = detectPII([{
      id: "f", tag: "input", type: "text",
      autocomplete: "shipping email",
      label: "", aria: {},
    }]);
    assert.equal(result.isPII, true);
    assert.equal(result.piiType, "email");
    assert.equal(result.matchedRule, 'autocomplete:"email"');
  });

  it("handles multi-token autocomplete ('billing cc-number')", () => {
    const [result] = detectPII([{
      id: "f", tag: "input", type: "text",
      autocomplete: "billing cc-number",
      label: "", aria: {},
    }]);
    assert.equal(result.isPII, true);
    assert.equal(result.piiType, "creditcard");
  });

  it("autocomplete:on does NOT trigger any rule", () => {
    const [result] = detectPII([{
      id: "f", tag: "input", type: "text",
      autocomplete: "on",
      label: "", aria: {},
    }]);
    assert.equal(result.isPII, false);
  });

  it("processes a large array without throwing", () => {
    const bigArray = Array.from({ length: 500 }, (_, i) => ({
      id: `f${i}`,
      tag: "input",
      type: "text",
      autocomplete: "off",
      label: "Promo code",
      aria: {},
    }));
    const results = detectPII(bigArray);
    assert.equal(results.length, 500);
    assert.ok(results.every((r) => r.isPII === false));
  });

  it("autocomplete priority beats label keyword (cc-number wins over a label that says 'email')", () => {
    // Contrived field: autocomplete says cc-number, but label says email
    const [result] = detectPII([{
      id: "f", tag: "input", type: "text",
      autocomplete: "cc-number",
      label: "Email (used for card receipt)",
      aria: {},
    }]);
    // autocomplete priority is higher — should classify as creditcard
    assert.equal(result.isPII, true);
    assert.equal(result.piiType, "creditcard");
    assert.ok(result.matchedRule.startsWith('autocomplete:"'));
  });

  it("input type priority beats label keyword (type=password wins over neutral label)", () => {
    const [result] = detectPII([{
      id: "f", tag: "input", type: "password",
      autocomplete: "off",
      label: "Enter value", // no PII keyword in label
      aria: {},
    }]);
    assert.equal(result.isPII, true);
    assert.equal(result.piiType, "password");
    assert.equal(result.matchedRule, 'input-type:"password"');
  });

  it("label 'Search' does NOT match any PII keyword", () => {
    const [result] = detectPII([{
      id: "f", tag: "input", type: "search",
      autocomplete: "off",
      label: "Search",
      aria: { label: "Search products", role: "searchbox" },
    }]);
    assert.equal(result.isPII, false);
  });

  it("label 'User name' (with space) matches username rule", () => {
    const [result] = detectPII([{
      id: "f", tag: "input", type: "text",
      autocomplete: "off",
      label: "User name",
      aria: {},
    }]);
    assert.equal(result.isPII, true);
    assert.equal(result.piiType, "username");
  });

  it("returns correct count: MOCK_DOM_STATE has 14 PII and 5 non-PII fields", () => {
    const results = detectPII(MOCK_DOM_STATE);
    const piiCount    = results.filter((r) => r.isPII).length;
    const nonPiiCount = results.filter((r) => !r.isPII).length;
    assert.equal(piiCount,    14, `Expected 14 PII fields, got ${piiCount}`);
    assert.equal(nonPiiCount,  5, `Expected 5 non-PII fields, got ${nonPiiCount}`);
  });
});

// ---------------------------------------------------------------------------
// 5. Adversarial false-positive traps
//    These fields are deliberately crafted to look like PII to a naive
//    keyword scanner, but should return isPII: false under the current rules.
//    Each test documents exactly which rules were checked and why they passed.
// ---------------------------------------------------------------------------
describe("detectPII — adversarial false-positive traps", () => {

  /**
   * "Company Name"
   * ─────────────
   * Danger: contains the substring "name", which could naively collide with
   * the `name` PII rule's labelKeywords.
   *
   * Why it's safe: the name rule uses PHRASE keywords only:
   *   "full name", "first name", "last name", "surname", "given name",
   *   "family name", "middle name", "legal name", "display name", "your name"
   * None of those phrases appear as a substring of "company name".
   * "company name" does NOT contain "full name", "first name", etc.
   * The bare word "name" is intentionally absent from labelKeywords — this is
   * the protection. Tier 1 (autocomplete=off → skipped), Tier 2 (type=text →
   * no inputType match), Tier 3 (label scan → no phrase match). No match.
   */
  it("does NOT flag 'Company Name' — bare 'name' substring is not a PII keyword phrase", () => {
    const [result] = detectPII([{
      id: "adv-company-name",
      tag: "input",
      type: "text",
      autocomplete: "off",
      label: "Company Name",
      aria: {},
    }]);
    assert.equal(result.isPII, false,
      `Expected isPII=false but got piiType=${result.piiType}, matchedRule=${result.matchedRule}`);
    assert.equal(result.piiType, null);
    assert.equal(result.matchedRule, null);
  });

  /**
   * "Search users"
   * ──────────────
   * Danger: contains "user" which could collide with the `username` rule's
   * labelKeywords (specifically "user id", "user name", "username").
   *
   * Why it's safe: the username rule uses the phrases "username", "user name",
   * "user id", "login id", "account name", "screen name" — none of which is
   * a substring of "search users". "user" alone is not in the keyword list.
   * Tier 1: autocomplete=off → skipped. Tier 2: type=search → no inputType
   * match. Tier 3: "search users" contains no username keyword phrase, no
   * email keyword, no phone keyword, no name phrase, no address token, no
   * SSN keyword. No match anywhere.
   */
  it("does NOT flag 'Search users' — 'user' fragment does not match 'username' keyword phrases", () => {
    const [result] = detectPII([{
      id: "adv-search-users",
      tag: "input",
      type: "search",
      autocomplete: "off",
      label: "Search users",
      aria: { label: "Search users", role: "searchbox" },
    }]);
    assert.equal(result.isPII, false,
      `Expected isPII=false but got piiType=${result.piiType}, matchedRule=${result.matchedRule}`);
    assert.equal(result.piiType, null);
    assert.equal(result.matchedRule, null);
  });

  /**
   * "Promo code" with autocomplete="off"
   * ─────────────────────────────────────
   * Danger: autocomplete="off" is the same signal developers put on password/
   * sensitive fields. A naive detector might treat "off" as a sensitivity hint.
   * Label "Promo code" has "code" which could collide with "passcode" or
   * "one-time-code" in the password rule.
   *
   * Why it's safe:
   *   Tier 1: matchAutocomplete("off", ...) hits the early-exit guard and
   *           returns null — "off" is never a positive match.
   *   Tier 2: type=text → no inputType match (only "password" maps to password).
   *   Tier 3: password.labelKeywords = ["password","passphrase","pin","passcode",
   *           "otp","one-time"]. None is a substring of "promo code".
   *           "passcode" ⊄ "promo code" (different words entirely).
   *           No other rule's keywords match either.
   */
  it("does NOT flag 'Promo code' with autocomplete='off' — 'off' is not a positive signal and 'code' != 'passcode'", () => {
    const [result] = detectPII([{
      id: "adv-promo-code",
      tag: "input",
      type: "text",
      autocomplete: "off",
      label: "Promo code",
      aria: {},
    }]);
    assert.equal(result.isPII, false,
      `Expected isPII=false but got piiType=${result.piiType}, matchedRule=${result.matchedRule}`);
    assert.equal(result.piiType, null);
    assert.equal(result.matchedRule, null);
  });

});
