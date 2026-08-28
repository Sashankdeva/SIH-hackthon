import { detectFaces, type VisionAssetUrls } from "../perception/faceDetector";
import { overlayFaceBoxes } from "../privacy/visualRedact";

/**
 * MAIN-world content script — see the architecture note at the top of
 * perception/faceDetector.ts for why this lives in its own world
 * instead of the project's usual isolated-world content script.
 *
 * Has NO access to chrome.* APIs (that's the main/isolated-world
 * trade-off) — it waits for the isolated-world script to hand over the
 * extension resource URLs it needs via a CustomEvent, does its work
 * (find <img>s, detect faces, redact on the page), then reports back
 * primitive metadata only — never a DOM reference — through another
 * CustomEvent. See content/index.ts for the isolated-world side.
 */

interface VisionResultDetail {
  imageIndex: number;
  faceCount: number;
  latencyMs: number;
}

document.addEventListener(
  "privyvision:init-vision",
  async (event) => {
    const urls = (event as CustomEvent<VisionAssetUrls>).detail;
    const images = Array.from(document.querySelectorAll("img"));

    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      if (!img.complete || img.naturalWidth === 0) continue;

      const start = performance.now();
      let faces;
      try {
        faces = await detectFaces(img, urls);
      } catch (err) {
        console.warn("[vision-main] face detection failed for an image (likely cross-origin without CORS):", err);
        continue;
      }
      const latencyMs = Math.round(performance.now() - start);
      console.log(`[vision-main] ${faces.length} face(s) in ${latencyMs}ms`, img.src);

      if (faces.length > 0) {
        overlayFaceBoxes(img, faces);
      }

      document.dispatchEvent(
        new CustomEvent<VisionResultDetail>("privyvision:vision-result", {
          detail: { imageIndex: i, faceCount: faces.length, latencyMs },
        })
      );
    }

    document.dispatchEvent(new CustomEvent("privyvision:vision-done"));
  },
  { once: true }
);
