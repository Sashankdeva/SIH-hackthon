export interface CapturedElement {
  elementId: number;
  role: string;
  label: string | null;
  tag: string;
  inputType: string | null;
  disabled?: boolean;
  readonly?: boolean;
  placeholder?: string | null;
}

export interface PageState {
  taskId: string;
  url: string;
  title: string;
  capturedAt: number;
  elements: CapturedElement[];
}
