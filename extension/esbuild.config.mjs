import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const buildOptions = {
  entryPoints: {
    background: "src/background/index.ts",
    content: "src/content/index.ts",
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

const ctx = await esbuild.context(buildOptions);

if (watch) {
  await ctx.watch();
  console.log("Watching extension/src for changes...");
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
