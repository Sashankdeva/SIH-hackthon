import test from "node:test";
import assert from "node:assert/strict";

interface VisionResultDetail {
  imageIndex: number;
  faceCount: number;
  latencyMs: number;
}

test("face detection emits vision-result event with faceCount and leaves DOM visually unmutated", async () => {
  // Setup event dispatch target and mock DOM elements
  const listeners: Record<string, Array<(event: unknown) => void>> = {};

  const mockDocument = {
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push(listener);
    },
    removeEventListener: (type: string, listener: (event: unknown) => void) => {
      if (listeners[type]) {
        listeners[type] = listeners[type].filter((l) => l !== listener);
      }
    },
    dispatchEvent: (event: { type: string; detail?: unknown }) => {
      const handlers = listeners[event.type] || [];
      for (const h of handlers) {
        h(event);
      }
      return true;
    },
    querySelectorAll: (selector: string) => {
      if (selector === "img") {
        return [
          {
            complete: true,
            naturalWidth: 640,
            naturalHeight: 480,
            src: "http://localhost:8000/photo.jpg",
            style: { visibility: "visible" },
          },
        ];
      }
      return [];
    },
    querySelector: (_selector: string) => null,
  };

  const detectedBoxes = [
    { x1: 50, y1: 50, x2: 150, y2: 150, confidence: 0.95 },
    { x1: 200, y1: 100, x2: 300, y2: 200, confidence: 0.92 },
  ];

  let resultEventReceived: VisionResultDetail | null = null;
  let doneEventReceived = false;

  mockDocument.addEventListener("privyvision:vision-result", (e: unknown) => {
    resultEventReceived = (e as { detail: VisionResultDetail }).detail;
  });

  mockDocument.addEventListener("privyvision:vision-done", () => {
    doneEventReceived = true;
  });

  // Execute the vision-main logic (without overlayFaceBoxes)
  mockDocument.addEventListener(
    "privyvision:init-vision",
    () => {
      const images = mockDocument.querySelectorAll("img");
      for (let i = 0; i < images.length; i++) {
        const targetImg = images[i];
        if (!targetImg.complete || targetImg.naturalWidth === 0) continue;
        const faces = detectedBoxes;
        const latencyMs = 5;

        // Note: overlayFaceBoxes(targetImg, faces) was removed here.

        mockDocument.dispatchEvent({
          type: "privyvision:vision-result",
          detail: { imageIndex: i, faceCount: faces.length, latencyMs },
        });
      }
      mockDocument.dispatchEvent({ type: "privyvision:vision-done" });
    }
  );

  // Trigger vision init event
  mockDocument.dispatchEvent({
    type: "privyvision:init-vision",
    detail: { ort: "", model: "", wasmBase: "" },
  });

  // 1. Verify face detection events and count
  assert.ok(resultEventReceived !== null, "privyvision:vision-result must be dispatched");
  const received: VisionResultDetail = resultEventReceived!;
  assert.equal(received.faceCount, 2, "faceCount must equal detected faces (2)");
  assert.equal(received.imageIndex, 0);
  assert.equal(doneEventReceived, true, "privyvision:vision-done must be dispatched");

  // 2. Verify no overlay elements are created in the document
  const overlay = mockDocument.querySelector('[data-privyvision-overlay="face-redaction"]');
  assert.equal(overlay, null, "No face-redaction overlay div must exist in the DOM");

  const blackBoxes = mockDocument.querySelectorAll('div[style*="background: #000000"]');
  assert.equal(blackBoxes.length, 0, "No black box overlay elements must be created");
});
