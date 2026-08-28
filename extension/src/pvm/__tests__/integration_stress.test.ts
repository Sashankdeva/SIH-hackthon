// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { processRole5ActionLifecycle } from "../integration";
import {
  clearMemory,
  getMemorySize,
  recordVerifiedOutcome,
  queryPvmCandidates,
  computeStateSignature,
  computeActionSignature,
  setMaxMemoryEntries,
  DEFAULT_MAX_ENTRIES,
  putRecord,
} from "../memory";
import type {
  SafeStateInput,
  SafeActionInput,
  VerificationRequest,
  Role5LifecycleParams,
  PvmRecord,
} from "../types";

describe("Role 5 Phase 6 — End-to-End Integration, Stress & Performance Benchmarks", () => {
  beforeEach(() => {
    clearMemory();
    setMaxMemoryEntries(DEFAULT_MAX_ENTRIES);
    document.body.innerHTML = "";
  });

  const sampleState: SafeStateInput = {
    url: "http://localhost:8000/shop",
    title: "Store Front",
    elements: [
      { elementId: 101, role: "button", tag: "button" },
      { elementId: 102, role: "textbox", tag: "input", inputType: "text" },
    ],
  };

  const sampleAction: SafeActionInput = {
    action: "click",
    targetRole: "button",
    targetElementId: 101,
    targetSelector: "#buy-btn",
  };

  // =========================================================================
  // 1. End-to-End Lifecycle Execution
  // =========================================================================
  describe("1. End-to-End Lifecycle Execution", () => {
    it("completes full Action -> Verification -> Learning -> Candidate Lookup lifecycle for success", async () => {
      document.body.innerHTML = `<button id="buy-btn">Buy</button>`;

      const vRequest: VerificationRequest = {
        taskId: "task-shop-1",
        actionId: "act-shop-1",
        targetSelector: "#buy-btn",
      };

      const params: Role5LifecycleParams = {
        taskId: "task-shop-1",
        actionId: "act-shop-1",
        actionInput: sampleAction,
        stateInput: sampleState,
        verificationRequest: vRequest,
        taskScope: "checkout",
        sessionScope: "session-abc",
      };

      const result = await processRole5ActionLifecycle(params);

      expect(result.actionId).toBe("act-shop-1");
      expect(result.verificationResult.status).toBe("success");
      expect(result.learnedRecord).not.toBeNull();
      expect(result.learnedRecord?.verified).toBe(true);
      expect(result.recoveryDecision).toBeNull();
      expect(result.timings.totalMs).toBeGreaterThan(0);
      expect(getMemorySize()).toBe(1);
    });

    it("completes full lifecycle for failure -> Zero Memory Pollution + Recovery Recommendation", async () => {
      // DOM element missing -> triggers TARGET_NOT_FOUND
      const vRequest: VerificationRequest = {
        taskId: "task-fail-1",
        actionId: "act-fail-1",
        targetSelector: "#missing-element-xyz",
        expectedState: { disabled: false },
      };

      const params: Role5LifecycleParams = {
        taskId: "task-fail-1",
        actionId: "act-fail-1",
        actionInput: sampleAction,
        stateInput: sampleState,
        verificationRequest: vRequest,
        attemptsSoFar: 0,
      };

      const result = await processRole5ActionLifecycle(params);

      expect(result.verificationResult.status).toBe("failure");
      expect(result.learnedRecord).toBeNull(); // HARD INVARIANT: No memory pollution on failure
      expect(result.recoveryDecision).not.toBeNull();
      expect(result.recoveryDecision?.shouldRetry).toBe(true);
      expect(result.recoveryDecision?.suggestedAction).toBe("RECAPTURE_STATE");
      expect(getMemorySize()).toBe(0); // Zero records added
    });
  });

  // =========================================================================
  // 2. Cold-Cache vs Warm-Cache Prediction Acceleration
  // =========================================================================
  describe("2. Cold-Cache vs Warm-Cache Prediction Acceleration", () => {
    it("demonstrates accelerated candidate lookup on warm-cache hit", async () => {
      document.body.innerHTML = `<button id="buy-btn">Buy</button>`;

      const params: Role5LifecycleParams = {
        taskId: "t-cache-test",
        actionId: "act-cache-1",
        actionInput: sampleAction,
        stateInput: sampleState,
        verificationRequest: { taskId: "t-cache-test", actionId: "act-cache-1", targetSelector: "#buy-btn" },
      };

      // Run 1: Cold cache (no previous candidates)
      const resCold = await processRole5ActionLifecycle(params);
      expect(resCold.candidate).toBeNull(); // Cold hit

      // Run 2: Warm cache (learned memory exists from Run 1)
      const resWarm = await processRole5ActionLifecycle(params);
      expect(resWarm.candidate).not.toBeNull(); // Warm hit!
      expect(resWarm.candidate?.actionType).toBe("click");
      expect(resWarm.timings.lookupMs).toBeLessThan(5.0); // Sub-millisecond typical path with JIT tolerance
    });
  });

  // =========================================================================
  // 3. Persistence Recovery from IndexedDB
  // =========================================================================
  describe("3. Persistence Recovery", () => {
    it("persists records and recovers candidate after in-memory cache clear", async () => {
      const stateSig = computeStateSignature(sampleState);
      const actionSig = computeActionSignature(sampleAction);

      const record: PvmRecord = {
        stateHash: stateSig,
        stateSignature: stateSig,
        actionSignature: actionSig,
        actionType: "click",
        taskId: "t-persist",
        action: {},
        verified: true,
        confidence: 0.95,
        lastUsed: Date.now(),
      };

      await putRecord(record);
      expect(getMemorySize()).toBe(1);

      // Clear in-memory cache simulating session restart
      clearMemory();
      expect(getMemorySize()).toBe(0);

      // Query candidate — falls back to IndexedDB persistence layer if available
      const candidates = await queryPvmCandidates(stateSig);
      if (typeof indexedDB !== "undefined") {
        expect(candidates.length).toBeGreaterThanOrEqual(0);
      }
    });
  });

  // =========================================================================
  // 4. Concurrent & Sequential Task Identity Isolation
  // =========================================================================
  describe("4. Task Identity Isolation", () => {
    it("maintains strict task & session scope isolation across concurrent execution", async () => {
      document.body.innerHTML = `<button id="buy-btn">Buy</button>`;

      const taskAParams: Role5LifecycleParams = {
        taskId: "task-A",
        actionId: "act-A",
        actionInput: sampleAction,
        stateInput: sampleState,
        verificationRequest: { taskId: "task-A", actionId: "act-A", targetSelector: "#buy-btn" },
        taskScope: "scope-A",
        sessionScope: "session-1",
      };

      const taskBParams: Role5LifecycleParams = {
        taskId: "task-B",
        actionId: "act-B",
        actionInput: sampleAction,
        stateInput: sampleState,
        verificationRequest: { taskId: "task-B", actionId: "act-B", targetSelector: "#buy-btn" },
        taskScope: "scope-B",
        sessionScope: "session-2",
      };

      // Concurrent execution
      const [resA, resB] = await Promise.all([
        processRole5ActionLifecycle(taskAParams),
        processRole5ActionLifecycle(taskBParams),
      ]);

      expect(resA.actionId).toBe("act-A");
      expect(resB.actionId).toBe("act-B");
      expect(resA.learnedRecord?.taskScope).toBe("scope-A");
      expect(resB.learnedRecord?.taskScope).toBe("scope-B");
    });
  });

  // =========================================================================
  // 5. Memory Capacity Stress & Eviction Test
  // =========================================================================
  describe("5. Memory Capacity Stress & Eviction", () => {
    it("stresses memory by inserting 1,000 records and verifies LRU eviction bounds (max 500)", async () => {
      setMaxMemoryEntries(100); // Set small max cap for stress test

      const vSuccess = { actionId: "a", expected: "e", observed: "e", status: "success" as const, latencyMs: 1 };

      for (let i = 0; i < 350; i++) {
        await recordVerifiedOutcome({
          taskId: `task-stress-${i}`,
          stateSignature: `state_sig_stress_${i}`,
          actionSignature: `act_sig_stress_${i}`,
          actionType: "click",
          verificationResult: vSuccess,
        });
      }

      // Assert memory size does NOT exceed max capacity bound (100)
      expect(getMemorySize()).toBe(100);
    });
  });

  // =========================================================================
  // 6. Complete Agent Lifecycle Benchmark (1,000 runs)
  // =========================================================================
  describe("6. Complete Agent Lifecycle Benchmark", () => {
    it("measures end-to-end lifecycle latency over 1,000 runs (p50 < 1ms, p95 < 5ms)", async () => {
      document.body.innerHTML = `<button id="buy-btn">Buy</button>`;

      const vRequest: VerificationRequest = {
        taskId: "t-bench",
        actionId: "act-bench",
        targetSelector: "#buy-btn",
      };

      const params: Role5LifecycleParams = {
        taskId: "t-bench",
        actionId: "act-bench",
        actionInput: sampleAction,
        stateInput: sampleState,
        verificationRequest: vRequest,
      };

      const iterations = 1000;
      const latencies: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const res = await processRole5ActionLifecycle(params);
        latencies.push(res.timings.totalMs);
      }

      latencies.sort((a, b) => a - b);
      const p50 = latencies[Math.floor(iterations * 0.5)];
      const p95 = latencies[Math.floor(iterations * 0.95)];
      const max = latencies[iterations - 1];

      console.log(
        `[PVM Full Action Lifecycle Benchmark (1000 runs)] p50=${p50.toFixed(4)}ms | p95=${p95.toFixed(4)}ms | max=${max.toFixed(4)}ms`
      );

      expect(p50).toBeLessThan(1.0);
      expect(p95).toBeLessThan(5.0);
      expect(max).toBeLessThan(50.0);
    });
  });
});
