import * as esbuild from "esbuild";
import { mkdirSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const watch = process.argv.includes("--watch");

const buildOptions = {
  entryPoints: {
    background: "src/background/index.ts",
    content: "src/content/index.ts",
    "vision-main": "src/vision-main/index.ts",
    popup: "src/popup/index.ts",
  },
  outdir: "dist",
  bundle: true,
  // IIFE everywhere (not ESM) so the background service worker, content
  // script, and popup script all load as plain classic scripts — one
  // less MV3 edge case (module-type service workers) to debug under a
  // 5-day deadline.
  format: "iife",
  target: "chrome110",
  sourcemap: true,
  logLevel: "info",
};

/**
 * onnxruntime-web deliberately is NOT imported/bundled through esbuild —
 * its WASM/worker loading trips up most bundlers (see the GitHub issue
 * on service-worker WASM support). Instead we copy the pre-built UMD
 * bundle + its WASM binaries as static files, and
 * perception/faceDetector.ts (running inside vision-main, the
 * MAIN-world content script) injects ort.all.min.js as a plain
 * <script> tag at runtime, exactly like ONNX Runtime Web's own docs
 * recommend for non-bundler use. See docs/ARCHITECTURE.md.
 */
function copyOnnxRuntimeAssets() {
  const srcDir = "node_modules/onnxruntime-web/dist";
  const destDir = "dist";
  mkdirSync(destDir, { recursive: true });

  const files = [
    "ort.all.min.js",
    "ort-wasm-simd-threaded.jsep.mjs",
    "ort-wasm-simd-threaded.jsep.wasm",
    "ort-wasm-simd-threaded.mjs",
    "ort-wasm-simd-threaded.wasm",
  ];
  for (const f of files) {
    const src = join(srcDir, f);
    if (!existsSync(src)) {
      console.warn(`[esbuild] missing expected onnxruntime-web asset: ${src}`);
      continue;
    }
    copyFileSync(src, join(destDir, f));
  }
}

function copyModel() {
  mkdirSync("dist/models", { recursive: true });
  copyFileSync("models/face-detector.onnx", "dist/models/face-detector.onnx");
}

copyOnnxRuntimeAssets();
copyModel();

const ctx = await esbuild.context(buildOptions);

if (watch) {
  await ctx.watch();
  console.log("Watching extension/src for changes...");
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
