/**
 * shared/privacy/validateRedaction.js
 *
 * Client-side boundary proof validator.
 * Asserts that a payload is safe to leave the client (i.e. contains zero raw
 * secrets, passwords, cookies, session tokens, or PII).
 *
 * Note: Never mutates the input payload, and never leaks raw sensitive values
 * in the violation reports.
 */

import { detectPII } from './detectPII.js';

// Independent check patterns
const JWT_PATTERN = /eyJ[a-zA-Z0-9_-]{5,}\.[a-zA-Z0-9_-]{5,}\.[a-zA-Z0-9_-]{5,}/;
const BEARER_PATTERN = /\bBearer\s+[a-zA-Z0-9-_=.]+\b/i;
const COOKIE_LIKE_PATTERN = /\b(?:session|auth|token|cookie)[a-z0-9-_]*\s*=\s*[a-zA-Z0-9-_%]{16,}\b/i;

/**
 * Validates that a DOM state object contains no detectable sensitive information.
 *
 * @param {{ fields: Record<string, string> }} domState
 * @returns {{ safe: boolean, violations: Array<{ type: string, field: string }> }}
 */
export function validateRedaction(domState) {
  const violations = [];
  
  if (!domState || !domState.fields || typeof domState.fields !== "object") {
    return { safe: false, violations: [{ type: "malformed_payload", field: "root" }] };
  }

  // 1. Second-pass detectPII check
  // Even if redaction ran, we re-run detection to ensure nothing slipped through
  const piiMatches = detectPII(domState);
  for (const match of piiMatches) {
    // Extract rule name (e.g. 'tier1-email') without logging the raw leaked value
    const colonIndex = match.matchedRule.indexOf(':');
    const ruleId = colonIndex !== -1 ? match.matchedRule.substring(0, colonIndex) : "unknown-pii";
    
    violations.push({
      type: `unredacted_pii:${ruleId}`,
      field: match.field
    });
  }

  // 2. Independent pattern checks for secrets/tokens (which detectPII wasn't designed for)
  for (const [field, rawValue] of Object.entries(domState.fields)) {
    const value = typeof rawValue === "string" ? rawValue : String(rawValue ?? "");
    if (!value.trim()) continue;

    if (JWT_PATTERN.test(value)) {
      violations.push({ type: "exposed_jwt_token", field });
    }

    if (BEARER_PATTERN.test(value)) {
      violations.push({ type: "exposed_bearer_token", field });
    }

    if (COOKIE_LIKE_PATTERN.test(value)) {
      violations.push({ type: "exposed_cookie_or_session", field });
    }

    // Check for obvious password/secret leftovers
    // If a field name contains 'password', 'pwd', 'passwd', 'passcode', 'secret', or 'pin',
    // its value must be a placeholder, empty, or not exist.
    if (/password|passwd|pwd|passcode/i.test(field)) {
      if (!value.includes("[REDACTED") && !value.includes("***")) {
        violations.push({ type: "exposed_password_field", field });
      }
    } else if (/\b(?:secret|pin)\b|_secret|_pin/i.test(field)) {
      if (!value.includes("[REDACTED") && !value.includes("***")) {
        violations.push({ type: "exposed_secret_field", field });
      }
    }

    // Check for opaque API keys / access tokens under token/auth/key fields
    if (/api_?key|access_?token|client_?secret/i.test(field)) {
      if (/[a-zA-Z0-9_-]{16,}/.test(value) && !value.includes("[REDACTED")) {
        violations.push({ type: "exposed_opaque_token", field });
      }
    }
  }

  return {
    safe: violations.length === 0,
    violations
  };
}
