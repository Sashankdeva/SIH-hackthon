/**
 * Tests for shared/privacy/validateRedaction.js
 */

import { describe, it, expect } from "vitest";

import { validateRedaction } from "../../../../shared/privacy/validateRedaction.js";
import { detectPII } from "../../../../shared/privacy/detectPII.js";
import { redactValue } from "../../../../shared/privacy/redactValue.js";
import { MIXED_PII_STATE } from "../../../../shared/privacy/mockDomState.js";
import {
  REDACTED_SAFE_STATE,
  UNREDACTED_PII_STATE,
  JWT_LEAK_STATE,
  COOKIE_LEAK_STATE,
  PASSWORD_LEAK_STATE
} from "../../../../shared/privacy/mockCanaryState.js";

describe("validateRedaction", () => {
  it("passes a correctly redacted payload", () => {
    const verdict = validateRedaction(REDACTED_SAFE_STATE);
    expect(verdict.safe).toBe(true);
    expect(verdict.violations).toHaveLength(0);
  });

  it("fails if detectPII finds unredacted PII", () => {
    const verdict = validateRedaction(UNREDACTED_PII_STATE);
    expect(verdict.safe).toBe(false);
    expect(verdict.violations.length).toBeGreaterThan(0);
    expect(verdict.violations[0].type).toBe("unredacted_pii:tier1-email");
    expect(verdict.violations[0].field).toBe("email");
  });

  it("fails if a JWT/Bearer token is found", () => {
    const verdict = validateRedaction(JWT_LEAK_STATE);
    expect(verdict.safe).toBe(false);
    
    const types = verdict.violations.map(v => v.type);
    // Might match both JWT and Bearer patterns depending on regex evaluation order
    expect(types).toContain("exposed_jwt_token");
    expect(types).toContain("exposed_bearer_token");
  });

  it("fails if a cookie/session token is found", () => {
    const verdict = validateRedaction(COOKIE_LEAK_STATE);
    expect(verdict.safe).toBe(false);
    expect(verdict.violations.map(v => v.type)).toContain("exposed_cookie_or_session");
  });

  it("fails if an obvious password field is unredacted", () => {
    const verdict = validateRedaction(PASSWORD_LEAK_STATE);
    expect(verdict.safe).toBe(false);
    expect(verdict.violations.map(v => v.type)).toContain("exposed_password_field");
    expect(verdict.violations[0].field).toBe("userPassword");
  });

  it("ensures violations never contain raw leaked values in their description", () => {
    const verdict = validateRedaction(UNREDACTED_PII_STATE);
    const serialized = JSON.stringify(verdict.violations);
    
    // Make sure the raw value isn't echoed in the violation object
    expect(serialized).not.toContain("secret@example.com");
  });

  it("passes an end-to-end payload processed by the Phase 1+2 pipeline", () => {
    // 1. Detect
    const matches = detectPII(MIXED_PII_STATE);
    
    // 2. Redact
    const redactedState = redactValue(MIXED_PII_STATE, matches);
    
    // 3. Validate
    const verdict = validateRedaction(redactedState);
    expect(verdict.safe).toBe(true);
    expect(verdict.violations).toHaveLength(0);
  });

  it("handles malformed input gracefully", () => {
    // @ts-expect-error - intentional bad input
    const verdict = validateRedaction(null);
    expect(verdict.safe).toBe(false);
    expect(verdict.violations[0].type).toBe("malformed_payload");
  });
});
