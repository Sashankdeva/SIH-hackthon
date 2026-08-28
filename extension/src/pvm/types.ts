/**
 * Role 5 — Verification & PVM Types
 *
 * Formal type definitions for Deterministic Level-1 Verification,
 * failure classification, verification evidence, recovery decisions,
 * privacy-safe state/action signatures, and PVM memory records.
 */

export type VerificationStatus = "success" | "failure" | "ambiguous";

export type VerificationLevel = "L1" | "L2" | "L3";

export type VerificationSignal =
  | "url"
  | "element_presence"
  | "element_absence"
  | "element_state"
  | "value_mutation"
  | "attribute_mutation"
  | "scroll"
  | "generic_completion";

export type FailureCategory =
  | "TARGET_NOT_FOUND"
  | "STATE_NOT_CHANGED"
  | "URL_MISMATCH"
  | "ELEMENT_STATE_MISMATCH"
  | "TIMEOUT"
  | "STALE_STATE"
  | "TAB_UNAVAILABLE"
  | "EXECUTION_INTERRUPTED"
  | "MALFORMED_REQUEST"
  | "UNKNOWN";

export type Retryability = "retryable" | "nonRetryable" | "inconclusive";

export interface VerificationEvidence {
  signal: VerificationSignal;
  expected: string;
  observed: string;
  target?: string | number | null;
  matched: boolean;
  details?: string;
}

export interface VerificationResult {
  actionId: string;
  expected: string;
  observed: string;
  status: VerificationStatus;
  latencyMs: number;
  level?: VerificationLevel;
  failureCategory?: FailureCategory;
  retryability?: Retryability;
  evidence?: VerificationEvidence[];
  timestamp?: number;
}

export interface ElementStateExpectation {
  disabled?: boolean;
  readonly?: boolean;
  textContent?: string;
  ariaChecked?: string | boolean;
  ariaExpanded?: string | boolean;
  className?: string;
  value?: string;
  isSecret?: boolean;
}

export interface VerificationRequest {
  taskId: string;
  stepId?: number;
  actionId: string;
  actionType?: string;
  targetElementId?: number | null;
  targetSelector?: string | null;
  expectedUrl?: string | null;
  urlBefore?: string | null;
  expectedState?: ElementStateExpectation | null;
  expectedDisappearance?: boolean;
  expectedRegionSelector?: string | null;
  startedAt?: number;
  level?: VerificationLevel;
}

export interface RecoveryDecision {
  shouldRetry: boolean;
  reason: string;
  failureCategory?: FailureCategory;
  retryability?: Retryability;
  suggestedAction?: "RETRY_IMMEDIATE" | "RECAPTURE_STATE" | "BACKOFF_RETRY" | "ABORT";
}

/** Safe state input for computing deterministic, privacy-safe state signatures */
export interface SafeStateInput {
  url?: string;
  title?: string;
  elements?: Array<{
    elementId?: number;
    role?: string;
    tag?: string;
    inputType?: string | null;
    disabled?: boolean;
    readonly?: boolean;
    placeholder?: string | null;
  }>;
  customFlags?: Record<string, string | boolean | number>;
}

/** Safe action input for computing deterministic, privacy-safe action signatures */
export interface SafeActionInput {
  action: string;
  targetRole?: string | null;
  targetElementId?: number | null;
  targetSelector?: string | null;
  value?: string | null;
  valueRef?: string | null;
  direction?: "up" | "down" | "left" | "right" | null;
  amount?: number | null;
  url?: string | null;
  key?: string | null;
  isSecret?: boolean;
}

/** Canonical PVM Memory Record */
export interface PvmRecord {
  stateHash: string; // stateSignature identifier (primary key in IndexedDB)
  taskId: string;
  action: unknown; // Canonical action representation / signature
  verified: boolean; // Invariant: MUST be true for positive learned memory
  lastUsed: number; // Epoch ms timestamp for LRU eviction

  // Phase 2 structured metadata:
  recordId?: string;
  stateSignature?: string;
  actionSignature?: string;
  actionType?: string;
  targetRole?: string;
  targetElementId?: number | null;
  verificationLevel?: VerificationLevel;
  verificationStatus?: VerificationStatus;
  confidence?: number;
  successCount?: number;
  failureCount?: number;
  createdAt?: number;
  updatedAt?: number;
}

/** Parameters for recording a verified outcome */
export interface RecordVerifiedOutcomeParams {
  taskId: string;
  stateSignature: string;
  actionSignature: string;
  actionType: string;
  targetRole?: string;
  targetElementId?: number | null;
  verificationResult: VerificationResult;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

/** Candidate prediction result returned from PVM lookup */
export interface PvmPredictionCandidate {
  actionType: string;
  targetRole?: string;
  targetElementId?: number | null;
  actionSignature: string;
  stateSignature: string;
  confidence: number;
  successCount: number;
  lastUsed: number;
}
