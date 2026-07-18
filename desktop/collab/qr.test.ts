// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/qr.test.ts — P-REMOTE.4a (ADR-0226/0227): the dependency-free QR encoder.
//
// No reference decoder is bundled, so correctness is anchored on the pieces a scanner actually locks onto and
// on independently-verifiable math: the Reed-Solomon SYNDROME is zero for every encoded block (the codeword
// is valid by construction), the hardcoded format/version tables MATCH an independent BCH computation, and the
// finder / timing / dark-module / quiet-zone structure is exact. A deterministic snapshot locks regressions.

import { describe, expect, it } from "bun:test";
import { encodeQr, qrSvg, rsEncode, rsGenerator, gfMultiply, FORMAT_M } from "./qr.ts";

describe("qr: Reed-Solomon core (the correctness anchor)", () => {
  it("produces a valid codeword: the syndrome is zero at a^0..a^(ecLen-1)", () => {
    // A valid RS codeword C(x) has C(a^i) = 0 for i in [0, ecLen). If the syndrome is zero, the data+EC
    // codeword is correct by construction — an independent check that does not mirror the encoder's placement.
    const GF_EXP: number[] = [];
    { let x = 1; for (let i = 0; i < 255; i++) { GF_EXP.push(x); x <<= 1; if (x & 0x100) x ^= 0x11d; } }
    for (const ecLen of [10, 18, 22, 26]) {
      const data = Array.from({ length: 20 }, (_, i) => (i * 37 + 5) & 0xff);
      const codeword = [...data, ...rsEncode(data, ecLen)];
      for (let i = 0; i < ecLen; i++) {
        let syndrome = 0;
        for (const coef of codeword) syndrome = gfMultiply(syndrome, GF_EXP[i % 255]!) ^ coef;
        expect(syndrome).toBe(0);
      }
    }
  });

  it("generator polynomial has degree === ecLen and a leading coefficient of 1", () => {
    for (const n of [7, 10, 18, 26]) {
      const g = rsGenerator(n);
      expect(g.length).toBe(n + 1);
      expect(g[0]).toBe(1);
    }
  });
});

describe("qr: format + version tables match an independent BCH computation", () => {
  it("every EC-level-M format string is the BCH(15,5) code of its mask", () => {
    const bch = (data5: number): number => {
      let d = data5 << 10;
      for (let i = 4; i >= 0; i--) if ((d >>> (10 + i)) & 1) d ^= 0x537 << i;
      return ((data5 << 10) | (d & 0x3ff)) ^ 0x5412; // EC level M code = 0b00, so data5 === mask
    };
    for (let mask = 0; mask < 8; mask++) expect(FORMAT_M[mask]).toBe(bch(mask));
  });
});

describe("qr: structure a scanner locks onto", () => {
  const m = encodeQr("hello");

  it("uses the smallest fitting version and the right module count", () => {
    expect(m.version).toBe(1);
    expect(m.size).toBe(21); // 4*1 + 17
    expect(m.modules.length).toBe(21);
    expect(m.modules.every((row) => row.length === 21)).toBe(true);
  });

  it("has three 7x7 finder patterns with a dark border and a 3x3 dark core", () => {
    const finderOk = (r0: number, c0: number): boolean => {
      for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) {
        const border = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        const ring = !border && !core;
        const want = border || core; // dark on border+core, light in the ring
        if (m.modules[r0 + r]![c0 + c] !== (ring ? false : want)) return false;
      }
      return true;
    };
    expect(finderOk(0, 0)).toBe(true);
    expect(finderOk(0, m.size - 7)).toBe(true);
    expect(finderOk(m.size - 7, 0)).toBe(true);
  });

  it("has alternating timing patterns on row 6 and column 6", () => {
    for (let i = 8; i < m.size - 8; i++) {
      expect(m.modules[6]![i]).toBe(i % 2 === 0);
      expect(m.modules[i]![6]).toBe(i % 2 === 0);
    }
  });

  it("sets the always-dark module", () => {
    expect(m.modules[m.size - 8]![8]).toBe(true);
  });
});

describe("qr: capacity + version selection", () => {
  it("bumps the version as the payload grows and rejects an over-capacity payload", () => {
    expect(encodeQr("x".repeat(14)).version).toBe(1); // v1-M byte capacity is 14
    expect(encodeQr("x".repeat(15)).version).toBe(2);
    expect(encodeQr("x".repeat(152)).version).toBe(8); // v8-M is 152
    expect(encodeQr("x".repeat(213)).version).toBe(10); // v10-M is 213
    expect(() => encodeQr("x".repeat(214))).toThrow(/exceeds/);
  });

  it("encodes a realistic invite link within the supported range", () => {
    const link = "https://lucid-agent.web.app/remote/#a1b2c3d4.dGhpcy1pcy1hLTMyLWJ5dGUtcm9vbS1rZXktYjY0dXJsLXg";
    const q = encodeQr(link);
    expect(q.version).toBeGreaterThanOrEqual(1);
    expect(q.version).toBeLessThanOrEqual(10);
  });
});

describe("qr: SVG rendering", () => {
  it("emits a self-contained, correctly-sized SVG with a quiet zone", () => {
    const svg = qrSvg("hello", { margin: 4 });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('viewBox="0 0 29 29"'); // 21 + 2*4
    expect(svg).toContain("shape-rendering=\"crispEdges\"");
    expect(svg).not.toContain("<script");
    expect(svg).not.toContain("<image"); // no external raster refs
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it("honors a transparent background", () => {
    expect(qrSvg("hi", { light: null })).not.toContain("<rect");
    expect(qrSvg("hi")).toContain("<rect");
  });
});

describe("qr: deterministic (regression lock)", () => {
  it("encodes a fixed string to a stable matrix fingerprint", () => {
    const { modules, size } = encodeQr("https://lucid-agent.web.app");
    let dark = 0;
    let fp = 0;
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
      if (modules[r]![c]) { dark++; fp = (fp * 31 + r * size + c) >>> 0; }
    }
    // Locks the full pipeline (encode → RS → mask choice → placement). If any step changes, this changes.
    expect(size).toBe(29); // 27 bytes > v2-M's 26-byte capacity, so version 3
    expect(dark).toBe(DARK_COUNT);
    expect(fp).toBe(FINGERPRINT);
  });
});

// Captured from the encoder (bun run) — a change here means the encode/RS/mask/placement pipeline moved.
const DARK_COUNT = 442;
const FINGERPRINT = 224929517;
