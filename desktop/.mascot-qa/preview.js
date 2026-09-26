// Copyright (c) 2026 TechLead 187 LLC | SPDX-License-Identifier: BUSL-1.1
(() => {

  // renderer/mascot.ts
  var MASCOT_W = 40;
  var MASCOT_H = 52;
  var MASCOT_PALETTE = {
    k: "#10161d",
    K: "#223140",
    D: "#18232e",
    S: "#eec39a",
    G: "#41ff8b",
    g: "#1e8f52",
    W: "#f4f7f5",
    B: "#0a0e12",
    M: "#c2d1dc",
    L: "#3d5a73",
    s: "#d8a377"
  };
  var MASCOT_THEMES = {
    lucid: { name: "Lucid", palette: { ...MASCOT_PALETTE } },
    ember: { name: "Ember", palette: { ...MASCOT_PALETTE, K: "#492a32", D: "#2c1b28", L: "#87504b", G: "#ff9354", g: "#a94732" } },
    glacier: { name: "Glacier", palette: { ...MASCOT_PALETTE, K: "#24465e", D: "#172e43", L: "#527f99", G: "#75e8ff", g: "#2987ab" } },
    orchid: { name: "Orchid", palette: { ...MASCOT_PALETTE, K: "#45305e", D: "#2a203e", L: "#795791", G: "#ec9cff", g: "#984faa" } },
    solar: { name: "Solar", palette: { ...MASCOT_PALETTE, K: "#4b3d29", D: "#2f281d", L: "#887046", G: "#ffe56b", g: "#af802d" } },
    stealth: { name: "Stealth", palette: { ...MASCOT_PALETTE, K: "#303b47", D: "#202833", L: "#596e7e", G: "#bddbcc", g: "#577b71" } }
  };
  function rows(base, over = {}) {
    const out = base.slice();
    for (const [i, r] of Object.entries(over))
      out[Number(i)] = r;
    return out;
  }
  var BASE_20 = [
    "....kkkkkkkkkk......",
    "...kKLLLLLLLLKk.....",
    "..kKKLLKKKKLLKKk....",
    ".kKKKKKKKKKKKKKKk...",
    ".kgGGGGGGGGGGGGgk...",
    ".kgGGGGGGGGGGGGgkGg.",
    ".ksSWWBSSSSWWBSsk.g.",
    ".ksSWWBSSSSWWBSsk...",
    ".kDKKKKKKKKKKKKDk...",
    ".kKKKKDKKKKDKKKKk...",
    "..kDKKKKKKKKKKDk....",
    "...kkDKKKKKKDkk.....",
    "....kKKKKKKKKk......",
    "..kkKKKKKKKKKKkk....",
    ".kKKDKKKKKKKKDKKk...",
    ".kKKDkKKKKKKkDKKk...",
    ".kSSkkKKKKKKkkSSk...",
    "..kk.kGGgGGGk.kk....",
    ".....kKKgKKKk.......",
    ".....kKKGKKKk.......",
    ".....kDKkkKDk.......",
    "....kKLk..kKLk......",
    "....kKKk..kKKk......",
    "....kDDk..kDDk......",
    "...kkkkk..kkkkk.....",
    "...................."
  ];
  var RAW_FRAMES_20 = {
    idleA: BASE_20,
    idleB: rows(BASE_20, {
      5: ".kgGGGGGGGGGGGGgk.Gg",
      6: ".ksSWWBSSSSWWBSskGg.",
      12: "...kKKKKKKKKKKk.....",
      13: ".kkKKKKKKKKKKKKkk..."
    }),
    idleC: rows(BASE_20, {
      5: ".kgGGGGGGGGGGGGgkG.."
    }),
    blink: rows(BASE_20, {
      6: ".ksSkkkSSSSkkkSsk...",
      7: ".ksSSSSSSSSSSSSsk..."
    }),
    guard: rows(BASE_20, {
      14: ".kKKDKKKKKKKKDKKk...",
      15: ".kSSkKKKKKKKKkSSk...",
      16: ".kSSkkKKKKKKkkSSk..."
    }),
    talkA: rows(BASE_20, {
      14: ".kKKDKKKKKKKKDSSk...",
      15: ".kKKDkKKKKKKkSSk....",
      16: ".kSSkkKKKKKKkkk....."
    }),
    talkB: rows(BASE_20, {
      14: ".kSSDKKKKKKKKDKKk...",
      15: "..kSSkKKKKKKkDKKk...",
      16: "...kkkKKKKKKkkSSk..."
    }),
    talkC: rows(BASE_20, {
      14: ".kSSDKKKKKKKKDSSk...",
      15: "..kSSkKKKKKKkSSk....",
      16: "...kkkKKKKKKkkk....."
    }),
    throwA: rows(BASE_20, {
      13: "..kkKKKKKKKKKKkkM...",
      14: ".kKKDKKKKKKKKDSSMk..",
      15: ".kKKDkKKKKKKkSSk....",
      16: ".kSSkkKKKKKKkkk....."
    }),
    throwB: rows(BASE_20, {
      13: "..kkKKKKKKKKKKkk..M.",
      14: ".kKKDKKKKKKKKDkkk.M.",
      15: ".kKKDkKKKKKKkSSSSk..",
      16: ".kSSkkKKKKKKkkkkk..."
    }),
    meditate: rows(BASE_20, {
      6: ".ksSkkkSSSSkkkSsk...",
      7: ".ksSSSSSSSSSSSSsk...",
      14: ".kKKDKKKKKKKKDKKk...",
      15: "..kSSkKKKKKKkSSk....",
      16: "...kkSSKKKKSSkk.....",
      17: "....kGGGGGGGGk......",
      18: "...kKKKKKKKKKKk.....",
      19: "..kKKKKkkkkKKKKk....",
      20: ".kKKKKk....kKKKKk...",
      21: ".kkkkk......kkkkk...",
      22: "....................",
      23: "....................",
      24: "...................."
    }),
    hang: rows(BASE_20, {
      12: ".kSSkKKKKKKKKkSSk...",
      13: ".kSSkKKKKKKKKkSSk...",
      14: ".kKKDKKKKKKKKDKKk...",
      15: ".kKKDkKKKKKKkDKKk...",
      16: "..kkkkKKKKKKkkkk....",
      21: "....kKKk..kKKk......",
      22: "....kKKkkkKKk.......",
      23: ".....kDDkkDD........",
      24: "......kkkkk........."
    }),
    hangB: rows(BASE_20, {
      11: "...kkKKKKKKKKkkSS...",
      12: ".kSSkKKKKKKKKkSSk...",
      13: ".kSSkKKKKKKKKkkk....",
      14: ".kKKDKKKKKKKKDKKk...",
      15: ".kKKDkKKKKKKkDKKk...",
      16: "..kkkkKKKKKKkkkk....",
      21: "....kKKk..kKKk......",
      22: "....kKKkkkKKk.......",
      23: ".....kDDkkDD........",
      24: "......kkkkk........."
    }),
    mantle: rows(BASE_20, {
      12: "....kKKKKKKKKk......",
      13: "..kkKKKKKKKKKKkk....",
      14: ".kSSDKKKKKKKKDSSk...",
      15: ".kkkkkKKKKKKkkkkk...",
      16: "......kKKKKKKk......",
      20: "....kDKkkKDkkk......",
      21: "...kKKk..kKKKKk.....",
      22: "...kKKk...kkkkk.....",
      23: "...kDDk.............",
      24: "..kkkkk............."
    }),
    land: rows(BASE_20, {
      14: ".kSSDKKKKKKKKDSSk...",
      15: ".kkkDkKKKKKKkDkkk...",
      16: "....kkKKKKKKkk......",
      20: "...kkDKkkKDkk.......",
      21: "..kKKKk..kKKKk......",
      22: ".kKKkk....kkKKk.....",
      23: ".kkkk......kkkk.....",
      24: "...................."
    }),
    sneakA: rows(BASE_20, {
      20: "....kDKkkKDkk.......",
      21: "..kkKKk..kKKKkk.....",
      22: ".kKKkk....kkKKKk....",
      23: ".kkkk......kkkkk....",
      24: "...................."
    }),
    sneakB: rows(BASE_20, {
      20: "....kkDKkkKDk.......",
      21: "...kkKKKk..kKKkk....",
      22: "..kKKKkk....kkKKk...",
      23: "..kkkkk......kkkk...",
      24: "...................."
    }),
    fall: rows(BASE_20, {
      12: ".kSSkKKKKKKKKkSSk...",
      13: ".kSSkKKKKKKKKkSSk...",
      14: ".kKKDKKKKKKKKDKKk...",
      15: ".kKKDkKKKKKKkDKKk...",
      16: "..kkkkKKKKKKkkkk....",
      20: "....kDKkkKDkk.......",
      21: "...kKKKkkKKKk.......",
      22: "....kkkkkkkk........",
      23: "....................",
      24: "...................."
    }),
    draw: rows(BASE_20, {
      12: "..MMkKKKKKKKKk......",
      13: "..kkKKKKKKKKKKkk....",
      14: ".kKKSSSKKKKKKDKKk...",
      15: ".kKKDkKKKKKKkDKKk...",
      16: "..kkkkKKKKKKkkkk...."
    }),
    slashUp: rows(BASE_20, {
      12: "....kKKKKKKKKkM.....",
      13: "..kkKKKKKKKKKSSk....",
      14: ".kKKDKKKKKKKKDkk....",
      15: ".kKKDkKKKKKKkDKKk...",
      16: "..kkkkKKKKKKkkkk...."
    }),
    slash: rows(BASE_20, {
      14: ".kKKDKKKKKKKKDSSkM..",
      15: ".kKKDkKKKKKKkSSSkk..",
      16: "..kkkkKKKKKKkkkk....",
      20: "....kDKkkKDkk.......",
      21: "...kKKk..kKKKk......",
      22: "..kKKk....kKKKk.....",
      23: "..kDDk.....kkkk.....",
      24: ".kkkkk.............."
    }),
    slashEnd: rows(BASE_20, {
      14: ".kKKDKKKKKKKKDKKk...",
      15: ".kKKDkKKKKKKkDSSk...",
      16: "..kkkkKKKKKKkkSSkM..",
      20: "....kDKkkKDkk.......",
      21: "...kKKk..kKKKk......",
      22: "..kKKk....kKKKk.....",
      23: "..kDDk.....kkkk.....",
      24: ".kkkkk.............."
    }),
    victoryA: rows(BASE_20, {
      13: "..kkKKKKKKKKKKkkSSk.",
      14: ".kKKDKKKKKKKKDkSSk..",
      15: ".kKKDkKKKKKKkDkk....",
      16: ".kSSkkKKKKKKkk......",
      21: "....kKKk..kKKk......",
      22: "....kDDk..kDDk......",
      23: "...kkkkk..kkkkk.....",
      24: "...................."
    }),
    victoryB: rows(BASE_20, {
      12: "....kKKKKKKKKk...SS.",
      13: "..kkKKKKKKKKKKkkSSk.",
      14: ".kKKDKKKKKKKKDkkk...",
      15: ".kKKDkKKKKKKkDk.....",
      16: ".kSSkkKKKKKKkk......",
      20: ".....kDKkkKDk.......",
      21: "....kKKkkkKKk.......",
      22: "....kDDk..kDDk......",
      23: "...kkkkk..kkkkk.....",
      24: "...................."
    }),
    victoryC: rows(BASE_20, {
      5: ".kgGGGGGGGGGGGGgkGGG",
      6: ".ksSWWBSSSSWWBSsk.gG"
    })
  };
  var BASE_40 = [
    "........kkkkkkkkkkkkkkkkkkkk............",
    ".......kkKKKLLLLLLLLLLLLKKKkk...........",
    "......kKKKKKLLLLLLLLLLLLKKKKKk..........",
    ".....kKKKKKKLLLLLLLLLLLLKKKKKKk.........",
    "....kKKKKKKKKLLLLLLLLLLKKKKKKKKk........",
    "....kKKKKKKKKKLLLLLLLLKKKKKKKKKk........",
    "...kKKKKKKKKKKKLLLLLLKKKKKKKKKKKk.......",
    "...kKKKKKKKKKKKKKKKKKKKKKKKKKKKKKk......",
    "...kKKKKKKKKKKKKKKKKKKKKKKKKKKKKKk......",
    "...kgggggggggggggggggggggggggggggk......",
    "..kggGGGGGGGGGGGGGGGGGGGGGGGGGGggk......",
    "..kgGGGGGGGGGGGGGGGGGGGGGGGGGGGGgk......",
    "..kgGGGGGGGGGGGGGGGGGGGGGGGGGGGGgk..gg..",
    "..kggGGGGGGGGGGGGGGGGGGGGGGGGGGggk.Ggg..",
    "..kssSSSSSSSSSSSSSSSSSSSSSSSSSSSSsskGg..",
    ".kssSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSssk...",
    ".kssSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSsk..",
    ".kssSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSsk..",
    ".kssSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSssk...",
    "..kssSSSSSSSSSSSSSSSSSSSSSSSSSSSSssk....",
    "..kkDDKKKKKKKKKKKKKKKKKKKKKKKKDDKk......",
    "..kKkDDKKKKKKKKKKKKKKKKKKKKKKDDKkKk.....",
    "..kKKkKDKKKKKKDKKKKKDKKKKKKDKkKKk.......",
    "...kKKKKDKKKKKDDKKKKDDKKKKKDKKKKk.......",
    "....kkKKKKKDKKKKKKKKKKKKKKDKKKKKKkk.....",
    "...kKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKk....",
    "..kKKKDKkKKKKKKKKKKKKKKKKKKKKKkKDKKk....",
    "..kKKDk..kkkKKKKKKKKKKKKKKKkkk..kDDKk...",
    ".kKKDk.....kKKKKKKKKKKKKKKKk.....kDDKk..",
    ".kKKDk.....kKKKKKKKKKKKKKKKk.....kDDKk..",
    ".kKSSSk...kkKKKKKKKKKKKKKKKkk....kSSSk..",
    ".kSSSSk...kKKKKKKKKKKKKKKKKKk....kSSSSk.",
    ".kSSSSk...kKKKDKKKKKKKKKKDKKk....kSSSk..",
    "..kkkk....kKKKkDDKKKKKKDDKKKk.....kkk...",
    "..........kkGGggggggggggggGGkk..........",
    "..........kGGGGGGGGGGGGGGGGGGk..........",
    "..........kkKKKggggggggKKKKkk...........",
    "...........kKKKGGGGGGGGKKKKk............",
    "...........kKKKKGGGGGGKKKKKk............",
    "...........kKDKKkkkkkkKKDDKk............",
    "..........kKLLKk......kKLLKk............",
    "..........kKLLKk......kKLLKk............",
    "..........kKKKKk......kKKKKk............",
    "..........kKKKKk......kKKKKk............",
    "..........kDDDk........kDDDk............",
    ".........kDDDDk........kDDDDk...........",
    ".........kDDDDk........kDDDDk...........",
    ".........kkkkkk........kkkkkk...........",
    "........kKKKKKk........kKKKKKk..........",
    "........kDDDDDk........kDDDDDk..........",
    "........kkkkkkk........kkkkkkk..........",
    "........................................"
  ];
  function upscaleEPX(grid) {
    const out = [];
    const h = grid.length;
    const w = grid[0].length;
    for (let y = 0;y < h; y++) {
      let r0 = "";
      let r1 = "";
      for (let x = 0;x < w; x++) {
        const p = grid[y][x];
        const a = y > 0 ? grid[y - 1][x] : p;
        const d = y < h - 1 ? grid[y + 1][x] : p;
        const c = x > 0 ? grid[y][x - 1] : p;
        const b = x < w - 1 ? grid[y][x + 1] : p;
        if (a !== d && b !== c) {
          r0 += (a === c ? a : p) + (a === b ? a : p);
          r1 += (c === d ? c : p) + (b === d ? b : p);
        } else {
          r0 += p + p;
          r1 += p + p;
        }
      }
      out.push(r0, r1);
    }
    return out;
  }
  var EYES = {
    focused: [
      ["kkSSSSSSS", "SkkkkSSSS", "SWWWWkkSS", "SSWWWWWSS", "SSSWWWSSS", "SSSSSSSSS"],
      ["SSSSSSSkk", "SSSkkkkSS", "SSkkWWWWW", "SWWWWWWSS", "SSWWWWSSS", "SSSSSSSSS"]
    ],
    curious: [
      ["SkkkkkSSS", "SSSSSSSSS", "SSWWWWWSS", "SWWWWWWWS", "SSWWWWWSS", "SSSSSSSSS"],
      ["SSSSSkkkS", "SSSkkSSSS", "SSSWWWWSS", "SSWWWWWWS", "SSSWWWWSS", "SSSSSSSSS"]
    ],
    joyful: [
      ["SSkkkSSSS", "SkSSSkkSS", "SSWWWWWSS", "SWWWWWWSS", "SSkkkkSSS", "SSSSSSSSS"],
      ["SSSSkkkSS", "SSkkSSSkS", "SSWWWWWSS", "SSWWWWWWS", "SSSkkkkSS", "SSSSSSSSS"]
    ],
    closed: [
      ["SSSSSSSSS", "SSSSSSSSS", "SkSSSSSkS", "SSkkkkkSS", "SSSSSSSSS", "SSSSSSSSS"],
      ["SSSSSSSSS", "SSSSSSSSS", "SSkSSSSSk", "SSSkkkkkS", "SSSSSSSSS", "SSSSSSSSS"]
    ]
  };
  function expressiveEyes(grid, expression, offset = 0, gaze = 0) {
    for (let y = 12;y <= 19; y++)
      for (let x = 0;x < 35; x++) {
        const color = BASE_40[y][x];
        grid[y + offset][x] = color === "W" || color === "B" ? "S" : color;
      }
    for (let eye = 0;eye < 2; eye++) {
      const shape = EYES[expression][eye];
      const left = eye === 0 ? 7 : 22;
      for (let y = 0;y < shape.length; y++)
        for (let x = 0;x < shape[y].length; x++) {
          grid[14 + offset + y][left + x] = shape[y][x];
        }
      if (expression === "closed")
        continue;
      for (let y = 3;y <= (expression === "joyful" ? 3 : 4); y++)
        for (let x = 4 + gaze;x <= 5 + gaze; x++) {
          if (grid[14 + offset + y][left + x] === "W")
            grid[14 + offset + y][left + x] = "B";
        }
    }
  }
  var MASCOT_FRAMES = {};
  for (const [key, frame20] of Object.entries(RAW_FRAMES_20)) {
    const up40 = upscaleEPX(frame20);
    const out40 = [];
    for (let y = 0;y < MASCOT_H; y++) {
      let rowStr = "";
      const y20 = Math.floor(y / 2);
      for (let x = 0;x < MASCOT_W; x++) {
        if (frame20[y20] === BASE_20[y20]) {
          rowStr += BASE_40[y][x];
        } else {
          rowStr += up40[y][x];
        }
      }
      out40.push(rowStr);
    }
    const expression = key === "blink" || key === "meditate" ? "closed" : key.startsWith("victory") ? "joyful" : key.startsWith("idle") || key.startsWith("talk") ? "curious" : "focused";
    const grid = out40.map((row) => [...row]);
    expressiveEyes(grid, expression, 0, key === "talkB" ? -1 : key === "idleC" ? 1 : 0);
    MASCOT_FRAMES[key] = grid.map((row) => row.join(""));
  }
  function actionFrame(p) {
    const grid = Array.from({ length: MASCOT_H }, () => Array(MASCOT_W).fill("."));
    const dot = (x, y, r, color) => {
      for (let dy = -r;dy <= r; dy++)
        for (let dx = -r;dx <= r; dx++) {
          if (dx * dx + dy * dy > r * r + 1)
            continue;
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && xx < MASCOT_W && yy >= 0 && yy < MASCOT_H)
            grid[yy][xx] = color;
        }
    };
    const line = (a, b, r, color) => {
      const steps = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), 1);
      for (let i = 0;i <= steps; i++)
        dot(Math.round(a[0] + (b[0] - a[0]) * i / steps), Math.round(a[1] + (b[1] - a[1]) * i / steps), r, color);
    };
    const limb = (a, b, c, far) => {
      line(a, b, 3, "k");
      line(b, c, 3, "k");
      line(a, b, 2, far ? "D" : "K");
      line(b, c, 2, far ? "D" : "K");
      line([a[0] - 1, a[1]], [b[0] - 1, b[1]], 0, far ? "K" : "L");
      line([b[0] - 1, b[1]], [c[0] - 1, c[1] - 1], 0, far ? "K" : "L");
    };
    const boot = (a, far) => {
      line([a[0] - 1, a[1]], [a[0] + 3, a[1]], 2, "k");
      line([a[0], a[1] - 1], [a[0] + 2, a[1] - 1], 0, far ? "K" : "L");
    };
    const hand = (a) => {
      dot(a[0], a[1], 2, "k");
      dot(a[0], a[1], 1, "S");
    };
    const hipY = 38 + p.bob;
    limb([20 + p.lean, hipY], p.backKnee, p.backFoot, true);
    boot(p.backFoot, true);
    limb([15 + p.lean, hipY], p.frontKnee, p.frontFoot, false);
    boot(p.frontFoot, false);
    limb([24 + p.lean, 27 + p.bob], p.backElbow, p.backHand, true);
    hand(p.backHand);
    for (let y = 25;y <= 39; y++) {
      const edge = y < 29 ? 11 : y < 36 ? 12 : 13;
      for (let x = edge;x <= 27 - (edge - 11); x++)
        grid[y + p.bob][x + p.lean] = x === edge || x === 27 - (edge - 11) ? "k" : "K";
    }
    line([13 + p.lean, 26 + p.bob], [20 + p.lean, 34 + p.bob], 0, "L");
    line([24 + p.lean, 26 + p.bob], [17 + p.lean, 35 + p.bob], 0, "D");
    line([13 + p.lean, 36 + p.bob], [25 + p.lean, 36 + p.bob], 1, "g");
    line([13 + p.lean, 35 + p.bob], [25 + p.lean, 35 + p.bob], 0, "G");
    line([19 + p.lean, 36 + p.bob], [20 + p.lean, 40 + p.bob], 0, "G");
    limb([12 + p.lean, 27 + p.bob], p.frontElbow, p.frontHand, false);
    hand(p.frontHand);
    for (let y = 0;y < 24; y++)
      for (let x = 0;x < MASCOT_W; x++) {
        const color = BASE_40[y][x];
        const yy = y + 1 + p.bob;
        if (color !== "." && yy >= 0)
          grid[yy][x] = color;
      }
    expressiveEyes(grid, p.expression ?? "focused", 1 + p.bob, p.gaze ?? 1);
    if (p.prop === "terminal") {
      const beat = p.propBeat ?? 0;
      for (let y = 28;y <= 35; y++)
        for (let x = 14;x <= 31; x++) {
          grid[y][x] = y === 28 || y === 35 || x === 14 || x === 31 ? "k" : "D";
        }
      line([16, 30], [18, 31], 0, "G");
      line([18, 31], [16, 32], 0, "G");
      line([21, 30], [26 + beat % 3, 30], 0, "g");
      line([21, 32], [23 + beat % 4, 32], 0, "G");
      line([12, 36], [33, 36], 1, "k");
      line([13, 36], [32, 36], 0, "L");
      line([12, 38], [33, 38], 1, "k");
      line([13, 38], [32, 38], 0, "D");
      for (let x = 15;x <= 30; x += 3)
        grid[37][x] = x === 15 + beat * 3 ? "G" : "M";
      hand(p.backHand);
      hand(p.frontHand);
    } else if (p.prop === "scanner") {
      const [x, y] = p.backHand;
      line([x, y - 3], [x, y + 1], 1, "k");
      for (let dy = -9;dy <= -3; dy++)
        for (let dx = -3;dx <= 3; dx++) {
          grid[y + dy][x + dx] = dy === -9 || dy === -3 || dx === -3 || dx === 3 ? "k" : "L";
        }
      for (let dy = -8;dy <= -5; dy++)
        for (let dx = -2;dx <= 2; dx++) {
          grid[y + dy][x + dx] = dy === -8 + (p.propBeat ?? 0) % 4 ? "G" : "D";
        }
      grid[y - 4][x + 1] = "G";
      hand(p.backHand);
    }
    if (p.staff) {
      line(p.staff[0], p.staff[1], 1, "k");
      line(p.staff[0], p.staff[1], 0, "L");
      dot(p.staff[0][0], p.staff[0][1], 0, "G");
      dot(p.staff[1][0], p.staff[1][1], 0, "G");
      hand(p.backHand);
      hand(p.frontHand);
    }
    return grid.map((row) => row.join(""));
  }
  var stance = {
    bob: 0,
    lean: 0,
    backKnee: [24, 43],
    backFoot: [27, 49],
    frontKnee: [13, 43],
    frontFoot: [10, 49],
    backElbow: [27, 31],
    backHand: [27, 26],
    frontElbow: [9, 32],
    frontHand: [14, 29]
  };
  MASCOT_FRAMES.guard = actionFrame(stance);
  MASCOT_FRAMES.punchA = actionFrame({ ...stance, lean: -1, backElbow: [24, 32], backHand: [21, 30] });
  MASCOT_FRAMES.punchB = actionFrame({ ...stance, lean: 1, backKnee: [26, 44], backElbow: [30, 27], backHand: [36, 27] });
  MASCOT_FRAMES.punchC = actionFrame({ ...stance, lean: 1, backElbow: [29, 28], backHand: [32, 28] });
  MASCOT_FRAMES.punchD = actionFrame({ ...stance, backElbow: [28, 31], backHand: [28, 27] });
  MASCOT_FRAMES.kickA = actionFrame({ ...stance, lean: -1, backKnee: [26, 34], backFoot: [24, 40] });
  MASCOT_FRAMES.kickB = actionFrame({ ...stance, lean: -2, backKnee: [27, 34], backFoot: [34, 31], backElbow: [26, 29], backHand: [25, 26] });
  MASCOT_FRAMES.kickC = actionFrame({ ...stance, lean: -1, backKnee: [26, 33], backFoot: [26, 38] });
  MASCOT_FRAMES.kickD = actionFrame({ ...stance, backKnee: [25, 40], backFoot: [27, 45] });
  var gait = [
    [0, [14, 43], [8, 49], [22, 43], [29, 49]],
    [1, [12, 43], [9, 46], [21, 45], [25, 49]],
    [0, [16, 41], [12, 43], [20, 44], [21, 49]],
    [-1, [22, 41], [23, 45], [18, 44], [17, 49]],
    [0, [23, 43], [29, 49], [13, 43], [8, 49]],
    [1, [22, 45], [25, 49], [12, 43], [9, 46]],
    [0, [21, 44], [21, 49], [16, 41], [12, 43]],
    [-1, [18, 44], [17, 49], [22, 41], [23, 45]]
  ];
  var armSwing = [-3, -2, 0, 2, 3, 2, 0, -2];
  for (let i = 0;i < gait.length; i++) {
    const [bob, frontKnee, frontFoot, backKnee, backFoot] = gait[i];
    const swing = armSwing[i];
    MASCOT_FRAMES["run" + String.fromCharCode(65 + i)] = actionFrame({
      ...stance,
      bob,
      frontKnee,
      frontFoot,
      backKnee,
      backFoot,
      frontElbow: [10 + swing, 31 + bob],
      frontHand: [14 + swing, 29 + bob],
      backElbow: [26 - swing, 31 + bob],
      backHand: [29 - swing, 28 + bob]
    });
  }
  var coding = {
    ...stance,
    expression: "focused",
    gaze: 0,
    prop: "terminal",
    frontElbow: [9, 33],
    frontHand: [16, 37],
    backElbow: [32, 33],
    backHand: [28, 37]
  };
  MASCOT_FRAMES.codingA = actionFrame(coding);
  MASCOT_FRAMES.codingB = actionFrame({ ...coding, propBeat: 1, frontElbow: [10, 32], frontHand: [17, 35], backHand: [27, 38] });
  MASCOT_FRAMES.codingC = actionFrame({ ...coding, propBeat: 2, frontHand: [16, 38], backElbow: [31, 32], backHand: [27, 35] });
  MASCOT_FRAMES.codingD = actionFrame({ ...coding, propBeat: 3, expression: "curious", frontHand: [18, 37], backHand: [29, 37] });
  var scanning = {
    ...stance,
    expression: "curious",
    gaze: 1,
    prop: "scanner",
    frontElbow: [10, 32],
    frontHand: [18, 33],
    backElbow: [28, 36],
    backHand: [33, 34]
  };
  MASCOT_FRAMES.scanningA = actionFrame(scanning);
  MASCOT_FRAMES.scanningB = actionFrame({ ...scanning, propBeat: 1, backElbow: [29, 34], backHand: [34, 31] });
  MASCOT_FRAMES.scanningC = actionFrame({ ...scanning, propBeat: 2, lean: 1, expression: "focused", backElbow: [28, 32], backHand: [32, 29], frontHand: [21, 32] });
  MASCOT_FRAMES.scanningD = actionFrame({ ...scanning, propBeat: 3, backElbow: [29, 35], backHand: [33, 32] });
  MASCOT_FRAMES.staffA = actionFrame({ ...stance, frontElbow: [18, 32], frontHand: [30, 38], backElbow: [28, 32], backHand: [30, 29], staff: [[30, 23], [30, 49]] });
  MASCOT_FRAMES.staffB = actionFrame({ ...stance, lean: -1, backKnee: [25, 44], frontElbow: [14, 34], frontHand: [22, 38], backElbow: [27, 32], backHand: [30, 28], staff: [[14, 48], [34, 23]] });
  MASCOT_FRAMES.staffC = actionFrame({ ...stance, lean: 1, frontKnee: [10, 43], frontFoot: [6, 49], backFoot: [30, 49], frontElbow: [10, 30], frontHand: [15, 30], backElbow: [30, 31], backHand: [27, 30], staff: [[3, 30], [37, 30]] });
  MASCOT_FRAMES.staffD = actionFrame({ ...stance, bob: 1, lean: 1, gaze: -1, frontKnee: [10, 44], frontFoot: [6, 49], backFoot: [30, 49], frontElbow: [9, 34], frontHand: [13, 33], backElbow: [28, 37], backHand: [25, 39], staff: [[3, 28], [37, 45]] });
  MASCOT_FRAMES.staffE = actionFrame({ ...stance, gaze: -1, frontElbow: [12, 35], frontHand: [18, 36], backElbow: [28, 36], backHand: [26, 32], staff: [[6, 42], [36, 27]] });
  MASCOT_FRAMES.staffF = actionFrame({ ...stance, frontElbow: [16, 34], frontHand: [27, 38], backElbow: [28, 32], backHand: [30, 29], staff: [[24, 47], [32, 23]] });
  var MASCOT_RUN_FRAMES = ["runA", "runB", "runC", "runD", "runE", "runF", "runG", "runH"];
  var MASCOT_RUN_BEAT_MS = 80;
  var ACTIVITY_MS = 6500;
  var LOOPS = {
    idle: [
      { frame: "idleA", ms: 1900 },
      { frame: "idleC", ms: 420 },
      { frame: "idleB", ms: 850 },
      { frame: "idleC", ms: 380 },
      { frame: "idleA", ms: 1150 },
      { frame: "blink", ms: 130 },
      { frame: "idleA", ms: 110 },
      { frame: "blink", ms: 120 }
    ],
    listening: [
      { frame: "guard", ms: 1150 },
      { frame: "idleB", ms: 200 },
      { frame: "guard", ms: 850 },
      { frame: "blink", ms: 120 }
    ],
    speaking: [
      { frame: "talkA", ms: 360 },
      { frame: "idleA", ms: 190 },
      { frame: "talkB", ms: 360 },
      { frame: "talkC", ms: 300 },
      { frame: "idleA", ms: 190 }
    ],
    victory: [
      { frame: "victoryA", ms: 200 },
      { frame: "victoryB", ms: 340 },
      { frame: "victoryA", ms: 150 },
      { frame: "victoryC", ms: 310 }
    ]
  };
  var WORK_ACTIVITIES = ["kata", "shuriken", "meditate", "coding", "scanning", "staff"];
  var WORK_THEMES = [MASCOT_THEMES.lucid, MASCOT_THEMES.ember, MASCOT_THEMES.glacier, MASCOT_THEMES.orchid, MASCOT_THEMES.solar, MASCOT_THEMES.stealth];
  var WORK_LOOPS = {
    kata: [
      { frame: "idleA", ms: 200 },
      { frame: "guard", ms: 200 },
      { frame: "punchA", ms: 200 },
      { frame: "punchB", ms: 80 },
      { frame: "punchC", ms: 100 },
      { frame: "punchD", ms: 240 },
      { frame: "guard", ms: 200 },
      { frame: "kickA", ms: 230 },
      { frame: "kickB", ms: 120 },
      { frame: "kickC", ms: 160 },
      { frame: "kickD", ms: 240 },
      { frame: "idleB", ms: 350 }
    ],
    shuriken: [
      { frame: "idleA", ms: 460 },
      { frame: "guard", ms: 260 },
      { frame: "throwA", ms: 280 },
      { frame: "throwB", ms: 360 },
      { frame: "idleB", ms: 380 }
    ],
    meditate: [{ frame: "meditate", ms: 2600 }, { frame: "meditate", ms: 2600 }],
    coding: [
      { frame: "codingA", ms: 180 },
      { frame: "codingB", ms: 120 },
      { frame: "codingA", ms: 100 },
      { frame: "codingC", ms: 120 },
      { frame: "codingB", ms: 140 },
      { frame: "codingD", ms: 380 }
    ],
    scanning: [
      { frame: "scanningA", ms: 360 },
      { frame: "scanningB", ms: 240 },
      { frame: "scanningC", ms: 440 },
      { frame: "scanningD", ms: 240 },
      { frame: "scanningA", ms: 240 }
    ],
    staff: [
      { frame: "staffA", ms: 320 },
      { frame: "staffB", ms: 260 },
      { frame: "staffC", ms: 90 },
      { frame: "staffD", ms: 150 },
      { frame: "staffE", ms: 200 },
      { frame: "staffF", ms: 220 }
    ]
  };
  function workSlot(elapsedMs) {
    return Math.floor(Math.max(0, elapsedMs) / ACTIVITY_MS) % WORK_ACTIVITIES.length;
  }
  function workActivity(elapsedMs) {
    return WORK_ACTIVITIES[workSlot(elapsedMs)];
  }
  function beatFrame(beats, elapsedMs) {
    let cycle = 0;
    for (const beat of beats)
      cycle += beat.ms;
    let t = Math.max(0, elapsedMs) % cycle;
    for (const beat of beats) {
      if (t < beat.ms)
        return beat.frame;
      t -= beat.ms;
    }
    return beats[0].frame;
  }
  function mascotActivityFrame(activity, elapsedMs) {
    return beatFrame(Object.prototype.hasOwnProperty.call(WORK_LOOPS, activity) ? WORK_LOOPS[activity] : LOOPS.idle, elapsedMs);
  }
  function mascotFrame(snap, now) {
    const elapsed = Math.max(0, now - snap.since);
    return snap.state === "working" ? mascotActivityFrame(workActivity(elapsed), elapsed) : beatFrame(LOOPS[snap.state], elapsed);
  }
  var diag = [];
  for (let y = 0;y < 12; y++) {
    const row = Array.from({ length: 13 }, () => ".");
    const c = 12 - y;
    row[c] = "W";
    if (c - 1 >= 0 && y > 0)
      row[c - 1] = "M";
    diag.push(row.join(""));
  }
  function paintRows(ctx, f, scale, ox, oy, palette = MASCOT_PALETTE) {
    for (let y = 0;y < f.length; y++) {
      const row = f[y];
      for (let x = 0;x < row.length; x++) {
        const c = palette[row[x]];
        if (!c)
          continue;
        ctx.fillStyle = c;
        ctx.fillRect(ox + x * scale, oy + y * scale, scale, scale);
      }
    }
  }
  function paintFrame(ctx, frameId, scale, ox, oy, palette = MASCOT_PALETTE) {
    paintRows(ctx, MASCOT_FRAMES[frameId] ?? MASCOT_FRAMES.idleA, scale, ox, oy, palette);
  }

  // .mascot-qa/preview.ts
  var roster = [
    { theme: "lucid", title: "LUCID / Original", activity: "kata", role: "Precision kata", note: "Wind-up, strike, recoil. The original green." },
    { theme: "ember", title: "EMBER / Striker", activity: "staff", role: "Staff practice", note: "Warm copper armor. A measured staff sweep." },
    { theme: "glacier", title: "GLACIER / Scout", activity: "scanning", role: "Field scanning", note: "Cold blue kit. Eyes tracking the next signal." },
    { theme: "orchid", title: "ORCHID / Builder", activity: "coding", role: "Terminal work", note: "Violet wraps. Small hands, serious debugging." },
    { theme: "solar", title: "SOLAR / Sentinel", activity: "shuriken", role: "Throwing practice", note: "Gold accents. Set, aim, release, recover." },
    { theme: "stealth", title: "STEALTH / Monk", activity: "meditate", role: "Quiet focus", note: "Muted slate. A moment between missions." }
  ];
  var host = document.querySelector("#roster");
  var cards = roster.map((entry, i) => {
    const theme = MASCOT_THEMES[entry.theme];
    const card = document.createElement("article");
    card.className = "card";
    card.style.setProperty("--accent", theme.palette.G);
    const meta = document.createElement("div");
    meta.className = "card-top";
    const number = document.createElement("span");
    number.textContent = String(i + 1).padStart(2, "0");
    const badge = document.createElement("span");
    badge.textContent = entry.role;
    meta.append(number, badge);
    const cv = document.createElement("canvas");
    cv.width = 240;
    cv.height = 240;
    cv.setAttribute("aria-label", entry.title + " animated " + entry.role);
    cv.setAttribute("role", "img");
    const title = document.createElement("h2");
    title.textContent = entry.title;
    title.title = entry.title;
    const note = document.createElement("p");
    note.textContent = entry.note;
    const foot = document.createElement("div");
    foot.className = "card-foot";
    const small = document.createElement("canvas");
    small.width = MASCOT_W;
    small.height = MASCOT_H;
    small.setAttribute("aria-label", "Actual 40 by 52 pixel size");
    const frame = document.createElement("span");
    frame.className = "frame-name";
    foot.append(small, frame);
    card.append(meta, cv, title, note, foot);
    host.append(card);
    return { ...entry, cv, ctx: cv.getContext("2d"), small, smallCtx: small.getContext("2d"), frame, palette: theme.palette, lastFrame: "" };
  });
  var mode = document.querySelector("#activity");
  for (const activity of WORK_ACTIVITIES) {
    const option = document.createElement("option");
    option.value = activity;
    option.textContent = activity[0].toUpperCase() + activity.slice(1);
    mode.append(option);
  }
  var speed = document.querySelector("#speed");
  var pause = document.querySelector("#pause");
  var status = document.querySelector("#status");
  var motion = matchMedia("(prefers-reduced-motion: reduce)");
  var paused = motion.matches;
  var time = 0;
  var last = performance.now();
  function syncPause() {
    pause.textContent = paused ? "Play animation" : "Pause animation";
    pause.setAttribute("aria-pressed", String(paused));
  }
  syncPause();
  pause.onclick = () => {
    paused = !paused;
    syncPause();
  };
  document.querySelector("#step").onclick = () => {
    paused = true;
    time += MASCOT_RUN_BEAT_MS;
    syncPause();
    draw();
  };
  mode.onchange = () => {
    time = 0;
    draw();
  };
  motion.addEventListener("change", (event) => {
    paused = event.matches;
    syncPause();
  });
  function frameAt(activity) {
    if (activity === "run")
      return MASCOT_RUN_FRAMES[Math.floor(time / MASCOT_RUN_BEAT_MS) % MASCOT_RUN_FRAMES.length];
    if (activity === "idle" || activity === "speaking" || activity === "victory" || activity === "listening")
      return mascotFrame({ state: activity, since: 0, until: 1500 }, time);
    return mascotActivityFrame(activity, time);
  }
  function draw() {
    for (const card of cards) {
      const frame = frameAt(mode.value === "signature" ? card.activity : mode.value);
      if (card.lastFrame === frame)
        continue;
      card.lastFrame = frame;
      card.ctx.clearRect(0, 0, card.cv.width, card.cv.height);
      card.ctx.fillStyle = "#080e18";
      card.ctx.beginPath();
      card.ctx.ellipse(120, 224, 54, 7, 0, 0, Math.PI * 2);
      card.ctx.fill();
      paintFrame(card.ctx, frame, 4, 40, 16, card.palette);
      card.smallCtx.clearRect(0, 0, MASCOT_W, MASCOT_H);
      paintFrame(card.smallCtx, frame, 1, 0, 0, card.palette);
      if (card.frame.textContent !== frame)
        card.frame.textContent = frame;
    }
    status.textContent = `40 x 52 native pixels / ${Math.round(time)} ms / ${paused ? "paused" : speed.value + "x playback"}`;
  }
  function tick(now) {
    if (!paused && !document.hidden)
      time += Math.min(100, now - last) * Number(speed.value);
    last = now;
    draw();
    requestAnimationFrame(tick);
  }
  draw();
  requestAnimationFrame(tick);
})();
