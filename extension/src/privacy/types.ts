export type SensitiveCategory =
  | "password"
  | "email"
  | "phone"
  | "person_name"
  | "address"
  | "government_id"
  | "financial"
  | "face"
  | "unknown_sensitive";

export interface PrivacyDetection {
  /** Real DOM element id for text-field detections. Synthetic negative ids for visual/face detections — see perception/faceDetector.ts. */
  elementId: number;
  category: SensitiveCategory;
  /** "text_ner" is still deferred past Sept 1 — dom_rule (form fields) and visual (faces) are both implemented. */
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
