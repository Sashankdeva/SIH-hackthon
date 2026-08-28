# Role 5 — PVM & Verification Contract

**Sprint Scope:** Deterministic Level-1 Verification, Recovery Decision Foundation & PVM Memory Foundation (Level-2 semantic and Level-3 visual verification deferred).  
**Module Location:** `extension/src/pvm/`  

---

## 1. Primary Exports

### Verification Engine (`extension/src/pvm/verify.ts`):
- `verifyUrlChanged(actionId: string, urlBefore: string, startedAt?: number): VerificationResult`
- `verifyUrlMatches(actionId: string, expectedUrl: string, startedAt?: number): VerificationResult`
- `verifyElementPresent(actionId: string, selector: string, startedAt?: number): VerificationResult`
- `verifyElementAbsent(actionId: string, selector: string, startedAt?: number): VerificationResult`
- `verifyElementState(actionId: string, selector: string, expectedState: ElementStateExpectation, startedAt?: number): VerificationResult`
- `verifyValueMutation(actionId: string, selector: string, expectedValue: string, isSecret?: boolean, startedAt?: number): VerificationResult`
- `verifyScrollPosition(actionId: string, expectedRegionSelector: string, startedAt?: number): VerificationResult`
- `verifyDeterministicOutcome(request: VerificationRequest): VerificationResult`

### Recovery & Classification Engine (`extension/src/pvm/recovery.ts`):
- `decideRecovery(result: VerificationResult, attemptsSoFar: number): RecoveryDecision`
- `classifyFailure(result: VerificationResult): FailureCategory`
- `isFailureRetryable(category: FailureCategory, attemptsSoFar?: number): Retryability`

### PVM Memory & Signatures (`extension/src/pvm/memory.ts`):
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

---

## 2. PVM Memory Invariants & Guarantees

1. **Verified-Outcome Learning Invariant:**
   - Memory records are **ONLY** created or updated from verification results with `status === "success"`.
   - Actions resulting in `failure`, `ambiguous`, `interrupted`, or `timeout` are **STRICTLY REJECTED** and never enter positive learned memory.

2. **Privacy Boundary Invariants:**
   - **Zero Secret Persisted:** Password and secret action signatures replace raw strings with `"[SECRET]"` and reference opaque `valueRef` tokens.
   - **Zero Raw PII Storage:** State signatures extract only structural properties (`role`, `tag`, `inputType`, `disabled`, `readonly`, `elementId`). User input values and PII are stripped prior to hashing.
   - **Zero Screenshots:** PVM stores purely compact hexadecimal state and action signatures (`state_sig_...`, `act_sig_...`).

3. **Bounded Capacity & O(1) Eviction:**
   - Default capacity is bounded to `MAX_ENTRIES = 500`.
   - Eviction operates deterministically via Least Recently Used (LRU) policy in $O(1)$ time.

4. **Deterministic Signatures:**
   - State and action signatures use canonical JSON key ordering and fast 32-bit FNV-1a hashing.
   - Insertion order of object properties does not alter signature output.

5. **Prediction Safety:**
   - PVM candidate lookups return previously verified candidate actions for a given state signature.
   - A PVM prediction is a candidate proposal; it does not bypass Role 1 action validation or post-action Level-1 verification.
