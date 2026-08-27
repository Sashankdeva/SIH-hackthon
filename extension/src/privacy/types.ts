export type SensitiveCategory =
  | "password"
  | "email"
  | "phone"
  | "person_name"
  | "government_id"
  | "financial"
  | "unknown_sensitive";

export interface PrivacyDetection {
  elementId: number;
  category: SensitiveCategory;
  /** Only "dom_rule" is implemented this sprint — text_ner and visual are deferred past Sept 1. */
  source: "dom_rule" | "text_ner" | "visual";
  confidence: number;
}

export interface RedactionRecord {
  elementId: number;
  category: SensitiveCategory;
  method: "blackout" | "mask" | "semantic_token";
  token: string;
}

export interface PrivacyReport {
  taskId: string;
  detections: PrivacyDetection[];
  redactions: RedactionRecord[];
}
