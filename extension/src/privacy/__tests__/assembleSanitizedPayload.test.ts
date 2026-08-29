/**
 * Tests for shared/privacy/assembleSanitizedPayload.js
 *
 * Covers Phase 5: Sanitized Payload Assembly & Certification.
 */

import { describe, it, expect } from "vitest";

import {
  assembleSanitizedPayload,
  UnsafePayloadError
} from "../../../../shared/privacy/assembleSanitizedPayload.js";
import { detectPII } from "../../../../shared/privacy/detectPII.js";
import { redactValue } from "../../../../shared/privacy/redactValue.js";
import {
  CLEAN_STATE,
  MIXED_PII_STATE
} from "../../../../shared/privacy/mockDomState.js";
import {
  REDACTED_SAFE_STATE,
  UNREDACTED_PII_STATE,
  JWT_LEAK_STATE,
  COOKIE_LEAK_STATE,
  PASSWORD_LEAK_STATE
} from "../../../../shared/privacy/mockCanaryState.js";

describe("assembleSanitizedPayload — safe payload assembly", () => {
  it("assembles a validated-safe payload and matches the schema contract", () => {
    const payload = assembleSanitizedPayload(REDACTED_SAFE_STATE, {
      taskId: "task-checkout-101",
      stepNumber: 2,
      pageRole: "checkout",
      urlOrigin: "https://example.com/checkout?user=123" // Query param should be stripped to origin
    });

    expect(payload).toHaveProperty("schemaVersion", "1.0.0");
    expect(payload).toHaveProperty("taskId", "task-checkout-101");
    expect(payload).toHaveProperty("stepNumber", 2);
    expect(payload).toHaveProperty("pageRole", "checkout");
    expect(payload).toHaveProperty("urlOrigin", "https://example.com");
    expect(payload).toHaveProperty("fields");
    expect(payload.fields.email).toBe("[REDACTED:tier1-email]");
    expect(payload.fields.city).toBe("London");
    expect(typeof payload.timestamp).toBe("string");
  });

  it("handles default options gracefully", () => {
    const payload = assembleSanitizedPayload(CLEAN_STATE);

    expect(payload.schemaVersion).toBe("1.0.0");
    expect(payload.taskId).toBe("task-0");
    expect(payload.stepNumber).toBe(1);
    expect(payload.pageRole).toBe("generic");
    expect(payload.urlOrigin).toBe("");
    expect(payload.fields).toEqual(CLEAN_STATE.fields);
  });
});

describe("assembleSanitizedPayload — rejection of unsafe payloads", () => {
  it("rejects payload containing unredacted PII", () => {
    expect(() => assembleSanitizedPayload(UNREDACTED_PII_STATE)).toThrow(UnsafePayloadError);
    try {
      assembleSanitizedPayload(UNREDACTED_PII_STATE);
    } catch (err: any) {
      expect(err).toBeInstanceOf(UnsafePayloadError);
      expect(err.violations.length).toBeGreaterThan(0);
      expect(err.violations[0].type).toContain("unredacted_pii");
    }
  });

  it("rejects payload containing JWT token", () => {
    expect(() => assembleSanitizedPayload(JWT_LEAK_STATE)).toThrow(UnsafePayloadError);
  });

  it("rejects payload containing exposed cookie/session string", () => {
    expect(() => assembleSanitizedPayload(COOKIE_LEAK_STATE)).toThrow(UnsafePayloadError);
  });

  it("rejects payload containing unredacted password field", () => {
    expect(() => assembleSanitizedPayload(PASSWORD_LEAK_STATE)).toThrow(UnsafePayloadError);
  });

  it("rejects malformed inputs", () => {
    // @ts-expect-error — intentional invalid input
    expect(() => assembleSanitizedPayload(null)).toThrow(UnsafePayloadError);
    // @ts-expect-error — intentional invalid input
    expect(() => assembleSanitizedPayload({})).toThrow(UnsafePayloadError);
  });
});

describe("assembleSanitizedPayload — end-to-end certification & scanning", () => {
  it("processes MIXED_PII_STATE through pipeline and proves serialized output is 100% clean", () => {
    // 1. Detect
    const matches = detectPII(MIXED_PII_STATE);
    expect(matches.length).toBeGreaterThan(0);

    // 2. Redact
    const redactedState = redactValue(MIXED_PII_STATE, matches);

    // 3. Assemble
    const payload = assembleSanitizedPayload(redactedState, {
      taskId: "task-mixed-e2e",
      stepNumber: 3,
      pageRole: "payment",
      urlOrigin: "https://shop.local:8080/order/pay"
    });

    expect(payload.urlOrigin).toBe("https://shop.local:8080");

    // 4. JSON Serialization & Deep Inspection
    const serialized = JSON.stringify(payload);

    // Assert raw PII strings are absent from the entire serialized output
    const rawPIIValues = [
      "jane@checkout-example.com",
      "800-555-9876",
      "5105-1051-0510-5100",
      "9876 5432 1098",
      "XYZPQ5678A"
    ];
    for (const rawVal of rawPIIValues) {
      expect(serialized).not.toContain(rawVal);
    }

    // 5. Re-scan the reconstituted fields object via detectPII
    const scanMatches = detectPII({ fields: payload.fields });
    expect(scanMatches).toEqual([]);

    // 6. Assert no token/cookie/secret patterns in serialized payload
    expect(serialized).not.toMatch(/eyJ[a-zA-Z0-9_-]{5,}\.[a-zA-Z0-9_-]{5,}/);
    expect(serialized).not.toMatch(/\bBearer\s+[a-zA-Z0-9-_=.]+\b/i);
    expect(serialized).not.toMatch(/\b(?:session|auth|token|cookie)[a-z0-9-_]*\s*=\s*[a-zA-Z0-9-_%]{16,}\b/i);
  });
});
