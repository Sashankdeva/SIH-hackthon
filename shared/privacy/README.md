# shared/privacy/ — Tier-1 DOM-Rule PII Detection

This sub-module implements **deterministic, rule-based PII detection** for form fields.  
No ML, no NER, no network calls — pure signal matching against HTML attributes and label text.

---

## File Layout

```
shared/privacy/
├── piiRules.js       ← Rule config/map      (EDIT THIS to extend detection)
├── detectPII.js      ← Detection logic      (rarely needs changes)
├── redactValue.js    ← Redaction renderer   (Phase 2 — EDIT masks here)
├── mockDomState.js   ← Dev fixture          (REPLACE when Perception module ships)
└── README.md         ← This file
```

| File | Purpose | Who edits it |
|---|---|---|
| `piiRules.js` | All PII category definitions — keywords, autocomplete tokens, input types | Privacy Guard / anyone adding a new PII type |
| `detectPII.js` | The `detectPII(fields)` function. Data-driven — reads from `piiRules.js` | Core module maintainer only |
| `redactValue.js` | `redactFields()` + `redactValue()` — masks PII values before network transmission | Privacy Guard / anyone adding a new piiType mask |
| `mockDomState.js` | Static mock of Perception module output for development & tests | Temporary — owned by Perception module team |

---

## How `detectPII` Works

`detectPII(fields)` accepts an array of **FieldDescriptor** objects and returns the same array enriched with three properties per field:

```js
{
  isPII: boolean,        // true if matched to any rule
  piiType: string|null,  // "email" | "phone" | "creditcard" | "name" | "address"
                         // | "password" | "ssn" | "dob" | "username" | null
  matchedRule: string|null  // audit string, e.g. "autocomplete:email", 'label:"phone"'
}
```

### Signal Priority (first match wins)

| Priority | Signal | Example |
|---|---|---|
| 1 (highest) | `autocomplete` attribute token | `autocomplete="cc-number"` |
| 2 | HTML `type` attribute | `type="email"`, `type="tel"`, `type="password"` |
| 3 | Visible `label` text (substring, case-insensitive) | label = "Card number" |
| 4 | `aria-label` attribute text (same keyword set) | aria-label = "Email address" |
| 5 (lowest) | ARIA `role` attribute | role = "...custom..." |

---

## How to Add a New PII Rule

**Only edit `piiRules.js`** — `detectPII.js` picks up new rules automatically.

### Step-by-step

1. Open `shared/privacy/piiRules.js`.
2. Append a new object to the `PII_RULES` array:

```js
// --- Biometric identifier --------------------------------------------------
{
  piiType: "biometric",
  inputTypes: [],
  autocompleteTokens: [],       // no standard autocomplete token
  labelKeywords: [
    "fingerprint",
    "face id",
    "iris scan",
    "biometric",
  ],
  ariaRoles: [],
},
```

3. Pick a unique, lowercase `piiType` string.
4. Add keywords to any or all of the four signal arrays.  
   Leave unused arrays as `[]` — never `null`.
5. Add a corresponding test case in `tests/privacy/detectPII.test.js`.
6. Done — no changes to `detectPII.js` needed.

### Signal array guidelines

| Array | What to put in it |
|---|---|
| `inputTypes` | Only recognised HTML5 `type` values: `"email"`, `"tel"`, `"password"`, `"date"`, etc. |
| `autocompleteTokens` | Exact tokens from the [HTML autocomplete spec](https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#autofill) |
| `labelKeywords` | Short, distinctive substrings. Avoid overly broad words like "id" or "number" that will cause false positives |
| `ariaRoles` | ARIA role values. Use sparingly — roles rarely identify PII on their own |

---

## FieldDescriptor Schema

The input to `detectPII()` follows this shape (until Perception module ships):

```ts
interface FieldDescriptor {
  id:           string;         // unique field key
  tag:          string;         // "input" | "select" | "textarea"
  type?:        string;         // HTML type attribute value
  autocomplete?: string;        // HTML autocomplete attribute value (may be space-separated)
  label?:       string;         // visible label text
  aria?: {
    label?: string | null;      // aria-label value
    role?:  string | null;      // role attribute value
  };
}
```

> **Note**: `mockDomState.js` is a temporary stub. Once the Perception module
> provides real DOM-traversal output, replace it by pointing `detectPII()` at
> the live data. Verify the live schema matches `FieldDescriptor` before doing so.

---

## Running Tests

```bash
# Using Node.js built-in test runner (v18+)
node --test tests/privacy/detectPII.test.js

# With spec reporter
node --test --test-reporter=spec tests/privacy/detectPII.test.js
```

Or add to `package.json`:

```json
"scripts": {
  "test:privacy": "node --test tests/privacy/detectPII.test.js"
}
```

---

## Why `shared/`?

Both `extension/` and `server/` need PII-category awareness:

- **`extension/`** — redaction renderer needs to know *which* fields to mask and how (by `piiType`)
- **`server/`** — payload validator can double-check that the sanitized context doesn't contain raw PII

Keeping the ruleset and detector in `shared/` avoids duplicating or diverging the logic across both consumers.

---

## Extending to Tier-2 / ML Detection

Tier-1 (this module) is purely deterministic. Future tiers may add:

- **Tier-2**: Regex pattern matching (e.g. SSN format `\d{3}-\d{2}-\d{4}`, Luhn check for card numbers)
- **Tier-3**: NLP / ML classifier on field context (label + surrounding DOM text)
- **Tier-4**: Visual detection (screenshot-based)

The intended extension point: call Tier-1 first, then pass `isPII: false` fields to the next tier for a second opinion. `matchedRule` should include the tier that matched (e.g. `"tier1:autocomplete:email"` vs `"tier2:regex:luhn"`).

---

## Phase 2: Redaction Renderer (`redactValue.js`)

### What it does

`redactValue.js` consumes the output of `detectPII()` and replaces every PII field's value with a deterministic, type-specific placeholder mask before any data leaves the browser.

**Two exported functions:**

```js
import { redactValue, redactFields } from "./redactValue.js";

// Low-level: mask a single value (useful for testing and reuse)
redactValue("user@example.com", "email");   // → "[REDACTED_EMAIL]"
redactValue("PROMO2024",        null);      // → "PROMO2024"  (unchanged)

// High-level: process the full detectPII() output array
const detected = detectPII(fields);
const redacted = redactFields(detected);
```

**Key guarantees:**
- **Deterministic** — same input always produces same mask. No randomness, no timestamps.
- **Non-mutating** — original field objects and the input array are never modified.
- **Safe fallback** — an unknown piiType never leaks raw data; it returns `[REDACTED_UNKNOWN:<TYPE>]`.

### Data flow

```
MOCK_DOM_STATE / Perception output
         │
         ▼
   detectPII(fields)          ← shared/privacy/detectPII.js
         │  adds: isPII, piiType, matchedRule
         ▼
   redactFields(detected)     ← shared/privacy/redactValue.js
         │  replaces: field.value → mask string (PII fields only)
         ▼
   RedactedField[]            → safe to log / transmit
```

### Redaction mask naming convention

All masks follow the format: `[REDACTED_<PIITYPE_UPPERCASE>]`

| `piiType` | Mask |
|---|---|
| `email` | `[REDACTED_EMAIL]` |
| `password` | `[REDACTED_PASSWORD]` |
| `phone` | `[REDACTED_PHONE]` |
| `creditcard` | `[REDACTED_CARD]` |
| `name` | `[REDACTED_NAME]` |
| `address` | `[REDACTED_ADDRESS]` |
| `ssn` | `[REDACTED_SSN]` |
| `dob` | `[REDACTED_DOB]` |
| `username` | `[REDACTED_USERNAME]` |

The suffix matches the `piiType` string in UPPER_SNAKE_CASE, with one exception: `creditcard` → `CARD` (kept short deliberately — `[REDACTED_CREDITCARD]` would be unnecessarily verbose for a display token).

### How to add a mask for a new piiType

When a new PII category is added to `piiRules.js`, add its mask here too:

1. Open `shared/privacy/redactValue.js`.
2. Add one entry to `REDACTION_MASKS` following the convention:

```js
// In REDACTION_MASKS:
biometric: "[REDACTED_BIOMETRIC]",
```

3. Add a test in `tests/privacy/redactValue.test.js` — the loop-based suite in section 2 will pick it up automatically; add a named assertion in section 3 for documentation.
4. Done. `redactFields()` picks it up with no other changes.

> **Note:** `REDACTION_MASKS` is `Object.freeze()`d — attempting to add a key at runtime will silently fail in sloppy mode and throw in strict mode. Always add new masks in the source file, not at runtime.

### Running Phase 2 tests

```bash
# Phase 2 only
node --test tests/privacy/redactValue.test.js

# Both phases together
node --test tests/privacy/

# Spec reporter (both phases)
node --test --test-reporter=spec tests/privacy/
```
