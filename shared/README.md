# shared/

Frozen contracts between the extension and the server. Both sides must honor
these exactly — a mismatch here is the single most common way to lose a
whole afternoon to "why isn't the action executing."

- **`schemas/sanitized-context.schema.json`** — the *only* payload shape
  allowed to leave the browser. The extension's Privacy Firewall builds it;
  the server's `SanitizedContext` Pydantic model (`server/app/models/context.py`)
  parses it. If you need a new field, add it here first, then update both
  implementations in the same PR.
- **`schemas/action.schema.json`** — the structured action the server is
  allowed to return. The extension's action validator
  (`extension/src/action/validator.ts`) rejects anything that doesn't match
  this shape before it's ever executed.

Changing either schema is a cross-team decision — see
`PS26171_Role1_Extension.pdf` and `PS26171_Role4_Server.pdf`: the schema
freeze is an explicit Day-1 task for both roles, together.

## Phase 1: Privacy Detection

- **`privacy/piiRules.js`** and **`privacy/detectPII.js`** — dependency-free, Tier-1 PII scanners that inspect a DOM state payload and output rule-based detection matches. Pure ES modules.
- **`privacy/mockDomState.js`** — test fixtures providing clean, single, mixed, and edge-case DOM state objects.

## Phase 2: Deterministic Redaction

- **`privacy/redactValue.js`** — deterministic redaction function that takes a DOM state and PII matches, and produces a new DOM state with PII replaced by `[REDACTED:<rule-id>]` placeholders. Ensures unchanged fields pass through exactly identical.

## Phase 3: Redaction Validator

- **`privacy/validateRedaction.js`** — client-side boundary proof validator. Asserts that a payload is safe to leave the client. Checks for unredacted PII (via `detectPII`) and independently checks for leaked JWTs, session tokens, cookies, and passwords. Never mutates payload and never logs raw values.
- **`privacy/mockCanaryState.js`** — mock payloads (canary/poison fixtures) designed to trigger the validator's failure conditions.

## Phase 4: Secret/Profile Storage

- **`privacy/secretStore.js`** — local-only client-side storage for secrets and autofill profile data with swappable backend interface (in-memory adapter for node/tests, chrome.storage.local adapter for browser extension runtime). Enforces a non-leakage guarantee: `listSecretKeys()` yields only string keys without values, and `resolveSecret()` yields isolated direct values for client-side local action execution.

## Phase 5: Sanitized Payload Assembly

- **`privacy/assembleSanitizedPayload.js`** — payload assembler that structures sanitized DOM content alongside non-sensitive execution metadata. Enforces a mandatory gate via `validateRedaction()`, throwing `UnsafePayloadError` if any unredacted PII or secret/token remains, guaranteeing that unvalidated or unsafe payloads cannot be assembled.

## Phase 6: Canary Tests & Payload Proof Logging

- **`privacy/mockCanaryState.js`** — expanded poison fixtures covering blind spots (non-password secret keys such as `pwd`, `pin`, `secret`, `passcode`, and non-JWT opaque tokens under API/auth key fields).
- **`privacy/proofLogger.js`** — lightweight audit/proof logger recording non-sensitive sanitization metadata (correlation ID, safe verdict, violation type tags, timestamp). Structurally rejects raw DOM states or payloads to guarantee zero data leakage.