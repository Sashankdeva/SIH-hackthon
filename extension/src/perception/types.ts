/**
 * Safe, current occupancy of an editable control. Reports ONLY whether the
 * control holds text — never the text itself.
 *   empty     — editable and currently blank
 *   nonempty  — editable and currently holds text
 *   redacted  — sensitive; occupancy is deliberately not disclosed
 */
export type ValueState = "empty" | "nonempty" | "redacted";

export interface CapturedElement {
  elementId: number;
  role: string;
  label: string | null;
  tag: string;
  inputType: string | null;
  disabled?: boolean;
  readonly?: boolean;
  placeholder?: string | null;
  /** Present only for editable controls. Never carries the value itself. */
  valueState?: ValueState;
}

export interface PageState {
  taskId: string;
  url: string;
  title: string;
  capturedAt: number;
  elements: CapturedElement[];
}
