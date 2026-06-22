// esbuild.mjs — bundle the VS Code extension host entry. `vscode` is provided by the host (external).
// The extension reuses the proven ACP client (desktop/acp.ts) and the shared, tested IDE-client logic
// (harness/launcher/ide_client.ts) by bundling them from the monorepo.
import { build, context } from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const opts = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile: "dist/extension.js",
  external: ["vscode"],
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

if (watch) {
  const ctx = await context(opts);
  await ctx.watch();
  console.log("[lucid-ext] watching…");
} else {
  await build(opts);
  console.log("[lucid-ext] built dist/extension.js");
}
