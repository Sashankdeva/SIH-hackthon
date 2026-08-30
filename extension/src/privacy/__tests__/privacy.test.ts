// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { detectTier1 } from "../tier1DomRules";
import { redact, resetTokenCounters, getCurrentTokenCounters } from "../redact";
import { validateRedactionCoverage } from "../redactionValidator";
import { storeSecret, resolveSecret, clearSecrets, getSecretCount } from "../secretStore";
import {
  categoryFromToken,
  loadProfile,
  saveProfile,
  clearProfile,
  resolveFromProfile,
  encryptProfile,
  decryptProfile,
  unlockProfile,
  lockProfile,
  isProfileLocked,
  type Profile,
  type EncryptedProfileEnvelope,
} from "../profileStore";
import {
  buildSanitizedContext,
  toWireSanitizedContext,
  sanitizePageTitle,
  sanitizeOrigin,
} from "../sanitizedContext";
import {
  overlayFaceBoxes,
  clearFaceOverlays,
  observeImageTarget,
  unobserveImageTarget,
  getTrackedTargetCount,
  destroyVisualRedactionObservers,
} from "../visualRedact";
import type { CapturedElement, PageState } from "../../perception/types";
import type { PrivacyDetection, RedactionRecord } from "../types";

describe("Role 3 — Privacy Guard & Redaction Core Engine", () => {
  beforeEach(() => {
    resetTokenCounters();
    clearSecrets();
    document.body.innerHTML = "";
    document.title = "Test Page";
  });

  // =========================================================================
  // 1. Tier 1 DOM-Rule PII Detection
  // =========================================================================
  describe("1. Tier 1 DOM-Rule PII Detection (detectTier1)", () => {
    it("detects sensitive fields by HTML inputType with 1.0 confidence", () => {
      const elements: CapturedElement[] = [
        { elementId: 1, role: "textbox", label: "User Input", tag: "input", inputType: "password" },
        { elementId: 2, role: "textbox", label: "Contact Field", tag: "input", inputType: "email" },
        { elementId: 3, role: "textbox", label: "Dial Number", tag: "input", inputType: "tel" },
      ];

      const detections = detectTier1(elements);
      expect(detections).toHaveLength(3);
      expect(detections[0]).toEqual({
        elementId: 1,
        category: "password",
        source: "dom_rule",
        confidence: 1.0,
      });
      expect(detections[1]).toEqual({
        elementId: 2,
        category: "email",
        source: "dom_rule",
        confidence: 1.0,
      });
      expect(detections[2]).toEqual({
        elementId: 3,
        category: "phone",
        source: "dom_rule",
        confidence: 1.0,
      });
    });

    it("detects sensitive categories by label text keywords", () => {
      const elements: CapturedElement[] = [
        { elementId: 1, role: "textbox", label: "Enter your Password", tag: "input", inputType: "text" },
        { elementId: 2, role: "textbox", label: "Customer Full Name", tag: "input", inputType: "text" },
        { elementId: 3, role: "textbox", label: "Shipping Address (Street & City)", tag: "input", inputType: "text" },
        { elementId: 4, role: "textbox", label: "Postal Pin Code", tag: "input", inputType: "text" },
        { elementId: 5, role: "textbox", label: "12-digit Aadhaar Card Number", tag: "input", inputType: "text" },
        { elementId: 6, role: "textbox", label: "Indian PAN Card", tag: "input", inputType: "text" },
        { elementId: 7, role: "textbox", label: "Credit Card Number", tag: "input", inputType: "text" },
        { elementId: 8, role: "textbox", label: "Card CVV / CVC", tag: "input", inputType: "text" },
      ];

      const detections = detectTier1(elements);
      expect(detections).toHaveLength(8);
      expect(detections.map((d) => d.category)).toEqual([
        "password",
        "person_name",
        "address",
        "address",
        "government_id",
        "government_id",
        "financial",
        "financial",
      ]);
    });

    it("detects sensitive categories via placeholder when label is absent", () => {
      const elements: CapturedElement[] = [
        { elementId: 1, role: "textbox", label: null, placeholder: "e-mail address", tag: "input", inputType: "text" },
        { elementId: 2, role: "textbox", label: null, placeholder: "mobile phone number", tag: "input", inputType: "text" },
        { elementId: 3, role: "textbox", label: null, placeholder: "Passport Number", tag: "input", inputType: "text" },
        { elementId: 4, role: "textbox", label: null, placeholder: "Card Expiry (MM/YY)", tag: "input", inputType: "text" },
      ];

      const detections = detectTier1(elements);
      expect(detections).toHaveLength(4);
      expect(detections.map((d) => d.category)).toEqual([
        "email",
        "phone",
        "government_id",
        "financial",
      ]);
    });

    it("safely ignores non-sensitive elements", () => {
      const elements: CapturedElement[] = [
        { elementId: 1, role: "button", label: "Place Order", tag: "button", inputType: null },
        { elementId: 2, role: "textbox", label: "Search products", tag: "input", inputType: "search" },
        { elementId: 3, role: "checkbox", label: "I agree to terms", tag: "input", inputType: "checkbox" },
        { elementId: 4, role: "link", label: "Back to Home", tag: "a", inputType: null },
      ];

      const detections = detectTier1(elements);
      expect(detections).toHaveLength(0);
    });

    it("handles empty or invalid element lists gracefully", () => {
      expect(detectTier1([])).toEqual([]);
      expect(detectTier1(null as unknown as CapturedElement[])).toEqual([]);
    });
  });

  // =========================================================================
  // 2. Deterministic Token Minting & Lifecycle
  // =========================================================================
  describe("2. Deterministic Token Minting & Lifecycle (redact)", () => {
    it("mints deterministic tokens starting from 01 per category", () => {
      const detections: PrivacyDetection[] = [
        { elementId: 10, category: "email", source: "dom_rule", confidence: 1.0 },
        { elementId: 11, category: "password", source: "dom_rule", confidence: 1.0 },
        { elementId: 12, category: "email", source: "dom_rule", confidence: 0.9 },
        { elementId: 13, category: "government_id", source: "dom_rule", confidence: 0.9 },
      ];

      const redactions = redact(detections);
      expect(redactions).toHaveLength(4);
      expect(redactions[0]).toEqual({
        elementId: 10,
        category: "email",
        method: "semantic_token",
        token: "[EMAIL_01]",
      });
      expect(redactions[1]).toEqual({
        elementId: 11,
        category: "password",
        method: "blackout",
        token: "[PASSWORD_01]",
      });
      expect(redactions[2]).toEqual({
        elementId: 12,
        category: "email",
        method: "semantic_token",
        token: "[EMAIL_02]",
      });
      expect(redactions[3]).toEqual({
        elementId: 13,
        category: "government_id",
        method: "semantic_token",
        token: "[GOVERNMENT_ID_01]",
      });
    });

    it("resets counters between independent scans by default (no token drift)", () => {
      const detections: PrivacyDetection[] = [
        { elementId: 10, category: "email", source: "dom_rule", confidence: 1.0 },
      ];

      const scan1 = redact(detections);
      expect(scan1[0].token).toBe("[EMAIL_01]");

      // Second scan of same page should STILL produce [EMAIL_01]
      const scan2 = redact(detections);
      expect(scan2[0].token).toBe("[EMAIL_01]");
    });

    it("allows explicitly preserving counters when requested", () => {
      const batch1: PrivacyDetection[] = [
        { elementId: 1, category: "email", source: "dom_rule", confidence: 1.0 },
      ];
      const batch2: PrivacyDetection[] = [
        { elementId: 2, category: "email", source: "dom_rule", confidence: 1.0 },
      ];

      const r1 = redact(batch1);
      expect(r1[0].token).toBe("[EMAIL_01]");

      const r2 = redact(batch2, { preserveCounters: true });
      expect(r2[0].token).toBe("[EMAIL_02]");
    });

    it("resets counters cleanly with resetTokenCounters()", () => {
      redact([{ elementId: 1, category: "phone", source: "dom_rule", confidence: 1.0 }]);
      expect(getCurrentTokenCounters()["phone"]).toBe(1);

      resetTokenCounters();
      expect(getCurrentTokenCounters()).toEqual({});
    });
  });

  // =========================================================================
  // 3. Redaction Coverage Validator
  // =========================================================================
  describe("3. Redaction Coverage Validator (validateRedactionCoverage)", () => {
    it("returns ok: true when all detected elements have redaction records", () => {
      const detections: PrivacyDetection[] = [
        { elementId: 1, category: "email", source: "dom_rule", confidence: 1.0 },
        { elementId: 2, category: "password", source: "dom_rule", confidence: 1.0 },
      ];
      const redactions: RedactionRecord[] = [
        { elementId: 1, category: "email", method: "semantic_token", token: "[EMAIL_01]" },
        { elementId: 2, category: "password", method: "blackout", token: "[PASSWORD_01]" },
      ];

      const result = validateRedactionCoverage(detections, redactions);
      expect(result.ok).toBe(true);
      expect(result.missing).toHaveLength(0);
    });

    it("returns ok: false and lists missing element IDs when redaction is incomplete (Fail Closed)", () => {
      const detections: PrivacyDetection[] = [
        { elementId: 1, category: "email", source: "dom_rule", confidence: 1.0 },
        { elementId: 2, category: "password", source: "dom_rule", confidence: 1.0 },
        { elementId: 3, category: "financial", source: "dom_rule", confidence: 0.9 },
      ];
      const redactions: RedactionRecord[] = [
        { elementId: 1, category: "email", method: "semantic_token", token: "[EMAIL_01]" },
      ];

      const result = validateRedactionCoverage(detections, redactions);
      expect(result.ok).toBe(false);
      expect(result.missing).toEqual([2, 3]);
    });

    it("handles empty arrays cleanly", () => {
      expect(validateRedactionCoverage([], [])).toEqual({ ok: true, missing: [] });
    });
  });

  // =========================================================================
  // 4. In-Memory Secret Store
  // =========================================================================
  describe("4. In-Memory Secret Store (secretStore)", () => {
    it("stores and resolves credentials by reference token", () => {
      storeSecret("[PASSWORD_01]", "superSecretPassword123!");
      expect(resolveSecret("[PASSWORD_01]")).toBe("superSecretPassword123!");
    });

    it("returns null for non-existent or invalid references", () => {
      expect(resolveSecret("[UNKNOWN_REF]")).toBeNull();
      expect(resolveSecret("")).toBeNull();
      expect(resolveSecret(null as unknown as string)).toBeNull();
    });

    it("clears all secrets on clearSecrets()", () => {
      storeSecret("[PASSWORD_01]", "secretA");
      storeSecret("[PASSWORD_02]", "secretB");
      clearSecrets();
      expect(resolveSecret("[PASSWORD_01]")).toBeNull();
      expect(resolveSecret("[PASSWORD_02]")).toBeNull();
    });

    it("ignores invalid non-string inputs safely", () => {
      storeSecret("", "secret");
      storeSecret("[REF]", null as unknown as string);
      expect(resolveSecret("")).toBeNull();
      expect(resolveSecret("[REF]")).toBeNull();
    });
  });

  // =========================================================================
  // 5. Local Profile Store & Category Resolution
  // =========================================================================
  describe("5. Local Profile Store & Category Resolution (profileStore)", () => {
    it("maps tokens back to profile categories including government_id", () => {
      expect(categoryFromToken("[PERSON_NAME_01]")).toBe("person_name");
      expect(categoryFromToken("[EMAIL_01]")).toBe("email");
      expect(categoryFromToken("[PHONE_02]")).toBe("phone");
      expect(categoryFromToken("[ADDRESS_01]")).toBe("address");
      expect(categoryFromToken("[FINANCIAL_03]")).toBe("financial");
      expect(categoryFromToken("[GOVERNMENT_ID_01]")).toBe("government_id");
      expect(categoryFromToken("[UNKNOWN_01]")).toBeNull();
      expect(categoryFromToken("invalid-format")).toBeNull();
    });

    it("saves and loads user profile data via chrome.storage.local mock", async () => {
      const mockStorage: Record<string, unknown> = {};
      (globalThis as unknown as { chrome: unknown }).chrome = {
        storage: {
          local: {
            get: vi.fn((keys: string[], cb: (res: Record<string, unknown>) => void) => {
              const res: Record<string, unknown> = {};
              for (const k of keys) {
                if (k in mockStorage) res[k] = mockStorage[k];
              }
              cb(res);
            }),
            set: vi.fn((items: Record<string, unknown>, cb?: () => void) => {
              Object.assign(mockStorage, items);
              if (cb) cb();
            }),
          },
        },
      };

      const profileData: Profile = {
        person_name: "Jane Doe",
        email: "jane.doe@example.com",
        phone: "+91-9876543210",
        address: "Bengaluru, Karnataka",
        government_id: "ABCD1234E",
      };

      await saveProfile(profileData);
      const loaded = await loadProfile();
      expect(loaded).toEqual(profileData);

      // Resolve from profile by token
      const resolvedName = await resolveFromProfile("[PERSON_NAME_01]");
      expect(resolvedName).toBe("Jane Doe");

      const resolvedGovId = await resolveFromProfile("[GOVERNMENT_ID_01]");
      expect(resolvedGovId).toBe("ABCD1234E");

      const unmapped = await resolveFromProfile("[FINANCIAL_01]");
      expect(unmapped).toBeNull();
    });
  });

  // =========================================================================
  // 6. Sanitized Context, Title Privacy & Wire Serialization
  // =========================================================================
  describe("6. Sanitized Context, Title Privacy & Wire Serialization", () => {
    it("sanitizes document.title containing PII", () => {
      expect(sanitizePageTitle("Welcome john.doe@example.com - Portal")).toBe("Welcome [EMAIL] - Portal");
      expect(sanitizePageTitle("Order for Card 4111 2222 3333 4444")).toBe("Order for Card [FINANCIAL]");
      expect(sanitizePageTitle("Account verified: +1 (555) 019-2834")).toBe("Account verified: [PHONE]");
      expect(sanitizePageTitle("PAN: ABCDE1234F Confirmation")).toBe("PAN: [GOVERNMENT_ID] Confirmation");
      expect(sanitizePageTitle("Normal Checkout Page")).toBe("Normal Checkout Page");
      expect(sanitizePageTitle("")).toBe("unknown");
    });

    it("builds SanitizedContext replacing sensitive labels with tokens and capturing password secrets", () => {
      document.body.innerHTML = `
        <form>
          <input id="pwd-field" type="password" value="mySecretPassword99" data-privy-id="1" />
          <input id="email-field" type="email" value="real_user@example.com" data-privy-id="2" />
          <button id="submit-btn" data-privy-id="3">Submit</button>
        </form>
      `;

      const pageState: PageState = {
        taskId: "task-test-01",
        url: "http://localhost:8000/checkout",
        title: "User Profile: user@secret.com",
        capturedAt: Date.now(),
        elements: [
          { elementId: 1, role: "textbox", label: "Password", tag: "input", inputType: "password" },
          { elementId: 2, role: "textbox", label: "Email", tag: "input", inputType: "email" },
          { elementId: 3, role: "button", label: "Submit", tag: "button", inputType: null },
        ],
      };

      const detections = detectTier1(pageState.elements);
      const redactions = redact(detections);

      document.title = "User Profile: user@secret.com";

      const firewall = buildSanitizedContext(pageState, detections, redactions, "submit login");
      expect(firewall.ok).toBe(true);

      if (firewall.ok) {
        const ctx = firewall.context;
        expect(ctx.taskId).toBe("task-test-01");
        expect(ctx.task).toBe("submit login");
        expect(ctx.page).toBe("User Profile: [EMAIL]");
        expect(ctx.fields).toEqual({
          "1": "[PASSWORD_01]",
          "2": "[EMAIL_01]",
        });
        // Sensitive labels replaced by tokens in elements array
        expect(ctx.elements[0].label).toBe("[PASSWORD_01]");
        expect(ctx.elements[1].label).toBe("[EMAIL_01]");
        expect(ctx.elements[2].label).toBe("Submit"); // Non-sensitive element intact

        // Password secret was captured locally in secretStore
        expect(resolveSecret("[PASSWORD_01]")).toBe("mySecretPassword99");
      }
    });

    it("blocks payload creation when redaction coverage is incomplete", () => {
      const pageState: PageState = {
        taskId: "task-test-fail",
        url: "http://localhost:8000",
        title: "Test",
        capturedAt: Date.now(),
        elements: [
          { elementId: 1, role: "textbox", label: "Email", tag: "input", inputType: "email" },
        ],
      };
      const detections: PrivacyDetection[] = [
        { elementId: 1, category: "email", source: "dom_rule", confidence: 1.0 },
      ];
      const incompleteRedactions: RedactionRecord[] = [];

      const result = buildSanitizedContext(pageState, detections, incompleteRedactions, "task");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.missingElementIds).toEqual([1]);
      }
    });

    it("converts internal SanitizedContext to wire format adhering to schema", () => {
      const context = {
        taskId: "task-123",
        task: "book flight",
        page: "Booking",
        urlOrigin: "http://localhost:8000",
        elements: [{ elementId: 1, role: "button", label: "Next" }],
        fields: { "2": "[EMAIL_01]" },
        history: [
          {
            step: 1,
            action: "click",
            element_id: 1,
            element_label: "Next",
            outcome: "success" as const,
          },
        ],
      };

      const wire = toWireSanitizedContext(context);
      expect(wire.task_id).toBe("task-123");
      expect(wire.task).toBe("book flight");
      expect(wire.page).toBe("Booking");
      expect(wire.url_origin).toBe("http://localhost:8000");
      expect(wire.elements).toEqual([{ element_id: 1, role: "button", label: "Next" }]);
      expect(wire.fields).toEqual({ "2": "[EMAIL_01]" });
      expect(wire.history).toHaveLength(1);
    });
  });

  // =========================================================================
  // 7. Visual Redaction Overlay Lifecycle
  // =========================================================================
  describe("7. Visual Redaction Overlay Lifecycle (visualRedact)", () => {
    it("renders black-box overlay divs over detected face coordinates", () => {
      const container = document.createElement("div");
      container.style.position = "relative";
      document.body.appendChild(container);

      const img = document.createElement("img");
      img.id = "face-img";
      img.src = "http://localhost:8000/face.jpg";
      // Mock dimensions
      Object.defineProperty(img, "naturalWidth", { value: 640 });
      Object.defineProperty(img, "naturalHeight", { value: 480 });
      Object.defineProperty(img, "offsetLeft", { value: 10 });
      Object.defineProperty(img, "offsetTop", { value: 20 });
      img.getBoundingClientRect = () => ({
        width: 320,
        height: 240,
        top: 20,
        left: 10,
        right: 330,
        bottom: 260,
        x: 10,
        y: 20,
        toJSON: () => {},
      });
      container.appendChild(img);

      const boxes = [
        { x1: 100, y1: 50, x2: 200, y2: 150, score: 0.95 },
      ];

      overlayFaceBoxes(img, boxes);

      const overlay = container.querySelector('[data-privyvision-overlay="face-redaction"]');
      expect(overlay).not.toBeNull();
      expect(overlay?.children).toHaveLength(1);

      const faceDiv = overlay?.children[0] as HTMLElement;
      expect(faceDiv.style.background).toBe("rgb(0, 0, 0)");
      // Scaled by 320/640 = 0.5
      expect(faceDiv.style.left).toBe("50px"); // 100 * 0.5
      expect(faceDiv.style.top).toBe("25px");  // 50 * 0.5
      expect(faceDiv.style.width).toBe("50px"); // (200 - 100) * 0.5
      expect(faceDiv.style.height).toBe("50px"); // (150 - 50) * 0.5
    });

    it("replaces stale overlays on re-scan without creating duplicate DOM nodes", () => {
      const container = document.createElement("div");
      document.body.appendChild(container);

      const img = document.createElement("img");
      img.id = "face-img-2";
      img.src = "http://localhost:8000/face2.jpg";
      Object.defineProperty(img, "naturalWidth", { value: 640 });
      Object.defineProperty(img, "naturalHeight", { value: 480 });
      img.getBoundingClientRect = () => ({
        width: 640,
        height: 480,
        top: 0,
        left: 0,
        right: 640,
        bottom: 480,
        x: 0,
        y: 0,
        toJSON: () => {},
      });
      container.appendChild(img);

      const boxes = [{ x1: 50, y1: 50, x2: 100, y2: 100, score: 0.9 }];

      // First pass
      overlayFaceBoxes(img, boxes);
      expect(container.querySelectorAll('[data-privyvision-overlay="face-redaction"]')).toHaveLength(1);

      // Re-scan with new boxes
      overlayFaceBoxes(img, boxes);
      expect(container.querySelectorAll('[data-privyvision-overlay="face-redaction"]')).toHaveLength(1);
    });

    it("clears all overlays with clearFaceOverlays()", () => {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const img = document.createElement("img");
      Object.defineProperty(img, "naturalWidth", { value: 100 });
      Object.defineProperty(img, "naturalHeight", { value: 100 });
      img.getBoundingClientRect = () => ({
        width: 100,
        height: 100,
        top: 0,
        left: 0,
        right: 100,
        bottom: 100,
        x: 0,
        y: 0,
        toJSON: () => {},
      });
      container.appendChild(img);

      overlayFaceBoxes(img, [{ x1: 10, y1: 10, x2: 50, y2: 50, score: 0.9 }]);
      expect(document.querySelectorAll('[data-privyvision-overlay="face-redaction"]')).toHaveLength(1);

      clearFaceOverlays();
      expect(document.querySelectorAll('[data-privyvision-overlay="face-redaction"]')).toHaveLength(0);
    });
  });

  // =========================================================================
  // 8. Adversarial PII Evasion & Precedence
  // =========================================================================
  describe("8. Adversarial PII Evasion & Precedence", () => {
    it("detects alternate casing, extra whitespace, and punctuation in labels", () => {
      const elements: CapturedElement[] = [
        { elementId: 1, role: "textbox", label: "  E-MAIL   ADDRESS  ", tag: "input", inputType: "text" },
        { elementId: 2, role: "textbox", label: "Mobile-No / Contact-No:", tag: "input", inputType: "text" },
        { elementId: 3, role: "textbox", label: "PAN Card / Tax Identifier", tag: "input", inputType: "text" },
        { elementId: 4, role: "textbox", label: "12-Digit AADHAAR Number", tag: "input", inputType: "text" },
        { elementId: 5, role: "textbox", label: "Credit/Debit Card Number", tag: "input", inputType: "text" },
        { elementId: 6, role: "textbox", label: "Bank IFSC Code", tag: "input", inputType: "text" },
        { elementId: 7, role: "textbox", label: "SSN (Social Security Number)", tag: "input", inputType: "text" },
      ];

      const detections = detectTier1(elements);
      expect(detections).toHaveLength(7);
      expect(detections.map((d) => d.category)).toEqual([
        "email",
        "phone",
        "government_id",
        "government_id",
        "financial",
        "financial",
        "government_id",
      ]);
    });

    it("ensures inputType password takes precedence over deceptive labels", () => {
      const elements: CapturedElement[] = [
        { elementId: 1, role: "textbox", label: "Search query", tag: "input", inputType: "password" },
      ];

      const detections = detectTier1(elements);
      expect(detections).toHaveLength(1);
      expect(detections[0].category).toBe("password");
      expect(detections[0].confidence).toBe(1.0);
    });
  });

  // =========================================================================
  // 9. Network Boundary Zero-Leakage (Canary PII Verification)
  // =========================================================================
  describe("9. Network Boundary Zero-Leakage (Canary PII Verification)", () => {
    it("guarantees zero raw canary strings cross into the wire payload", () => {
      const CANARY_EMAIL = "CANARY_EMAIL_26171@example.com";
      const CANARY_PHONE = "+91-9988776655";
      const CANARY_PASSWORD = "CANARY_PASSWORD_SUPER_SECRET_123";
      const CANARY_CARD = "4242-4242-4242-4242";
      const CANARY_PAN = "ABCDE1234F";
      const CANARY_AADHAAR = "9988 7766 5544";

      document.body.innerHTML = `
        <form>
          <input id="canary-pwd" type="password" value="${CANARY_PASSWORD}" data-privy-id="1" />
          <input id="canary-email" type="email" value="${CANARY_EMAIL}" data-privy-id="2" />
          <input id="canary-phone" type="tel" value="${CANARY_PHONE}" data-privy-id="3" />
          <input id="canary-card" type="text" value="${CANARY_CARD}" data-privy-id="4" />
          <input id="canary-pan" type="text" value="${CANARY_PAN}" data-privy-id="5" />
          <input id="canary-aadhaar" type="text" value="${CANARY_AADHAAR}" data-privy-id="6" />
        </form>
      `;

      const pageState: PageState = {
        taskId: "task-canary-boundary",
        url: `http://localhost:8000/canary?email=${encodeURIComponent(CANARY_EMAIL)}&card=${CANARY_CARD}`,
        title: `Dashboard - Account for ${CANARY_EMAIL} / ${CANARY_PAN}`,
        capturedAt: Date.now(),
        elements: [
          { elementId: 1, role: "textbox", label: "Password", tag: "input", inputType: "password" },
          { elementId: 2, role: "textbox", label: "Email Address", tag: "input", inputType: "email" },
          { elementId: 3, role: "textbox", label: "Mobile Phone", tag: "input", inputType: "tel" },
          { elementId: 4, role: "textbox", label: "Credit Card Number", tag: "input", inputType: "text" },
          { elementId: 5, role: "textbox", label: "PAN Card", tag: "input", inputType: "text" },
          { elementId: 6, role: "textbox", label: "Aadhaar Number", tag: "input", inputType: "text" },
        ],
      };

      const detections = detectTier1(pageState.elements);
      const redactions = redact(detections);
      const coverage = validateRedactionCoverage(detections, redactions);
      expect(coverage.ok).toBe(true);

      const firewall = buildSanitizedContext(pageState, detections, redactions, "execute canary test");
      expect(firewall.ok).toBe(true);

      if (firewall.ok) {
        const wirePayload = toWireSanitizedContext(firewall.context);
        const serializedJson = JSON.stringify(wirePayload);

        // Verify CANARY strings are NEVER present in outbound wire payload
        expect(serializedJson).not.toContain(CANARY_EMAIL);
        expect(serializedJson).not.toContain(CANARY_PHONE);
        expect(serializedJson).not.toContain(CANARY_PASSWORD);
        expect(serializedJson).not.toContain(CANARY_CARD);
        expect(serializedJson).not.toContain(CANARY_PAN);
        expect(serializedJson).not.toContain(CANARY_AADHAAR);

        // Verify tokens ARE present
        expect(serializedJson).toContain("[PASSWORD_01]");
        expect(serializedJson).toContain("[EMAIL_01]");
        expect(serializedJson).toContain("[PHONE_01]");
        expect(serializedJson).toContain("[FINANCIAL_01]");
        expect(serializedJson).toContain("[GOVERNMENT_ID_01]");
        expect(serializedJson).toContain("[GOVERNMENT_ID_02]");

        // Verify query parameters with PII were stripped from url_origin
        expect(wirePayload.url_origin).toBe("http://localhost:8000");

        // Verify title PII was sanitized
        expect(wirePayload.page).not.toContain(CANARY_EMAIL);
        expect(wirePayload.page).not.toContain(CANARY_PAN);
        expect(wirePayload.page).toContain("[EMAIL]");
        expect(wirePayload.page).toContain("[GOVERNMENT_ID]");
      }
    });
  });

  // =========================================================================
  // 10. Repeated Scan Isolation & Token Consistency
  // =========================================================================
  describe("10. Repeated Scan Isolation & Token Consistency", () => {
    it("produces identical token sequences over 10 repeated page captures without drift", () => {
      const pageElements: CapturedElement[] = [
        { elementId: 1, role: "textbox", label: "Email Address", tag: "input", inputType: "email" },
        { elementId: 2, role: "textbox", label: "User Password", tag: "input", inputType: "password" },
        { elementId: 3, role: "textbox", label: "Contact Phone", tag: "input", inputType: "tel" },
      ];

      for (let scan = 1; scan <= 10; scan++) {
        const detections = detectTier1(pageElements);
        const redactions = redact(detections);

        expect(redactions[0].token).toBe("[EMAIL_01]");
        expect(redactions[1].token).toBe("[PASSWORD_01]");
        expect(redactions[2].token).toBe("[PHONE_01]");
      }
    });
  });

  // =========================================================================
  // 11. Malformed & Boundary Input Hardening
  // =========================================================================
  describe("11. Malformed & Boundary Input Hardening", () => {
    it("handles null, undefined, and non-array arguments without throwing", () => {
      expect(detectTier1(null as unknown as CapturedElement[])).toEqual([]);
      expect(detectTier1(undefined as unknown as CapturedElement[])).toEqual([]);
      expect(detectTier1([{ elementId: null as unknown as number, role: "textbox", label: null, tag: "input", inputType: null }])).toEqual([]);

      expect(redact(null as unknown as PrivacyDetection[])).toEqual([]);
      expect(redact(undefined as unknown as PrivacyDetection[])).toEqual([]);

      expect(validateRedactionCoverage(null as unknown as PrivacyDetection[], null as unknown as RedactionRecord[])).toEqual({ ok: false, missing: [] });

      expect(buildSanitizedContext(null as unknown as PageState, [], [], "task")).toEqual({ ok: false, missingElementIds: [] });
    });

    it("deduplicates duplicate element IDs in detection and redaction", () => {
      const duplicateElements: CapturedElement[] = [
        { elementId: 5, role: "textbox", label: "Email", tag: "input", inputType: "email" },
        { elementId: 5, role: "textbox", label: "Email Address", tag: "input", inputType: "email" },
      ];

      const detections = detectTier1(duplicateElements);
      expect(detections).toHaveLength(1);

      const redactions = redact(detections);
      expect(redactions).toHaveLength(1);
      expect(redactions[0].elementId).toBe(5);
    });
  });

  // =========================================================================
  // 12. Large Form & High-Volume Element Stress Benchmark
  // =========================================================================
  describe("12. Large Form & High-Volume Element Stress Benchmark", () => {
    it("processes a 250-element synthetic DOM in under 2ms with complete coverage", () => {
      const elements: CapturedElement[] = [];
      for (let i = 1; i <= 250; i++) {
        const isEmail = i % 5 === 0;
        const isPassword = i % 7 === 0;
        const isPhone = i % 11 === 0;
        elements.push({
          elementId: i,
          role: "textbox",
          label: isEmail ? `User Email ${i}` : isPassword ? `Password ${i}` : isPhone ? `Phone ${i}` : `Field ${i}`,
          tag: "input",
          inputType: isEmail ? "email" : isPassword ? "password" : isPhone ? "tel" : "text",
        });
      }

      const t0 = performance.now();
      const detections = detectTier1(elements);
      const redactions = redact(detections);
      const coverage = validateRedactionCoverage(detections, redactions);
      const durationMs = performance.now() - t0;

      expect(coverage.ok).toBe(true);
      expect(detections.length).toBeGreaterThan(50);
      expect(redactions.length).toBe(detections.length);
      expect(durationMs).toBeLessThan(15.0); // High-speed execution
    });
  });

  // =========================================================================
  // 13. URL Query Parameter Stripping & Origin Isolation
  // =========================================================================
  describe("13. URL Query Parameter Stripping & Origin Isolation", () => {
    it("strips all paths and query parameters to emit pure origin only", () => {
      expect(sanitizeOrigin("https://example.com/checkout?token=secret123&user=john@test.com")).toBe("https://example.com");
      expect(sanitizeOrigin("http://192.168.1.50:8787/reason/v1#section2")).toBe("http://192.168.1.50:8787");
      expect(sanitizeOrigin("invalid-url-string")).toBe("http://localhost");
      expect(sanitizeOrigin("")).toBe("http://localhost");
    });
  });

  // =========================================================================
  // 14. Storage Tampering & Profile Data Sanitization
  // =========================================================================
  describe("14. Storage Tampering & Profile Data Sanitization", () => {
    it("sanitizes corrupted, non-string, or oversized data in chrome.storage.local", async () => {
      const mockStorage: Record<string, unknown> = {
        userProfile: {
          person_name: "A".repeat(2000), // Oversized string
          email: "valid@example.com",
          phone: 1234567890, // Invalid non-string type
          injected_field: "malicious_payload", // Unknown non-allowed field
          __proto__: { polluted: true },
        },
      };

      (globalThis as unknown as { chrome: unknown }).chrome = {
        storage: {
          local: {
            get: vi.fn((keys: string[], cb: (res: Record<string, unknown>) => void) => {
              const res: Record<string, unknown> = {};
              for (const k of keys) {
                if (k in mockStorage) res[k] = mockStorage[k];
              }
              cb(res);
            }),
            set: vi.fn((items: Record<string, unknown>, cb?: () => void) => {
              Object.assign(mockStorage, items);
              if (cb) cb();
            }),
            remove: vi.fn((keys: string[], cb?: () => void) => {
              for (const k of keys) delete mockStorage[k];
              if (cb) cb();
            }),
          },
        },
      };

      const profile = await loadProfile();
      // Bounded string
      expect(profile.person_name).toHaveLength(1000);
      expect(profile.email).toBe("valid@example.com");
      // Non-string rejected
      expect(profile.phone).toBeUndefined();
      // Unknown field stripped
      expect((profile as Record<string, unknown>).injected_field).toBeUndefined();

      // Clear profile
      await clearProfile();
      const cleared = await loadProfile();
      expect(cleared).toEqual({});
    });
  });

  // =========================================================================
  // 15. Secret Store Lifecycle & Cross-Task Isolation
  // =========================================================================
  describe("15. Secret Store Lifecycle & Cross-Task Isolation", () => {
    it("isolates secrets strictly within one task lifecycle", () => {
      // Task 1: Store secret
      storeSecret("[PASSWORD_01]", "Task1SecretPassword!");
      expect(getSecretCount()).toBe(1);
      expect(resolveSecret("[PASSWORD_01]")).toBe("Task1SecretPassword!");

      // Task boundary transition / Navigation -> clearSecrets()
      clearSecrets();
      expect(getSecretCount()).toBe(0);

      // Task 2: Attempt resolving Task 1 token
      expect(resolveSecret("[PASSWORD_01]")).toBeNull();

      // Task 2: Store distinct secret
      storeSecret("[PASSWORD_01]", "Task2DifferentPassword!");
      expect(resolveSecret("[PASSWORD_01]")).toBe("Task2DifferentPassword!");
      clearSecrets();
    });
  });

  // =========================================================================
  // 16. Error-Path & Diagnostics Privacy
  // =========================================================================
  describe("16. Error-Path & Diagnostics Privacy", () => {
    it("logs only element IDs during firewall block without exposing labels or values", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const pageState: PageState = {
        taskId: "task-error-privacy",
        url: "http://localhost:8000",
        title: "Test",
        capturedAt: Date.now(),
        elements: [
          { elementId: 42, role: "textbox", label: "SecretPassword123", tag: "input", inputType: "password" },
        ],
      };

      const detections: PrivacyDetection[] = [
        { elementId: 42, category: "password", source: "dom_rule", confidence: 1.0 },
      ];
      // Incomplete redactions to trigger firewall block
      const result = buildSanitizedContext(pageState, detections, [], "task");
      expect(result.ok).toBe(false);

      expect(errorSpy).toHaveBeenCalledWith(
        "[privacy-firewall] blocked: missing redactions for elements",
        [42]
      );
      // Ensure raw label was never logged
      expect(errorSpy.mock.calls[0][1]).toEqual([42]);

      errorSpy.mockRestore();
    });
  });

  // =========================================================================
  // 17. Multi-Field Adversarial Synthetic Canary Boundary
  // =========================================================================
  describe("17. Multi-Field Adversarial Synthetic Canary Boundary", () => {
    it("guarantees all Phase 3 synthetic canaries are excluded from outbound serialization", () => {
      const CANARY_EMAIL_P3 = "CANARY_EMAIL_R3_PHASE3@example.invalid";
      const CANARY_PASSWORD_P3 = "CANARY_PASSWORD_R3_PHASE3";
      const CANARY_PHONE_P3 = "+91 91234 56789";
      const CANARY_PAN_P3 = "R3ABC1234D";
      const CANARY_AADHAAR_P3 = "1234 5678 9012";
      const CANARY_CARD_P3 = "5555 4444 3333 2222";

      document.body.innerHTML = `
        <form>
          <input id="canary-p3-pwd" type="password" value="${CANARY_PASSWORD_P3}" data-privy-id="101" />
          <input id="canary-p3-email" type="email" value="${CANARY_EMAIL_P3}" data-privy-id="102" />
          <input id="canary-p3-phone" type="tel" value="${CANARY_PHONE_P3}" data-privy-id="103" />
          <input id="canary-p3-pan" type="text" value="${CANARY_PAN_P3}" data-privy-id="104" />
          <input id="canary-p3-aadhaar" type="text" value="${CANARY_AADHAAR_P3}" data-privy-id="105" />
          <input id="canary-p3-card" type="text" value="${CANARY_CARD_P3}" data-privy-id="106" />
        </form>
      `;

      const pageState: PageState = {
        taskId: "task-phase3-canary",
        url: `https://secure-portal.isro.gov.in/auth?user=${encodeURIComponent(CANARY_EMAIL_P3)}`,
        title: `ISRO Portal - Login for ${CANARY_EMAIL_P3}`,
        capturedAt: Date.now(),
        elements: [
          { elementId: 101, role: "textbox", label: "Password", tag: "input", inputType: "password" },
          { elementId: 102, role: "textbox", label: "Email Address", tag: "input", inputType: "email" },
          { elementId: 103, role: "textbox", label: "Mobile Phone Number", tag: "input", inputType: "tel" },
          { elementId: 104, role: "textbox", label: "Indian PAN Card Number", tag: "input", inputType: "text" },
          { elementId: 105, role: "textbox", label: "Aadhaar Identity Card", tag: "input", inputType: "text" },
          { elementId: 106, role: "textbox", label: "Card Number", tag: "input", inputType: "text" },
        ],
      };

      const detections = detectTier1(pageState.elements);
      const redactions = redact(detections);
      const firewall = buildSanitizedContext(pageState, detections, redactions, "login and verify credentials");

      expect(firewall.ok).toBe(true);
      if (firewall.ok) {
        const wire = toWireSanitizedContext(firewall.context);
        const wireString = JSON.stringify(wire);

        // Assert 0 raw canaries in wire serialization
        expect(wireString).not.toContain(CANARY_EMAIL_P3);
        expect(wireString).not.toContain(CANARY_PASSWORD_P3);
        expect(wireString).not.toContain(CANARY_PHONE_P3);
        expect(wireString).not.toContain(CANARY_PAN_P3);
        expect(wireString).not.toContain(CANARY_AADHAAR_P3);
        expect(wireString).not.toContain(CANARY_CARD_P3);

        // Assert url_origin stripped query parameter PII
        expect(wire.url_origin).toBe("https://secure-portal.isro.gov.in");

        // Assert page title sanitized
        expect(wire.page).not.toContain(CANARY_EMAIL_P3);
        expect(wire.page).toContain("[EMAIL]");
      }
    });
  });

  // =========================================================================
  // 18. WebCrypto AES-GCM Encrypted Profile Storage (Phase 4)
  // =========================================================================
  describe("18. WebCrypto AES-GCM Encrypted Profile Storage", () => {
    const testProfile: Profile = {
      person_name: "Vikram Sarabhai",
      email: "vikram@isro.gov.in",
      phone: "+91-9876501234",
      address: "ISRO HQ, Antariksh Bhavan, Bengaluru",
      government_id: "GOV-ISRO-001",
      financial: "4111-2222-3333-4444",
    };
    const validPin = "SecretPIN@2026";

    it("encrypts and decrypts profile data with correct PIN using AES-GCM 256", async () => {
      const envelope = await encryptProfile(testProfile, validPin);

      expect(envelope.version).toBe(1);
      expect(envelope.format).toBe("aes-gcm-pbkdf2");
      expect(typeof envelope.salt).toBe("string");
      expect(typeof envelope.iv).toBe("string");
      expect(typeof envelope.ciphertext).toBe("string");

      // Verify envelope does not contain raw plaintext
      const rawJson = JSON.stringify(envelope);
      expect(rawJson).not.toContain("Vikram Sarabhai");
      expect(rawJson).not.toContain("vikram@isro.gov.in");

      // Decrypt with correct PIN
      const decrypted = await decryptProfile(envelope, validPin);
      expect(decrypted).toEqual(testProfile);
    });

    it("fails safely and returns null on wrong PIN", async () => {
      const envelope = await encryptProfile(testProfile, validPin);
      const failedDecryption = await decryptProfile(envelope, "WrongPIN!999");
      expect(failedDecryption).toBeNull();
    });

    it("uses unique cryptographically random salt and IV for repeated encryptions", async () => {
      const enc1 = await encryptProfile(testProfile, validPin);
      const enc2 = await encryptProfile(testProfile, validPin);

      // Salts and IVs must differ across encryptions
      expect(enc1.salt).not.toBe(enc2.salt);
      expect(enc1.iv).not.toBe(enc2.iv);
      expect(enc1.ciphertext).not.toBe(enc2.ciphertext);

      // Both must still decrypt to the identical original profile
      expect(await decryptProfile(enc1, validPin)).toEqual(testProfile);
      expect(await decryptProfile(enc2, validPin)).toEqual(testProfile);
    });

    it("guarantees chrome.storage.local contains zero plaintext canaries when saved with PIN", async () => {
      const CANARY_EMAIL_R4 = "CANARY_EMAIL_R4@example.invalid";
      const CANARY_PHONE_R4 = "CANARY_PHONE_R4_998877";
      const CANARY_GOV_ID_R4 = "CANARY_GOV_ID_R4_PAN123";
      const CANARY_FINANCIAL_R4 = "CANARY_CARD_R4_42424242";

      const canaryProfile: Profile = {
        email: CANARY_EMAIL_R4,
        phone: CANARY_PHONE_R4,
        government_id: CANARY_GOV_ID_R4,
        financial: CANARY_FINANCIAL_R4,
      };

      let storedRaw: unknown = null;
      (globalThis as unknown as { chrome: unknown }).chrome = {
        storage: {
          local: {
            get: vi.fn((_keys: string[], cb: (res: Record<string, unknown>) => void) => {
              cb({ userProfile: storedRaw });
            }),
            set: vi.fn((items: Record<string, unknown>, cb?: () => void) => {
              storedRaw = items["userProfile"];
              if (cb) cb();
            }),
            remove: vi.fn((_keys: string[], cb?: () => void) => {
              storedRaw = null;
              if (cb) cb();
            }),
          },
        },
      };

      await saveProfile(canaryProfile, validPin);

      // Inspect chrome.storage.local raw contents
      expect(storedRaw).not.toBeNull();
      const storageJson = JSON.stringify(storedRaw);

      // Zero plaintext canaries in storage
      expect(storageJson).not.toContain(CANARY_EMAIL_R4);
      expect(storageJson).not.toContain(CANARY_PHONE_R4);
      expect(storageJson).not.toContain(CANARY_GOV_ID_R4);
      expect(storageJson).not.toContain(CANARY_FINANCIAL_R4);

      // Envelope structure is preserved
      expect((storedRaw as EncryptedProfileEnvelope).format).toBe("aes-gcm-pbkdf2");

      // Load with correct PIN restores canaries
      const loaded = await loadProfile(validPin);
      expect(loaded.email).toBe(CANARY_EMAIL_R4);
      expect(loaded.government_id).toBe(CANARY_GOV_ID_R4);
    });

    it("handles corrupted ciphertext, wrong version, or tampered envelope safely", async () => {
      const envelope = await encryptProfile(testProfile, validPin);

      // 1. Corrupted ciphertext
      const corruptedCiphertext: EncryptedProfileEnvelope = {
        ...envelope,
        ciphertext: envelope.ciphertext.slice(0, -10) + "ABCDEFGHIJ",
      };
      expect(await decryptProfile(corruptedCiphertext, validPin)).toBeNull();

      // 2. Corrupted IV
      const corruptedIv: EncryptedProfileEnvelope = {
        ...envelope,
        iv: "invalid-base64-length",
      };
      expect(await decryptProfile(corruptedIv, validPin)).toBeNull();

      // 3. Corrupted version
      const corruptedVersion = {
        ...envelope,
        version: 99 as unknown as 1,
      };
      expect(await decryptProfile(corruptedVersion, validPin)).toBeNull();
    });

    it("manages unlock, lock, and isProfileLocked lifecycle", async () => {
      let storedRaw: unknown = null;
      (globalThis as unknown as { chrome: unknown }).chrome = {
        storage: {
          local: {
            get: vi.fn((_keys: string[], cb: (res: Record<string, unknown>) => void) => {
              cb({ userProfile: storedRaw });
            }),
            set: vi.fn((items: Record<string, unknown>, cb?: () => void) => {
              storedRaw = items["userProfile"];
              if (cb) cb();
            }),
            remove: vi.fn((_keys: string[], cb?: () => void) => {
              storedRaw = null;
              if (cb) cb();
            }),
          },
        },
      };

      // Save encrypted profile
      await saveProfile(testProfile, validPin);
      // Lock profile
      lockProfile();

      expect(await isProfileLocked()).toBe(true);

      // Attempt unlock with wrong PIN
      const unlockFailed = await unlockProfile("WrongPIN!");
      expect(unlockFailed).toBe(false);
      expect(await isProfileLocked()).toBe(true);

      // Unlock with correct PIN
      const unlockSuccess = await unlockProfile(validPin);
      expect(unlockSuccess).toBe(true);
      expect(await isProfileLocked()).toBe(false);

      // Hot-path token resolution works when unlocked
      const resolved = await resolveFromProfile("[EMAIL_01]");
      expect(resolved).toBe("vikram@isro.gov.in");

      // Lock again
      lockProfile();
      expect(await isProfileLocked()).toBe(true);
      const lockedResolution = await resolveFromProfile("[EMAIL_01]");
      expect(lockedResolution).toBeNull();
    });
  });

  // =========================================================================
  // 19. Dynamic Visual Redaction Lifecycle & Dynamic DOM Hardening (Phase 5)
  // =========================================================================
  describe("19. Dynamic Visual Redaction Lifecycle & Dynamic DOM Hardening", () => {
    beforeEach(() => {
      destroyVisualRedactionObservers();
      document.body.innerHTML = "";
    });

    it("observes, tracks, and unobserves image targets dynamically", () => {
      const container = document.createElement("div");
      container.style.position = "relative";
      document.body.appendChild(container);

      const img = document.createElement("img");
      img.id = "avatar-img";
      Object.defineProperty(img, "naturalWidth", { value: 200, configurable: true });
      Object.defineProperty(img, "naturalHeight", { value: 200, configurable: true });
      img.getBoundingClientRect = () => ({
        width: 100,
        height: 100,
        top: 0,
        left: 0,
        right: 100,
        bottom: 100,
        x: 0,
        y: 0,
        toJSON: () => {},
      });
      container.appendChild(img);

      expect(getTrackedTargetCount()).toBe(0);

      const faceBoxes = [{ x1: 20, y1: 20, x2: 80, y2: 80, score: 0.95 }];
      observeImageTarget(img, faceBoxes);

      expect(getTrackedTargetCount()).toBe(1);
      const overlay = container.querySelector('[data-privyvision-overlay="face-redaction"]');
      expect(overlay).not.toBeNull();

      unobserveImageTarget(img);
      expect(getTrackedTargetCount()).toBe(0);
      const overlayAfterUnobserve = container.querySelector('[data-privyvision-overlay="face-redaction"]');
      expect(overlayAfterUnobserve).toBeNull();
    });

    it("cleans up all observers and overlays completely upon destruction", () => {
      const container = document.createElement("div");
      document.body.appendChild(container);

      const img1 = document.createElement("img");
      img1.id = "img1";
      Object.defineProperty(img1, "naturalWidth", { value: 100, configurable: true });
      Object.defineProperty(img1, "naturalHeight", { value: 100, configurable: true });
      container.appendChild(img1);

      const img2 = document.createElement("img");
      img2.id = "img2";
      Object.defineProperty(img2, "naturalWidth", { value: 100, configurable: true });
      Object.defineProperty(img2, "naturalHeight", { value: 100, configurable: true });
      container.appendChild(img2);

      observeImageTarget(img1, [{ x1: 10, y1: 10, x2: 50, y2: 50, score: 0.9 }]);
      observeImageTarget(img2, [{ x1: 20, y1: 20, x2: 60, y2: 60, score: 0.9 }]);

      expect(getTrackedTargetCount()).toBe(2);
      expect(document.querySelectorAll('[data-privyvision-overlay="face-redaction"]').length).toBe(2);

      destroyVisualRedactionObservers();

      expect(getTrackedTargetCount()).toBe(0);
      expect(document.querySelectorAll('[data-privyvision-overlay="face-redaction"]').length).toBe(0);
    });

    it("coalesces repeated layout re-computations without creating duplicate overlays", () => {
      const container = document.createElement("div");
      container.style.position = "relative";
      document.body.appendChild(container);

      const img = document.createElement("img");
      img.id = "coalesce-target";
      Object.defineProperty(img, "naturalWidth", { value: 400, configurable: true });
      Object.defineProperty(img, "naturalHeight", { value: 400, configurable: true });
      img.getBoundingClientRect = () => ({
        width: 200,
        height: 200,
        top: 0,
        left: 0,
        right: 200,
        bottom: 200,
        x: 0,
        y: 0,
        toJSON: () => {},
      });
      container.appendChild(img);

      const boxes = [{ x1: 50, y1: 50, x2: 150, y2: 150, score: 0.98 }];

      // Simulate 50 rapid re-render / layout cycles
      for (let i = 0; i < 50; i++) {
        overlayFaceBoxes(img, boxes);
      }

      // Must strictly contain exactly 1 overlay container
      const overlays = container.querySelectorAll(
        `[data-privyvision-overlay="face-redaction"][data-target-id="coalesce-target"]`
      );
      expect(overlays.length).toBe(1);
    });

    it("protects dynamically inserted sensitive elements before outbound serialization", () => {
      const initialElements: CapturedElement[] = [
        { elementId: 1, role: "button", label: "Search", tag: "button", inputType: "" },
      ];

      const pageState: PageState = {
        taskId: "task-phase5-dynamic",
        url: "https://portal.isro.gov.in/dashboard",
        title: "ISRO Mission Dashboard",
        capturedAt: Date.now(),
        elements: initialElements,
      };

      // Initial scan
      const det1 = detectTier1(pageState.elements);
      const red1 = redact(det1);
      const fw1 = buildSanitizedContext(pageState, det1, red1, "search mission");
      expect(fw1.ok).toBe(true);

      // Dynamically insert sensitive government ID input
      const dynamicGovId: CapturedElement = {
        elementId: 2,
        role: "textbox",
        label: "Enter Aadhaar Number for Clearance",
        tag: "input",
        inputType: "text",
      };
      pageState.elements.push(dynamicGovId);

      // Re-scan dynamic DOM state
      const det2 = detectTier1(pageState.elements);
      expect(det2.length).toBe(1);
      expect(det2[0].category).toBe("government_id");

      const red2 = redact(det2);
      const fw2 = buildSanitizedContext(pageState, det2, red2, "submit clearance");
      expect(fw2.ok).toBe(true);

      if (fw2.ok) {
        const wire = toWireSanitizedContext(fw2.context);
        const wireStr = JSON.stringify(wire);
        expect(wireStr).not.toContain("Aadhaar Number");
        expect(wireStr).toContain("[GOVERNMENT_ID_01]");
      }
    });

    it("safely isolates dynamically replaced DOM nodes without stale token bleed", () => {
      // Step 1: Initial sensitive element
      const element1: CapturedElement = {
        elementId: 10,
        role: "textbox",
        label: "Contact Email",
        tag: "input",
        inputType: "email",
      };
      const det1 = detectTier1([element1]);
      const red1 = redact(det1);
      expect(red1[0].token).toBe("[EMAIL_01]");

      // Step 2: DOM node replaced with safe element with new ID
      const replacementElement: CapturedElement = {
        elementId: 11,
        role: "textbox",
        label: "Mission Code",
        tag: "input",
        inputType: "text",
      };

      const det2 = detectTier1([replacementElement]);
      expect(det2.length).toBe(0); // Safe element -> no detection

      const red2 = redact(det2);
      expect(red2.length).toBe(0); // Zero redactions
    });
  });

  // =========================================================================
  // 20. Phase 6 Final Hardening, Multi-Canary Boundary & Freeze Verification
  // =========================================================================
  describe("20. Phase 6 Final Hardening, Multi-Canary Boundary & Freeze Verification", () => {
    it("guarantees 100% canary elimination across end-to-end multi-category workflow", async () => {
      const CANARY_EMAIL_R6 = "CANARY_EMAIL_R6_vikram@isro.gov.in";
      const CANARY_PASSWORD_R6 = "CANARY_PASSWORD_R6_TopSecret#2026";
      const CANARY_PHONE_R6 = "+91-9988776655";
      const CANARY_PAN_R6 = "CANARY_PAN_R6ABCDE1234F";
      const CANARY_AADHAAR_R6 = "CANARY_AADHAAR_R6123412341234";
      const CANARY_CARD_R6 = "CANARY_CARD_R64242424242424242";
      const CANARY_GOV_ID_R6 = "CANARY_GOV_ID_R6_ISRO_999";
      const CANARY_NAME_R6 = "CANARY_PERSON_Dr. APJ Abdul Kalam";
      const CANARY_ADDRESS_R6 = "CANARY_ADDR_Antariksh Bhavan, Bengaluru, 560094";

      const pageState: PageState = {
        taskId: "task-phase6-canary-freeze",
        url: `https://secure.isro.gov.in/launch-control?operator_email=${encodeURIComponent(CANARY_EMAIL_R6)}&token=secret123`,
        title: `ISRO Launch Clearance - Commander Dashboard (${CANARY_EMAIL_R6})`,
        capturedAt: Date.now(),
        elements: [
          { elementId: 201, role: "textbox", label: "Operator Password", tag: "input", inputType: "password" },
          { elementId: 202, role: "textbox", label: "Official Email Address", tag: "input", inputType: "email" },
          { elementId: 203, role: "textbox", label: "Duty Phone Number", tag: "input", inputType: "tel" },
          { elementId: 204, role: "textbox", label: "Permanent Account Number (PAN)", tag: "input", inputType: "text" },
          { elementId: 205, role: "textbox", label: "Aadhaar Identity Card", tag: "input", inputType: "text" },
          { elementId: 206, role: "textbox", label: "Payment Card Details", tag: "input", inputType: "text" },
          { elementId: 207, role: "textbox", label: "Government ID / Badge Number", tag: "input", inputType: "text" },
          { elementId: 208, role: "textbox", label: "Full Name of Commander", tag: "input", inputType: "text" },
          { elementId: 209, role: "textbox", label: "Postal Billing Address", tag: "input", inputType: "text" },
        ],
      };

      // 1. DOM Detection
      const detections = detectTier1(pageState.elements);
      expect(detections.length).toBe(9);

      // 2. Redaction
      const redactions = redact(detections);
      expect(redactions.length).toBe(9);

      // 3. Validation
      const coverage = validateRedactionCoverage(detections, redactions);
      expect(coverage.ok).toBe(true);

      // 4. Build Sanitized Context
      const firewall = buildSanitizedContext(pageState, detections, redactions, "authorize mission launch");
      expect(firewall.ok).toBe(true);

      if (firewall.ok) {
        // 5. Wire Serialization
        const wire = toWireSanitizedContext(firewall.context);
        const wireString = JSON.stringify(wire);

        // Assert 0 raw canaries in wire payload
        expect(wireString).not.toContain(CANARY_EMAIL_R6);
        expect(wireString).not.toContain(CANARY_PASSWORD_R6);
        expect(wireString).not.toContain(CANARY_PHONE_R6);
        expect(wireString).not.toContain(CANARY_PAN_R6);
        expect(wireString).not.toContain(CANARY_AADHAAR_R6);
        expect(wireString).not.toContain(CANARY_CARD_R6);
        expect(wireString).not.toContain(CANARY_GOV_ID_R6);
        expect(wireString).not.toContain(CANARY_NAME_R6);
        expect(wireString).not.toContain(CANARY_ADDRESS_R6);

        // Assert URL query parameter PII is stripped down to pure origin
        expect(wire.url_origin).toBe("https://secure.isro.gov.in");

        // Assert document title is fully sanitized
        expect(wire.page).not.toContain(CANARY_EMAIL_R6);
        expect(wire.page).toContain("[EMAIL]");
      }
    });

    it("verifies deterministic token numbering stability across 50 repeated cycles", () => {
      const elements: CapturedElement[] = [
        { elementId: 1, role: "textbox", label: "Email", tag: "input", inputType: "email" },
        { elementId: 2, role: "textbox", label: "Password", tag: "input", inputType: "password" },
        { elementId: 3, role: "textbox", label: "Phone", tag: "input", inputType: "tel" },
      ];

      for (let cycle = 0; cycle < 50; cycle++) {
        const detections = detectTier1(elements);
        const redactions = redact(detections);
        expect(redactions[0].token).toBe("[EMAIL_01]");
        expect(redactions[1].token).toBe("[PASSWORD_01]");
        expect(redactions[2].token).toBe("[PHONE_01]");
      }
    });
  });
});

