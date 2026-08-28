# Role 5 — PVM & Verification Master Contract

**Project:** SIH 2026 • ISRO Problem Statement 26171 (`privyvision-extension`)  
**Target Handoff Branch:** `satya-05`  
**Completion Status:** All 8 Phases Complete (Phase 0 – Phase 7)  
**Module Location:** `extension/src/pvm/`  

---

## 1. Primary Component Exports

### End-to-End Action Lifecycle Engine ([`extension/src/pvm/integration.ts`](file:///d:/SIH_26_171/extension/src/pvm/integration.ts)):
- `processRole5ActionLifecycle(params: Role5LifecycleParams): Promise<Role5LifecycleResult>`

### Verification Engine ([`extension/src/pvm/verify.ts`](file:///d:/SIH_26_171/extension/src/pvm/verify.ts)):
- `verifyDeterministicOutcome(request: VerificationRequest): VerificationResult`
- `verifyLevel2Semantic(actionId: string, selector: string | null, expectation: L2SemanticExpectation, startedAt?: number): VerificationResult`
- `verifyLevel3Visual(actionId: string, selector: string | null, expectation: L3VisualExpectation, startedAt?: number): VerificationResult`
- `verifyWithEscalation(request: VerificationRequest): VerificationResult`
- `verifyUrlChanged(actionId: string, urlBefore: string, startedAt?: number): VerificationResult`
- `verifyUrlMatches(actionId: string, expectedUrl: string, startedAt?: number): VerificationResult`
- `verifyElementPresent(actionId: string, selector: string, startedAt?: number): VerificationResult`
- `verifyElementAbsent(actionId: string, selector: string, startedAt?: number): VerificationResult`
- `verifyElementState(actionId: string, selector: string, expectedState: ElementStateExpectation, startedAt?: number): VerificationResult`
- `verifyValueMutation(actionId: string, selector: string, expectedValue: string, isSecret?: boolean, startedAt?: number): VerificationResult`
- `verifyScrollPosition(actionId: string, expectedRegionSelector: string, startedAt?: number): VerificationResult`

### Candidate Validation & PVM Memory Engine ([`extension/src/pvm/memory.ts`](file:///d:/SIH_26_171/extension/src/pvm/memory.ts)):
- `validateCandidate(request: CandidateValidationRequest): CandidateValidationResult`
- `findAndValidateCandidates(currentStateInput: SafeStateInput, options?: ValidationOptions): CandidateValidationResult[]`
- `computeStateSignature(input: SafeStateInput): string`
- `computeActionSignature(input: SafeActionInput): string`
- `recordVerifiedOutcome(params: RecordVerifiedOutcomeParams): Promise<PvmRecord | null>`
- `queryPvmCandidates(stateSignature: string): Promise<PvmPredictionCandidate[]>`
- `lookupInMemory(stateSignature: string, actionSignature?: string): PvmRecord | undefined`
- `findCandidatesInMemory(stateSignature: string): PvmPredictionCandidate[]`
- `putRecord(record: PvmRecord): Promise<void>`
- `getRecord(stateHash: string): Promise<PvmRecord | undefined>`
- `evictIfOverBound(): Promise<void>`
- `clearMemory(): void`
- `setMaxMemoryEntries(max: number): void`
- `getMaxMemoryEntries(): number`

### Recovery & Classification Engine ([`extension/src/pvm/recovery.ts`](file:///d:/SIH_26_171/extension/src/pvm/recovery.ts)):
- `decideRecovery(result: VerificationResult, attemptsOrContext: number | PvmRecoveryContext, maxAttemptsOverride?: number): RecoveryDecision`
- `classifyFailure(result: VerificationResult): FailureCategory`
- `isFailureRetryable(category: FailureCategory, attemptsSoFar?: number, maxAttempts?: number): Retryability`

---

## 2. Architectural Invariants & Privacy Rules

1. **Verified-Outcome Learning Invariant:**
   - Memory records are **ONLY** created or updated from verification results with `status === "success"`.
   - Actions resulting in `failure`, `ambiguous`, `interrupted`, or `timeout` are **STRICTLY REJECTED** and never enter positive learned memory.

2. **Privacy Firewall Invariants:**
   - **Zero Secrets Persisted:** Password and secret action signatures replace raw strings with `"[SECRET]"` and reference opaque `valueRef` tokens.
   - **Zero Raw PII Storage:** State signatures extract only structural properties (`role`, `tag`, `inputType`, `disabled`, `readonly`, `elementId`). User input values and PII are stripped prior to hashing.
   - **Zero Screenshots:** PVM stores purely compact hexadecimal state and action signatures (`state_sig_...`, `act_sig_...`). No visual byte buffers or base64 images are stored in PVM records or verification evidence.

3. **Bounded Capacity & O(1) Eviction:**
   - Default capacity is bounded to `MAX_ENTRIES = 500`.
   - Eviction operates deterministically via Least Recently Used (LRU) policy in $O(1)$ time.

4. **Deterministic Signatures:**
   - State and action signatures use canonical JSON key ordering and fast 32-bit FNV-1a hashing.
   - Insertion order of object properties does not alter signature output.

5. **Ownership & Authority Boundaries:**
   - **Role 1 (Execution)**: Execution & browser action authority.
   - **Role 2 (Perception)**: DOM & accessibility scanning source.
   - **Role 5 (PVM & Verification)**: State verification & candidate memory proposal. **Role 5 MUST NOT execute browser actions directly.**

---

## 3. Benchmarked Performance SLA Matrix (1,000 runs)

| Component | p50 Latency | p95 Latency | SLA Target |
| :--- | :--- | :--- | :--- |
| **Full Action Lifecycle (`processRole5ActionLifecycle`)** | `0.1230 ms` | `0.2795 ms` | < 1.0 ms |
| **L1 Latency Isolation (`verifyWithEscalation`)** | `0.0138 ms` | `0.0397 ms` | < 0.05 ms |
| **Recovery Decision Engine (`decideRecovery`)** | `0.0010 ms` | `0.0014 ms` | < 0.05 ms |
| **Candidate Validation (`validateCandidate`)** | `0.0204 ms` | `0.0414 ms` | < 0.1 ms |
| **Fast Candidate Lookup (`findCandidatesInMemory`)** | `0.0022 ms` | `0.0029 ms` | < 0.05 ms |
| **State Signature Computation (`computeStateSignature`)** | `0.0266 ms` | `0.0644 ms` | < 0.5 ms |
| **L1 Verification Engine (`verifyDeterministicOutcome`)** | `0.0152 ms` | `0.0422 ms` | < 5.0 ms |

