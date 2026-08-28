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

  // Phase 5 multi-level per-level timing and escalation metadata:
  l1LatencyMs?: number;
  l2LatencyMs?: number;
  l3LatencyMs?: number;
  escalatedFromLevel?: VerificationLevel;
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

/** Level 2 Semantic Verification expectations */
export interface L2SemanticExpectation {
  semanticRole?: string;
  expectedTextPattern?: string; // Regex or substring pattern
  accessibilityLabel?: string;
  semanticStatus?: "success" | "error" | "pending" | "info";
  customSemanticFlags?: Record<string, string | boolean | number>;
}

/** Level 3 Visual Verification expectations (privacy-safe, NO image buffers) */
export interface L3VisualExpectation {
  regionBoundingBox?: { x: number; y: number; width: number; height: number };
  expectedVisibilityState?: "visible" | "hidden" | "occluded";
  elementLayoutShifted?: boolean;
  visualColorClass?: string;
}

/** Options for controlling higher-level verification escalation */
export interface HigherLevelVerificationOptions {
  allowEscalation?: boolean;
  requestedLevel?: VerificationLevel;
  minL2Confidence?: number;
  minL3Confidence?: number;
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

  // Phase 5 Higher-Level Verification fields:
  expectedSemanticState?: L2SemanticExpectation | null;
  expectedVisualState?: L3VisualExpectation | null;
  verificationOptions?: HigherLevelVerificationOptions | null;
}

export type SuggestedRecoveryAction =
  | "RETRY_IMMEDIATE"
  | "RECAPTURE_STATE"
  | "BACKOFF_RETRY"
  | "ALTERNATIVE_CANDIDATE"
  | "ABORT";

export interface Role5LifecycleParams {
  taskId: string;
  actionId: string;
  actionInput: SafeActionInput;
  stateInput: SafeStateInput;
  verificationRequest: VerificationRequest;
  taskScope?: string;
  sessionScope?: string;
  attemptsSoFar?: number;
}

export interface Role5LifecycleTimings {
  lookupMs: number;
  verificationMs: number;
  learningMs: number;
  recoveryMs: number;
  totalMs: number;
}

export interface Role5LifecycleResult {
  actionId: string;
  candidate: PvmPredictionCandidate | null;
  verificationResult: VerificationResult;
  learnedRecord: PvmRecord | null;
  recoveryDecision: RecoveryDecision | null;
  timings: Role5LifecycleTimings;
}

export interface PvmRecoveryContext {
  attemptsSoFar: number;
  maxAttempts?: number;
  stateSignature?: string;
  stateInput?: SafeStateInput;
  pvmCandidates?: PvmPredictionCandidate[];
  taskScope?: string;
  sessionScope?: string;
}

export interface RecoveryDecision {
  shouldRetry: boolean;
  reason: string;
  failureCategory?: FailureCategory;
  retryability?: Retryability;
  suggestedAction?: SuggestedRecoveryAction;
  alternativeCandidate?: PvmPredictionCandidate;
  recoveryLatencyMs?: number;
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

  // Phase 3 scope & freshness fields:
  taskScope?: string;
  sessionScope?: string;
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
  taskScope?: string;
  sessionScope?: string;
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
  taskId?: string;
  taskScope?: string;
  sessionScope?: string;
  createdAt?: number;
}

/** Reasons why a candidate might be rejected during validation */
export type CandidateRejectionReason =
  | "INVALID_CANDIDATE"
  | "STATE_MISMATCH"
  | "ACTION_MISMATCH"
  | "LOW_CONFIDENCE"
  | "TASK_SCOPE_MISMATCH"
  | "SESSION_SCOPE_MISMATCH"
  | "STALE_RECORD"
  | "UNVERIFIED_RECORD";

/** Request parameters for validating a PVM candidate action */
export interface CandidateValidationRequest {
  candidate: PvmPredictionCandidate | PvmRecord;
  currentStateInput: SafeStateInput;
  currentActionInput?: SafeActionInput;
  taskScope?: string;
  sessionScope?: string;
  minConfidenceThreshold?: number;
  maxStaleAgeMs?: number;
}

/** Result of validating a PVM candidate action */
export interface CandidateValidationResult {
  isValid: boolean;
  candidate: PvmPredictionCandidate | null;
  confidence: number;
  rejectionReason?: CandidateRejectionReason;
  details?: string;
  validationLatencyMs: number;
}

