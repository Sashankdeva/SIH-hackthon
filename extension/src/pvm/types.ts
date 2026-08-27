export interface VerificationResult {
  actionId: string;
  expected: string;
  observed: string;
  status: "success" | "failure" | "ambiguous";
  latencyMs: number;
}

export interface PvmRecord {
  stateHash: string;
  taskId: string;
  action: unknown;
  verified: boolean;
  lastUsed: number;
}
