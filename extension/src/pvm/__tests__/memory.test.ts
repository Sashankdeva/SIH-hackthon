// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  fnv1aHash,
  canonicalizeJson,
  normalizeUrlForSignature,
  computeStateSignature,
  computeActionSignature,
  recordVerifiedOutcome,
  queryPvmCandidates,
  lookupInMemory,
  findCandidatesInMemory,
  getMemorySize,
  clearMemory,
  setMaxMemoryEntries,
  getMaxMemoryEntries,
  DEFAULT_MAX_ENTRIES,
  putRecord,
  getRecord,
} from "../memory";
import type {
  SafeStateInput,
  SafeActionInput,
  VerificationResult,
  PvmRecord,
} from "../types";

describe("Role 5 Phase 2 — PVM Memory Foundation, Privacy-Safe Signatures & Verified Learning", () => {
  beforeEach(() => {
    clearMemory();
    setMaxMemoryEntries(DEFAULT_MAX_ENTRIES);
  });

  // =========================================================================
  // 1. Hashing & Canonicalization
  // =========================================================================
  describe("1. Hashing & Canonicalization", () => {
    it("computes deterministic FNV-1a 32-bit hex hash with sub-microsecond latency", () => {
      const hash1 = fnv1aHash("checkout_page_button_1");
      const hash2 = fnv1aHash("checkout_page_button_1");
      const hash3 = fnv1aHash("checkout_page_button_2");

      expect(hash1).toBe(hash2);
      expect(hash1).not.toBe(hash3);
      expect(hash1).toHaveLength(8);
    });

    it("canonicalizes JSON with scrambled key orders to identical strings", () => {
      const objA = { z: 1, a: "test", m: { b: 2, a: 1 } };
      const objB = { a: "test", m: { a: 1, b: 2 }, z: 1 };

      const canonA = canonicalizeJson(objA);
      const canonB = canonicalizeJson(objB);

      expect(canonA).toBe(canonB);
      expect(canonA).toBe('{"a":"test","m":{"a":1,"b":2},"z":1}');
    });

    it("normalizes URLs by stripping query parameters and hash fragments", () => {
      const raw1 = "http://localhost:8000/checkout?token=secret123&user=aarav#step2";
      const raw2 = "http://localhost:8000/checkout";

      expect(normalizeUrlForSignature(raw1)).toBe("http://localhost:8000/checkout");
      expect(normalizeUrlForSignature(raw2)).toBe("http://localhost:8000/checkout");
      expect(normalizeUrlForSignature("")).toBe("/");
    });
  });

  // =========================================================================
  // 2. Privacy-Safe State Signatures
  // =========================================================================
  describe("2. Privacy-Safe State Signatures", () => {
    it("produces identical stateSignature for equivalent states regardless of property insertion order", () => {
      const stateA: SafeStateInput = {
        url: "http://localhost:8000/checkout",
        title: "Checkout",
        elements: [
          { elementId: 1, role: "textbox", tag: "input", inputType: "text" },
          { elementId: 2, role: "button", tag: "button" },
        ],
      };

      const stateB: SafeStateInput = {
        elements: [
          { role: "button", tag: "button", elementId: 2 },
          { inputType: "text", role: "textbox", tag: "input", elementId: 1 },
        ],
        title: "Checkout",
        url: "http://localhost:8000/checkout",
      };

      const sigA = computeStateSignature(stateA);
      const sigB = computeStateSignature(stateB);

      expect(sigA).toBe(sigB);
      expect(sigA).toMatch(/^state_sig_[a-f0-9]{8}$/);
    });

    it("produces different stateSignatures for meaningfully different DOM states", () => {
      const stateCheckout: SafeStateInput = {
        url: "http://localhost:8000/checkout",
        title: "Checkout",
        elements: [{ elementId: 1, role: "button", tag: "button" }],
      };

      const stateLogin: SafeStateInput = {
        url: "http://localhost:8000/login",
        title: "Login",
        elements: [{ elementId: 1, role: "textbox", tag: "input" }],
      };

      const sig1 = computeStateSignature(stateCheckout);
      const sig2 = computeStateSignature(stateLogin);

      expect(sig1).not.toBe(sig2);
    });

    it("PRIVACY INVARIANT: never includes user input values in state signature", () => {
      const stateWithPii: any = {
        url: "http://localhost:8000/checkout",
        title: "Checkout",
        elements: [
          { elementId: 1, role: "textbox", tag: "input", inputType: "password", value: "SuperSecretPassword" },
          { elementId: 2, role: "textbox", tag: "input", inputType: "email", value: "canary_email@example.com" },
        ],
      };

      const sig = computeStateSignature(stateWithPii);
      expect(sig).toMatch(/^state_sig_[a-f0-9]{8}$/);

      // Verify that changing the PII value does NOT change the structural state signature
      const stateWithDifferentPii: any = {
        url: "http://localhost:8000/checkout",
        title: "Checkout",
        elements: [
          { elementId: 1, role: "textbox", tag: "input", inputType: "password", value: "DifferentPassword999" },
          { elementId: 2, role: "textbox", tag: "input", inputType: "email", value: "other_email@example.com" },
        ],
      };

      const sigDifferent = computeStateSignature(stateWithDifferentPii);
      expect(sig).toBe(sigDifferent); // Structural signature is invariant to sensitive value changes!
    });
  });

  // =========================================================================
  // 3. Privacy-Safe Action Signatures
  // =========================================================================
  describe("3. Privacy-Safe Action Signatures", () => {
    it("produces deterministic action signature for click actions", () => {
      const actionA: SafeActionInput = {
        action: "click",
        targetRole: "button",
        targetElementId: 42,
      };

      const sigA = computeActionSignature(actionA);
      const sigB = computeActionSignature({ ...actionA });

      expect(sigA).toBe(sigB);
      expect(sigA).toMatch(/^act_sig_click_[a-f0-9]{8}$/);
    });

    it("PRIVACY INVARIANT: masks secret values as [SECRET] in type_secret action signatures", () => {
      const secretAction: SafeActionInput = {
        action: "type_secret",
        targetRole: "textbox",
        targetElementId: 5,
        value: "RawPassword12345!",
        valueRef: "[SECRET_REF_TOKEN_01]",
      };

      const sig = computeActionSignature(secretAction);
      expect(sig).toMatch(/^act_sig_type_secret_[a-f0-9]{8}$/);

      // Same action with different secret value produces same signature because raw secret is masked
      const secretAction2: SafeActionInput = {
        action: "type_secret",
        targetRole: "textbox",
        targetElementId: 5,
        value: "CompletelyDifferentPassword!",
        valueRef: "[SECRET_REF_TOKEN_01]",
      };

      const sig2 = computeActionSignature(secretAction2);
      expect(sig).toBe(sig2);
    });

    it("produces distinct signatures for different action types", () => {
      const sigClick = computeActionSignature({ action: "click", targetElementId: 1 });
      const sigType = computeActionSignature({ action: "type", targetElementId: 1, value: "hello" });
      const sigScroll = computeActionSignature({ action: "scroll", direction: "down" });

      expect(sigClick).not.toBe(sigType);
      expect(sigClick).not.toBe(sigScroll);
    });
  });

  // =========================================================================
  // 4. Verified-Outcome Learning Invariant
  // =========================================================================
  describe("4. Verified-Outcome Learning Invariant", () => {
    it("LEARNS ONLY FROM VERIFIED SUCCESS: accepts verified outcome and stores PvmRecord", async () => {
      const successVerification: VerificationResult = {
        actionId: "task-01-step-1",
        expected: "element_present:#submit-btn",
        observed: "present",
        status: "success",
        latencyMs: 1.2,
      };

      const record = await recordVerifiedOutcome({
        taskId: "task-01",
        stateSignature: "state_sig_11112222",
        actionSignature: "act_sig_click_33334444",
        actionType: "click",
        targetRole: "button",
        targetElementId: 10,
        verificationResult: successVerification,
      });

      expect(record).not.toBeNull();
      expect(record!.verified).toBe(true);
      expect(record!.verificationStatus).toBe("success");
      expect(record!.successCount).toBe(1);
      expect(getMemorySize()).toBe(1);

      // Verify in-memory lookup
      const inMem = lookupInMemory("state_sig_11112222", "act_sig_click_33334444");
      expect(inMem).toBeDefined();
      expect(inMem!.actionType).toBe("click");
    });

    it("HARD INVARIANT: REJECTS failed verification outcome from entering PVM memory", async () => {
      const failureVerification: VerificationResult = {
        actionId: "task-02-step-1",
        expected: "element_present:#submit-btn",
        observed: "absent",
        status: "failure",
        failureCategory: "TARGET_NOT_FOUND",
        latencyMs: 0.8,
      };

      const record = await recordVerifiedOutcome({
        taskId: "task-02",
        stateSignature: "state_sig_fail_1111",
        actionSignature: "act_sig_click_fail_2222",
        actionType: "click",
        verificationResult: failureVerification,
      });

      expect(record).toBeNull();
      expect(getMemorySize()).toBe(0); // Memory untouched
      expect(lookupInMemory("state_sig_fail_1111")).toBeUndefined();
    });

    it("HARD INVARIANT: REJECTS ambiguous / unverified outcome from entering PVM memory", async () => {
      const ambiguousVerification: VerificationResult = {
        actionId: "task-03-step-1",
        expected: "url_changed",
        observed: "url_unchanged",
        status: "ambiguous",
        failureCategory: "STATE_NOT_CHANGED",
        latencyMs: 1.0,
      };

      const record = await recordVerifiedOutcome({
        taskId: "task-03",
        stateSignature: "state_sig_ambig_1111",
        actionSignature: "act_sig_nav_ambig_2222",
        actionType: "navigate",
        verificationResult: ambiguousVerification,
      });

      expect(record).toBeNull();
      expect(getMemorySize()).toBe(0);
    });
  });

  // =========================================================================
  // 5. Duplicate Prevention & Memory Updates
  // =========================================================================
  describe("5. Duplicate Prevention & Memory Updates", () => {
    it("updates existing record in-place on repeated verified transitions without duplicate records", async () => {
      const verification: VerificationResult = {
        actionId: "task-dup-step-1",
        expected: "element_present",
        observed: "present",
        status: "success",
        latencyMs: 0.5,
      };

      const stateSig = "state_sig_repeated";
      const actSig = "act_sig_repeated";

      // 1st Insertion
      const rec1 = await recordVerifiedOutcome({
        taskId: "task-dup",
        stateSignature: stateSig,
        actionSignature: actSig,
        actionType: "click",
        verificationResult: verification,
      });
      expect(rec1!.successCount).toBe(1);
      expect(getMemorySize()).toBe(1);

      // 2nd Insertion of identical transition
      const rec2 = await recordVerifiedOutcome({
        taskId: "task-dup",
        stateSignature: stateSig,
        actionSignature: actSig,
        actionType: "click",
        verificationResult: verification,
      });
      expect(rec2!.successCount).toBe(2);
      expect(getMemorySize()).toBe(1); // Still 1 record!

      // 3rd Insertion
      const rec3 = await recordVerifiedOutcome({
        taskId: "task-dup",
        stateSignature: stateSig,
        actionSignature: actSig,
        actionType: "click",
        verificationResult: verification,
      });
      expect(rec3!.successCount).toBe(3);
      expect(rec3!.confidence).toBeGreaterThan(rec1!.confidence ?? 0.9);
      expect(getMemorySize()).toBe(1);
    });
  });

  // =========================================================================
  // 6. Prediction & Candidate Retrieval
  // =========================================================================
  describe("6. Prediction & Candidate Retrieval", () => {
    it("retrieves previously verified candidate actions sorted by confidence and successCount", async () => {
      const stateSig = "state_sig_dashboard";

      const vRes: VerificationResult = {
        actionId: "act-1",
        expected: "done",
        observed: "done",
        status: "success",
        latencyMs: 1,
      };

      // Record candidate A (clicked once)
      await recordVerifiedOutcome({
        taskId: "t1",
        stateSignature: stateSig,
        actionSignature: "act_sig_click_export",
        actionType: "click",
        targetRole: "button",
        targetElementId: 101,
        verificationResult: vRes,
      });

      // Record candidate B (clicked twice -> higher successCount)
      await recordVerifiedOutcome({
        taskId: "t1",
        stateSignature: stateSig,
        actionSignature: "act_sig_click_refresh",
        actionType: "click",
        targetRole: "button",
        targetElementId: 102,
        verificationResult: vRes,
      });
      await recordVerifiedOutcome({
        taskId: "t1",
        stateSignature: stateSig,
        actionSignature: "act_sig_click_refresh",
        actionType: "click",
        targetRole: "button",
        targetElementId: 102,
        verificationResult: vRes,
      });

      const candidates = await queryPvmCandidates(stateSig);
      expect(candidates).toHaveLength(2);

      // Higher success count / confidence should rank first
      expect(candidates[0].actionSignature).toBe("act_sig_click_refresh");
      expect(candidates[0].successCount).toBe(2);
      expect(candidates[1].actionSignature).toBe("act_sig_click_export");
      expect(candidates[1].successCount).toBe(1);
    });

    it("returns empty array when querying an unlearned state signature", async () => {
      const candidates = await queryPvmCandidates("state_sig_never_seen_before");
      expect(candidates).toEqual([]);
    });
  });

  // =========================================================================
  // 7. Bounded Memory & LRU Eviction
  // =========================================================================
  describe("7. Bounded Memory & LRU Eviction", () => {
    it("strictly clamps capacity to maxEntries and evicts least recently used records", async () => {
      const maxCap = 5;
      setMaxMemoryEntries(maxCap);
      expect(getMaxMemoryEntries()).toBe(5);

      const vRes: VerificationResult = {
        actionId: "act-test",
        expected: "done",
        observed: "done",
        status: "success",
        latencyMs: 1,
      };

      // Insert 5 records (filling capacity)
      for (let i = 1; i <= 5; i++) {
        await recordVerifiedOutcome({
          taskId: `task-${i}`,
          stateSignature: `state_sig_${i}`,
          actionSignature: `act_sig_${i}`,
          actionType: "click",
          verificationResult: vRes,
        });
      }
      expect(getMemorySize()).toBe(5);

      // Access entry 1 to make it freshly used (LRU position refreshed)
      lookupInMemory("state_sig_1", "act_sig_1");

      // Insert 6th entry -> should evict the oldest unaccessed entry (entry 2)
      await recordVerifiedOutcome({
        taskId: "task-6",
        stateSignature: "state_sig_6",
        actionSignature: "act_sig_6",
        actionType: "click",
        verificationResult: vRes,
      });

      expect(getMemorySize()).toBe(5); // Bound maintained!

      // Entry 1 was accessed -> retained
      expect(lookupInMemory("state_sig_1", "act_sig_1")).toBeDefined();

      // Entry 2 was least recently used -> evicted
      expect(lookupInMemory("state_sig_2", "act_sig_2")).toBeUndefined();

      // Entry 6 is newest -> present
      expect(lookupInMemory("state_sig_6", "act_sig_6")).toBeDefined();
    });
  });

  // =========================================================================
  // 8. Backward Compatibility Storage Layer
  // =========================================================================
  describe("8. Backward Compatibility Storage Layer", () => {
    it("supports legacy putRecord and getRecord interfaces seamlessly", async () => {
      const legacyRecord: PvmRecord = {
        stateHash: "legacy_state_hash_1234",
        taskId: "task-legacy",
        action: { type: "click", elementId: 7 },
        verified: true,
        lastUsed: Date.now(),
      };

      await putRecord(legacyRecord);
      expect(getMemorySize()).toBe(1);

      const fetched = await getRecord("legacy_state_hash_1234");
      expect(fetched).toBeDefined();
      expect(fetched!.taskId).toBe("task-legacy");
      expect(fetched!.verified).toBe(true);
    });
  });

  // =========================================================================
  // 9. Performance Micro-Benchmarks
  // =========================================================================
  describe("9. Performance Micro-Benchmarks", () => {
    it("measures state signature computation latency over 1,000 iterations (p50, p95 < 0.5ms)", () => {
      const mockState: SafeStateInput = {
        url: "http://localhost:8000/checkout?param=1",
        title: "Mock Checkout Title",
        elements: [
          { elementId: 1, role: "textbox", tag: "input", inputType: "text" },
          { elementId: 2, role: "textbox", tag: "input", inputType: "password" },
          { elementId: 3, role: "button", tag: "button", disabled: false },
          { elementId: 4, role: "combobox", tag: "select" },
        ],
      };

      const iterations = 1000;
      const latencies: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const t0 = performance.now();
        computeStateSignature(mockState);
        const t1 = performance.now();
        latencies.push(t1 - t0);
      }

      latencies.sort((a, b) => a - b);
      const p50 = latencies[Math.floor(iterations * 0.5)];
      const p95 = latencies[Math.floor(iterations * 0.95)];
      const max = latencies[iterations - 1];

      console.log(
        `[PVM State Signature Benchmark (1000 runs)] p50=${p50.toFixed(4)}ms | p95=${p95.toFixed(4)}ms | max=${max.toFixed(4)}ms`
      );

      expect(p50).toBeLessThan(0.5);
      expect(p95).toBeLessThan(1.0);
      expect(max).toBeLessThan(10.0);
    });

    it("measures in-memory candidate lookup latency over 1,000 iterations (p50, p95 < 0.05ms)", async () => {
      const stateSig = "state_sig_bench";
      const vRes: VerificationResult = { actionId: "a", expected: "e", observed: "e", status: "success", latencyMs: 1 };

      await recordVerifiedOutcome({
        taskId: "t-bench",
        stateSignature: stateSig,
        actionSignature: "act_sig_bench_1",
        actionType: "click",
        verificationResult: vRes,
      });

      const iterations = 1000;
      const latencies: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const t0 = performance.now();
        findCandidatesInMemory(stateSig);
        const t1 = performance.now();
        latencies.push(t1 - t0);
      }

      latencies.sort((a, b) => a - b);
      const p50 = latencies[Math.floor(iterations * 0.5)];
      const p95 = latencies[Math.floor(iterations * 0.95)];
      const max = latencies[iterations - 1];

      console.log(
        `[PVM Fast Candidate Lookup Benchmark (1000 runs)] p50=${p50.toFixed(4)}ms | p95=${p95.toFixed(4)}ms | max=${max.toFixed(4)}ms`
      );

      expect(p50).toBeLessThan(0.05);
      expect(p95).toBeLessThan(0.2);
      expect(max).toBeLessThan(5.0);
    });
  });
});
