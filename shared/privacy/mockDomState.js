/**
 * shared/privacy/mockDomState.js
 *
 * Mock DOM state fixtures for testing detectPII().
 *
 * Four fixture categories:
 *   CLEAN_STATE         — no PII at all
 *   SINGLE_PII_STATES   — one PII type per fixture
 *   MIXED_PII_STATE     — multiple PII types in the same state
 *   EDGE_CASE_STATES    — PII-shaped values that are actually safe
 *
 * The `fields` object mirrors the shape consumed by detectPII():
 *   { [fieldName: string]: string }
 */

// ---------------------------------------------------------------------------
// 1. CLEAN_STATE — no PII present
// ---------------------------------------------------------------------------
export const CLEAN_STATE = {
  description: "No PII — all values are safe product/UI data",
  fields: {
    productName: "Wireless Mechanical Keyboard",
    quantity: "2",
    category: "Electronics",
    sku: "WMK-7890-BLK",
    color: "Midnight Black",
    inStock: "true",
    rating: "4.5",
    // A short description that contains no personal data
    description: "Compact TKL layout with RGB backlight and Cherry MX Red switches.",
  },
};

// ---------------------------------------------------------------------------
// 2. SINGLE_PII_STATES — one type each
// ---------------------------------------------------------------------------

export const EMAIL_ONLY_STATE = {
  description: "Single PII: email address only",
  fields: {
    username: "jane_doe",
    email: "jane.doe@example.com",
    country: "India",
  },
};

export const PHONE_ONLY_STATE = {
  description: "Single PII: US phone number only",
  fields: {
    productId: "PROD-001",
    contactNumber: "(800) 555-1234",
    region: "North America",
  },
};

export const PHONE_INDIAN_STATE = {
  description: "Single PII: Indian mobile number (10 digits, starts with 9)",
  fields: {
    name: "Priya",
    mobile: "+91 9876543210",
  },
};

export const ADDRESS_STATE = {
  description: "Single PII: physical address (street-type keyword heuristic)",
  fields: {
    shippingLine1: "42 Baker Street",
    city: "London",
    postalCode: "NW1 6XE",
  },
};

export const CREDIT_CARD_STATE = {
  description: "Single PII: credit card number in grouped format",
  fields: {
    cardNumber: "4111 1111 1111 1111",
    expiryMonth: "08",
    expiryYear: "2027",
  },
};

export const SSN_STATE = {
  description: "Single PII: US SSN-like value",
  fields: {
    idField: "123-45-6789",
    note: "Test record",
  },
};

export const AADHAAR_STATE = {
  description: "Single PII: Aadhaar-like 12-digit UID in 4-4-4 grouped format",
  fields: {
    aadhaarNumber: "1234 5678 9012",
    state: "Karnataka",
  },
};

export const PAN_STATE = {
  description: "Single PII: Indian PAN card number",
  fields: {
    panCard: "ABCDE1234F",
    taxYear: "2025-26",
  },
};

export const PASSPORT_STATE = {
  description: "Single PII: Indian passport number format",
  fields: {
    passportNumber: "A1234567",
    nationality: "Indian",
  },
};

// ---------------------------------------------------------------------------
// 3. MIXED_PII_STATE — multiple PII types together
// ---------------------------------------------------------------------------
export const MIXED_PII_STATE = {
  description: "Mixed PII: checkout form with email, phone, address, and card",
  fields: {
    // Personal contact
    fullName: "Jane Doe",
    emailAddress: "jane@checkout-example.com",
    phoneNumber: "800-555-9876",

    // Shipping address
    shippingAddress: "7 Elm Avenue, Apt 3",
    city: "Springfield",
    zip: "62701",

    // Payment
    cardNumber: "5105-1051-0510-5100",
    cvv: "321",

    // Government ID (for age verification flow)
    aadhaar: "9876 5432 1098",
    pan: "XYZPQ5678A",
  },
};

// ---------------------------------------------------------------------------
// 4. EDGE_CASE_STATES — PII-shaped values that should be treated carefully
// ---------------------------------------------------------------------------

/**
 * Product SKU that superficially resembles a phone number numerically.
 * The PHONE_RULE's false-positive guard looks for adjacent uppercase letter
 * runs but this SKU has the letters after the digits. Test asserts that
 * even if the phone rule fires here, it's expected behavior per the
 * conservative-flagging policy (false positives safer than false negatives),
 * and the test documents the known over-reach rather than silently accepting it.
 */
export const SKU_RESEMBLING_PHONE = {
  description:
    "Edge case: product SKU 'SKU-800-555-1234' — numerically phone-like but not PII. " +
    "Conservative policy means this MAY be flagged; test documents the behavior.",
  fields: {
    sku: "SKU-800-555-1234",
    productName: "HDMI Cable 2m",
  },
};

/**
 * Version string that looks like a dotted number but must not fire credit card.
 */
export const VERSION_STRING_STATE = {
  description: "Edge case: version string with many digits — must not fire credit card rule",
  fields: {
    appVersion: "1.23.456.789012",
    buildId: "20260829-build-0042",
  },
};

/**
 * An order reference that looks like an SSN (NNN-NN-NNNN) but contains
 * a year component that the SSN guard should suppress.
 */
export const ORDER_REF_RESEMBLING_SSN = {
  description:
    "Edge case: order reference '2025-08-2901' — looks SSN-adjacent but " +
    "the year prefix triggers the SSN false-positive guard.",
  fields: {
    orderRef: "ORD-2025-08-29",
    amount: "1299.00",
  },
};

/**
 * A product barcode that is 12 or 13 digits — could superficially match
 * Aadhaar (12 digits) or a credit card (13 digits). Documents the known
 * overlap and the conservative policy.
 */
export const BARCODE_STATE = {
  description:
    "Edge case: 12-digit EAN barcode — same digit count as Aadhaar. " +
    "Conservative policy flags it. Test documents the expected behavior.",
  fields: {
    barcode: "012345678901",
    productName: "Organic Green Tea",
  },
};

/**
 * An email-like string that is missing a TLD — must NOT fire the email rule.
 */
export const BARE_AT_SIGN_STATE = {
  description: "Edge case: '@localhost' style string — must not match email rule",
  fields: {
    internalHandle: "admin@localhost",
    service: "local-auth",
  },
};

/**
 * A PAN-card–shaped alphanumeric product code — 5 letters, 4 digits, 1 letter.
 * The PAN_RULE will fire on this. Documents the known collision.
 */
export const PAN_SHAPED_PRODUCT_CODE = {
  description:
    "Edge case: product code 'ALPHA1234Z' is PAN-shaped (5L-4N-1L). " +
    "The PAN rule fires conservatively. Test documents expected behavior.",
  fields: {
    internalCode: "ALPHA1234Z",
    category: "Tools",
  },
};

// ---------------------------------------------------------------------------
// Convenience: all fixtures grouped for iteration in tests
// ---------------------------------------------------------------------------
export const ALL_FIXTURES = {
  CLEAN_STATE,
  EMAIL_ONLY_STATE,
  PHONE_ONLY_STATE,
  PHONE_INDIAN_STATE,
  ADDRESS_STATE,
  CREDIT_CARD_STATE,
  SSN_STATE,
  AADHAAR_STATE,
  PAN_STATE,
  PASSPORT_STATE,
  MIXED_PII_STATE,
  SKU_RESEMBLING_PHONE,
  VERSION_STRING_STATE,
  ORDER_REF_RESEMBLING_SSN,
  BARCODE_STATE,
  BARE_AT_SIGN_STATE,
  PAN_SHAPED_PRODUCT_CODE,
};
