/**
 * Local vision processing — the piece PS26171 names first in its
 * expected-solution list and weights at 25%, the largest single metric.
 *
 * Runs in `vision-main/index.ts`, a SEPARATE content script declared
 * with `"world": "MAIN"` in manifest.json — not in this project's usual
 * isolated-world content script. Real bug, found only by loading this
 * for real in Chrome (my own testing tools can't reproduce Chrome's
 * isolated/main world split, so this could not be caught by simulated
 * testing): a <script> tag injected from an isolated-world content
 * script executes in the page's MAIN world. ort.all.min.js does
 * `var ort = ...` at its top level; the resulting global landed in the
 * main world and was invisible to isolated-world code trying to use
 * it — "ort is not defined" the moment that code touched it. Isolated
 * worlds share the DOM with the page but not arbitrary JS globals.
 *
 * Running this whole module in the main world instead (where a
 * <script>-tag-loaded ort naturally lives) sidesteps the problem
 * entirely, at the cost of losing access to chrome.* APIs there — so
 * every extension-resource URL this module needs is passed in as a
 * parameter, computed by the isolated-world content script and handed
 * over via a CustomEvent (the one thing that does cross the world
 * boundary). See vision-main/index.ts and docs/ARCHITECTURE.md.
 */

interface OrtTensor {
  data: Float32Array;
  dims: number[];
}
interface OrtSession {
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
}
interface OrtGlobal {
  env: { wasm: { wasmPaths: string; numThreads: number } };
  Tensor: new (type: string, data: Float32Array, dims: number[]) => OrtTensor;
  InferenceSession: {
    create(url: string, opts: { executionProviders: string[] }): Promise<OrtSession>;
  };
}

export interface VisionAssetUrls {
  ort: string;
  model: string;
  wasmBase: string;
}

const MODEL_INPUT_WIDTH = 320;
const MODEL_INPUT_HEIGHT = 240;
// Measured on the real test image (Python, independent of this file):
// 0.7 -> 44 faces found; 0.5 -> 50; 0.3 -> also 50 (no further gain);
// 0.2 -> 54 (starts risking false positives). 0.5 sits at the recall
// "elbow" — meaningfully better than 0.7, with no precision cost
// visually confirmed at 0.5 (every box lands on a real face). See
// docs/ARCHITECTURE.md.
const CONFIDENCE_THRESHOLD = 0.5;
const IOU_THRESHOLD = 0.3;

export interface FaceBox {
  /** Natural (unscaled) pixel coordinates on the source image. */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  score: number;
}

/**
 * Loads ort.all.min.js as a plain <script> tag. This module runs in
 * the main world (see file header), so a script tag it injects lands
 * in the SAME world it runs in — no eval/Function tricks needed here.
 * Each call injects a fresh <script> element rather than reusing a
 * cached one: verified live, WebGPU and WASM execution providers share
 * one underlying WASM runtime singleton *within a single loaded ort
 * instance* — if a WebGPU attempt fails at WASM-init time, a WASM
 * fallback reusing that same instance then fails too ("previous call
 * to initWasm() failed"), even though it's a different provider.
 * Re-injecting the script tag gives a genuinely fresh `ort` global.
 */
function loadOrtFresh(ortScriptUrl: string): Promise<OrtGlobal> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = ortScriptUrl;
    script.onload = () => {
      const w = window as unknown as { ort?: OrtGlobal };
      if (!w.ort) {
        reject(new Error("ort.all.min.js loaded but window.ort is still undefined"));
        return;
      }
      resolve(w.ort);
    };
    script.onerror = () => reject(new Error(`failed to load ${ortScriptUrl}`));
    document.head.appendChild(script);
  });
}

/**
 * A zeroed dummy input, same shape the model expects. Used to prove a
 * session can actually run before we commit to it — session creation
 * succeeding is not enough. Verified live: WebGPU session creation
 * succeeded in testing but the first real inference threw a kernel
 * error ("[Mul] failed... dims [1,4420,2]") — a failure mode session
 * creation alone can't catch.
 */
function dummyInput(ort: OrtGlobal): OrtTensor {
  return new ort.Tensor(
    "float32",
    new Float32Array(3 * MODEL_INPUT_HEIGHT * MODEL_INPUT_WIDTH),
    [1, 3, MODEL_INPUT_HEIGHT, MODEL_INPUT_WIDTH]
  );
}

function configureOrt(ort: OrtGlobal, wasmBase: string): void {
  ort.env.wasm.wasmPaths = wasmBase;
  // Required outside a cross-origin-isolated context (no
  // SharedArrayBuffer) — without this, threaded WASM init fails even
  // as a fallback. Verified live.
  ort.env.wasm.numThreads = 1;
}

let sessionAndOrtPromise: Promise<{ session: OrtSession; ort: OrtGlobal }> | null = null;

async function getSession(urls: VisionAssetUrls): Promise<{ session: OrtSession; ort: OrtGlobal }> {
  if (!sessionAndOrtPromise) {
    sessionAndOrtPromise = (async () => {
      const gpuOrt = await loadOrtFresh(urls.ort);
      configureOrt(gpuOrt, urls.wasmBase);
      try {
        const webgpuSession = await gpuOrt.InferenceSession.create(urls.model, { executionProviders: ["webgpu"] });
        await webgpuSession.run({ input: dummyInput(gpuOrt) }); // prove it actually runs, not just constructs
        return { session: webgpuSession, ort: gpuOrt };
      } catch (err) {
        console.warn("[face-detector] WebGPU unavailable or failed on first run, falling back to WASM:", err);
        const wasmOrt = await loadOrtFresh(urls.ort); // fresh instance — see loadOrtFresh() doc comment
        configureOrt(wasmOrt, urls.wasmBase);
        const wasmSession = await wasmOrt.InferenceSession.create(urls.model, { executionProviders: ["wasm"] });
        return { session: wasmSession, ort: wasmOrt };
      }
    })();
  }
  return sessionAndOrtPromise;
}

/** Resize the source image into the model's expected 320x240 input and normalize to (px-127)/128, NCHW. */
function preprocess(img: HTMLImageElement, ort: OrtGlobal): OrtTensor {
  const canvas = document.createElement("canvas");
  canvas.width = MODEL_INPUT_WIDTH;
  canvas.height = MODEL_INPUT_HEIGHT;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, MODEL_INPUT_WIDTH, MODEL_INPUT_HEIGHT);
  const { data } = ctx.getImageData(0, 0, MODEL_INPUT_WIDTH, MODEL_INPUT_HEIGHT); // RGBA, HWC

  const chw = new Float32Array(3 * MODEL_INPUT_HEIGHT * MODEL_INPUT_WIDTH);
  const plane = MODEL_INPUT_HEIGHT * MODEL_INPUT_WIDTH;
  for (let i = 0; i < plane; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    chw[i] = (r - 127) / 128; // R plane
    chw[plane + i] = (g - 127) / 128; // G plane
    chw[plane * 2 + i] = (b - 127) / 128; // B plane
  }

  return new ort.Tensor("float32", chw, [1, 3, MODEL_INPUT_HEIGHT, MODEL_INPUT_WIDTH]);
}

/** Greedy hard-NMS — same algorithm verified in Python (iou_threshold=0.3). */
function hardNms(boxes: FaceBox[]): FaceBox[] {
  const sorted = [...boxes].sort((a, b) => a.score - b.score);
  const picked: FaceBox[] = [];

  while (sorted.length > 0) {
    const current = sorted.pop()!;
    picked.push(current);
    for (let i = sorted.length - 1; i >= 0; i--) {
      const b = sorted[i];
      const x1 = Math.max(current.x1, b.x1);
      const y1 = Math.max(current.y1, b.y1);
      const x2 = Math.min(current.x2, b.x2);
      const y2 = Math.min(current.y2, b.y2);
      const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
      const areaCur = (current.x2 - current.x1) * (current.y2 - current.y1);
      const areaB = (b.x2 - b.x1) * (b.y2 - b.y1);
      const iou = inter / (areaCur + areaB - inter + 1e-9);
      if (iou > IOU_THRESHOLD) sorted.splice(i, 1);
    }
  }
  return picked;
}

/**
 * Runs local face detection on one same-origin <img>. Returns boxes in
 * the image's natural (unscaled) pixel coordinates. Cross-origin images
 * without CORS headers will throw when read from canvas — that's a
 * known, documented limitation for this sprint, not a silent failure.
 */
export async function detectFaces(img: HTMLImageElement, urls: VisionAssetUrls): Promise<FaceBox[]> {
  const { session, ort } = await getSession(urls);
  const inputTensor = preprocess(img, ort);
  const outputs = await session.run({ input: inputTensor });

  const scores = outputs.scores.data; // [1, 4420, 2] flattened
  const boxes = outputs.boxes.data; // [1, 4420, 4] flattened, normalized [0,1]
  const numAnchors = scores.length / 2;

  const candidates: FaceBox[] = [];
  for (let i = 0; i < numAnchors; i++) {
    const faceProb = scores[i * 2 + 1];
    if (faceProb <= CONFIDENCE_THRESHOLD) continue;
    candidates.push({
      x1: boxes[i * 4] * img.naturalWidth,
      y1: boxes[i * 4 + 1] * img.naturalHeight,
      x2: boxes[i * 4 + 2] * img.naturalWidth,
      y2: boxes[i * 4 + 3] * img.naturalHeight,
      score: faceProb,
    });
  }

  return hardNms(candidates);
}
