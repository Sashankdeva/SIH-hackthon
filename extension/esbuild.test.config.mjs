/**
 * Bundles the TypeScript tests to ESM so `node --test` can run them.
 *
 * Node cannot load src/ directly: the sources use extensionless imports
 * ("../action/executor"), which its ESM resolver rejects. esbuild is
 * already a dependency for the extension build, so reusing it here adds
 * no new tooling. It strips types without checking them — `npm run
 * typecheck:tests` is what type-checks this tree.
 */
import * as esbuild from "esbuild";
import { readdirSync } from "node:fs";

const entryPoints = readdirSync("tests")
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => `tests/${f}`);

if (entryPoints.length === 0) {
  console.error("[esbuild:test] no tests/*.test.ts files found");
  process.exit(1);
}

await esbuild.build({
  entryPoints,
  outdir: "dist-tests",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  sourcemap: "inline",
  logLevel: "info",
});
