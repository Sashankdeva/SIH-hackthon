/**
 * tests/privacy/redactValue.test.js
 *
 * Unit Tests — Phase 2: Deterministic Redaction Renderer
 * ======================================================
 * Framework: Node.js built-in test runner (node:test + node:assert)
 *
 * Run with:
 *   node --test tests/privacy/redactValue.test.js
 *   node --test --test-reporter=spec tests/privacy/redactValue.test.js
 *
 * Or via npm script:
 *   "test:redact": "node --test tests/privacy/redactValue.test.js"
 *
 * Run both Phase 1 + Phase 2 tests together:
 *   node --test tests/privacy/
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  REDACTION_MASKS,
  redactValue,
  redactFields,
} from "../../shared/privacy/redactValue.js";

import { detectPII } from "../../shared/privacy/detectPII.js";
import { MOCK_DOM_STATE } from "../../shared/privacy/mockDomState.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal FieldResult as if detectPII() had already processed it.
 * Keeps test cases concise without requiring a full detectPII() call.
 */
function makeDetected({ id = "f", tag = "input", type = "text",
                        value = "raw-value", isPII, piiType,
                        matchedRule = null } = {}) {
  return { id, tag, type, value, isPII, piiType, matchedRule };
}

// ---------------------------------------------------------------------------
// 1. REDACTION_MASKS shape
// ---------------------------------------------------------------------------
describe("REDACTION_MASKS — shape and content", () => {
  it("is a frozen object (cannot be mutated at runtime)", () => {
    assert.ok(Object.isFrozen(REDACTION_MASKS), "REDACTION_MASKS must be frozen");
  });

  it("contains exactly the 9 piiType keys defined in piiRules.js", () => {
    const expectedKeys = [
      "email", "password", "phone", "creditcard",
      "name", "address", "ssn", "dob", "username",
    ];
    const actualKeys = Object.keys(REDACTION_MASKS).sort();
    assert.deepEqual(actualKeys.sort(), expectedKeys.sort(),
      "REDACTION_MASKS keys must match piiRules.js piiType strings exactly");
  });

  it("every mask follows the [REDACTED_*] naming convention", () => {
    for (const [piiType, mask] of Object.entries(REDACTION_MASKS)) {
      assert.ok(
        mask.startsWith("[REDACTED_") && mask.endsWith("]"),
        `Mask for "${piiType}" does not follow [REDACTED_*] format: "${mask}"`
      );
    }
  });

  it("all mask values are non-empty strings", () => {
    for (const [piiType, mask] of Object.entries(REDACTION_MASKS)) {
      assert.equal(typeof mask, "string", `Mask for "${piiType}" is not a string`);
      assert.ok(mask.length > 0, `Mask for "${piiType}" is empty`);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. redactValue — every piiType produces the correct mask
// ---------------------------------------------------------------------------
describe("redactValue — correct mask per piiType", () => {
  // Generate one test per entry in REDACTION_MASKS so new piiTypes are
  // automatically covered as REDACTION_MASKS grows.
  for (const [piiType, expectedMask] of Object.entries(REDACTION_MASKS)) {
    it(`piiType="${piiType}" → "${expectedMask}"`, () => {
      const result = redactValue("any-raw-value", piiType);
      assert.equal(result, expectedMask,
        `redactValue for piiType="${piiType}" returned "${result}", expected "${expectedMask}"`);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. redactValue — specific named assertions (explicit contract documentation)
// ---------------------------------------------------------------------------
describe("redactValue — named piiType assertions", () => {
  it('email      → "[REDACTED_EMAIL]"',    () => assert.equal(redactValue("user@example.com", "email"),    "[REDACTED_EMAIL]"));
  it('password   → "[REDACTED_PASSWORD]"', () => assert.equal(redactValue("s3cr3tP@ss",       "password"), "[REDACTED_PASSWORD]"));
  it('phone      → "[REDACTED_PHONE]"',    () => assert.equal(redactValue("+91-9876543210",    "phone"),   "[REDACTED_PHONE]"));
  it('creditcard → "[REDACTED_CARD]"',     () => assert.equal(redactValue("4111111111111111",  "creditcard"), "[REDACTED_CARD]"));
  it('name       → "[REDACTED_NAME]"',     () => assert.equal(redactValue("Jane Doe",          "name"),    "[REDACTED_NAME]"));
  it('address    → "[REDACTED_ADDRESS]"',  () => assert.equal(redactValue("12 Main St",        "address"), "[REDACTED_ADDRESS]"));
  it('ssn        → "[REDACTED_SSN]"',      () => assert.equal(redactValue("123-45-6789",       "ssn"),     "[REDACTED_SSN]"));
  it('dob        → "[REDACTED_DOB]"',      () => assert.equal(redactValue("1990-01-15",        "dob"),     "[REDACTED_DOB]"));
  it('username   → "[REDACTED_USERNAME]"', () => assert.equal(redactValue("janedoe42",         "username"),"[REDACTED_USERNAME]"));
});

// ---------------------------------------------------------------------------
// 4. redactValue — non-PII pass-through
// ---------------------------------------------------------------------------
describe("redactValue — non-PII pass-through", () => {
  it("null piiType returns value unchanged", () => {
    assert.equal(redactValue("PROMO2024", null), "PROMO2024");
  });

  it("undefined piiType returns value unchanged", () => {
    assert.equal(redactValue("some-text", undefined), "some-text");
  });

  it("empty string piiType returns value unchanged (falsy)", () => {
    assert.equal(redactValue("raw", ""), "raw");
  });

  it("preserves undefined value when piiType is null", () => {
    assert.equal(redactValue(undefined, null), undefined);
  });

  it("preserves empty string value when piiType is null", () => {
    assert.equal(redactValue("", null), "");
  });

  it("preserves numeric value (as-is) when piiType is null", () => {
    assert.equal(redactValue(42, null), 42);
  });
});

// ---------------------------------------------------------------------------
// 5. redactValue — unknown / future piiType fallback
// ---------------------------------------------------------------------------
describe("redactValue — unknown piiType fallback (future-proofing)", () => {
  it("unknown piiType returns a [REDACTED_UNKNOWN:*] string, not the raw value", () => {
    const result = redactValue("sensitive-biometric-data", "biometric");
    assert.ok(
      result.startsWith("[REDACTED_UNKNOWN:"),
      `Expected fallback mask, got: "${result}"`
    );
    assert.ok(result.endsWith("]"), `Fallback mask must end with "]", got: "${result}"`);
  });

  it("fallback mask encodes the piiType in uppercase for auditability", () => {
    const result = redactValue("data", "passport");
    assert.ok(result.includes("PASSPORT"),
      `Fallback mask should include uppercase piiType, got: "${result}"`);
  });

  it("fallback mask is deterministic — same piiType always produces same mask", () => {
    assert.equal(
      redactValue("x", "future-type"),
      redactValue("x", "future-type")
    );
  });

  it("fallback mask does NOT contain the raw value", () => {
    const sensitiveValue = "TOP_SECRET_BIOMETRIC_123";
    const result = redactValue(sensitiveValue, "biometric");
    assert.ok(!result.includes(sensitiveValue),
      `Fallback mask must not leak the raw value. Got: "${result}"`);
  });
});

// ---------------------------------------------------------------------------
// 6. redactFields — input validation
// ---------------------------------------------------------------------------
describe("redactFields — input validation", () => {
  it("throws TypeError for non-array input", () => {
    assert.throws(() => redactFields(null),   { name: "TypeError" });
    assert.throws(() => redactFields("bad"),  { name: "TypeError" });
    assert.throws(() => redactFields(42),     { name: "TypeError" });
    assert.throws(() => redactFields({}),     { name: "TypeError" });
  });

  it("returns empty array for empty input", () => {
    assert.deepEqual(redactFields([]), []);
  });
});

// ---------------------------------------------------------------------------
// 7. redactFields — correct masking of PII fields
// ---------------------------------------------------------------------------
describe("redactFields — PII fields are masked", () => {
  it("masks a single email field", () => {
    const input = [makeDetected({ value: "user@example.com", isPII: true, piiType: "email" })];
    const [result] = redactFields(input);
    assert.equal(result.value, "[REDACTED_EMAIL]");
  });

  it("masks a single password field", () => {
    const input = [makeDetected({ value: "s3cr3t", isPII: true, piiType: "password" })];
    const [result] = redactFields(input);
    assert.equal(result.value, "[REDACTED_PASSWORD]");
  });

  it("masks a credit card field", () => {
    const input = [makeDetected({ value: "4111111111111111", isPII: true, piiType: "creditcard" })];
    const [result] = redactFields(input);
    assert.equal(result.value, "[REDACTED_CARD]");
  });

  it("masks all 9 piiTypes correctly in a single batch", () => {
    const fields = Object.entries(REDACTION_MASKS).map(([piiType, expectedMask]) =>
      makeDetected({ id: piiType, value: `raw-${piiType}`, isPII: true, piiType })
    );
    const results = redactFields(fields);
    for (const result of results) {
      const expectedMask = REDACTION_MASKS[result.piiType];
      assert.equal(result.value, expectedMask,
        `piiType="${result.piiType}" → expected "${expectedMask}", got "${result.value}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. redactFields — non-PII fields pass through unchanged
// ---------------------------------------------------------------------------
describe("redactFields — non-PII fields pass through unchanged", () => {
  it("non-PII field: value is preserved exactly", () => {
    const input = [makeDetected({ id: "promo", value: "SUMMER25", isPII: false, piiType: null })];
    const [result] = redactFields(input);
    assert.equal(result.value, "SUMMER25");
  });

  it("non-PII field: all non-value properties are preserved", () => {
    const input = [makeDetected({ id: "qty", tag: "input", type: "number",
                                  value: "3", isPII: false, piiType: null })];
    const [result] = redactFields(input);
    assert.equal(result.id,    "qty");
    assert.equal(result.tag,   "input");
    assert.equal(result.type,  "number");
    assert.equal(result.isPII, false);
    assert.equal(result.piiType, null);
    assert.equal(result.value, "3");
  });

  it("mixed batch: PII fields are masked, non-PII pass through", () => {
    const input = [
      makeDetected({ id: "email",  value: "a@b.com",  isPII: true,  piiType: "email" }),
      makeDetected({ id: "promo",  value: "SAVE10",   isPII: false, piiType: null }),
      makeDetected({ id: "phone",  value: "9999",     isPII: true,  piiType: "phone" }),
      makeDetected({ id: "search", value: "laptops",  isPII: false, piiType: null }),
    ];
    const results = redactFields(input);
    assert.equal(results[0].value, "[REDACTED_EMAIL]");
    assert.equal(results[1].value, "SAVE10");
    assert.equal(results[2].value, "[REDACTED_PHONE]");
    assert.equal(results[3].value, "laptops");
  });
});

// ---------------------------------------------------------------------------
// 9. Immutability — original objects must NOT be mutated
// ---------------------------------------------------------------------------
describe("redactFields — immutability (no mutation of inputs)", () => {
  it("does not mutate the input array reference", () => {
    const input = [makeDetected({ value: "secret", isPII: true, piiType: "password" })];
    const inputRef = input;
    redactFields(input);
    assert.strictEqual(input, inputRef, "Input array reference must not change");
  });

  it("does not mutate the original field object — value is unchanged", () => {
    const field = makeDetected({ id: "pw", value: "original-secret", isPII: true, piiType: "password" });
    const input = [field];
    redactFields(input);
    assert.equal(field.value, "original-secret",
      "Original field.value must not be overwritten by redactFields()");
  });

  it("does not mutate any property on a non-PII field", () => {
    const field = makeDetected({ id: "x", value: "plain", isPII: false, piiType: null });
    redactFields([field]);
    assert.equal(field.value,   "plain");
    assert.equal(field.isPII,   false);
    assert.equal(field.piiType, null);
  });

  it("output object is a different reference from the input object", () => {
    const field = makeDetected({ value: "pw", isPII: true, piiType: "password" });
    const [output] = redactFields([field]);
    assert.notStrictEqual(output, field,
      "redactFields must return a new object, not the original reference");
  });

  it("does not mutate any field when processing MOCK_DOM_STATE (integration)", () => {
    // Snapshot the mock state before running the pipeline
    const detected = detectPII(MOCK_DOM_STATE);
    const valuesBefore = detected.map((f) => f.value);

    // Add a value to each detected field (mockDomState has no .value — add one)
    const withValues = detected.map((f) => ({ ...f, value: `raw-${f.id}` }));
    const valuesBefore2 = withValues.map((f) => f.value);

    redactFields(withValues);

    // Original objects must be unchanged
    withValues.forEach((f, i) => {
      assert.equal(f.value, valuesBefore2[i],
        `Field "${f.id}" was mutated — value changed from "${valuesBefore2[i]}" to "${f.value}"`);
    });
  });
});

// ---------------------------------------------------------------------------
// 10. Determinism — identical input always yields identical output
// ---------------------------------------------------------------------------
describe("redactFields — determinism", () => {
  it("running the same field twice produces identical output", () => {
    const field = makeDetected({ value: "4111111111111111", isPII: true, piiType: "creditcard" });
    const [r1] = redactFields([field]);
    const [r2] = redactFields([field]);
    assert.equal(r1.value, r2.value);
  });

  it("output is identical on 100 consecutive runs (stability check)", () => {
    const field = makeDetected({ value: "user@example.com", isPII: true, piiType: "email" });
    const referenceValue = redactFields([field])[0].value;
    for (let i = 0; i < 100; i++) {
      const [result] = redactFields([field]);
      assert.equal(result.value, referenceValue,
        `Run ${i + 1} produced a different value: "${result.value}" vs "${referenceValue}"`);
    }
  });

  it("non-PII value determinism: same raw value in, same raw value out", () => {
    const field = makeDetected({ value: "PROMO2024", isPII: false, piiType: null });
    const [r1] = redactFields([field]);
    const [r2] = redactFields([field]);
    assert.equal(r1.value, r2.value);
    assert.equal(r1.value, "PROMO2024");
  });
});

// ---------------------------------------------------------------------------
// 11. Audit metadata preservation
// ---------------------------------------------------------------------------
describe("redactFields — audit metadata is preserved on output objects", () => {
  it("isPII is preserved on PII field output", () => {
    const [result] = redactFields([
      makeDetected({ value: "v", isPII: true, piiType: "email", matchedRule: 'autocomplete:"email"' }),
    ]);
    assert.equal(result.isPII, true);
  });

  it("piiType is preserved on PII field output", () => {
    const [result] = redactFields([
      makeDetected({ value: "v", isPII: true, piiType: "phone", matchedRule: 'input-type:"tel"' }),
    ]);
    assert.equal(result.piiType, "phone");
  });

  it("matchedRule is preserved on PII field output", () => {
    const rule = 'label-text:"card number"';
    const [result] = redactFields([
      makeDetected({ value: "v", isPII: true, piiType: "creditcard", matchedRule: rule }),
    ]);
    assert.equal(result.matchedRule, rule);
  });

  it("id, tag, type are all preserved on PII field output", () => {
    const [result] = redactFields([
      makeDetected({ id: "field-email", tag: "input", type: "email",
                     value: "x@y.com", isPII: true, piiType: "email" }),
    ]);
    assert.equal(result.id,   "field-email");
    assert.equal(result.tag,  "input");
    assert.equal(result.type, "email");
  });

  it("isPII and piiType are preserved on non-PII field output", () => {
    const [result] = redactFields([
      makeDetected({ value: "text", isPII: false, piiType: null, matchedRule: null }),
    ]);
    assert.equal(result.isPII,       false);
    assert.equal(result.piiType,     null);
    assert.equal(result.matchedRule, null);
  });
});

// ---------------------------------------------------------------------------
// 12. End-to-end integration: detectPII → redactFields
// ---------------------------------------------------------------------------
describe("integration: detectPII → redactFields on MOCK_DOM_STATE", () => {
  // Attach synthetic values, run the full pipeline, verify results.
  const withValues = MOCK_DOM_STATE.map((f) => ({ ...f, value: `raw-${f.id}` }));
  const detected   = detectPII(withValues);
  const redacted   = redactFields(detected);

  it("output array length equals input length", () => {
    assert.equal(redacted.length, MOCK_DOM_STATE.length);
  });

  it("all PII fields have a masked value (not their raw value)", () => {
    for (const field of redacted) {
      if (field.isPII) {
        assert.notEqual(field.value, `raw-${field.id}`,
          `PII field "${field.id}" was not redacted`);
        assert.ok(field.value.startsWith("[REDACTED_"),
          `PII field "${field.id}" has unexpected value: "${field.value}"`);
      }
    }
  });

  it("all non-PII fields retain their original raw value", () => {
    for (const field of redacted) {
      if (!field.isPII) {
        assert.equal(field.value, `raw-${field.id}`,
          `Non-PII field "${field.id}" value was changed`);
      }
    }
  });

  it("email field → [REDACTED_EMAIL]", () => {
    const f = redacted.find((r) => r.id === "field-email");
    assert.equal(f.value, "[REDACTED_EMAIL]");
  });

  it("credit card field → [REDACTED_CARD]", () => {
    const f = redacted.find((r) => r.id === "field-card-number");
    assert.equal(f.value, "[REDACTED_CARD]");
  });

  it("password field → [REDACTED_PASSWORD]", () => {
    const f = redacted.find((r) => r.id === "field-password");
    assert.equal(f.value, "[REDACTED_PASSWORD]");
  });

  it("phone field → [REDACTED_PHONE]", () => {
    const f = redacted.find((r) => r.id === "field-phone");
    assert.equal(f.value, "[REDACTED_PHONE]");
  });

  it("address field → [REDACTED_ADDRESS]", () => {
    const f = redacted.find((r) => r.id === "field-address");
    assert.equal(f.value, "[REDACTED_ADDRESS]");
  });

  it("SSN/Aadhaar field → [REDACTED_SSN]", () => {
    const f = redacted.find((r) => r.id === "field-aadhaar");
    assert.equal(f.value, "[REDACTED_SSN]");
  });

  it("DOB field → [REDACTED_DOB]", () => {
    const f = redacted.find((r) => r.id === "field-dob");
    assert.equal(f.value, "[REDACTED_DOB]");
  });

  it("username field → [REDACTED_USERNAME]", () => {
    const f = redacted.find((r) => r.id === "field-username");
    assert.equal(f.value, "[REDACTED_USERNAME]");
  });

  it("promo code (non-PII) retains raw value", () => {
    const f = redacted.find((r) => r.id === "field-promo");
    assert.equal(f.value, "raw-field-promo");
    assert.equal(f.isPII, false);
  });

  it("search field (non-PII) retains raw value", () => {
    const f = redacted.find((r) => r.id === "field-search");
    assert.equal(f.value, "raw-field-search");
    assert.equal(f.isPII, false);
  });
});
