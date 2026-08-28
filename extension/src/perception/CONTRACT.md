# Role 2 — Perception & Local Inference Contract

**Sprint Scope:** DOM & Accessibility-based local perception engine (Vision inference deferred).  
**Module Location:** `extension/src/perception/`  
**Primary Export:** `captureDomState(taskId: string): PageState` and `resolveElement(elementId: number): Element | null`

---

## 1. PageState Structure (Frozen)

```typescript
export interface PageState {
  taskId: string;        // Unique task/session identifier (UUID string)
  url: string;           // Current document URL (location.href)
  title: string;         // Document title (document.title)
  capturedAt: number;    // Capture timestamp in epoch milliseconds (Date.now())
  elements: CapturedElement[]; // Array of visible interactive elements
}
```

---

## 2. CapturedElement Structure (Frozen)

```typescript
export interface CapturedElement {
  elementId: number;          // Unique, stable, opaque positive integer
  role: string;               // Normalized WAI-ARIA semantic role (e.g. "textbox", "button", "combobox", "link")
  label: string | null;       // Accessible name resolved via deterministic precedence cascade
  tag: string;                // Lowercase HTML tag name (e.g. "input", "button", "select", "a")
  inputType: string | null;   // HTML input type for inputs (e.g. "text", "password", "email", "tel"); null otherwise
  disabled?: boolean;         // True if control or parent fieldset is disabled / aria-disabled
  readonly?: boolean;         // True if control is readonly / aria-readonly
  placeholder?: string | null;// Placeholder attribute string if present
}
```

---

## 3. Downstream Consumer Integration

| Consumer | Module | Inputs Consumed | Role 2 Guarantees |
|---|---|---|---|
| **Content Script** | `extension/src/content/index.ts` | `PageState` | Full structured page snapshot; dispatched over message bus. |
| **Privacy Guard** | `extension/src/privacy/tier1DomRules.ts` | `elementId`, `inputType`, `label` | High-fidelity labels and inputType values for deterministic PII regex matching. |
| **Privacy Firewall** | `extension/src/privacy/sanitizedContext.ts` | `elementId`, `role`, `label` | Clean element mapping for downstream sanitized context assembly. |
| **Action Validator** | `extension/src/action/validator.ts` | `resolveElement(elementId)` | Live DOM element re-validation with fallback recovery across virtual DOM re-renders. |
| **Action Executor** | `extension/src/action/executor.ts` | `resolveElement(elementId)` | Direct element dispatch target retrieval. |

---

## 4. Privacy Boundary Invariants

- **Zero Value Capture**: `CapturedElement` never contains `element.value`.
- **Zero Token Leakage**: Password strings, session tokens, and input values are never accessed or stored.
- **Opaque Identification**: `data-privy-id` is strictly an incremental integer (`"1"`, `"2"`), never encoding semantic or user PII.
