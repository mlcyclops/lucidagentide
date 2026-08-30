// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/build/build-creator.ts - CREATOR-0 (ADR-0279): compile the Electron shell for the CREATOR flavor.
//
// Same two bundles as `bun run build` (dist/main.js + dist/preload.js), with ONE difference: the flavor is
// BAKED IN via a define, so a packaged Creator app resolves its identity even if nothing sets an env var
// and even before it reads its own package.json. Belt and braces beside `extraMetadata.lucidBuildFlavor`.
//
// dist/ is shared with the standard build, so a Creator package run always recompiles it first (the
// dist:*:creator scripts call this) and a later standard `bun run build` puts the Agent bundle back.

import { rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const desktopDir = resolve(dirname(import.meta.dir));
const dist = join(desktopDir, "dist");

// A stale Agent bundle in dist/ would silently ship as "Creator", so start from a clean directory.
rmSync(dist, { recursive: true, force: true });

const shared = {
  target: "node" as const,
  format: "cjs" as const,
  external: ["electron"],
  outdir: dist,
};

const main = await Bun.build({
  ...shared,
  entrypoints: [join(desktopDir, "main.ts")],
  define: { "process.env.LUCID_BUILD_FLAVOR": '"creator"' },
});
const preload = await Bun.build({ ...shared, entrypoints: [join(desktopDir, "preload.ts")] });

for (const [label, out] of [["main", main], ["preload", preload]] as const) {
  if (out.success) continue;
  console.error(`[build-creator] ${label} bundle failed`);
  for (const log of out.logs) console.error(log);
  process.exit(1);
}

console.log(`[build-creator] dist/main.js + dist/preload.js built with LUCID_BUILD_FLAVOR=creator`);
