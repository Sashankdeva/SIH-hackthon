/**
 * Tests for shared/privacy/proofLogger.js & Phase 6 Canary Expansions
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  logSanitizationProof,
  recordVerdictProof,
  getProofLogs,
  clearProofLogs
} from "../../../../shared/privacy/proofLogger.js";
import { validateRedaction } from "../../../../shared/privacy/validateRedaction.js";
import { detectPII } from "../../../../shared/privacy/detectPII.js";
import {
  EXPANDED_SECRET_FIELD_STATE,
  OPAQUE_TOKEN_STATE,
  REDACTED_SAFE_STATE
} from "../../../../shared/privacy/mockCanaryState.js";

describe("Phase 6 — Expanded Canary Blind-Spot Validation", () => {
  it("rejects EXPANDED_SECRET_FIELD_STATE (pwd, pin, secret, passcode)", () => {
    const verdict = validateRedaction(EXPANDED_SECRET_FIELD_STATE);
    expect(verdict.safe).toBe(false);
    expect(verdict.violations.length).toBeGreaterThanOrEqual(4);

    const types = verdict.violations.map(v => v.type);
    expect(types).toContain("exposed_password_field");
    expect(types).toContain("exposed_secret_field");
  });

  it("rejects OPAQUE_TOKEN_STATE (apiKey, accessToken, client_secret)", () => {
    const verdict = validateRedaction(OPAQUE_TOKEN_STATE);
    expect(verdict.safe).toBe(false);
    expect(verdict.violations.length).toBeGreaterThanOrEqual(3);

    const types = verdict.violations.map(v => v.type);
    expect(types).toContain("exposed_opaque_token");
  });
});

describe("shared/privacy/proofLogger — audit and non-leakage", () => {
  beforeEach(() => {
    clearProofLogs();
  });

  it("records a valid pass log entry for safe validation", () => {
    const verdict = validateRedaction(REDACTED_SAFE_STATE);
    const entry = recordVerdictProof(verdict, "req-corr-safe-001");

    expect(entry.safe).toBe(true);
    expect(entry.correlationId).toBe("req-corr-safe-001");
    expect(entry.violationTypes).toEqual([]);
    expect(typeof entry.timestamp).toBe("string");
    expect(entry.logId).toMatch(/^proof-/);

    const logs = getProofLogs();
    expect(logs.length).toBe(1);
    expect(logs[0]).toEqual(entry);
  });

  it("records a valid fail log entry with only violation types", () => {
    const verdict = validateRedaction(OPAQUE_TOKEN_STATE);
    const entry = recordVerdictProof(verdict, "req-corr-fail-002");

    expect(entry.safe).toBe(false);
    expect(entry.correlationId).toBe("req-corr-fail-002");
    expect(entry.violationTypes.length).toBeGreaterThan(0);
    expect(entry.violationTypes).toContain("exposed_opaque_token");
  });

  it("structurally rejects attempts to log raw domState or payload objects", () => {
    expect(() => {
      // @ts-expect-error — intentional dangerous parameter
      logSanitizationProof({
        correlationId: "leak-attempt",
        safe: false,
        fields: { password: "raw_secret_value" }
      });
    }).toThrow(TypeError);

    expect(() => {
      // @ts-expect-error — intentional dangerous parameter
      logSanitizationProof({
        correlationId: "leak-attempt-2",
        safe: false,
        payload: { email: "user@example.com" }
      });
    }).toThrow(TypeError);
  });

  it("proves log entries never contain raw sensitive values when serialized", () => {
    const secretVerdict = validateRedaction(EXPANDED_SECRET_FIELD_STATE);
    recordVerdictProof(secretVerdict, "req-secret-check");

    const tokenVerdict = validateRedaction(OPAQUE_TOKEN_STATE);
    recordVerdictProof(tokenVerdict, "req-token-check");

    const logs = getProofLogs();
    const serializedLogs = JSON.stringify(logs);

    // Assert that raw secret/token values are NEVER in the serialized log output
    const rawSensitiveValues = [
      "TempPassword#2026",
      "4321",
      "889900",
      "TopSecretSharedKey",
      "ak_live_89f3b129a0c34e89b71e62a4d98e102f",
      "ghp_16CharacterRandomOpaqueAccessTokenStr9988",
      "sec_9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d"
    ];

    for (const val of rawSensitiveValues) {
      expect(serializedLogs).not.toContain(val);
    }

    // Run detectPII on logs representation
    const scan = detectPII({ fields: { logOutput: serializedLogs } });
    expect(scan).toEqual([]);
  });
});
