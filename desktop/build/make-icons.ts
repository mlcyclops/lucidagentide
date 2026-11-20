// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/build/make-icons.ts - rasterize the brand SVGs into the icons
// electron-builder consumes. Sources of truth are build/icon.svg (Agent) and
// build/icon-creator.svg (Creator, P-SETUX.1 / ADR-0618; the Creator overlay
// electron-builder.creator.cjs points every icon field at the -creator files).
//
//   <name>.png  1024×1024  → electron-builder generates macOS .icns from it
//   <name>.ico  16…256 px  → Windows NSIS installer + .exe + shortcuts + taskbar
//
// Run automatically by the desktop `build` script (and the CI workflow) so a
// fresh checkout always has up-to-date icons without committing binaries.
//
// Deps: @resvg/resvg-js (prebuilt native rasterizer) + png-to-ico - both pure
// installs that work on Windows/macOS/Linux runners alike.

import { Resvg } from "@resvg/resvg-js";
import pngToIco from "png-to-ico";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Rasterize an SVG at an exact square pixel size. */
function renderPng(svg: string, size: number): Buffer {
  const r = new Resvg(svg, { fitTo: { mode: "width", value: size }, background: "rgba(0,0,0,0)" });
  return Buffer.from(r.render().asPng());
}

// Windows .ico needs the standard size ladder; png-to-ico packs them.
const icoSizes = [16, 24, 32, 48, 64, 128, 256];

for (const name of ["icon", "icon-creator"]) {
  const svg = readFileSync(join(HERE, `${name}.svg`), "utf8");
  // 1024 master → macOS icns (electron-builder) + a high-res reference.
  writeFileSync(join(HERE, `${name}.png`), renderPng(svg, 1024));
  writeFileSync(join(HERE, `${name}.ico`), await pngToIco(icoSizes.map((s) => renderPng(svg, s))));
  console.log(`icons: ${name}.png (1024) + ${name}.ico (${icoSizes.join(",")})`);
}
