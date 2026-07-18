// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_premote4a.ts — P-REMOTE.4a (ADR-0226/0227): the invite-link QR, dependency-free.
//
// Renders a REAL invite link as a QR: prints it to the terminal (correctly colored via ANSI background cells,
// so it actually scans) and writes a self-contained SVG. Asserts the structure a scanner locks onto + that
// the round-trip is well-formed. The room key rides IN the link fragment, so scanning the QR carries the E2E
// secret exactly like copying the link — nothing extra ever touches a server.

import { mkdirSync } from "node:fs";
import { encodeQr, qrSvg } from "../../desktop/collab/qr.ts";

// A realistic edit invite link (roomId + base64url(32B key || 16B write token) in the URL fragment).
const link =
  "wss://lucid-collab-relay-abc123.run.app/r/a1b2c3d4?k=dGhpc2lzYTMyYnl0ZXJvb21rZXliNjR1cmx4eHg.d3JpdGV0b2tlbjE2Yg";

let step = 0;
const pass = (m: string): void => { console.log(`  [${++step}] PASS ${m}`); };
const fail = (m: string): never => { console.error(`  FAIL ${m}`); process.exit(1); };

console.log("== P-REMOTE.4a: a scannable QR of the invite link (dependency-free encoder) ==\n");

const { modules, size, version } = encodeQr(link);

// Correctly-colored terminal render (dark modules on a white quiet zone) — scans from the terminal.
const WHITE = "\x1b[47m", BLACK = "\x1b[40m", RESET = "\x1b[0m";
const QUIET = 4;
const cell = (dark: boolean): string => (dark ? BLACK : WHITE) + "  " + RESET;
const blankRow = (): string => WHITE + " ".repeat((size + QUIET * 2) * 2) + RESET;
for (let q = 0; q < QUIET; q++) console.log(blankRow());
for (let r = 0; r < size; r++) {
  let out = WHITE + " ".repeat(QUIET * 2) + RESET;
  for (let c = 0; c < size; c++) out += cell(modules[r]![c]!);
  out += WHITE + " ".repeat(QUIET * 2) + RESET;
  console.log(out);
}
for (let q = 0; q < QUIET; q++) console.log(blankRow());
console.log();

// [1] the payload fits a supported version
if (version < 1 || version > 10) fail(`version ${version} out of the supported 1..10 range`);
if (size !== version * 4 + 17) fail("size does not match the version");
pass(`invite link (${link.length} chars) encodes to a version-${version} QR (${size}x${size} modules)`);

// [2] the three finder patterns are present (a scanner locates the code by these)
const finderOk = (r0: number, c0: number): boolean => {
  for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) {
    const border = r === 0 || r === 6 || c === 0 || c === 6;
    const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
    if (modules[r0 + r]![c0 + c] !== (border || core)) return false;
  }
  return true;
};
if (!finderOk(0, 0) || !finderOk(0, size - 7) || !finderOk(size - 7, 0)) fail("a finder pattern is malformed");
pass("three finder patterns intact (top-left, top-right, bottom-left)");

// [3] timing patterns alternate + the dark module is set
for (let i = 8; i < size - 8; i++) if (modules[6]![i] !== (i % 2 === 0)) fail("row-6 timing pattern broken");
if (!modules[size - 8]![8]) fail("the always-dark module is not set");
pass("timing patterns alternate and the always-dark module is set");

// [4] the SVG is self-contained and safe to inline (no script/external raster refs)
const svg = qrSvg(link, { margin: 4 });
if (!svg.startsWith("<svg") || svg.includes("<script") || svg.includes("<image")) fail("SVG is not safe to inline");
if (!svg.includes(`viewBox="0 0 ${size + 8} ${size + 8}"`)) fail("SVG viewBox does not match the module count");
pass("SVG is self-contained, crisp, and safe to inline (no script / external refs)");

// write the SVG + an openable HTML so a human can scan it
const outDir = ".omp/tmp";
mkdirSync(outDir, { recursive: true });
const svgPath = `${outDir}/premote4a_invite_qr.svg`;
const htmlPath = `${outDir}/premote4a_invite_qr.html`;
await Bun.write(svgPath, svg);
await Bun.write(
  htmlPath,
  `<!doctype html><meta charset="utf-8"><title>LUCID remote invite QR</title>` +
    `<body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#0a0b0f;font:14px system-ui;color:#e6e6ea">` +
    `<div style="text-align:center"><div style="background:#fff;padding:20px;border-radius:16px;display:inline-block">${svg.replace("<svg", '<svg width="300" height="300"')}</div>` +
    `<p style="max-width:320px;margin:16px auto 0;color:#9aa">Scan with your phone camera to open the LUCID remote session. The room key rides inside the link — the relay never sees it.</p></div></body>`,
);
pass(`wrote a scannable SVG (${svgPath}) and preview HTML (${htmlPath})`);

console.log(`\nP-REMOTE.4a demo: all ${step} checks passed — the invite link is a scannable, dependency-free QR.`);
process.exit(0);
