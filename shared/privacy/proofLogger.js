/**
 * shared/privacy/proofLogger.js
 *
 * Payload Proof Logger for Audit and Verification.
 * Records proof that sanitization & validation checks were executed
 * WITHOUT storing, logging, or exposing any raw sensitive values.
 *
 * ============================================================================
 * STRUCTURAL NON-LEAKAGE GUARANTEE:
 * ============================================================================
 * 1. The logger signature accepts ONLY metadata summaries: correlation ID,
 *    pass/fail verdict, and violation type names.
 * 2. It explicitly rejects any argument structure containing `fields`, `domState`,
 *    `payload`, or raw sensitive data.
 * 3. Log entries contain ONLY non-reversible references, timestamps, and violation tags.
 */

// In-memory proof log buffer
const proofLogs = [];

/**
 * Validates and logs a sanitization proof entry.
 *
 * @param {object} proofEntry
 * @param {string} proofEntry.correlationId - Non-reversible reference / request correlation ID.
 * @param {boolean} proofEntry.safe - Whether validation passed.
 * @param {string[]} [proofEntry.violationTypes] - Array of violation type identifiers (NO raw values).
 * @param {string} [proofEntry.timestamp] - Optional ISO timestamp.
 * @returns {object} The recorded proof log record.
 */
export function logSanitizationProof(proofEntry) {
  if (!proofEntry || typeof proofEntry !== 'object') {
    throw new TypeError('logSanitizationProof: proofEntry must be an object');
  }

  // Structural Safety Gate: Reject any attempt to pass a raw DOM state or payload
  if (
    'fields' in proofEntry ||
    'domState' in proofEntry ||
    'payload' in proofEntry ||
    'raw' in proofEntry
  ) {
    throw new TypeError(
      'logSanitizationProof: Structural safety violation — raw DOM state or payload cannot be passed to proofLogger'
    );
  }

  if (!proofEntry.correlationId || typeof proofEntry.correlationId !== 'string') {
    throw new TypeError('logSanitizationProof: correlationId must be a non-empty string');
  }

  if (typeof proofEntry.safe !== 'boolean') {
    throw new TypeError('logSanitizationProof: safe verdict must be a boolean');
  }

  // Sanitize violation types to ensure only strings (never raw match objects)
  const violationTypes = Array.isArray(proofEntry.violationTypes)
    ? proofEntry.violationTypes.map(v => (typeof v === 'string' ? v : v.type || 'unknown_violation'))
    : [];

  const record = {
    logId: `proof-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    correlationId: proofEntry.correlationId,
    safe: proofEntry.safe,
    violationTypes,
    timestamp: proofEntry.timestamp || new Date().toISOString()
  };

  proofLogs.push(record);
  return record;
}

/**
 * Creates a proof record directly from a validation verdict object and correlation ID.
 * Extracts only non-sensitive metadata (safe flag + violation types).
 *
 * @param {{ safe: boolean, violations?: Array<{ type: string }> }} verdict
 * @param {string} correlationId
 * @returns {object} The logged proof record.
 */
export function recordVerdictProof(verdict, correlationId) {
  if (!verdict || typeof verdict.safe !== 'boolean') {
    throw new TypeError('recordVerdictProof: invalid validation verdict');
  }

  return logSanitizationProof({
    correlationId,
    safe: verdict.safe,
    violationTypes: (verdict.violations || []).map(v => v.type)
  });
}

/**
 * Returns a copy of all proof log records in the buffer.
 *
 * @returns {Array<object>}
 */
export function getProofLogs() {
  return [...proofLogs];
}

/**
 * Clears the in-memory proof log buffer (primarily for test isolation).
 */
export function clearProofLogs() {
  proofLogs.length = 0;
}
