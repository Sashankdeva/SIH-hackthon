/**
 * shared/privacy/assembleSanitizedPayload.js
 *
 * Tier-1 Sanitized Payload Assembler.
 * Assembles a certified, sanitized JSON payload safe for transit toward the LLM Host.
 *
 * ============================================================================
 * MANDATORY SECURITY GATE
 * ============================================================================
 * Under NO circumstances can a payload be assembled without first passing
 * `validateRedaction()`. If `validateRedaction()` reports `safe: false`,
 * this module immediately throws an `UnsafePayloadError` containing the
 * violation list. No partial or fallback payload is ever returned on failure.
 *
 * ============================================================================
 * PAYLOAD SCHEMA CONTRACT
 * ============================================================================
 * {
 *   schemaVersion: string,          // e.g. "1.0.0"
 *   taskId: string,                 // Non-sensitive task identifier
 *   stepNumber: number,             // Current step index (1-based integer)
 *   pageRole: string,               // High-level page role (e.g. "login", "checkout", "generic")
 *   urlOrigin: string,              // Origin only (e.g. "https://example.com"), never full URL paths or queries
 *   fields: Record<string, string>, // Sanitized field map containing ONLY redacted values / non-sensitive text
 *   timestamp: string               // ISO-8601 creation timestamp
 * }
 *
 * ============================================================================
 * EXCLUSION GUARANTEE — WHAT MUST NEVER APPEAR IN THIS PAYLOAD:
 * ============================================================================
 * 1. Raw PII of any kind (emails, phones, physical addresses, credit cards, SSNs, Aadhaar, PAN, passports).
 * 2. Resolved secrets, passwords, or credentials (from secretStore or elsewhere).
 * 3. Session identifiers, JWTs, Bearer tokens, authentication headers, or cookies.
 * 4. Full URLs containing query parameters, session tokens, or private paths.
 */

import { validateRedaction } from './validateRedaction.js';

/**
 * Custom error thrown when a payload fails the mandatory validation gate.
 */
export class UnsafePayloadError extends Error {
  /**
   * @param {string} message
   * @param {Array<{ type: string, field: string }>} violations
   */
  constructor(message, violations = []) {
    super(message);
    this.name = 'UnsafePayloadError';
    this.violations = violations;
  }
}

/**
 * Assembles a sanitized JSON payload from a redacted DOM state and metadata.
 *
 * @param {{ fields: Record<string, string> }} domState - The redacted DOM state object.
 * @param {object} [options] - Non-sensitive metadata options.
 * @param {string} [options.taskId] - Non-sensitive task ID (default: "task-0").
 * @param {number} [options.stepNumber] - Step number (default: 1).
 * @param {string} [options.pageRole] - Semantic page classification (default: "generic").
 * @param {string} [options.urlOrigin] - Base origin (e.g. "https://example.com").
 * @returns {object} The certified sanitized payload.
 * @throws {UnsafePayloadError} If input fails validation or is malformed.
 */
export function assembleSanitizedPayload(domState, options = {}) {
  if (!domState || typeof domState !== 'object' || !domState.fields || typeof domState.fields !== 'object') {
    throw new UnsafePayloadError('assembleSanitizedPayload: domState must be an object with a `fields` map', [
      { type: 'malformed_input', field: 'root' }
    ]);
  }

  // 1. Mandatory Gate: Validate redaction
  const verdict = validateRedaction(domState);
  if (!verdict.safe) {
    throw new UnsafePayloadError(
      `assembleSanitizedPayload: payload contains ${verdict.violations.length} unredacted violation(s). Assembly rejected.`,
      verdict.violations
    );
  }

  // 2. Normalize and ensure safe origin (no query params or hash fragments)
  let origin = "";
  if (typeof options.urlOrigin === 'string' && options.urlOrigin.trim()) {
    try {
      const parsed = new URL(options.urlOrigin);
      origin = parsed.origin;
    } catch {
      origin = options.urlOrigin.split('?')[0].split('#')[0];
    }
  }

  // 3. Assemble and freeze safe payload
  const payload = {
    schemaVersion: "1.0.0",
    taskId: typeof options.taskId === 'string' && options.taskId.trim() ? options.taskId : "task-0",
    stepNumber: typeof options.stepNumber === 'number' && options.stepNumber > 0 ? options.stepNumber : 1,
    pageRole: typeof options.pageRole === 'string' && options.pageRole.trim() ? options.pageRole : "generic",
    urlOrigin: origin,
    fields: { ...domState.fields },
    timestamp: new Date().toISOString()
  };

  return payload;
}
