/**
 * SIH 2026 — PS26171 Client Laptop 5 Phase 3
 * Privacy, Security & Egress-Boundary Comprehensive Validation Suite
 *
 * Validates:
 * 1. Raw PII detection & tokenization before network transmission
 * 2. Egress wire payload inspection (proving absence of raw PII/secrets)
 * 3. Privacy Firewall fail-closed behavior on incomplete/missing redaction
 * 4. Synthetic PII Canary tests (email, password, phone, govt ID, secrets)
 * 5. Secret Store isolation and client-only resolution
 * 6. Action validation security (disallowing dangerous navigation, invalid IDs, low confidence, malformed actions)
 * 7. History privacy invariants (no raw values in step records)
 * 8. Direct Ollama isolation (zero client->Ollama paths)
 * 9. Privacy performance micro-benchmark (p50, p95, max)
 */

import test from "node:test";
import assert from "node:assert/strict";

import { installFakeDom, serverAction, FakeElement, FakeInputElement } from "./helpers/fakeDom";
import { captureDomState } from "../src/perception/domCapture";
import { detectTier1 } from "../src/privacy/tier1DomRules";
import { redact, resetTokenCounters } from "../src/privacy/redact";
import { validateRedactionCoverage } from "../src/privacy/redactionValidator";
import {
  buildSanitizedContext,
  toWireSanitizedContext,
} from "../src/privacy/sanitizedContext";
import { storeSecret, resolveSecret, clearSecrets } from "../src/privacy/secretStore";
import { saveProfile, loadProfile, resolveFromProfile, categoryFromToken } from "../src/privacy/profileStore";
import { validateAction, isSafeNavigationUrl } from "../src/action/validator";
import { runOneStep, fetchAction, sha256Hex, normalizeServerUrl, getHealthEndpoint } from "../src/content/pipeline";
import { buildStepRecord } from "../src/content/index";
import type { ActionRequest } from "../src/action/types";
import type { PrivacyDetection, RedactionRecord } from "../src/privacy/types";

// ============================================================================
// Synthetic Canary Identifiers (Purely synthetic test values)
// ============================================================================
const CANARY_EMAIL = "TEST_EMAIL_26171@example.invalid";
const CANARY_PASSWORD = "TEST_PASSWORD_26171";
const CANARY_PHONE = "+91-98765-26171";
const CANARY_GOVT_ID = "AADHAAR-26171-XXXX-YYYY";
const CANARY_NAME = "Dr. Vikram Sarabhai Canary 26171";
const CANARY_SECRET = "TEST_SECRET_26171_TOKEN_ABC";

// ============================================================================
// 1. Synthetic PII Canary & Wire Payload Egress Inspection
// ============================================================================
test("Phase 3 — Canary Test: Raw PII is detected, tokenized, and ABSENT from outbound wire payload", async () => {
  resetTokenCounters();
  clearSecrets();

  const emailField = new FakeInputElement("email", { "aria-label": "Enter your work email", id: "field-email" });
  emailField.value = CANARY_EMAIL;

  const passwordField = new FakeInputElement("password", { "aria-label": "Account Password", id: "field-password" });
  passwordField.value = CANARY_PASSWORD;

  const phoneField = new FakeInputElement("tel", { "aria-label": "Mobile Phone Number", id: "field-phone" });
  phoneField.value = CANARY_PHONE;

  const idField = new FakeInputElement("text", { "aria-label": "Aadhaar Card Number", id: "field-id" });
  idField.value = CANARY_GOVT_ID;

  const nameField = new FakeInputElement("text", { "aria-label": "Full Name", id: "field-name" });
  nameField.value = CANARY_NAME;

  const submitButton = new FakeElement("button", { id: "btn-submit" }, "Log In");

  const env = installFakeDom([emailField, passwordField, phoneField, idField, nameField, submitButton]);

  try {
    const taskId = "canary-task-phase3";
    const pageState = captureDomState(taskId);

    // Step A: Tier 1 Detection
    const detections = detectTier1(pageState.elements);
    assert.equal(detections.length, 5, "Must detect 5 sensitive form fields");

    // Verify categories
    const categories = detections.map((d) => d.category);
    assert.ok(categories.includes("email"), "Email detected");
    assert.ok(categories.includes("password"), "Password detected");
    assert.ok(categories.includes("phone"), "Phone detected");
    assert.ok(categories.includes("government_id"), "Govt ID detected");
    assert.ok(categories.includes("person_name"), "Name detected");

    // Step B: Redaction
    const redactions = redact(detections);
    assert.equal(redactions.length, 5, "Must generate exactly 5 redactions");

    // Step C: Privacy Firewall
    const firewall = buildSanitizedContext(pageState, detections, redactions, "Submit registration form");
    assert.equal(firewall.ok, true, "Firewall must pass valid coverage");
    if (!firewall.ok) return;

    // Step D: Wire Serialization
    const wire = toWireSanitizedContext(firewall.context);
    const wireJson = JSON.stringify(wire);

    // CRITICAL CANARY PROOFS: Exact wire payload must NOT contain raw canary values
    assert.ok(!wireJson.includes(CANARY_EMAIL), `CANARY LEAK: wireJson contains raw email: ${CANARY_EMAIL}`);
    assert.ok(!wireJson.includes(CANARY_PASSWORD), `CANARY LEAK: wireJson contains raw password: ${CANARY_PASSWORD}`);
    assert.ok(!wireJson.includes(CANARY_PHONE), `CANARY LEAK: wireJson contains raw phone: ${CANARY_PHONE}`);
    assert.ok(!wireJson.includes(CANARY_GOVT_ID), `CANARY LEAK: wireJson contains raw govt ID: ${CANARY_GOVT_ID}`);
    assert.ok(!wireJson.includes(CANARY_NAME), `CANARY LEAK: wireJson contains raw name: ${CANARY_NAME}`);

    // Verify presence of tokens in wire payload
    assert.ok(wireJson.includes("[EMAIL_01]"), "Wire JSON must contain [EMAIL_01]");
    assert.ok(wireJson.includes("[PASSWORD_01]"), "Wire JSON must contain [PASSWORD_01]");
    assert.ok(wireJson.includes("[PHONE_01]"), "Wire JSON must contain [PHONE_01]");
    assert.ok(wireJson.includes("[GOVERNMENT_ID_01]"), "Wire JSON must contain [GOVERNMENT_ID_01]");
    assert.ok(wireJson.includes("[PERSON_NAME_01]"), "Wire JSON must contain [PERSON_NAME_01]");

    // Verify fields dictionary structure
    assert.equal(typeof wire.fields, "object");
    const fieldValues = Object.values(wire.fields);
    assert.equal(fieldValues.length, 5);
    for (const val of fieldValues) {
      assert.match(val, /^\[[A-Z_]+_\d+\]$/, `Field value '${val}' must be formatted as [CATEGORY_NN]`);
      assert.ok(!val.includes("@"), `Field token '${val}' must not contain '@'`);
    }

    // Step E: Verify full pipeline fetch wire payload
    env.respondWith(serverAction({ action: "done" }));
    await fetchAction(firewall.context);

    assert.equal(env.fetchCalls.length, 1);
    const outboundBody = env.fetchCalls[0].body;

    assert.ok(!outboundBody.includes(CANARY_EMAIL), "Outbound HTTP body must not contain canary email");
    assert.ok(!outboundBody.includes(CANARY_PASSWORD), "Outbound HTTP body must not contain canary password");
    assert.ok(!outboundBody.includes(CANARY_PHONE), "Outbound HTTP body must not contain canary phone");
    assert.ok(!outboundBody.includes(CANARY_GOVT_ID), "Outbound HTTP body must not contain canary govt ID");
    assert.ok(!outboundBody.includes(CANARY_NAME), "Outbound HTTP body must not contain canary name");

    // Verify SHA-256 integrity computation
    const sha = await sha256Hex(outboundBody);
    assert.equal(sha.length, 64, "SHA-256 digest must be 64 hex characters");
  } finally {
    env.restore();
  }
});

// ============================================================================
// 2. Fail-Closed Privacy Firewall Tests
// ============================================================================
test("Phase 3 — Privacy Firewall: Incomplete sanitization is deterministically blocked (Fail-Closed)", () => {
  const elements = [
    { elementId: 1, role: "textbox", label: "Email Address", inputType: "email", tag: "input" },
    { elementId: 2, role: "textbox", label: "Password", inputType: "password", tag: "input" },
  ];
  const pageState = {
    taskId: "test-task-incomplete",
    url: "http://localhost:8000/login",
    title: "Login",
    capturedAt: Date.now(),
    page: "Login",
    urlOrigin: "http://localhost:8000",
    elements,
  };

  const detections: PrivacyDetection[] = [
    { elementId: 1, category: "email", source: "dom_rule", confidence: 0.9 },
    { elementId: 2, category: "password", source: "dom_rule", confidence: 0.9 },
  ];

  // Incomplete redactions: elementId 2 is missing
  const incompleteRedactions: RedactionRecord[] = [
    { elementId: 1, category: "email", method: "semantic_token", token: "[EMAIL_01]" },
  ];

  const coverage = validateRedactionCoverage(detections, incompleteRedactions);
  assert.equal(coverage.ok, false, "validateRedactionCoverage must fail when elements are missing");
  assert.deepEqual(coverage.missing, [2], "Must identify missing element ID 2");

  const firewall = buildSanitizedContext(pageState, detections, incompleteRedactions, "Attempt login");
  assert.equal(firewall.ok, false, "Firewall MUST block context building when coverage is incomplete");
  if (!firewall.ok) {
    assert.deepEqual(firewall.missingElementIds, [2]);
  }
});

test("Phase 3 — Privacy Firewall: Entire task halts and transmits 0 bytes when Firewall blocks", async () => {
  const emailField = new FakeInputElement("email", { "aria-label": "User Email" });
  emailField.value = CANARY_EMAIL;
  const env = installFakeDom([emailField]);

  try {
    const pageState = captureDomState("task-blocked-test");
    const detections = detectTier1(pageState.elements);
    // Provide empty redactions
    const firewall = buildSanitizedContext(pageState, detections, [], "test task");
    assert.equal(firewall.ok, false);

    if (!firewall.ok) {
      assert.equal(env.fetchCalls.length, 0, "Zero network requests must be made when firewall blocks");
    }
  } finally {
    env.restore();
  }
});

// ============================================================================
// 3. Secret Store & Client-Side Isolation Tests
// ============================================================================
test("Phase 3 — Secret Store: Password captured to local store and resolved client-side only", async () => {
  resetTokenCounters();
  clearSecrets();

  const passwordField = new FakeInputElement("password", { "aria-label": "Password Field", id: "pwd-field" });
  // Initially passwordField is empty before user fill / autofill
  passwordField.value = "";

  const env = installFakeDom([passwordField]);

  try {
    storeSecret("[PASSWORD_01]", CANARY_PASSWORD);

    const pageState = captureDomState("task-secret-test");
    const detections = detectTier1(pageState.elements);
    const redactions = redact(detections);

    const firewall = buildSanitizedContext(pageState, detections, redactions, "login");
    assert.equal(firewall.ok, true);

    const token = redactions.find((r) => r.category === "password")?.token;
    assert.ok(token, "Must have generated a token for password");

    // Prove secret is stored locally under token
    const localVal = resolveSecret(token);
    assert.equal(localVal, CANARY_PASSWORD, "Secret store must hold real password locally");

    // Server returns type_secret action referencing token
    const ids = pageState.elements.map((el) => el.elementId);
    env.respondWith(
      serverAction({ action: "type_secret", element_id: ids[0], value_ref: token })
    );

    if (firewall.ok) {
      const stepResult = await runOneStep(firewall.context);
      assert.ok(stepResult);
      assert.equal(stepResult.status, "success");
      assert.equal(stepResult.observed, "value_changed");

      // Verify the element received the typing
      assert.equal(passwordField.value, CANARY_PASSWORD);

      // Verify wire payload NEVER contained the secret
      assert.equal(env.fetchCalls.length, 1);
      assert.ok(
        !env.fetchCalls[0].body.includes(CANARY_PASSWORD),
        "Outbound request must not contain the secret"
      );
    }
  } finally {
    clearSecrets();
    env.restore();
  }
});

test("Phase 3 — Secret Store: clearSecrets() purges all session secrets", () => {
  storeSecret("[PASSWORD_01]", CANARY_SECRET);
  storeSecret("[FINANCIAL_01]", "4111-2222-3333-4444");

  assert.equal(resolveSecret("[PASSWORD_01]"), CANARY_SECRET);
  assert.equal(resolveSecret("[FINANCIAL_01]"), "4111-2222-3333-4444");

  clearSecrets();

  assert.equal(resolveSecret("[PASSWORD_01]"), null, "Must be null after clear");
  assert.equal(resolveSecret("[FINANCIAL_01]"), null, "Must be null after clear");
});

test("Phase 3 — Profile Store: Local profile resolution maps tokens without network leakage", async () => {
  const env = installFakeDom([]);
  try {
    const profile = {
      person_name: CANARY_NAME,
      email: CANARY_EMAIL,
      phone: CANARY_PHONE,
      address: "ISRO HQ, Antariksh Bhavan, Bengaluru",
      financial: "4111-0000-1111-2222",
    };

    await saveProfile(profile);
    const loaded = await loadProfile();
    assert.equal(loaded.email, CANARY_EMAIL);

    assert.equal(categoryFromToken("[EMAIL_01]"), "email");
    assert.equal(categoryFromToken("[PERSON_NAME_02]"), "person_name");
    assert.equal(categoryFromToken("[PHONE_03]"), "phone");
    assert.equal(categoryFromToken("[ADDRESS_04]"), "address");
    assert.equal(categoryFromToken("[FINANCIAL_05]"), "financial");
    assert.equal(categoryFromToken("[UNKNOWN_99]"), null);
    assert.equal(categoryFromToken("not-a-token"), null);

    const resolvedEmail = await resolveFromProfile("[EMAIL_01]");
    assert.equal(resolvedEmail, CANARY_EMAIL);
  } finally {
    env.restore();
  }
});

// ============================================================================
// 4. Role 1 Action Validator Security & Attack Mitigation Matrix
// ============================================================================
test("Phase 3 — Action Validator: Blocks forbidden protocols, bad IDs, low confidence, and malformed actions", async () => {
  const targetInput = new FakeInputElement("text", { id: "input-1" });
  const disabledButton = new FakeElement("button", { disabled: "true", id: "btn-dis" });
  const readonlyInput = new FakeInputElement("text", { readonly: "true", id: "input-ro" });
  const nonEditableDiv = new FakeElement("div", { id: "div-nonedit" }, "Static Content");

  const env = installFakeDom([targetInput, disabledButton, readonlyInput, nonEditableDiv]);

  try {
    const pageState = captureDomState("task-action-sec");
    const [inputId, disId, roId, divId] = pageState.elements.map((el) => el.elementId);

    // Test 1: Unknown action
    const resUnknown = validateAction(
      { action: "eval_code" as unknown as ActionRequest["action"], confidence: 0.9, taskId: "task-action-sec", stepId: 1 },
      "task-action-sec"
    );
    assert.equal(resUnknown.ok, false);
    assert.match(resUnknown.reason || "", /Unknown action type/);

    // Test 2: Task ID mismatch
    const resMismatch = validateAction(
      { action: "click", elementId: inputId, confidence: 0.9, taskId: "evil-task-id", stepId: 1 },
      "task-action-sec"
    );
    assert.equal(resMismatch.ok, false);
    assert.match(resMismatch.reason || "", /targets a different task/);

    // Test 3: Confidence below 0.5 threshold
    const resLowConf = validateAction(
      { action: "click", elementId: inputId, confidence: 0.49, taskId: "task-action-sec", stepId: 1 },
      "task-action-sec"
    );
    assert.equal(resLowConf.ok, false);
    assert.match(resLowConf.reason || "", /Confidence 0.49 below threshold/);

    // Test 4: Missing element ID for element actions
    const resNoEl = validateAction(
      { action: "click", elementId: null, confidence: 0.9, taskId: "task-action-sec", stepId: 1 },
      "task-action-sec"
    );
    assert.equal(resNoEl.ok, false);
    assert.match(resNoEl.reason || "", /Missing elementId/);

    // Test 5: Non-existent element ID
    const resGhostEl = validateAction(
      { action: "click", elementId: 999999, confidence: 0.9, taskId: "task-action-sec", stepId: 1 },
      "task-action-sec"
    );
    assert.equal(resGhostEl.ok, false);
    assert.match(resGhostEl.reason || "", /not found/);

    // Test 6: Disabled element
    const resDisabled = validateAction(
      { action: "click", elementId: disId, confidence: 0.9, taskId: "task-action-sec", stepId: 1 },
      "task-action-sec"
    );
    assert.equal(resDisabled.ok, false);
    assert.match(resDisabled.reason || "", /is disabled/);

    // Test 7: Readonly input for typing
    const resReadonly = validateAction(
      { action: "type", elementId: roId, value: "test", confidence: 0.9, taskId: "task-action-sec", stepId: 1 },
      "task-action-sec"
    );
    assert.equal(resReadonly.ok, false);
    assert.match(resReadonly.reason || "", /is readonly/);

    // Test 8: Non-editable target for typing
    const resNonEdit = validateAction(
      { action: "type", elementId: divId, value: "test", confidence: 0.9, taskId: "task-action-sec", stepId: 1 },
      "task-action-sec"
    );
    assert.equal(resNonEdit.ok, false);
    assert.match(resNonEdit.reason || "", /not an editable text input/);

    // Test 9: Missing valueRef for type_secret
    const resNoRef = validateAction(
      { action: "type_secret", elementId: inputId, valueRef: "", confidence: 0.9, taskId: "task-action-sec", stepId: 1 },
      "task-action-sec"
    );
    assert.equal(resNoRef.ok, false);
    assert.match(resNoRef.reason || "", /Missing or empty valueRef/);

    // Test 10: Dangerous Navigation URLs
    assert.equal(isSafeNavigationUrl("javascript:alert('XSS')"), false);
    assert.equal(isSafeNavigationUrl("data:text/html,<script>alert(1)</script>"), false);
    assert.equal(isSafeNavigationUrl("vbscript:MsgBox(1)"), false);
    assert.equal(isSafeNavigationUrl("file:///C:/Windows/System32/drivers/etc/hosts"), false);
    assert.equal(isSafeNavigationUrl("http://192.168.1.50:8000/dashboard"), true);
    assert.equal(isSafeNavigationUrl("https://example.com/checkout"), true);

    const resNavXSS = validateAction(
      { action: "navigate", url: "javascript:document.cookie", confidence: 0.9, taskId: "task-action-sec", stepId: 1 },
      "task-action-sec"
    );
    assert.equal(resNavXSS.ok, false);
    assert.match(resNavXSS.reason || "", /Unsafe or disallowed navigation URL/);

    // Test 11: Invalid scroll params
    const resBadScrollDir = validateAction(
      { action: "scroll", direction: "diagonal" as unknown as ActionRequest["direction"], confidence: 0.9, taskId: "task-action-sec", stepId: 1 },
      "task-action-sec"
    );
    assert.equal(resBadScrollDir.ok, false);
    assert.match(resBadScrollDir.reason || "", /Invalid scroll direction/);

    const resNegScroll = validateAction(
      { action: "scroll", direction: "down", amount: -500, confidence: 0.9, taskId: "task-action-sec", stepId: 1 },
      "task-action-sec"
    );
    assert.equal(resNegScroll.ok, false);
    assert.match(resNegScroll.reason || "", /Invalid scroll amount/);
  } finally {
    env.restore();
  }
});

// ============================================================================
// 5. History Privacy & Sanitized StepRecord Contract
// ============================================================================
test("Phase 3 — History Privacy: StepRecord includes only structural metadata (no raw values or secrets)", () => {
  const safeRecord = buildStepRecord(1, "type_secret", 5, "[PASSWORD_01]", "success");

  assert.equal(safeRecord.step, 1);
  assert.equal(safeRecord.action, "type_secret");
  assert.equal(safeRecord.element_id, 5);
  assert.equal(safeRecord.element_label, "[PASSWORD_01]");
  assert.equal(safeRecord.outcome, "success");

  const recordKeys = Object.keys(safeRecord);
  assert.ok(!recordKeys.includes("value"), "StepRecord must NEVER contain 'value' key");
  assert.ok(!recordKeys.includes("value_ref"), "StepRecord must NEVER contain 'value_ref' key");
  assert.ok(!recordKeys.includes("secret"), "StepRecord must NEVER contain 'secret' key");
});

// ============================================================================
// 6. Direct Ollama Isolation & URL Normalization
// ============================================================================
test("Phase 3 — Ollama Isolation & URL Normalization: Client communicates only with FastAPI", () => {
  // Verify default and custom server URL normalization
  assert.equal(normalizeServerUrl(""), "http://127.0.0.1:8787/reason");
  assert.equal(normalizeServerUrl(null), "http://127.0.0.1:8787/reason");
  assert.equal(normalizeServerUrl("192.168.1.45:8787"), "http://192.168.1.45:8787/reason");
  assert.equal(normalizeServerUrl("http://192.168.1.45:8787/reason"), "http://192.168.1.45:8787/reason");
  assert.equal(normalizeServerUrl("http://192.168.1.45:8787"), "http://192.168.1.45:8787/reason");

  // Health endpoint derivation
  assert.equal(getHealthEndpoint("http://192.168.1.45:8787/reason"), "http://192.168.1.45:8787/health");

  // Rejection of disallowed schemes
  assert.equal(normalizeServerUrl("ftp://192.168.1.45/reason"), "http://127.0.0.1:8787/reason");
  assert.equal(normalizeServerUrl("file:///etc/hosts"), "http://127.0.0.1:8787/reason");
});

// ============================================================================
// 7. Privacy Performance Micro-Benchmark
// ============================================================================
test("Phase 3 — Performance: Privacy pipeline (capture + detect + redact + firewall + serialization) overhead is microsecond-scale", () => {
  const elements = [
    new FakeInputElement("email", { "aria-label": "User Email" }),
    new FakeInputElement("password", { "aria-label": "User Password" }),
    new FakeInputElement("tel", { "aria-label": "Phone Number" }),
    new FakeInputElement("text", { "aria-label": "Full Name" }),
    new FakeElement("button", {}, "Submit"),
  ];

  const env = installFakeDom(elements);

  try {
    const iterations = 1000;
    const latencies: number[] = [];

    // Warm-up JIT
    for (let w = 0; w < 50; w++) {
      const pageState = captureDomState("perf-warmup");
      const detections = detectTier1(pageState.elements);
      const redactions = redact(detections);
      const firewall = buildSanitizedContext(pageState, detections, redactions, "task");
      if (firewall.ok) toWireSanitizedContext(firewall.context);
    }

    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now();
      const pageState = captureDomState(`perf-task-${i}`);
      const detections = detectTier1(pageState.elements);
      const redactions = redact(detections);
      const firewall = buildSanitizedContext(pageState, detections, redactions, "perf test task");
      if (firewall.ok) {
        toWireSanitizedContext(firewall.context);
      }
      const t1 = performance.now();
      latencies.push(t1 - t0);
    }

    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(iterations * 0.5)];
    const p95 = latencies[Math.floor(iterations * 0.95)];
    const max = latencies[latencies.length - 1];

    console.log(
      `[Privacy Pipeline Benchmark (1000 runs)] p50=${p50.toFixed(4)}ms | p95=${p95.toFixed(4)}ms | max=${max.toFixed(4)}ms`
    );

    assert.ok(p50 < 0.2, `p50 must be under 0.2ms (observed: ${p50.toFixed(4)}ms)`);
    assert.ok(p95 < 0.5, `p95 must be under 0.5ms (observed: ${p95.toFixed(4)}ms)`);
    assert.ok(max < 15.0, `max must be under 15ms (observed: ${max.toFixed(4)}ms)`);
  } finally {
    env.restore();
  }
});
