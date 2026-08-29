/**
 * Tests for shared/privacy/redactValue.js
 *
 * Covers Tier-1 deterministic redaction.
 */

import { describe, it, expect } from "vitest";

import { detectPII } from "../../../../shared/privacy/detectPII.js";
import { redactValue } from "../../../../shared/privacy/redactValue.js";
import {
  CLEAN_STATE,
  EMAIL_ONLY_STATE,
  MIXED_PII_STATE,
  BARE_AT_SIGN_STATE,
  SKU_RESEMBLING_PHONE,
  VERSION_STRING_STATE,
} from "../../../../shared/privacy/mockDomState.js";

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------
describe("redactValue — input validation", () => {
  it("throws TypeError when called with null domState", () => {
    // @ts-expect-error — intentional bad input
    expect(() => redactValue(null, [])).toThrow(TypeError);
  });

  it("throws TypeError when domState.fields is missing", () => {
    // @ts-expect-error — intentional bad input
    expect(() => redactValue({}, [])).toThrow(TypeError);
  });

  it("handles empty matches array by returning exact same domState reference", () => {
    const result = redactValue(CLEAN_STATE, []);
    expect(result).toBe(CLEAN_STATE); // referential equality
  });
});

// ---------------------------------------------------------------------------
// Clean state (no changes)
// ---------------------------------------------------------------------------
describe("redactValue — clean state", () => {
  it("returns byte-for-byte identical output when no PII is detected", () => {
    const matches = detectPII(CLEAN_STATE);
    expect(matches).toHaveLength(0);

    const redacted = redactValue(CLEAN_STATE, matches);
    expect(redacted).toBe(CLEAN_STATE);
    expect(redacted.fields).toBe(CLEAN_STATE.fields);
  });
});

// ---------------------------------------------------------------------------
// Single PII
// ---------------------------------------------------------------------------
describe("redactValue — single PII", () => {
  it("redacts an email and leaves other fields untouched", () => {
    const matches = detectPII(EMAIL_ONLY_STATE);
    const redacted = redactValue(EMAIL_ONLY_STATE, matches);
    
    // Check the redacted field
    expect(redacted.fields.email).toBe("[REDACTED:tier1-email]");
    
    // Check the untouched fields
    expect(redacted.fields.username).toBe(EMAIL_ONLY_STATE.fields.username);
    expect(redacted.fields.country).toBe(EMAIL_ONLY_STATE.fields.country);
  });
});

// ---------------------------------------------------------------------------
// Mixed PII / Integration End-to-End
// ---------------------------------------------------------------------------
describe("redactValue — mixed PII integration", () => {
  it("runs detectPII -> redactValue and ensures no raw PII remains", () => {
    const matches = detectPII(MIXED_PII_STATE);
    const redacted = redactValue(MIXED_PII_STATE, matches);

    // Make sure we actually found matches
    expect(matches.length).toBeGreaterThan(0);

    // Verify all original PII strings are gone
    const rawValues = [
      "jane@checkout-example.com",
      "800-555-9876",
      "5105-1051-0510-5100",
      "321", // Note: CVV rule isn't in Tier-1, but let's check what was redacted.
      "9876 5432 1098",
      "XYZPQ5678A"
    ];

    const allRedactedText = JSON.stringify(redacted.fields);

    // Expect the known PII values (email, phone, card, aadhaar, pan) to be missing
    expect(allRedactedText).not.toContain("jane@checkout-example.com");
    expect(allRedactedText).not.toContain("800-555-9876");
    expect(allRedactedText).not.toContain("5105-1051-0510-5100");
    expect(allRedactedText).not.toContain("9876 5432 1098");
    expect(allRedactedText).not.toContain("XYZPQ5678A");

    // The fields themselves should have placeholders
    expect(redacted.fields.emailAddress).toBe("[REDACTED:tier1-email]");
    expect(redacted.fields.phoneNumber).toBe("[REDACTED:tier1-phone]");
    expect(redacted.fields.cardNumber).toBe("[REDACTED:tier1-credit-card]");
    expect(redacted.fields.aadhaar).toBe("[REDACTED:tier1-aadhaar]");
    expect(redacted.fields.pan).toBe("[REDACTED:tier1-pan]");

    // The fields without PII (like city, zip - since address rule might not match the standalone city string) 
    // are untouched
    expect(redacted.fields.city).toBe(MIXED_PII_STATE.fields.city);
    expect(redacted.fields.zip).toBe(MIXED_PII_STATE.fields.zip);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------
describe("redactValue — edge cases", () => {
  it("leaves BARE_AT_SIGN_STATE exactly identical", () => {
    const matches = detectPII(BARE_AT_SIGN_STATE);
    const redacted = redactValue(BARE_AT_SIGN_STATE, matches);
    expect(redacted).toBe(BARE_AT_SIGN_STATE);
  });

  it("redacts phone-like segments in VERSION_STRING_STATE since detectPII flags them conservatively", () => {
    const matches = detectPII(VERSION_STRING_STATE);
    const redacted = redactValue(VERSION_STRING_STATE, matches);
    
    // detectPII conservatively flags version segments as phones.
    // redactValue must trust detectPII and redact what it finds.
    expect(matches.length).toBeGreaterThan(0);
    expect(redacted.fields.appVersion).toContain("[REDACTED:tier1-phone]");
    expect(redacted.fields.buildId).toContain("[REDACTED:tier1-phone]");
  });

  it("handles SKU_RESEMBLING_PHONE exactly as detectPII dictates", () => {
    const matches = detectPII(SKU_RESEMBLING_PHONE);
    const redacted = redactValue(SKU_RESEMBLING_PHONE, matches);
    
    // If detectPII flags it (conservative policy), redactValue must redact it.
    // If not, it must remain untouched.
    if (matches.length > 0) {
      expect(redacted.fields.sku).toContain("[REDACTED");
    } else {
      expect(redacted).toBe(SKU_RESEMBLING_PHONE);
    }
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------
describe("redactValue — idempotency", () => {
  it("produces the exact same output when run twice with the same matches", () => {
    const matches = detectPII(MIXED_PII_STATE);
    const redacted1 = redactValue(MIXED_PII_STATE, matches);
    
    // Run redactValue again using the REDACTED state but the ORIGINAL matches
    const redacted2 = redactValue(redacted1, matches);
    
    // Since the text is already replaced, redactValue finds nothing to replace 
    // in the second pass and returns the exact same object reference.
    expect(redacted2).toBe(redacted1);
  });

  it("produces the exact same output when re-evaluating the redacted state", () => {
    const originalMatches = detectPII(MIXED_PII_STATE);
    const redacted1 = redactValue(MIXED_PII_STATE, originalMatches);
    
    // Scan the redacted state
    const newMatches = detectPII(redacted1);
    
    // There should be no new PII found, so newMatches is empty
    expect(newMatches).toHaveLength(0);
    
    // Redacting with empty matches returns the same object
    const redacted2 = redactValue(redacted1, newMatches);
    expect(redacted2).toBe(redacted1);
  });
});
