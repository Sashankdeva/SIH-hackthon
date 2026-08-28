import type {
  PvmRecord,
  SafeStateInput,
  SafeActionInput,
  RecordVerifiedOutcomeParams,
  PvmPredictionCandidate,
  CandidateValidationRequest,
  CandidateValidationResult,
  CandidateRejectionReason,
} from "./types";

export type { CandidateValidationRequest, CandidateValidationResult, CandidateRejectionReason };

export const DB_NAME = "pvm-store";
export const STORE_NAME = "transitions";
export const DEFAULT_MAX_ENTRIES = 500;

let currentMaxEntries = DEFAULT_MAX_ENTRIES;

/**
 * Sets the maximum entry capacity for PVM memory (used in testing and benchmarks).
 */
export function setMaxMemoryEntries(max: number): void {
  currentMaxEntries = Math.max(1, max);
}

/**
 * Gets the current maximum capacity.
 */
export function getMaxMemoryEntries(): number {
  return currentMaxEntries;
}

/**
 * Fast, deterministic 32-bit FNV-1a hash algorithm.
 * Generates an 8-character hexadecimal hash with zero dependencies in < 1 microsecond.
 */
export function fnv1aHash(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Canonicalizes an arbitrary JavaScript object or value by sorting keys recursively.
 * Ensures that property insertion order does NOT affect signature output.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalizeJson(item));
    return `[${items.join(",")}]`;
  }

  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const pairs = sortedKeys.map((k) => `${JSON.stringify(k)}:${canonicalizeJson(obj[k])}`);
  return `{${pairs.join(",")}}`;
}

/**
 * Normalizes a URL to origin and pathname only, stripping sensitive query params and hash fragments.
 */
export function normalizeUrlForSignature(rawUrl?: string): string {
  if (!rawUrl || typeof rawUrl !== "string") return "/";
  try {
    const base = typeof location !== "undefined" && location.href ? location.href : "http://localhost/";
    const parsed = new URL(rawUrl, base);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(rawUrl).split("?")[0].split("#")[0];
  }
}

/**
 * Computes a deterministic, privacy-safe state signature from safe state inputs.
 * Invariant: Never hashes or includes raw user input values, passwords, or PII.
 */
export function computeStateSignature(input: SafeStateInput): string {
  if (!input || typeof input !== "object") {
    return "state_sig_00000000";
  }

  const normalizedUrl = normalizeUrlForSignature(input.url);
  const normalizedTitle = (input.title || "").trim();

  // Extract only structural, non-sensitive element attributes
  const safeElements = (input.elements || [])
    .map((el) => ({
      id: el.elementId ?? 0,
      role: el.role || "unknown",
      tag: (el.tag || "").toLowerCase(),
      type: el.inputType ? el.inputType.toLowerCase() : null,
      disabled: el.disabled === true,
      readonly: el.readonly === true,
    }))
    .sort((a, b) => (a.id !== b.id ? a.id - b.id : a.role.localeCompare(b.role)));

  const canonicalPayload = {
    u: normalizedUrl,
    t: normalizedTitle,
    e: safeElements,
    f: input.customFlags || {},
  };

  const canonicalString = canonicalizeJson(canonicalPayload);
  return `state_sig_${fnv1aHash(canonicalString)}`;
}

/**
 * Computes a deterministic, privacy-safe action signature from action parameters.
 * Invariant: Raw secrets and passwords are NEVER included in action signatures.
 */
export function computeActionSignature(input: SafeActionInput): string {
  if (!input || typeof input !== "object") {
    return "act_sig_unknown_00000000";
  }

  const actionType = (input.action || "wait").toLowerCase();

  // Privacy Rule: For type_secret or marked secret actions, mask value as "[SECRET]"
  let safeValue: string | null = null;
  if (actionType === "type_secret" || input.isSecret) {
    safeValue = "[SECRET]";
  } else if (actionType === "type" && input.value != null) {
    safeValue = input.value;
  }

  const canonicalAction = {
    a: actionType,
    r: input.targetRole || null,
    id: input.targetElementId ?? null,
    sel: input.targetSelector || null,
    val: safeValue,
    ref: input.valueRef || null,
    dir: input.direction || null,
    amt: input.amount ?? null,
    url: input.url ? normalizeUrlForSignature(input.url) : null,
    k: input.key || null,
  };

  const canonicalString = canonicalizeJson(canonicalAction);
  return `act_sig_${actionType}_${fnv1aHash(canonicalString)}`;
}

/**
 * High-speed In-Memory LRU Memory Store.
 * Provides sub-millisecond O(1) constant-time lookup, insertion, and eviction.
 */
class InMemoryPvmStore {
  private records = new Map<string, PvmRecord>(); // Keyed by compositeKey `${stateSignature}::${actionSignature}`
  private stateIndex = new Map<string, Set<string>>(); // Maps stateSignature -> Set of compositeKeys

  /**
   * Generates composite key for indexing
   */
  private makeCompositeKey(stateSig: string, actionSig: string): string {
    return `${stateSig}::${actionSig}`;
  }

  /**
   * Puts or updates a record in memory with O(1) LRU ordering.
   */
  public put(record: PvmRecord): void {
    const stateSig = record.stateSignature || record.stateHash;
    const actionSig = record.actionSignature || (typeof record.action === "string" ? record.action : fnv1aHash(JSON.stringify(record.action)));
    const key = this.makeCompositeKey(stateSig, actionSig);

    // Refresh LRU order by deleting and re-inserting
    if (this.records.has(key)) {
      this.records.delete(key);
    }

    record.lastUsed = Date.now();
    this.records.set(key, record);

    // Update state index
    let set = this.stateIndex.get(stateSig);
    if (!set) {
      set = new Set<string>();
      this.stateIndex.set(stateSig, set);
    }
    set.add(key);

    this.evictIfOverBound();
  }

  /**
   * Retrieves a record by stateSignature and optional actionSignature in O(1) time.
   */
  public get(stateSig: string, actionSig?: string): PvmRecord | undefined {
    if (actionSig) {
      const key = this.makeCompositeKey(stateSig, actionSig);
      const record = this.records.get(key);
      if (record) {
        // Refresh LRU position
        this.records.delete(key);
        record.lastUsed = Date.now();
        this.records.set(key, record);
        return record;
      }
      return undefined;
    }

    // Lookup by stateSignature only (returns first matching record)
    const keys = this.stateIndex.get(stateSig);
    if (keys && keys.size > 0) {
      const firstKey = keys.values().next().value;
      if (firstKey) {
        return this.get(stateSig, firstKey.split("::")[1]);
      }
    }
    return undefined;
  }

  /**
   * Finds all verified candidate action records for a given stateSignature.
   */
  public findCandidates(stateSig: string): PvmRecord[] {
    const keys = this.stateIndex.get(stateSig);
    if (!keys || keys.size === 0) return [];

    const candidates: PvmRecord[] = [];
    for (const key of keys) {
      const rec = this.records.get(key);
      if (rec && rec.verified) {
        candidates.push(rec);
      }
    }

    // Sort by confidence (descending) and successCount (descending)
    return candidates.sort((a, b) => {
      const confDiff = (b.confidence ?? 0.9) - (a.confidence ?? 0.9);
      if (confDiff !== 0) return confDiff;
      return (b.successCount ?? 1) - (a.successCount ?? 1);
    });
  }

  /**
   * Returns current record count in memory.
   */
  public size(): number {
    return this.records.size;
  }

  /**
   * Clears all in-memory records.
   */
  public clear(): void {
    this.records.clear();
    this.stateIndex.clear();
  }

  /**
   * Returns all records as array.
   */
  public getAll(): PvmRecord[] {
    return Array.from(this.records.values());
  }

  /**
   * Performs O(1) LRU eviction when capacity exceeds maxEntries.
   */
  public evictIfOverBound(): void {
    while (this.records.size > currentMaxEntries) {
      // Map.keys().next().value returns the oldest inserted/accessed key in O(1)
      const oldestKey = this.records.keys().next().value;
      if (!oldestKey) break;

      const record = this.records.get(oldestKey);
      this.records.delete(oldestKey);

      if (record) {
        const stateSig = record.stateSignature || record.stateHash;
        const set = this.stateIndex.get(stateSig);
        if (set) {
          set.delete(oldestKey);
          if (set.size === 0) {
            this.stateIndex.delete(stateSig);
          }
        }
      }
    }
  }
}

// Global In-Memory Store singleton
const memoryCache = new InMemoryPvmStore();

// =========================================================================
// Synchronous Fast-Path Memory APIs
// =========================================================================

export function lookupInMemory(stateSignature: string, actionSignature?: string): PvmRecord | undefined {
  return memoryCache.get(stateSignature, actionSignature);
}

export function findCandidatesInMemory(stateSignature: string): PvmPredictionCandidate[] {
  const records = memoryCache.findCandidates(stateSignature);
  return records.map((r) => ({
    actionType: r.actionType || (typeof r.action === "string" ? r.action : "unknown"),
    targetRole: r.targetRole,
    targetElementId: r.targetElementId,
    actionSignature: r.actionSignature || (typeof r.action === "string" ? r.action : ""),
    stateSignature: r.stateSignature || r.stateHash,
    confidence: r.confidence ?? 0.95,
    successCount: r.successCount ?? 1,
    lastUsed: r.lastUsed,
    taskId: r.taskId,
    taskScope: r.taskScope,
    sessionScope: r.sessionScope,
    createdAt: r.createdAt,
  }));
}

export function getMemorySize(): number {
  return memoryCache.size();
}

export function clearMemory(): void {
  memoryCache.clear();
}

// =========================================================================
// Verified Outcome Learning Invariant & Recording
// =========================================================================

/**
 * Records a verified successful outcome into PVM memory.
 * HARD INVARIANT: Rejects failures, timeouts, ambiguous outcomes, and unverified actions.
 */
export async function recordVerifiedOutcome(params: RecordVerifiedOutcomeParams): Promise<PvmRecord | null> {
  const {
    verificationResult,
    stateSignature,
    actionSignature,
    actionType,
    taskId,
    targetRole,
    targetElementId,
    confidence,
    taskScope,
    sessionScope,
  } = params;

  // HARD INVARIANT CHECK: Only "success" verification status may enter PVM memory
  if (!verificationResult || verificationResult.status !== "success" || verificationResult.failureCategory) {
    return null;
  }

  const existing = memoryCache.get(stateSignature, actionSignature);
  const now = Date.now();

  const record: PvmRecord = {
    stateHash: stateSignature,
    taskId: taskId || existing?.taskId || "unknown-task",
    action: {
      actionType,
      targetRole,
      targetElementId,
      actionSignature,
    },
    verified: true,
    lastUsed: now,
    recordId: existing?.recordId || `rec_${stateSignature}_${actionSignature}`,
    stateSignature,
    actionSignature,
    actionType,
    targetRole,
    targetElementId,
    verificationLevel: verificationResult.level || "L1",
    verificationStatus: "success",
    confidence: Math.min(1.0, (existing?.confidence ?? (confidence || 0.95)) + (existing ? 0.02 : 0)),
    successCount: (existing?.successCount || 0) + 1,
    failureCount: existing?.failureCount || 0,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    taskScope: taskScope || existing?.taskScope,
    sessionScope: sessionScope || existing?.sessionScope,
  };

  // 1. Update high-speed in-memory store
  memoryCache.put(record);

  // 2. Persist asynchronously to IndexedDB if available
  try {
    await putRecord(record);
  } catch {
    // Non-critical persistence fallback
  }

  return record;
}

/**
 * Queries candidate actions for prediction / reuse based on current state signature.
 */
export async function queryPvmCandidates(stateSignature: string): Promise<PvmPredictionCandidate[]> {
  // First check high-speed in-memory cache
  const inMem = findCandidatesInMemory(stateSignature);
  if (inMem.length > 0) {
    return inMem;
  }

  // Fallback to IndexedDB if in-memory cache was cold
  try {
    const record = await getRecord(stateSignature);
    if (record && record.verified) {
      memoryCache.put(record);
      return findCandidatesInMemory(stateSignature);
    }
  } catch {
    // Return empty candidates if storage query fails
  }

  return [];
}

// =========================================================================
// Phase 3 — Confidence-Aware Candidate Validation Engine
// =========================================================================

/**
 * Validates a PVM candidate action deterministically against current state,
 * action signatures, confidence thresholds, task/session scope, and freshness.
 *
 * Invariants:
 * - Sub-millisecond execution latency
 * - Does NOT perform browser actions or mutate DOM
 * - Does NOT call neural models / LLMs
 */
export function validateCandidate(request: CandidateValidationRequest): CandidateValidationResult {
  const startTime = typeof performance !== "undefined" ? performance.now() : Date.now();

  const {
    candidate,
    currentStateInput,
    currentActionInput,
    taskScope,
    sessionScope,
    minConfidenceThreshold = 0.8,
    maxStaleAgeMs,
  } = request;

  const getLatency = () =>
    Math.max(0.0001, (typeof performance !== "undefined" ? performance.now() : Date.now()) - startTime);

  // 1. Candidate presence check
  if (!candidate || typeof candidate !== "object") {
    return {
      isValid: false,
      candidate: null,
      confidence: 0,
      rejectionReason: "INVALID_CANDIDATE",
      details: "Candidate object is null or missing",
      validationLatencyMs: getLatency(),
    };
  }

  // Check if candidate is a PvmRecord and verified === false
  if ("verified" in candidate && candidate.verified === false) {
    return {
      isValid: false,
      candidate: null,
      confidence: candidate.confidence ?? 0,
      rejectionReason: "UNVERIFIED_RECORD",
      details: "Candidate outcome was not verified as successful",
      validationLatencyMs: getLatency(),
    };
  }

  // Normalize candidate structure to PvmPredictionCandidate
  const candidateSig = candidate.stateSignature || ("stateHash" in candidate ? candidate.stateHash : "");
  const candActionSig = candidate.actionSignature || ("action" in candidate && typeof candidate.action === "string" ? candidate.action : "");
  const candConfidence = candidate.confidence ?? 0.9;

  const candidateObj: PvmPredictionCandidate = {
    actionType: candidate.actionType || ("action" in candidate && typeof candidate.action === "object" && candidate.action ? (candidate.action as any).actionType : "unknown"),
    targetRole: candidate.targetRole,
    targetElementId: candidate.targetElementId,
    actionSignature: candActionSig,
    stateSignature: candidateSig,
    confidence: candConfidence,
    successCount: candidate.successCount ?? 1,
    lastUsed: candidate.lastUsed ?? Date.now(),
    taskId: candidate.taskId,
    taskScope: candidate.taskScope,
    sessionScope: candidate.sessionScope,
  };

  // 2. State Signature Match Check
  const currentStateSig = computeStateSignature(currentStateInput);
  if (currentStateSig !== candidateSig) {
    return {
      isValid: false,
      candidate: candidateObj,
      confidence: candConfidence,
      rejectionReason: "STATE_MISMATCH",
      details: `State signature mismatch: expected ${candidateSig}, current is ${currentStateSig}`,
      validationLatencyMs: getLatency(),
    };
  }

  // 3. Action Signature Match Check (if current action input provided)
  if (currentActionInput) {
    const currentActionSig = computeActionSignature(currentActionInput);
    if (candActionSig && currentActionSig !== candActionSig) {
      return {
        isValid: false,
        candidate: candidateObj,
        confidence: candConfidence,
        rejectionReason: "ACTION_MISMATCH",
        details: `Action signature mismatch: candidate ${candActionSig}, current ${currentActionSig}`,
        validationLatencyMs: getLatency(),
      };
    }
  }

  // 4. Confidence Threshold Check
  if (candConfidence < minConfidenceThreshold) {
    return {
      isValid: false,
      candidate: candidateObj,
      confidence: candConfidence,
      rejectionReason: "LOW_CONFIDENCE",
      details: `Candidate confidence ${candConfidence.toFixed(2)} is below minimum threshold ${minConfidenceThreshold.toFixed(2)}`,
      validationLatencyMs: getLatency(),
    };
  }

  // 5. Task Scope Check
  if (taskScope && candidateObj.taskScope && candidateObj.taskScope !== taskScope) {
    return {
      isValid: false,
      candidate: candidateObj,
      confidence: candConfidence,
      rejectionReason: "TASK_SCOPE_MISMATCH",
      details: `Task scope mismatch: required '${taskScope}', candidate has '${candidateObj.taskScope}'`,
      validationLatencyMs: getLatency(),
    };
  }

  // 6. Session Scope Check
  if (sessionScope && candidateObj.sessionScope && candidateObj.sessionScope !== sessionScope) {
    return {
      isValid: false,
      candidate: candidateObj,
      confidence: candConfidence,
      rejectionReason: "SESSION_SCOPE_MISMATCH",
      details: `Session scope mismatch: required '${sessionScope}', candidate has '${candidateObj.sessionScope}'`,
      validationLatencyMs: getLatency(),
    };
  }

  // 7. Freshness / Stale Check
  if (maxStaleAgeMs && maxStaleAgeMs > 0) {
    const ageMs = Date.now() - candidateObj.lastUsed;
    if (ageMs > maxStaleAgeMs) {
      return {
        isValid: false,
        candidate: candidateObj,
        confidence: candConfidence,
        rejectionReason: "STALE_RECORD",
        details: `Candidate record age (${ageMs}ms) exceeds maximum allowed age (${maxStaleAgeMs}ms)`,
        validationLatencyMs: getLatency(),
      };
    }
  }

  // Passed all candidate applicability checks
  return {
    isValid: true,
    candidate: candidateObj,
    confidence: candConfidence,
    validationLatencyMs: getLatency(),
  };
}

/**
 * Finds and validates candidates for a given state input.
 * Returns only valid candidate validation results sorted by confidence descending.
 */
export function findAndValidateCandidates(
  currentStateInput: SafeStateInput,
  options: {
    currentActionInput?: SafeActionInput;
    taskScope?: string;
    sessionScope?: string;
    minConfidenceThreshold?: number;
    maxStaleAgeMs?: number;
  } = {}
): CandidateValidationResult[] {
  const stateSig = computeStateSignature(currentStateInput);
  const candidates = findCandidatesInMemory(stateSig);
  if (candidates.length === 0) return [];

  const results: CandidateValidationResult[] = [];
  for (const cand of candidates) {
    const validation = validateCandidate({
      candidate: cand,
      currentStateInput,
      currentActionInput: options.currentActionInput,
      taskScope: options.taskScope,
      sessionScope: options.sessionScope,
      minConfidenceThreshold: options.minConfidenceThreshold,
      maxStaleAgeMs: options.maxStaleAgeMs,
    });
    if (validation.isValid) {
      results.push(validation);
    }
  }

  return results.sort((a, b) => b.confidence - a.confidence);
}


// =========================================================================
// IndexedDB Storage Layer (Preserves Existing Signature & Schema)
// =========================================================================

function isIndexedDbAvailable(): boolean {
  return typeof indexedDB !== "undefined" && indexedDB != null;
}

function openDb(): Promise<IDBDatabase> {
  if (!isIndexedDbAvailable()) {
    return Promise.reject(new Error("IndexedDB unavailable in current environment"));
  }

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "stateHash" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Puts a PvmRecord into IndexedDB and high-speed in-memory cache.
 */
export async function putRecord(record: PvmRecord): Promise<void> {
  // Update in-memory cache
  memoryCache.put(record);

  if (!isIndexedDbAvailable()) {
    return;
  }

  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    await evictIfOverBound();
  } catch {
    // Graceful fallback to memory store
  }
}

/**
 * Retrieves a PvmRecord by stateHash from memory cache or IndexedDB.
 */
export async function getRecord(stateHash: string): Promise<PvmRecord | undefined> {
  // Check in-memory store first
  const inMem = memoryCache.get(stateHash);
  if (inMem) {
    return inMem;
  }

  if (!isIndexedDbAvailable()) {
    return undefined;
  }

  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(stateHash);
      req.onsuccess = () => {
        const res = req.result as PvmRecord | undefined;
        if (res) {
          memoryCache.put(res);
        }
        resolve(res);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return undefined;
  }
}

/**
 * Evicts least recently used records when object count exceeds maximum bound.
 */
export async function evictIfOverBound(): Promise<void> {
  memoryCache.evictIfOverBound();

  if (!isIndexedDbAvailable()) {
    return;
  }

  try {
    const db = await openDb();
    const all: PvmRecord[] = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => resolve(req.result as PvmRecord[]);
      req.onerror = () => reject(req.error);
    });

    if (all.length <= currentMaxEntries) return;

    const sorted = [...all].sort((a, b) => a.lastUsed - b.lastUsed);
    const toEvict = sorted.slice(0, all.length - currentMaxEntries);
    const tx = db.transaction(STORE_NAME, "readwrite");
    for (const rec of toEvict) {
      tx.objectStore(STORE_NAME).delete(rec.stateHash);
    }
  } catch {
    // Non-critical eviction error
  }
}
