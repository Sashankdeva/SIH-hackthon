import type { FaceBox } from "../perception/faceDetector";

/** Registry of active observed image targets and their detected face boxes */
const trackedTargets = new Map<HTMLImageElement, FaceBox[]>();

/** Shared ResizeObserver instance for tracking layout changes of target images */
let resizeObserver: ResizeObserver | null = null;

/** Set of targets with pending layout update requests (for rAF coalescing) */
const pendingUpdateTargets = new Set<HTMLImageElement>();
let updateScheduled = false;

/**
 * Coalesces layout updates for all pending image targets into a single animation frame.
 */
function scheduleCoalescedUpdate(): void {
  if (updateScheduled) return;
  updateScheduled = true;

  const runUpdate = () => {
    updateScheduled = false;
    for (const img of pendingUpdateTargets) {
      if (img.isConnected && trackedTargets.has(img)) {
        const boxes = trackedTargets.get(img)!;
        overlayFaceBoxes(img, boxes);
      } else {
        unobserveImageTarget(img);
      }
    }
    pendingUpdateTargets.clear();
  };

  if (typeof requestAnimationFrame !== "undefined") {
    requestAnimationFrame(runUpdate);
  } else {
    setTimeout(runUpdate, 0);
  }
}

/**
 * Initializes or retrieves the shared ResizeObserver for visual target tracking.
 */
function getOrCreateResizeObserver(): ResizeObserver | null {
  if (typeof ResizeObserver === "undefined") return null;
  if (!resizeObserver) {
    resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const target = entry.target;
        if (target instanceof HTMLImageElement && trackedTargets.has(target)) {
          pendingUpdateTargets.add(target);
        }
      }
      if (pendingUpdateTargets.size > 0) {
        scheduleCoalescedUpdate();
      }
    });
  }
  return resizeObserver;
}

/**
 * Draws opaque overlays over detected faces directly on the live page.
 * Safely manages overlay lifecycle to prevent duplicate/stale overlays on re-scan.
 */
export function overlayFaceBoxes(img: HTMLImageElement, boxes: FaceBox[]): void {
  if (!img || !Array.isArray(boxes) || boxes.length === 0) return;
  if (!img.naturalWidth || !img.naturalHeight) return;

  const parent = (img.offsetParent as HTMLElement | null) || (img.parentElement as HTMLElement | null);
  if (!parent) {
    // No positioned ancestor — fall back to hiding the original image
    // rather than leaving faces unredacted with nothing to anchor to.
    img.style.visibility = "hidden";
    return;
  }

  // Force the parent positioned BEFORE reading img.offsetLeft/offsetTop
  if (getComputedStyle(parent).position === "static") {
    parent.style.position = "relative";
  }

  // Clean up any existing overlay container for this image before appending a fresh one
  const targetId = img.id || (img.src ? encodeURIComponent(img.src) : "default");
  const existingOverlays = parent.querySelectorAll<HTMLElement>(
    `[data-privyvision-overlay="face-redaction"][data-target-id="${targetId}"]`
  );
  existingOverlays.forEach((el) => el.remove());

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
  container.dataset.targetId = targetId;

  for (const box of boxes) {
    if (!box || typeof box.x1 !== "number" || typeof box.x2 !== "number" || typeof box.y1 !== "number" || typeof box.y2 !== "number") {
      continue;
    }
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

/**
 * Tracks an image element and attaches a ResizeObserver to dynamically update
 * overlay positioning and dimensions during responsive layout changes.
 */
export function observeImageTarget(img: HTMLImageElement, boxes: FaceBox[]): void {
  if (!img || !Array.isArray(boxes) || boxes.length === 0) return;

  trackedTargets.set(img, boxes);
  overlayFaceBoxes(img, boxes);

  const observer = getOrCreateResizeObserver();
  if (observer && img.isConnected) {
    try {
      observer.observe(img);
    } catch {
      // Safe fallback if observation fails
    }
  }
}

/**
 * Unobserves an image target, removes it from tracking, and cleans up its overlay.
 */
export function unobserveImageTarget(img: HTMLImageElement): void {
  if (!img) return;

  trackedTargets.delete(img);
  pendingUpdateTargets.delete(img);

  if (resizeObserver) {
    try {
      resizeObserver.unobserve(img);
    } catch {
      // Safe fallback
    }
  }

  const parent = (img.offsetParent as HTMLElement | null) || (img.parentElement as HTMLElement | null);
  if (parent) {
    const targetId = img.id || (img.src ? encodeURIComponent(img.src) : "default");
    const overlays = parent.querySelectorAll<HTMLElement>(
      `[data-privyvision-overlay="face-redaction"][data-target-id="${targetId}"]`
    );
    overlays.forEach((el) => el.remove());
  }
}

/**
 * Returns the count of actively tracked image targets.
 */
export function getTrackedTargetCount(): number {
  return trackedTargets.size;
}

/**
 * Removes all PrivyVision face redaction overlays and unobserves all tracked targets.
 */
export function clearFaceOverlays(root: ParentNode = document): void {
  const overlays = root.querySelectorAll('[data-privyvision-overlay="face-redaction"]');
  overlays.forEach((el) => el.remove());

  for (const img of Array.from(trackedTargets.keys())) {
    unobserveImageTarget(img);
  }
  trackedTargets.clear();
  pendingUpdateTargets.clear();
}

/**
 * Disconnects and destroys all visual redaction observers and cleans up memory.
 */
export function destroyVisualRedactionObservers(): void {
  clearFaceOverlays();
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
}
