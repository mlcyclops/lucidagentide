// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

"use strict";
// Lucid Admin Console (AC-1 revision 4, 7.1): a small QR encoder for the authenticator app enrollment URI.
// Byte mode (UTF-8), error correction level M, the smallest version that fits, the mask with the lowest
// ISO/IEC 18004 penalty (ties: the lowest mask number). Drawn as SVG rect elements; no outside code, no style
// attribute, no HTML sink. window.LucidQR.matrix(text) gives {version, mask, size, rows} (rows of booleans, dark
// true, no quiet zone); window.LucidQR.svg(text, label) gives an svg element with a 4-module quiet zone.
(function (root) {
  // Per version 1 to 40 at level M (index 0 unused): error correction codewords per block, and blocks.
  var ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28,
    28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
  var BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29,
    31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
  var FORMAT_M = 0; // the two format bits of level M
  var N1 = 3, N2 = 3, N3 = 40, N4 = 10;

  function utf8(text) {
    return Array.prototype.slice.call(new TextEncoder().encode(String(text)));
  }
  function rawModules(ver) {
    var result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }
  function dataCodewords(ver) {
    return Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ver] * BLOCKS[ver];
  }
  function countBits(ver) {
    return ver <= 9 ? 8 : 16;
  }
  function getBit(x, i) {
    return ((x >>> i) & 1) !== 0;
  }

  // ---- Reed-Solomon over GF(2^8) with the polynomial 0x11D ----
  function rsMultiply(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
  }
  function rsDivisor(degree) {
    var result = [];
    for (var i = 0; i < degree; i++) result.push(0);
    result[degree - 1] = 1;
    var r = 1;
    for (var k = 0; k < degree; k++) {
      for (var j = 0; j < result.length; j++) {
        result[j] = rsMultiply(result[j], r);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      r = rsMultiply(r, 0x02);
    }
    return result;
  }
  function rsRemainder(data, divisor) {
    var result = divisor.map(function () { return 0; });
    for (var n = 0; n < data.length; n++) {
      var factor = data[n] ^ result.shift();
      result.push(0);
      for (var i = 0; i < result.length; i++) result[i] ^= rsMultiply(divisor[i], factor);
    }
    return result;
  }

  function alignmentPositions(ver, size) {
    if (ver === 1) return [];
    var numAlign = Math.floor(ver / 7) + 2;
    var step = ver === 32 ? 26 : Math.floor((ver * 4 + numAlign * 2 + 1) / (numAlign * 2 - 2)) * 2;
    var result = [6];
    for (var pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  function encode(text) {
    var bytes = utf8(text);
    var ver = 0;
    for (var v = 1; v <= 40; v++) {
      var cb = countBits(v);
      if (bytes.length >= (1 << cb)) continue;
      if (4 + cb + bytes.length * 8 <= dataCodewords(v) * 8) {
        ver = v;
        break;
      }
    }
    if (!ver) throw new Error("too long for a QR code");
    var size = ver * 4 + 17;
    var capacity = dataCodewords(ver) * 8;

    // Bit stream: byte mode, count, data, terminator, pad to a byte, pad codewords 0xEC 0x11.
    var bits = [];
    var put = function (val, len) {
      for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
    };
    put(4, 4);
    put(bytes.length, countBits(ver));
    bytes.forEach(function (b) { put(b, 8); });
    put(0, Math.min(4, capacity - bits.length));
    put(0, (8 - (bits.length % 8)) % 8);
    for (var pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
    var data = [];
    for (var p = 0; p < bits.length; p += 8) {
      var byte = 0;
      for (var q = 0; q < 8; q++) byte = (byte << 1) | bits[p + q];
      data.push(byte);
    }

    // Error correction per block, then interleaving.
    var numBlocks = BLOCKS[ver];
    var eccLen = ECC_PER_BLOCK[ver];
    var rawCodewords = Math.floor(rawModules(ver) / 8);
    var numShort = numBlocks - (rawCodewords % numBlocks);
    var shortLen = Math.floor(rawCodewords / numBlocks);
    var divisor = rsDivisor(eccLen);
    var blocks = [];
    for (var bi = 0, k = 0; bi < numBlocks; bi++) {
      var dat = data.slice(k, k + shortLen - eccLen + (bi < numShort ? 0 : 1));
      k += dat.length;
      var ecc = rsRemainder(dat, divisor);
      var block = dat.slice();
      if (bi < numShort) block.push(0);
      blocks.push(block.concat(ecc));
    }
    var codewords = [];
    for (var ci = 0; ci < blocks[0].length; ci++) {
      for (var bj = 0; bj < blocks.length; bj++) {
        if (ci !== shortLen - eccLen || bj >= numShort) codewords.push(blocks[bj][ci]);
      }
    }

    // Function patterns.
    var modules = [], isFunction = [];
    for (var y0 = 0; y0 < size; y0++) {
      modules.push([]);
      isFunction.push([]);
      for (var x0 = 0; x0 < size; x0++) {
        modules[y0].push(false);
        isFunction[y0].push(false);
      }
    }
    var setF = function (x, y, dark) {
      modules[y][x] = dark;
      isFunction[y][x] = true;
    };
    for (var t = 0; t < size; t++) {
      setF(6, t, t % 2 === 0);
      setF(t, 6, t % 2 === 0);
    }
    var finder = function (cx, cy) {
      for (var dy = -4; dy <= 4; dy++) {
        for (var dx = -4; dx <= 4; dx++) {
          var dist = Math.max(Math.abs(dx), Math.abs(dy));
          var xx = cx + dx, yy = cy + dy;
          if (xx >= 0 && xx < size && yy >= 0 && yy < size) setF(xx, yy, dist !== 2 && dist !== 4);
        }
      }
    };
    finder(3, 3);
    finder(size - 4, 3);
    finder(3, size - 4);
    var align = alignmentPositions(ver, size);
    var na = align.length;
    for (var ai = 0; ai < na; ai++) {
      for (var aj = 0; aj < na; aj++) {
        if ((ai === 0 && aj === 0) || (ai === 0 && aj === na - 1) || (ai === na - 1 && aj === 0)) continue;
        for (var ady = -2; ady <= 2; ady++) {
          for (var adx = -2; adx <= 2; adx++) setF(align[ai] + adx, align[aj] + ady, Math.max(Math.abs(adx), Math.abs(ady)) !== 1);
        }
      }
    }
    var drawFormat = function (msk) {
      var fdata = (FORMAT_M << 3) | msk;
      var rem = fdata;
      for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      var fbits = ((fdata << 10) | rem) ^ 0x5412;
      for (var a = 0; a <= 5; a++) setF(8, a, getBit(fbits, a));
      setF(8, 7, getBit(fbits, 6));
      setF(8, 8, getBit(fbits, 7));
      setF(7, 8, getBit(fbits, 8));
      for (var b = 9; b < 15; b++) setF(14 - b, 8, getBit(fbits, b));
      for (var c = 0; c < 8; c++) setF(size - 1 - c, 8, getBit(fbits, c));
      for (var d = 8; d < 15; d++) setF(8, size - 15 + d, getBit(fbits, d));
      setF(8, size - 8, true);
    };
    drawFormat(0);
    if (ver >= 7) {
      var vrem = ver;
      for (var vi = 0; vi < 12; vi++) vrem = (vrem << 1) ^ ((vrem >>> 11) * 0x1f25);
      var vbits = (ver << 12) | vrem;
      for (var vb = 0; vb < 18; vb++) {
        var bit = getBit(vbits, vb);
        var va = size - 11 + (vb % 3), vc = Math.floor(vb / 3);
        setF(va, vc, bit);
        setF(vc, va, bit);
      }
    }

    // Codewords in the zigzag scan; remainder bits stay light.
    var bitIndex = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j;
          var upward = ((right + 1) & 2) === 0;
          var y = upward ? size - 1 - vert : vert;
          if (!isFunction[y][x] && bitIndex < codewords.length * 8) {
            modules[y][x] = getBit(codewords[bitIndex >>> 3], 7 - (bitIndex & 7));
            bitIndex++;
          }
        }
      }
    }

    var applyMask = function (msk) {
      for (var my = 0; my < size; my++) {
        for (var mx = 0; mx < size; mx++) {
          var invert;
          switch (msk) {
            case 0: invert = (mx + my) % 2 === 0; break;
            case 1: invert = my % 2 === 0; break;
            case 2: invert = mx % 3 === 0; break;
            case 3: invert = (mx + my) % 3 === 0; break;
            case 4: invert = (Math.floor(mx / 3) + Math.floor(my / 2)) % 2 === 0; break;
            case 5: invert = ((mx * my) % 2) + ((mx * my) % 3) === 0; break;
            case 6: invert = (((mx * my) % 2) + ((mx * my) % 3)) % 2 === 0; break;
            default: invert = (((mx + my) % 2) + ((mx * my) % 3)) % 2 === 0; break;
          }
          if (invert && !isFunction[my][mx]) modules[my][mx] = !modules[my][mx];
        }
      }
    };
    var best = 0, minPenalty = Infinity;
    for (var m = 0; m < 8; m++) {
      applyMask(m);
      drawFormat(m);
      var pen = penalty(modules, size);
      if (pen < minPenalty) {
        best = m;
        minPenalty = pen;
      }
      applyMask(m);
    }
    applyMask(best);
    drawFormat(best);
    return { version: ver, mask: best, size: size, rows: modules };
  }

  // ---- Penalty (ISO/IEC 18004 section 7.8.3) ----
  function penalty(modules, size) {
    var result = 0;
    var addHistory = function (run, history) {
      if (history[0] === 0) run += size;
      history.pop();
      history.unshift(run);
    };
    var countPatterns = function (h) {
      var n = h[1];
      var core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n;
      return (core && h[0] >= n * 4 && h[6] >= n ? 1 : 0) + (core && h[6] >= n * 4 && h[0] >= n ? 1 : 0);
    };
    var terminate = function (color, run, history) {
      if (color) {
        addHistory(run, history);
        run = 0;
      }
      run += size;
      addHistory(run, history);
      return countPatterns(history);
    };
    var line = function (get) {
      for (var a = 0; a < size; a++) {
        var color = false, run = 0, history = [0, 0, 0, 0, 0, 0, 0];
        for (var b = 0; b < size; b++) {
          if (get(a, b) === color) {
            run++;
            if (run === 5) result += N1;
            else if (run > 5) result++;
          } else {
            addHistory(run, history);
            if (!color) result += countPatterns(history) * N3;
            color = get(a, b);
            run = 1;
          }
        }
        result += terminate(color, run, history) * N3;
      }
    };
    line(function (y, x) { return modules[y][x]; });
    line(function (x, y) { return modules[y][x]; });
    for (var y = 0; y < size - 1; y++) {
      for (var x = 0; x < size - 1; x++) {
        var c = modules[y][x];
        if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) result += N2;
      }
    }
    var dark = 0;
    modules.forEach(function (row) { row.forEach(function (v) { if (v) dark++; }); });
    var total = size * size;
    var k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * N4;
    return result;
  }

  // ---- SVG: one rect per run of dark modules in a row, on a light square with a 4-module quiet zone ----
  var SVG = "http://www.w3.org/2000/svg";
  function svg(text, label) {
    var q = encode(text);
    var side = q.size + 8;
    var doc = root.document;
    var s = doc.createElementNS(SVG, "svg");
    s.setAttribute("viewBox", "0 0 " + side + " " + side);
    s.setAttribute("class", "qr");
    s.setAttribute("role", "img");
    s.setAttribute("aria-label", label || "QR code");
    s.setAttribute("shape-rendering", "crispEdges");
    var bg = doc.createElementNS(SVG, "rect");
    bg.setAttribute("class", "qr-light");
    bg.setAttribute("width", String(side));
    bg.setAttribute("height", String(side));
    s.appendChild(bg);
    for (var y = 0; y < q.size; y++) {
      for (var x = 0; x < q.size;) {
        if (!q.rows[y][x]) {
          x++;
          continue;
        }
        var start = x;
        while (x < q.size && q.rows[y][x]) x++;
        var r = doc.createElementNS(SVG, "rect");
        r.setAttribute("class", "qr-dark");
        r.setAttribute("x", String(start + 4));
        r.setAttribute("y", String(y + 4));
        r.setAttribute("width", String(x - start));
        r.setAttribute("height", "1");
        s.appendChild(r);
      }
    }
    return s;
  }

  root.LucidQR = { matrix: encode, svg: svg };
})(typeof window !== "undefined" ? window : globalThis);
