/**
 * shared/privacy/mockCanaryState.js
 *
 * Canary/poison fixtures for testing the Redaction Validator (validateRedaction.js).
 */

export const REDACTED_SAFE_STATE = {
  description: "Correctly redacted payload — should pass validation",
  fields: {
    email: "[REDACTED:tier1-email]",
    city: "London",
    notes: "Please deliver to the front desk.",
    // Even an empty password field is safe (nothing to leak)
    password: ""
  }
};

export const UNREDACTED_PII_STATE = {
  description: "Redaction was skipped — contains a raw email address",
  fields: {
    email: "secret@example.com",
    city: "London"
  }
};

export const JWT_LEAK_STATE = {
  description: "Contains a raw JWT session token (not caught by standard detectPII)",
  fields: {
    // JWT typically has 3 parts separated by dots
    authHeader: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
  }
};

export const COOKIE_LEAK_STATE = {
  description: "Contains a raw cookie/session string",
  fields: {
    documentCookie: "session_id=abcdef1234567890deadbeef; tracking=1"
  }
};

export const PASSWORD_LEAK_STATE = {
  description: "Contains an unredacted password field",
  fields: {
    userPassword: "MySuperSecret123!" 
  }
};

// ============================================================================
// Phase 6 Expanded Blind-Spot Canary Fixtures
// ============================================================================

export const EXPANDED_SECRET_FIELD_STATE = {
  description: "Contains raw credentials/passcodes under non-'password' field keys (e.g. pwd, pin, secret, passcode)",
  fields: {
    user_pwd: "TempPassword#2026",
    card_pin: "4321",
    login_passcode: "889900",
    account_secret: "TopSecretSharedKey"
  }
};

export const OPAQUE_TOKEN_STATE = {
  description: "Contains raw non-JWT opaque API keys / access tokens under dedicated token fields",
  fields: {
    apiKey: "ak_live_89f3b129a0c34e89b71e62a4d98e102f",
    accessToken: "ghp_16CharacterRandomOpaqueAccessTokenStr9988",
    client_secret: "sec_9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d"
  }
};
