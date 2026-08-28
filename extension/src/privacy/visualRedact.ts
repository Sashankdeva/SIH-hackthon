import type { FaceBox } from "../perception/faceDetector";

/**
 * Draws opaque overlays over detected faces directly on the live page —
 * the "blurring faces, blacking out ... PII" behavior PS26171 names
 * explicitly. Positioned as absolutely-positioned divs on top of the
 * image, scaled from the image's natural pixel coordinates (what the
 * model saw) to its rendered CSS size (what the page shows) — those
 * two are rarely the same once a page applies its own width/height
 * styling.
 */
export function overlayFaceBoxes(img: HTMLImageElement, boxes: FaceBox[]): void {
  if (boxes.length === 0) return;

  const parent = img.offsetParent as HTMLElement | null;
  if (!parent) {
    // No positioned ancestor — fall back to hiding the original image
    // rather than leaving faces unredacted with nothing to anchor to.
    img.style.visibility = "hidden";
    return;
  }

  // Force the parent positioned BEFORE reading img.offsetLeft/offsetTop —
  // critical ordering, verified against a real bug: offsetLeft/offsetTop
  // are relative to whatever offsetParent's positioning currently is,
  // and forcing position:relative on a previously-static parent changes
  // that reference frame. Reading them first and mutating after silently
  // produces coordinates from the WRONG frame — this rendered redaction
  // boxes ~400px off from the actual image on first attempt (caught by
  // live testing, not by inspection — see docs/ARCHITECTURE.md).
  if (getComputedStyle(parent).position === "static") {
    parent.style.position = "relative";
  }

  const rect = img.getBoundingClientRect();
  const scaleX = rect.width / img.naturalWidth;
  const scaleY = rect.height / img.naturalHeight;

  const container = document.createElement("div");
  container.style.position = "absolute";
  container.style.left = `${img.offsetLeft}px`;
  container.style.top = `${img.offsetTop}px`;
  container.style.width = `${rect.width}px`;
  container.style.height = `${rect.height}px`;
  container.style.pointerEvents = "none";
  container.dataset.privyvisionOverlay = "face-redaction";

  for (const box of boxes) {
    const el = document.createElement("div");
    el.style.position = "absolute";
    el.style.left = `${box.x1 * scaleX}px`;
    el.style.top = `${box.y1 * scaleY}px`;
    el.style.width = `${(box.x2 - box.x1) * scaleX}px`;
    el.style.height = `${(box.y2 - box.y1) * scaleY}px`;
    el.style.background = "#000000";
    el.style.borderRadius = "2px";
    container.appendChild(el);
  }

  parent.appendChild(container);
}
