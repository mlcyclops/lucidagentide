// desktop/build/make-icons.ts - rasterize the brand SVG into the icons
// electron-builder consumes. Source of truth is build/icon.svg.
//
//   icon.png  1024×1024  → electron-builder generates macOS .icns from it
//   icon.ico  16…256 px  → Windows NSIS installer + .exe + taskbar
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
const svg = readFileSync(join(HERE, "icon.svg"), "utf8");

/** Rasterize the SVG at an exact square pixel size. */
function renderPng(size: number): Buffer {
  const r = new Resvg(svg, { fitTo: { mode: "width", value: size }, background: "rgba(0,0,0,0)" });
  return Buffer.from(r.render().asPng());
}

// 1024 master → macOS icns (electron-builder) + a high-res reference.
const master = renderPng(1024);
writeFileSync(join(HERE, "icon.png"), master);

// Windows .ico needs the standard size ladder; png-to-ico packs them.
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const ico = await pngToIco(icoSizes.map(renderPng));
writeFileSync(join(HERE, "icon.ico"), ico);

console.log(`icons: icon.png (1024) + icon.ico (${icoSizes.join(",")})`);
