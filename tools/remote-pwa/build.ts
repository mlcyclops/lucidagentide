// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// tools/remote-pwa/build.ts — P-REMOTE.3 (ADR-0226/0227): bundle the phone guest PWA into a static site.
//
// `bun build` app.ts (browser target) into dist/app.js — this pulls in the reused desktop/collab modules +
// pwa_view + @oh-my-pi/pi-wire constants, tree-shaken for the browser. The static shell (index.html,
// firebase_auth.js, manifest, sw.js, icon) is copied verbatim; config.js is seeded from config.example.js if
// a real one is not present (deploy fills the public values). Firebase itself is NOT bundled — the browser
// loads it from Google's CDN via firebase_auth.js (kept out of the bundle by design).

import { cp, mkdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url)); // trailing separator, Windows-safe
const dist = `${here}dist`;

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const result = await Bun.build({
  entrypoints: [`${here}app.ts`],
  outdir: dist,
  target: "browser",
  format: "esm",
  minify: true,
  naming: "[name].js",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("PWA bundle failed");
}

const STATIC = ["index.html", "firebase_auth.js", "manifest.webmanifest", "sw.js", "icon.svg", "r.html"]; // r.html: the /r/* path-to-fragment forwarder (ADR-0227 follow-up)
for (const f of STATIC) await cp(`${here}${f}`, `${dist}/${f}`);

// config.js: use a real one if present, else seed the placeholder so the build is self-contained + runnable.
const realConfig = `${here}config.js`;
await cp(existsSync(realConfig) ? realConfig : `${here}config.example.js`, `${dist}/config.js`);

const bundle = await stat(`${dist}/app.js`);
console.log(`[remote-pwa] built -> ${dist}`);
console.log(`[remote-pwa] app.js ${(bundle.size / 1024).toFixed(1)} KiB + shell (${STATIC.length} files) + config.js`);
if (!existsSync(realConfig)) console.log(`[remote-pwa] NOTE: using config.example.js placeholders - copy to config.js with the project's PUBLIC values before deploy`);
