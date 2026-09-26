// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1
// desktop/renderer/mascot.ts
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
  [0, [14, 43], [9, 49], [22, 43], [29, 49]],
  [1, [12, 43], [9, 46], [21, 45], [24, 49]],
  [0, [16, 41], [12, 43], [20, 44], [19, 49]],
  [-1, [22, 41], [23, 45], [18, 44], [14, 49]],
  [0, [23, 43], [29, 49], [13, 43], [9, 49]],
  [1, [22, 45], [24, 49], [12, 43], [9, 46]],
  [0, [21, 44], [19, 49], [16, 41], [12, 43]],
  [-1, [18, 44], [14, 49], [22, 41], [23, 45]]
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
var WORK_THEMES = [MASCOT_THEMES.lucid, MASCOT_THEMES.ember, MASCOT_THEMES.glacier, MASCOT_THEMES.orchid, MASCOT_THEMES.solar, MASCOT_THEMES.stealth];
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

// desktop/renderer/mascot_minigames.ts
var CANVAS_HEIGHT = 180;
var FLOOR_Y = 172;
var SPRITE_SCALE = 2;
var SPRITE_W = MASCOT_W * SPRITE_SCALE;
var SPRITE_H = MASCOT_H * SPRITE_SCALE;
var MIN_WIDTH = 260;
var MAX_SLICE_MS = 100;
var SUBSTEP_MS = 16;
function nextSeed(seed) {
  return Math.imul(seed, 1664525) + 1013904223 >>> 0;
}
function clampWidth(width) {
  return Math.max(MIN_WIDTH, Number.isFinite(width) ? Math.floor(width) : 640);
}
var SHURIKEN_LANES = 3;
var SHURIKEN_RUN_MS = 60000;
var SHURIKEN_HIT_POINTS = 10;
var SHURIKEN_DUMMY_PENALTY = 1;
var SHURIKEN_MAX_MULTIPLIER = 5;
var SHURIKEN_LAUNCH_X = 84;
var SHURIKEN_SHOT_SPEED = 330;
var SHURIKEN_SHOT_WIDTH = 10;
var SHURIKEN_COOLDOWN_MS = 200;
var SHURIKEN_LANE_Y = [84, 112, 140];
function shurikenMultiplier(combo) {
  return Math.min(SHURIKEN_MAX_MULTIPLIER, 1 + Math.max(0, Math.floor(combo)));
}
function createShurikenState(width = 640, seed = 1) {
  return {
    phase: "playing",
    width: clampWidth(width),
    elapsedMs: 0,
    remainingMs: SHURIKEN_RUN_MS,
    lane: 1,
    score: 0,
    combo: 0,
    bestCombo: 0,
    hits: 0,
    misses: 0,
    strikes: 0,
    targets: [],
    shots: [],
    spawnMs: 500,
    cooldownMs: 0,
    throwMs: 0,
    flashMs: 0,
    seed: seed >>> 0,
    nextId: 0
  };
}
function applyShurikenInput(state, action) {
  if (state.phase !== "playing")
    return state;
  if (action === "lane-up" || action === "lane-down") {
    const lane = Math.max(0, Math.min(SHURIKEN_LANES - 1, state.lane + (action === "lane-up" ? -1 : 1)));
    return lane === state.lane ? state : { ...state, lane };
  }
  if (state.cooldownMs > 0)
    return state;
  return {
    ...state,
    cooldownMs: SHURIKEN_COOLDOWN_MS,
    throwMs: 170,
    nextId: state.nextId + 1,
    shots: [...state.shots, { id: state.nextId, lane: state.lane, x: SHURIKEN_LAUNCH_X, spent: false }]
  };
}
function advanceShuriken(next, dtMs) {
  const dt = dtMs / 1000;
  next.elapsedMs += dtMs;
  next.remainingMs = Math.max(0, next.remainingMs - dtMs);
  next.cooldownMs = Math.max(0, next.cooldownMs - dtMs);
  next.throwMs = Math.max(0, next.throwMs - dtMs);
  next.flashMs = Math.max(0, next.flashMs - dtMs);
  for (const target of next.targets) {
    if (target.hit)
      target.popMs = Math.max(0, target.popMs - dtMs);
    else
      target.x -= target.speed * dt;
  }
  for (const shot of next.shots) {
    if (!shot.spent)
      shot.x += SHURIKEN_SHOT_SPEED * dt;
  }
  for (const shot of next.shots) {
    if (shot.spent)
      continue;
    for (const target of next.targets) {
      if (target.hit || target.lane !== shot.lane)
        continue;
      if (shot.x + SHURIKEN_SHOT_WIDTH < target.x || shot.x > target.x + target.width)
        continue;
      shot.spent = true;
      target.hit = true;
      target.popMs = 220;
      next.flashMs = 150;
      if (target.kind === "dummy") {
        next.score = Math.max(0, next.score - SHURIKEN_DUMMY_PENALTY);
        next.combo = 0;
        next.strikes++;
      } else {
        next.score += SHURIKEN_HIT_POINTS * shurikenMultiplier(next.combo);
        next.combo++;
        next.hits++;
        if (next.combo > next.bestCombo)
          next.bestCombo = next.combo;
      }
      break;
    }
    if (!shot.spent && shot.x > next.width) {
      shot.spent = true;
      next.combo = 0;
      next.misses++;
    }
  }
  next.spawnMs -= dtMs;
  if (next.spawnMs <= 0 && next.remainingMs > 0) {
    const rolled = nextSeed(next.seed);
    next.seed = rolled;
    const kind = (rolled >>> 5) % 4 === 0 ? "dummy" : "target";
    next.targets.push({
      id: next.nextId++,
      kind,
      lane: rolled % SHURIKEN_LANES,
      x: next.width + 18,
      width: kind === "dummy" ? 20 : 22,
      speed: 58 + (rolled >>> 9) % 5 * 16,
      hit: false,
      popMs: 0
    });
    next.spawnMs += 560 + (rolled >>> 13) % 460;
  }
  if (next.remainingMs <= 0)
    next.phase = "over";
}
function stepShuriken(state, elapsedMs) {
  if (state.phase !== "playing" || !Number.isFinite(elapsedMs) || elapsedMs <= 0)
    return state;
  let remaining = Math.min(MAX_SLICE_MS, elapsedMs);
  const next = {
    ...state,
    targets: state.targets.map((target) => ({ ...target })),
    shots: state.shots.map((shot) => ({ ...shot }))
  };
  while (remaining > 0) {
    const slice = Math.min(SUBSTEP_MS, remaining);
    advanceShuriken(next, slice);
    remaining -= slice;
  }
  next.targets = next.targets.filter((target) => target.hit ? target.popMs > 0 : target.x + target.width > -12);
  next.shots = next.shots.filter((shot) => !shot.spent);
  return next;
}
var KATA_POSES = ["punch", "kick", "duck", "jump"];
var KATA_BEAT_MS = 520;
var KATA_SHOW_MS = 340;
var KATA_CLEAR_MS = 780;
function rollPose(seed) {
  const rolled = nextSeed(seed);
  return { seed: rolled, pose: KATA_POSES[(rolled >>> 7) % KATA_POSES.length] };
}
function kataPayout(length) {
  const n = Math.max(0, Math.floor(length));
  return n * (n + 1) * 5;
}
function createKataState(width = 640, seed = 1) {
  const first = rollPose(seed >>> 0);
  return {
    phase: "demo",
    round: 1,
    sequence: [first.pose],
    cursor: 0,
    beatMs: KATA_BEAT_MS,
    score: 0,
    lastPose: null,
    wrongPose: null,
    flashMs: 0,
    elapsedMs: 0,
    seed: first.seed,
    width: clampWidth(width)
  };
}
function applyKataInput(state, pose) {
  if (state.phase !== "input")
    return state;
  const expected = state.sequence[state.cursor];
  if (expected === undefined)
    return state;
  if (pose !== expected) {
    return { ...state, phase: "over", lastPose: pose, wrongPose: pose, flashMs: 420 };
  }
  const cursor = state.cursor + 1;
  if (cursor < state.sequence.length) {
    return { ...state, cursor, lastPose: pose, flashMs: 180 };
  }
  return {
    ...state,
    phase: "clear",
    cursor,
    lastPose: pose,
    flashMs: 320,
    beatMs: KATA_CLEAR_MS,
    score: state.score + kataPayout(state.sequence.length)
  };
}
function stepKata(state, elapsedMs) {
  if (state.phase === "over" || !Number.isFinite(elapsedMs) || elapsedMs <= 0)
    return state;
  let remaining = Math.min(MAX_SLICE_MS, elapsedMs);
  const next = { ...state, sequence: [...state.sequence] };
  while (remaining > 0) {
    const slice = Math.min(SUBSTEP_MS, remaining);
    remaining -= slice;
    next.elapsedMs += slice;
    next.flashMs = Math.max(0, next.flashMs - slice);
    if (next.phase === "input")
      continue;
    next.beatMs -= slice;
    if (next.beatMs > 0)
      continue;
    if (next.phase === "demo") {
      next.cursor++;
      next.beatMs = KATA_BEAT_MS;
      if (next.cursor >= next.sequence.length) {
        next.phase = "input";
        next.cursor = 0;
        next.beatMs = 0;
        next.lastPose = null;
      }
      continue;
    }
    const grown = rollPose(next.seed);
    next.seed = grown.seed;
    next.sequence.push(grown.pose);
    next.round++;
    next.phase = "demo";
    next.cursor = 0;
    next.beatMs = KATA_BEAT_MS;
    next.lastPose = null;
  }
  return next;
}
var STACK_START_WIDTH = 96;
var STACK_PERFECT_PX = 2;
var STACK_PERFECT_GAIN = 4;
var STACK_BLOCK_HEIGHT = 12;
var STACK_HEIGHT_POINTS = 10;
var STACK_PERFECT_BONUS = 15;
function stackSpeed(height, width = 640) {
  return Math.min(340, 92 + Math.max(0, height) * 13) * Math.max(1, clampWidth(width) / 420);
}
function createStackState(width = 640, seed = 1) {
  const canvas = clampWidth(width);
  const baseX = Math.round((canvas - STACK_START_WIDTH) / 2);
  return {
    phase: "playing",
    width: canvas,
    tower: [{ x: baseX, width: STACK_START_WIDTH }],
    height: 0,
    score: 0,
    perfects: 0,
    blockX: 0,
    blockWidth: STACK_START_WIDTH,
    direction: 1,
    lastTrim: 0,
    perfectMs: 0,
    flashMs: 0,
    elapsedMs: 0,
    seed: seed >>> 0
  };
}
function dropStackBlock(state) {
  if (state.phase !== "playing")
    return state;
  const base = state.tower[state.tower.length - 1];
  const left = Math.max(state.blockX, base.x);
  const right = Math.min(state.blockX + state.blockWidth, base.x + base.width);
  const overlap = right - left;
  if (overlap <= 0) {
    return { ...state, phase: "over", lastTrim: state.blockWidth, flashMs: 520 };
  }
  const offset = Math.abs(state.blockX + state.blockWidth / 2 - (base.x + base.width / 2));
  const perfect = offset <= STACK_PERFECT_PX;
  const placedWidth = perfect ? Math.min(STACK_START_WIDTH, base.width + STACK_PERFECT_GAIN) : overlap;
  const placedX = perfect ? Math.max(0, Math.min(state.width - placedWidth, base.x - (placedWidth - base.width) / 2)) : left;
  const height = state.height + 1;
  const direction = height % 2 === 0 ? 1 : -1;
  const rolled = nextSeed(state.seed);
  return {
    ...state,
    tower: [...state.tower, { x: placedX, width: placedWidth }],
    height,
    score: state.score + STACK_HEIGHT_POINTS + (perfect ? STACK_PERFECT_BONUS : 0),
    perfects: state.perfects + (perfect ? 1 : 0),
    blockWidth: placedWidth,
    blockX: direction === 1 ? 0 : Math.max(0, state.width - placedWidth),
    direction,
    lastTrim: perfect ? 0 : state.blockWidth - overlap,
    perfectMs: perfect ? 420 : 0,
    flashMs: 200,
    seed: rolled
  };
}
function stepStack(state, elapsedMs) {
  if (state.phase !== "playing" || !Number.isFinite(elapsedMs) || elapsedMs <= 0)
    return state;
  let remaining = Math.min(MAX_SLICE_MS, elapsedMs);
  const next = { ...state, tower: state.tower.map((block) => ({ ...block })) };
  const travel = Math.max(0, next.width - next.blockWidth);
  while (remaining > 0) {
    const slice = Math.min(SUBSTEP_MS, remaining);
    remaining -= slice;
    next.elapsedMs += slice;
    next.flashMs = Math.max(0, next.flashMs - slice);
    next.perfectMs = Math.max(0, next.perfectMs - slice);
    let x = next.blockX + next.direction * stackSpeed(next.height, next.width) * (slice / 1000);
    if (x <= 0) {
      x = 0;
      next.direction = 1;
    } else if (x >= travel) {
      x = travel;
      next.direction = -1;
    }
    next.blockX = x;
  }
  return next;
}
function fillBackdrop(ctx, width, palette) {
  ctx.fillStyle = palette.B;
  ctx.fillRect(0, 0, width, CANVAS_HEIGHT);
}
function hudText(ctx, palette, text, x, y, align = "left") {
  ctx.fillStyle = palette.W;
  ctx.font = "12px monospace";
  ctx.textAlign = align;
  ctx.fillText(text, Math.round(x), y);
}
function paintShurikenRange(ctx, state, palette, playing) {
  const width = state.width;
  fillBackdrop(ctx, width, palette);
  ctx.fillStyle = palette.D;
  for (let x = 0;x < width; x += 56)
    ctx.fillRect(x + 4, 26, 48, CANVAS_HEIGHT - 44);
  ctx.fillStyle = palette.K;
  for (let x = 0;x < width; x += 56)
    ctx.fillRect(x + 4, 26, 48, 4);
  for (let lane = 0;lane < SHURIKEN_LANES; lane++) {
    const y = SHURIKEN_LANE_Y[lane];
    ctx.fillStyle = lane === state.lane ? palette.g : palette.L;
    ctx.fillRect(SHURIKEN_LAUNCH_X - 6, y + 15, width - SHURIKEN_LAUNCH_X + 6, 2);
  }
  ctx.fillStyle = palette.g;
  ctx.fillRect(0, FLOOR_Y, width, 2);
  for (const target of state.targets) {
    const x = Math.round(target.x);
    const y = SHURIKEN_LANE_Y[target.lane] ?? SHURIKEN_LANE_Y[1];
    if (target.kind === "dummy") {
      ctx.fillStyle = palette.s;
      ctx.fillRect(x + 4, y - 14, 12, 28);
      ctx.fillStyle = palette.S;
      ctx.fillRect(x + 6, y - 12, 4, 24);
      ctx.fillStyle = palette.k;
      ctx.fillRect(x + 2, y - 10, 16, 3);
      ctx.fillRect(x + 2, y + 6, 16, 3);
      ctx.fillStyle = palette.L;
      ctx.fillRect(x + 8, y + 14, 4, 6);
      continue;
    }
    if (target.hit) {
      ctx.fillStyle = palette.G;
      const burst = Math.max(2, Math.round(target.popMs / 26));
      ctx.fillRect(x + 11 - burst, y - 2, burst * 2, 3);
      ctx.fillRect(x + 10, y - 1 - burst, 3, burst * 2);
      continue;
    }
    ctx.fillStyle = palette.k;
    ctx.fillRect(x, y - 11, 22, 22);
    ctx.fillStyle = palette.M;
    ctx.fillRect(x + 1, y - 10, 20, 20);
    ctx.fillStyle = palette.k;
    ctx.fillRect(x + 3, y - 8, 16, 16);
    ctx.fillStyle = palette.W;
    ctx.fillRect(x + 5, y - 6, 12, 12);
    ctx.fillStyle = palette.k;
    ctx.fillRect(x + 7, y - 4, 8, 8);
    ctx.fillStyle = palette.G;
    ctx.fillRect(x + 9, y - 2, 4, 4);
  }
  ctx.fillStyle = palette.M;
  for (const shot of state.shots) {
    const x = Math.round(shot.x);
    const y = SHURIKEN_LANE_Y[shot.lane] ?? SHURIKEN_LANE_Y[1];
    const spin = Math.floor(state.elapsedMs / 45) % 2 === 0;
    if (spin) {
      ctx.fillRect(x, y - 2, 10, 4);
      ctx.fillRect(x + 3, y - 5, 4, 10);
    } else {
      ctx.fillRect(x + 1, y - 4, 8, 8);
      ctx.fillStyle = palette.k;
      ctx.fillRect(x + 4, y - 1, 2, 2);
      ctx.fillStyle = palette.M;
    }
  }
  const frame = state.throwMs > 90 ? "punchB" : state.throwMs > 0 ? "punchD" : playing ? "guard" : "idleA";
  paintFrame(ctx, frame, SPRITE_SCALE, 2, FLOOR_Y - SPRITE_H, palette);
  ctx.fillStyle = palette.G;
  const aimY = SHURIKEN_LANE_Y[state.lane];
  ctx.fillRect(SHURIKEN_LAUNCH_X - 8, aimY - 1, 6, 3);
  ctx.fillRect(SHURIKEN_LAUNCH_X - 4, aimY - 4, 3, 9);
  hudText(ctx, palette, `${Math.ceil(state.remainingMs / 1000)}s`, 6, 18);
  hudText(ctx, palette, `Run ${state.score}`, Math.round(width / 2), 18, "center");
  hudText(ctx, palette, `x${shurikenMultiplier(state.combo)}`, width - 6, 18, "right");
  if (!playing) {
    hudText(ctx, palette, state.phase === "over" ? `Range closed. ${state.hits} hits, best streak ${state.bestCombo}.` : "Paused. Resume to keep throwing.", Math.round(width / 2), CANVAS_HEIGHT - 8, "center");
  }
}
var KATA_FRAMES = { punch: "punchB", kick: "kickC", duck: "sneakA", jump: "fall" };
function paintKataFloor(ctx, state, palette, playing) {
  const width = state.width;
  fillBackdrop(ctx, width, palette);
  ctx.fillStyle = palette.D;
  ctx.fillRect(0, 40, width, CANVAS_HEIGHT - 40);
  ctx.fillStyle = palette.K;
  for (let x = 0;x < width; x += 48)
    ctx.fillRect(x + 2, 44, 44, CANVAS_HEIGHT - 50);
  ctx.fillStyle = palette.g;
  ctx.fillRect(0, FLOOR_Y, width, 2);
  const count = state.sequence.length;
  const pitch = 10;
  const originX = Math.max(4, Math.round((width - count * pitch) / 2));
  const showing = state.phase === "demo" && state.beatMs > KATA_BEAT_MS - KATA_SHOW_MS;
  for (let i = 0;i < count; i++) {
    const x = originX + i * pitch;
    if (x + 8 > width)
      break;
    const lit = state.phase === "demo" ? showing ? i === state.cursor : false : i < state.cursor;
    ctx.fillStyle = lit ? palette.G : palette.L;
    ctx.fillRect(x, 10, 8, 8);
    ctx.fillStyle = palette.k;
    ctx.fillRect(x + 2, 12, 4, 4);
  }
  const pose = state.phase === "demo" && showing ? state.sequence[state.cursor] ?? null : state.lastPose;
  const frame = state.phase === "over" ? "land" : pose ? KATA_FRAMES[pose] : "guard";
  paintFrame(ctx, frame, SPRITE_SCALE, Math.round(width / 2 - SPRITE_W / 2), FLOOR_Y - SPRITE_H, palette);
  if (state.flashMs > 0) {
    ctx.fillStyle = state.phase === "over" ? palette.s : palette.G;
    ctx.fillRect(0, 26, width, 2);
  }
  hudText(ctx, palette, `Round ${state.round}`, 6, 34);
  hudText(ctx, palette, `Run ${state.score}`, width - 6, 34, "right");
  const banner = state.phase === "demo" ? "Watch" : state.phase === "input" ? `Repeat ${state.cursor + 1} of ${count}` : state.phase === "clear" ? `Kata clean. +${kataPayout(count)}` : "Broken form. Start for a new kata.";
  hudText(ctx, palette, playing || state.phase === "over" ? banner : "Paused. Resume to continue.", Math.round(width / 2), CANVAS_HEIGHT - 8, "center");
}
function paintStackTower(ctx, state, palette, playing) {
  const width = state.width;
  fillBackdrop(ctx, width, palette);
  ctx.fillStyle = palette.D;
  for (let i = 0;i < 26; i++) {
    const x = i * 97 % Math.max(1, width - 3);
    const y = 6 + i * 53 % 120;
    ctx.fillRect(x, y, 2, 2);
  }
  ctx.fillStyle = palette.K;
  ctx.fillRect(0, FLOOR_Y, 76, CANVAS_HEIGHT - FLOOR_Y);
  ctx.fillStyle = palette.L;
  ctx.fillRect(0, FLOOR_Y - 2, 76, 2);
  paintFrame(ctx, playing ? "guard" : "idleA", SPRITE_SCALE, 0, FLOOR_Y - SPRITE_H, palette);
  const lift = Math.max(0, state.tower.length * STACK_BLOCK_HEIGHT - 108);
  const rowY = (index) => FLOOR_Y - (index + 1) * STACK_BLOCK_HEIGHT + lift;
  for (let i = 0;i < state.tower.length; i++) {
    const block = state.tower[i];
    const y = rowY(i);
    if (y > CANVAS_HEIGHT || y + STACK_BLOCK_HEIGHT < 0)
      continue;
    const x = Math.round(block.x);
    const w = Math.max(1, Math.round(block.width));
    ctx.fillStyle = palette.k;
    ctx.fillRect(x, y, w, STACK_BLOCK_HEIGHT);
    ctx.fillStyle = palette.s;
    ctx.fillRect(x + 1, y + 1, Math.max(1, w - 2), STACK_BLOCK_HEIGHT - 2);
    ctx.fillStyle = palette.S;
    ctx.fillRect(x + 2, y + 2, Math.max(1, w - 4), 2);
    ctx.fillRect(x + 2, y + STACK_BLOCK_HEIGHT - 4, Math.max(1, w - 4), 2);
    ctx.fillStyle = palette.D;
    ctx.fillRect(x + 2, y + 5, Math.max(1, w - 4), 1);
    for (let n = 2;n + 2 < w; n += 8)
      ctx.fillRect(x + n, y + 6, 2, 3);
  }
  const sliderY = Math.max(2, rowY(state.tower.length) - 6);
  const sliderX = Math.round(state.blockX);
  const sliderW = Math.max(1, Math.round(state.blockWidth));
  if (state.phase === "playing") {
    ctx.fillStyle = palette.g;
    ctx.fillRect(sliderX, sliderY, sliderW, STACK_BLOCK_HEIGHT);
    ctx.fillStyle = palette.G;
    ctx.fillRect(sliderX, sliderY, sliderW, 2);
    ctx.fillRect(sliderX + Math.floor(sliderW / 2) - 1, sliderY + 4, 2, 5);
    const guideX = sliderX + Math.floor(sliderW / 2);
    for (let y = sliderY + STACK_BLOCK_HEIGHT + 2;y < rowY(state.tower.length - 1); y += 6) {
      ctx.fillRect(guideX, y, 1, 3);
    }
  }
  if (state.perfectMs > 0) {
    ctx.fillStyle = palette.G;
    ctx.fillRect(0, rowY(state.tower.length - 1) - 2, width, 1);
  }
  hudText(ctx, palette, `Height ${state.height}`, 82, 18);
  hudText(ctx, palette, `Run ${state.score}`, Math.round(width / 2) + 30, 18, "center");
  hudText(ctx, palette, `${Math.round(state.blockWidth)}px`, width - 6, 18, "right");
  if (state.phase === "over") {
    hudText(ctx, palette, `Tower down at ${state.height}. Start to rebuild.`, Math.round(width / 2), CANVAS_HEIGHT - 8, "center");
  } else if (!playing) {
    hudText(ctx, palette, "Paused. Resume to drop.", Math.round(width / 2), CANVAS_HEIGHT - 8, "center");
  }
}
var runCounter = 0;
function mountMiniGame(host, scorePort, spec) {
  const root = document.createElement("section");
  root.className = `mini-game mini-game-${spec.id}`;
  root.setAttribute("aria-label", spec.name);
  root.innerHTML = `
    <div class="mini-game-toolbar">
      <span class="mini-game-title">${spec.name}</span>
      <output class="mini-game-score" aria-label="${spec.name} run readout"></output>
      <output class="mini-game-total" aria-label="Combined arcade score">Total 0</output>
      <button type="button" class="mini-game-start">Start</button>
    </div>
    <canvas class="mini-game-canvas" tabindex="0" aria-label="${spec.ariaLabel}"></canvas>
    <div class="mini-game-controls" role="group" aria-label="${spec.name} controls">
      ${spec.buttons.map((button) => `<button type="button" data-action="${button.action}" aria-label="${button.aria}">${button.label}</button>`).join("")}
      <span class="mini-game-status" role="status">Local only. Nothing leaves this machine.</span>
    </div>
    <p class="mini-game-help">${spec.blurb}</p>`;
  host.appendChild(root);
  const canvas = root.querySelector("canvas");
  const startButton = root.querySelector(".mini-game-start");
  const scoreOutput = root.querySelector(".mini-game-score");
  const totalOutput = root.querySelector(".mini-game-total");
  const status = root.querySelector(".mini-game-status");
  const controls = Array.from(root.querySelectorAll("[data-action]"));
  const context = canvas.getContext("2d");
  const events = new AbortController;
  const listenerOptions = { signal: events.signal };
  const palette = MASCOT_THEMES.lucid.palette;
  let width = MIN_WIDTH;
  let state = spec.create(width, 1);
  let playing = false;
  let started = false;
  let disposed = false;
  let awarded = false;
  let raf = 0;
  let resizeRaf = 0;
  let lastTime = 0;
  let dpr = 1;
  let sessionTotal = 0;
  let lastReadout = "";
  let lastTotal = -1;
  function measure() {
    const style = getComputedStyle(root);
    const padding = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
    return clampWidth(root.clientWidth - padding);
  }
  function paint() {
    if (!context || disposed || root.hidden || host.hidden)
      return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.imageSmoothingEnabled = false;
    spec.paint(context, state, palette, playing);
    const readout = spec.readout(state);
    if (readout !== lastReadout) {
      scoreOutput.textContent = readout;
      lastReadout = readout;
    }
    const total = scorePort ? scorePort.total() : sessionTotal;
    if (total !== lastTotal) {
      totalOutput.textContent = `Total ${total}`;
      lastTotal = total;
    }
  }
  function resize() {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = 0;
    if (disposed || root.hidden || host.hidden)
      return;
    const next = measure();
    dpr = Math.min(2, Math.max(1, Math.ceil(window.devicePixelRatio || 1)));
    const pixelWidth = next * dpr;
    const pixelHeight = CANVAS_HEIGHT * dpr;
    if (canvas.width !== pixelWidth)
      canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight)
      canvas.height = pixelHeight;
    if (next !== width) {
      width = next;
      state = spec.resize(state, width);
    }
    paint();
  }
  function halt() {
    playing = false;
    cancelAnimationFrame(raf);
    raf = 0;
    lastTime = 0;
    for (const button of controls)
      button.disabled = true;
  }
  function pause() {
    if (!playing)
      return;
    halt();
    startButton.textContent = "Resume";
    status.textContent = "Paused. Resume when ready.";
    paint();
  }
  function finish() {
    halt();
    if (!awarded) {
      awarded = true;
      const points = Math.max(0, Math.round(spec.points(state)));
      if (points > 0) {
        if (scorePort)
          scorePort.award(points);
        else
          sessionTotal += points;
      }
    }
    startButton.textContent = "Restart";
    status.textContent = spec.overText(state);
    paint();
  }
  function tick(time) {
    raf = 0;
    if (!playing || disposed || document.hidden || root.hidden || host.hidden) {
      pause();
      return;
    }
    state = spec.step(state, lastTime ? time - lastTime : 0);
    lastTime = time;
    if (spec.over(state)) {
      finish();
      return;
    }
    paint();
    raf = requestAnimationFrame(tick);
  }
  function begin() {
    if (disposed || !context || document.hidden)
      return;
    halt();
    width = measure();
    state = spec.create(width, Math.imul(Date.now() >>> 0, 2246822519) + ++runCounter >>> 0);
    started = true;
    awarded = false;
    playing = true;
    lastTime = 0;
    lastReadout = "";
    startButton.textContent = "Restart";
    status.textContent = spec.readyText;
    for (const button of controls)
      button.disabled = false;
    canvas.focus({ preventScroll: true });
    resize();
    raf = requestAnimationFrame(tick);
  }
  function resume() {
    if (disposed || !context || document.hidden || playing)
      return;
    if (!started || spec.over(state)) {
      begin();
      return;
    }
    playing = true;
    lastTime = 0;
    startButton.textContent = "Restart";
    status.textContent = spec.readyText;
    for (const button of controls)
      button.disabled = false;
    canvas.focus({ preventScroll: true });
    raf = requestAnimationFrame(tick);
  }
  function act(action) {
    if (!playing || disposed)
      return;
    state = spec.input(state, action);
    if (spec.over(state)) {
      finish();
      return;
    }
    paint();
  }
  startButton.addEventListener("click", () => {
    if (playing)
      begin();
    else
      resume();
  }, listenerOptions);
  for (const button of controls) {
    button.addEventListener("click", () => {
      act(button.dataset.action ?? "");
      if (playing)
        canvas.focus({ preventScroll: true });
    }, listenerOptions);
  }
  canvas.addEventListener("keydown", (event) => {
    if (!playing || disposed || document.activeElement !== canvas)
      return;
    const action = spec.keyAction(event);
    if (!action)
      return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat)
      return;
    act(action);
  }, listenerOptions);
  root.addEventListener("focusout", (event) => {
    if (!(event.relatedTarget instanceof Node) || !root.contains(event.relatedTarget))
      pause();
  }, listenerOptions);
  window.addEventListener("blur", pause, listenerOptions);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden)
      pause();
  }, listenerOptions);
  const observer = new ResizeObserver(() => {
    if (!disposed && !root.hidden && !host.hidden && !resizeRaf)
      resizeRaf = requestAnimationFrame(resize);
  });
  observer.observe(root);
  if (!context) {
    startButton.disabled = true;
    status.textContent = "Canvas is unavailable in this window.";
  }
  for (const button of controls)
    button.disabled = true;
  resize();
  return {
    start() {
      begin();
    },
    stop() {
      if (disposed || !playing)
        return;
      pause();
    },
    dispose() {
      if (disposed)
        return;
      disposed = true;
      const active = document.activeElement;
      if (active instanceof HTMLElement && root.contains(active))
        active.blur();
      halt();
      cancelAnimationFrame(resizeRaf);
      resizeRaf = 0;
      events.abort();
      observer.disconnect();
      root.remove();
    }
  };
}
var SHURIKEN_SPEC = {
  id: "shuriken",
  name: "Shuriken range",
  blurb: "Pick a lane with Up or Down, throw with Ctrl or Space, and keep the streak alive for sixty seconds; straw dummies cost a point.",
  ariaLabel: "Shuriken range. Up and Down choose a lane, Control or Space throws. Sixty second run.",
  readyText: "Sixty seconds. Chain hits for a bigger multiplier.",
  buttons: [
    { action: "lane-up", label: "Lane up", aria: "Move aim one lane up" },
    { action: "lane-down", label: "Lane down", aria: "Move aim one lane down" },
    { action: "throw", label: "Throw", aria: "Throw a shuriken" }
  ],
  keyAction(event) {
    switch (event.key) {
      case "ArrowUp":
        return "lane-up";
      case "ArrowDown":
        return "lane-down";
      case "Control":
      case " ":
      case "Spacebar":
        return "throw";
      default:
        return null;
    }
  },
  create: createShurikenState,
  resize: (state, width) => ({ ...state, width: clampWidth(width) }),
  step: stepShuriken,
  input: (state, action) => applyShurikenInput(state, action),
  paint: paintShurikenRange,
  over: (state) => state.phase === "over",
  points: (state) => state.score,
  readout: (state) => `${Math.ceil(state.remainingMs / 1000)}s · Run ${state.score} · Streak ${state.combo}`,
  overText: (state) => `Range closed. Score ${state.score}, best streak ${state.bestCombo}.`
};
var KATA_SPEC = {
  id: "kata",
  name: "Kata memory",
  blurb: "Watch LUCID demonstrate the kata, then repeat it with the arrows or Ctrl; one wrong pose ends the run.",
  ariaLabel: "Kata memory. Control punches, Right kicks, Down ducks, Up jumps. Repeat the demonstrated sequence.",
  readyText: "Watch the kata, then repeat it exactly.",
  buttons: [
    { action: "punch", label: "Punch", aria: "Repeat a punch" },
    { action: "kick", label: "Kick", aria: "Repeat a kick" },
    { action: "duck", label: "Duck", aria: "Repeat a duck" },
    { action: "jump", label: "Jump", aria: "Repeat a jump" }
  ],
  keyAction(event) {
    switch (event.key) {
      case "Control":
      case "ArrowLeft":
        return "punch";
      case "ArrowRight":
        return "kick";
      case "ArrowDown":
        return "duck";
      case "ArrowUp":
        return "jump";
      default:
        return null;
    }
  },
  create: createKataState,
  resize: (state, width) => ({ ...state, width: clampWidth(width) }),
  step: stepKata,
  input: (state, action) => KATA_POSES.includes(action) ? applyKataInput(state, action) : state,
  paint: paintKataFloor,
  over: (state) => state.phase === "over",
  points: (state) => state.score,
  readout: (state) => `Round ${state.round} · Run ${state.score} · Pose ${Math.min(state.cursor + 1, state.sequence.length)} of ${state.sequence.length}`,
  overText: (state) => `Broken form on round ${state.round}. Score ${state.score}.`
};
var STACK_SPEC = {
  id: "stack",
  name: "Rooftop stack",
  blurb: "Drop each dojo crate with Space or Ctrl; overhang is trimmed away for good, and a perfect centre pays a bonus and hands some width back.",
  ariaLabel: "Rooftop stack. Space or Control drops the sliding crate onto the tower.",
  readyText: "Drop the crate when it lines up with the tower.",
  buttons: [{ action: "drop", label: "Drop", aria: "Drop the sliding crate" }],
  keyAction(event) {
    switch (event.key) {
      case "Control":
      case " ":
      case "Spacebar":
      case "ArrowDown":
        return "drop";
      default:
        return null;
    }
  },
  create: createStackState,
  resize: (state, width) => {
    const next = clampWidth(width);
    return { ...state, width: next, blockX: Math.max(0, Math.min(next - state.blockWidth, state.blockX)) };
  },
  step: stepStack,
  input: (state, action) => action === "drop" ? dropStackBlock(state) : state,
  paint: paintStackTower,
  over: (state) => state.phase === "over",
  points: (state) => state.score,
  readout: (state) => `Height ${state.height} · Run ${state.score} · Width ${Math.round(state.blockWidth)}`,
  overText: (state) => `Tower down at height ${state.height}. Score ${state.score}.`
};
var MINI_GAMES = [
  {
    id: SHURIKEN_SPEC.id,
    name: SHURIKEN_SPEC.name,
    blurb: SHURIKEN_SPEC.blurb,
    mount: (host, scorePort) => mountMiniGame(host, scorePort, SHURIKEN_SPEC)
  },
  {
    id: KATA_SPEC.id,
    name: KATA_SPEC.name,
    blurb: KATA_SPEC.blurb,
    mount: (host, scorePort) => mountMiniGame(host, scorePort, KATA_SPEC)
  },
  {
    id: STACK_SPEC.id,
    name: STACK_SPEC.name,
    blurb: STACK_SPEC.blurb,
    mount: (host, scorePort) => mountMiniGame(host, scorePort, STACK_SPEC)
  }
];

// desktop/renderer/mascot_game.ts
function createArcadeState(width = 640, seed = 1) {
  return {
    phase: "playing",
    width: Math.max(260, Number.isFinite(width) ? width : 640),
    elapsedMs: 0,
    score: 0,
    level: 1,
    hearts: 3,
    x: 40,
    jumpY: 0,
    velocityY: 0,
    groundY: 0,
    invulnerableMs: 0,
    attack: null,
    attackMs: 0,
    cooldownMs: 0,
    held: { left: false, right: false, duck: false },
    obstacles: [],
    spawnMs: 700,
    seed: seed >>> 0,
    nextId: 0,
    mode: "runner",
    clears: 0,
    nextBonusAt: 5,
    bonus: null,
    debris: []
  };
}
function applyArcadeInput(state, action, pressed) {
  if (state.phase !== "playing")
    return state;
  if (state.mode === "flycatch" && state.bonus) {
    if (action === "aim-up")
      return { ...state, bonus: { ...state.bonus, up: pressed } };
    if (pressed && (action === "punch" || action === "kick" || action === "jump") && state.bonus.cooldownMs === 0) {
      const bonus = { ...state.bonus, pinchMs: 230, cooldownMs: 400 };
      const caught = Math.hypot(bonus.aimX - bonus.flyX, bonus.aimY - bonus.flyY) <= 25;
      if (caught) {
        bonus.caught++;
        bonus.flyX = 40 + (state.seed + bonus.caught * 137) % Math.max(1, state.width - 80);
        bonus.flyY = 36 + (state.seed + bonus.caught * 53) % 80;
      }
      return { ...state, bonus, score: state.score + (caught ? 50 : 0) };
    }
  }
  if (action === "aim-up")
    return state;
  if (action === "left" || action === "right" || action === "duck") {
    return state.held[action] === pressed ? state : { ...state, held: { ...state.held, [action]: pressed } };
  }
  if (!pressed || state.mode === "flycatch")
    return state;
  if (action === "jump") {
    const grounded = state.velocityY === 0 && state.jumpY <= (state.groundY ?? 0);
    return grounded && !state.held.duck ? { ...state, velocityY: 350, jumpY: state.jumpY + 0.01 } : state;
  }
  if (state.cooldownMs > 0)
    return state;
  return { ...state, attack: action, attackMs: action === "kick" ? 330 : 230, cooldownMs: 480 };
}
function arcadeSpeed(level) {
  return Math.min(250, 110 + Math.max(0, level - 1) * 14);
}
var OBSTACLE_KINDS = ["crate", "beam", "pot", "star", "target"];
var MIN_ARRIVAL_GAP_S = 0.95;
function arcadeScale(width) {
  return width >= 560 ? 2 : 1;
}
function advance(next, dtMs) {
  const dt = dtMs / 1000;
  next.elapsedMs += dtMs;
  if (next.mode === "flycatch" && next.bonus) {
    const bonus = next.bonus;
    bonus.remainingMs = Math.max(0, bonus.remainingMs - dtMs);
    bonus.pinchMs = Math.max(0, bonus.pinchMs - dtMs);
    bonus.cooldownMs = Math.max(0, bonus.cooldownMs - dtMs);
    bonus.aimX = Math.max(22, Math.min(next.width - 22, bonus.aimX + (Number(next.held.right) - Number(next.held.left)) * 210 * dt));
    bonus.aimY = Math.max(24, Math.min(150, bonus.aimY + (Number(next.held.duck) - Number(bonus.up)) * 160 * dt));
    bonus.flyX = Math.max(24, Math.min(next.width - 24, bonus.flyX + Math.sin(next.elapsedMs / 470 + next.seed % 9) * 95 * dt));
    bonus.flyY = Math.max(28, Math.min(145, bonus.flyY + Math.cos(next.elapsedMs / 310 + bonus.caught) * 72 * dt));
    next.level = 1 + Math.floor(next.score / 100);
    if (!bonus.remainingMs) {
      next.mode = "runner";
      next.bonus = null;
      next.obstacles = [];
      next.spawnMs = 1100;
      next.invulnerableMs = 1100;
      next.held = { left: false, right: false, duck: false };
    }
    return;
  }
  const scale = arcadeScale(next.width);
  for (const chip of next.debris) {
    chip.lifeMs -= dtMs;
    chip.x += chip.vx * dt;
    chip.y += chip.vy * dt;
    chip.vy -= 550 * dt;
  }
  next.invulnerableMs = Math.max(0, next.invulnerableMs - dtMs);
  next.attackMs = Math.max(0, next.attackMs - dtMs);
  next.cooldownMs = Math.max(0, next.cooldownMs - dtMs);
  next.spawnMs -= dtMs;
  if (!next.attackMs)
    next.attack = null;
  next.x = Math.max(8, Math.min(Math.min(next.width * 0.45, next.width - 150), next.x + (Number(next.held.right) - Number(next.held.left)) * 150 * dt));
  const speed = arcadeSpeed(next.level);
  const movement = speed * dt;
  for (const obstacle of next.obstacles)
    obstacle.x -= movement * (obstacle.kind === "star" ? 1.7 : 1);
  const left = next.x + 10 * scale;
  const right = next.x + 30 * scale;
  const previousBottom = next.jumpY;
  let support = 0;
  for (const obstacle of next.obstacles) {
    if (obstacle.kind !== "crate" || obstacle.x >= right || obstacle.x + obstacle.width <= left)
      continue;
    const lid = obstacle.bottom + obstacle.height;
    if (previousBottom >= lid - 1 && lid > support)
      support = lid;
  }
  if (next.jumpY > support || next.velocityY !== 0) {
    next.jumpY = next.jumpY + next.velocityY * dt - 550 * dt * dt;
    next.velocityY -= 1100 * dt;
    if (next.velocityY <= 0 && next.jumpY <= support && previousBottom >= support) {
      next.jumpY = support;
      next.velocityY = 0;
    }
    if (next.jumpY <= 0) {
      next.jumpY = 0;
      next.velocityY = 0;
    }
  }
  next.groundY = support;
  const bottom = next.jumpY;
  const grounded = next.velocityY === 0 && bottom <= support;
  const top = bottom + (next.held.duck && grounded ? 24 : 44) * scale;
  if (next.spawnMs <= 0) {
    const rolled = Math.imul(next.seed, 1664525) + 1013904223 >>> 0;
    const kind = next.nextId === 0 ? "crate" : OBSTACLE_KINDS[rolled % OBSTACLE_KINDS.length];
    const eta = (x, k) => (x - right) / (speed * (k === "star" ? 1.7 : 1));
    const arrival = eta(next.width + 24, kind);
    const recovery = 46 * scale / speed + 0.3;
    let deficit = 0;
    for (const obstacle of next.obstacles) {
      if (obstacle.handled)
        continue;
      const gap = arrival - eta(obstacle.x, obstacle.kind);
      const first = gap >= 0 ? obstacle.kind : kind;
      const second = gap >= 0 ? kind : obstacle.kind;
      const need = MIN_ARRIVAL_GAP_S + (first === "crate" && (second === "beam" || second === "star") ? recovery : 0);
      if (Math.abs(gap) < need)
        deficit = Math.max(deficit, need - gap);
    }
    if (deficit > 0) {
      next.spawnMs += deficit * 1000 + 1;
    } else {
      next.seed = rolled;
      next.obstacles.push({
        id: next.nextId++,
        kind,
        x: next.width + 24,
        width: (kind === "beam" ? 46 : kind === "star" ? 18 : 26) * scale,
        height: (kind === "beam" ? 12 : kind === "star" ? 18 : kind === "crate" ? 16 : 32) * scale,
        bottom: (kind === "beam" || kind === "star" ? 29 : 0) * scale,
        handled: false
      });
      next.spawnMs += 1700 + next.seed % 401;
    }
  }
  for (const obstacle of next.obstacles) {
    if (obstacle.handled)
      continue;
    const vertical = top > obstacle.bottom && bottom < obstacle.bottom + obstacle.height;
    const reach = (next.attack === "kick" ? 30 : 20) * scale;
    if ((obstacle.kind === "target" || obstacle.kind === "pot") && next.attack && vertical && obstacle.x >= left && obstacle.x <= right + reach) {
      obstacle.handled = true;
      next.score += obstacle.kind === "pot" ? 40 : 30;
      next.clears++;
      for (let n = 0;n < 10; n++) {
        next.debris.push({
          x: obstacle.x + obstacle.width / 2,
          y: obstacle.height / 2,
          vx: (n - 4.5) * 28,
          vy: 110 + n % 4 * 32,
          lifeMs: 650 + n % 3 * 100,
          color: obstacle.kind === "pot" && n % 3 === 0 ? "leaf" : "pot"
        });
      }
      continue;
    }
    if (vertical && obstacle.x < right && obstacle.x + obstacle.width > left) {
      obstacle.handled = true;
      if (next.invulnerableMs === 0) {
        next.hearts = Math.max(0, next.hearts - 1);
        next.invulnerableMs = 1100;
      }
    } else if (obstacle.x + obstacle.width < left) {
      obstacle.handled = true;
      next.score += obstacle.kind === "star" ? 35 : 20;
      next.clears++;
    }
  }
  next.level = 1 + Math.floor(next.score / 100);
  if (next.hearts && next.clears >= next.nextBonusAt) {
    next.mode = "flycatch";
    next.nextBonusAt += 5;
    next.bonus = {
      remainingMs: 12000,
      aimX: next.width / 2,
      aimY: 85,
      flyX: next.width / 2 + 55,
      flyY: 72,
      caught: 0,
      pinchMs: 0,
      cooldownMs: 0,
      up: false
    };
    next.held = { left: false, right: false, duck: false };
    next.jumpY = 0;
    next.velocityY = 0;
    next.attack = null;
    next.attackMs = 0;
    next.obstacles = [];
    next.debris = [];
  }
  if (!next.hearts) {
    next.phase = "lost";
    next.held = { left: false, right: false, duck: false };
  }
}
function stepArcade(state, elapsedMs) {
  if (state.phase !== "playing" || !Number.isFinite(elapsedMs) || elapsedMs <= 0)
    return state;
  let remaining = Math.min(100, elapsedMs);
  const next = {
    ...state,
    obstacles: state.obstacles.map((obstacle) => ({ ...obstacle })),
    bonus: state.bonus ? { ...state.bonus } : null,
    debris: state.debris.map((chip) => ({ ...chip }))
  };
  while (remaining > 0 && next.phase === "playing") {
    const slice = Math.min(16, remaining);
    advance(next, slice);
    remaining -= slice;
  }
  for (let i = next.obstacles.length - 1;i >= 0; i--) {
    const obstacle = next.obstacles[i];
    if (obstacle.x + obstacle.width <= -8)
      next.obstacles.splice(i, 1);
  }
  for (let i = next.debris.length - 1;i >= 0; i--) {
    if (next.debris[i].lifeMs <= 0)
      next.debris.splice(i, 1);
  }
  return next;
}
var PUNCH_FRAMES = ["punchA", "punchB", "punchC", "punchD"];
var KICK_FRAMES = ["kickA", "kickB", "kickC", "kickD"];
var FLOOR_Y2 = 172;
var CANVAS_HEIGHT2 = 180;
function paintObstacle(ctx, obstacle, palette, time) {
  const scale = obstacle.kind === "beam" ? obstacle.width / 46 : obstacle.kind === "star" ? obstacle.width / 18 : obstacle.width / 26;
  ctx.save();
  ctx.translate(Math.round(obstacle.x), Math.round(FLOOR_Y2 - obstacle.bottom - obstacle.height));
  ctx.scale(scale, scale);
  if (obstacle.kind === "pot") {
    ctx.fillStyle = palette.g;
    ctx.fillRect(12, 4, 2, 14);
    ctx.fillRect(6, 7, 7, 3);
    ctx.fillRect(14, 10, 7, 3);
    ctx.fillStyle = palette.G;
    ctx.fillRect(4, 5, 6, 3);
    ctx.fillRect(18, 8, 5, 3);
    ctx.fillStyle = palette.W;
    ctx.fillRect(9, 1, 7, 4);
    ctx.fillRect(7, 3, 11, 3);
    ctx.fillStyle = palette.S;
    ctx.fillRect(11, 3, 3, 3);
    ctx.fillStyle = palette.k;
    ctx.fillRect(3, 16, 20, 5);
    ctx.fillRect(5, 20, 16, 10);
    ctx.fillRect(7, 29, 12, 3);
    ctx.fillStyle = palette.s;
    ctx.fillRect(4, 17, 18, 3);
    ctx.fillRect(6, 21, 14, 7);
    ctx.fillRect(8, 28, 10, 2);
    ctx.fillStyle = palette.S;
    ctx.fillRect(6, 17, 14, 1);
    ctx.fillRect(7, 21, 3, 6);
    ctx.fillStyle = palette.D;
    ctx.fillRect(11, 23, 7, 1);
    ctx.fillRect(14, 24, 1, 3);
  } else if (obstacle.kind === "star") {
    const diagonal = Math.floor(time / 55) % 2 === 1;
    ctx.fillStyle = palette.L;
    ctx.fillRect(17, 7, 7, 4);
    ctx.fillRect(24, 8, 6, 2);
    ctx.fillRect(31, 9, 5, 1);
    ctx.fillStyle = palette.k;
    if (diagonal) {
      for (let n = 0;n < 8; n++) {
        const w = 2 + Math.floor(n / 3);
        ctx.fillRect(n, n, w, w);
        ctx.fillRect(18 - n - w, n, w, w);
        ctx.fillRect(n, 18 - n - w, w, w);
        ctx.fillRect(18 - n - w, 18 - n - w, w, w);
      }
    } else {
      for (let n = 0;n < 8; n++) {
        const half = 1 + Math.floor(n / 2);
        ctx.fillRect(9 - half, n, half * 2, 1);
        ctx.fillRect(9 - half, 17 - n, half * 2, 1);
        ctx.fillRect(n, 9 - half, 1, half * 2);
        ctx.fillRect(17 - n, 9 - half, 1, half * 2);
      }
    }
    ctx.fillStyle = palette.M;
    if (diagonal) {
      for (let n = 1;n < 7; n++) {
        const w = 1 + Math.floor(n / 3);
        ctx.fillRect(n + 1, n + 1, w, w);
        ctx.fillRect(16 - n - w, n + 1, w, w);
        ctx.fillRect(n + 1, 16 - n - w, w, w);
        ctx.fillRect(16 - n - w, 16 - n - w, w, w);
      }
    } else {
      for (let n = 1;n < 7; n++) {
        const half = Math.floor(n / 2);
        if (!half)
          continue;
        ctx.fillRect(9 - half, n, half * 2, 1);
        ctx.fillRect(9 - half, 17 - n, half * 2, 1);
        ctx.fillRect(n, 9 - half, 1, half * 2);
        ctx.fillRect(17 - n, 9 - half, 1, half * 2);
      }
    }
    ctx.fillStyle = palette.W;
    if (diagonal) {
      ctx.fillRect(2, 2, 2, 1);
      ctx.fillRect(14, 2, 2, 1);
    } else {
      ctx.fillRect(8, 1, 2, 1);
      ctx.fillRect(1, 8, 1, 2);
    }
    ctx.fillStyle = palette.M;
    ctx.fillRect(6, 6, 6, 6);
    ctx.fillStyle = palette.k;
    ctx.fillRect(5, 5, 8, 1);
    ctx.fillRect(5, 12, 8, 1);
    ctx.fillRect(5, 6, 1, 6);
    ctx.fillRect(12, 6, 1, 6);
    ctx.fillRect(8, 8, 2, 2);
  } else if (obstacle.kind === "crate") {
    ctx.fillStyle = palette.k;
    ctx.fillRect(0, 0, 26, 16);
    ctx.fillStyle = palette.s;
    ctx.fillRect(1, 1, 24, 14);
    ctx.fillStyle = palette.S;
    ctx.fillRect(2, 2, 22, 2);
    ctx.fillRect(2, 12, 22, 2);
    ctx.fillStyle = palette.D;
    ctx.fillRect(2, 5, 22, 1);
    ctx.fillRect(2, 10, 22, 1);
    for (let n = 0;n < 10; n++) {
      ctx.fillStyle = palette.k;
      ctx.fillRect(4 + n * 2, 3 + n, 2, 2);
      ctx.fillStyle = palette.S;
      ctx.fillRect(20 - n * 2, 3 + n, 2, 2);
    }
    ctx.fillStyle = palette.M;
    ctx.fillRect(2, 2, 2, 2);
    ctx.fillRect(22, 12, 2, 2);
  } else if (obstacle.kind === "target") {
    ctx.fillStyle = palette.k;
    ctx.fillRect(10, 3, 7, 29);
    ctx.fillRect(1, 9, 24, 14);
    ctx.fillStyle = palette.L;
    ctx.fillRect(11, 4, 5, 28);
    ctx.fillStyle = palette.G;
    ctx.fillRect(3, 11, 20, 10);
    ctx.fillStyle = palette.g;
    ctx.fillRect(6, 13, 14, 6);
    ctx.fillStyle = palette.W;
    ctx.fillRect(11, 14, 4, 4);
    ctx.fillStyle = palette.M;
    ctx.fillRect(6, 29, 17, 3);
  } else {
    ctx.fillStyle = palette.k;
    ctx.fillRect(0, 0, 46, 12);
    ctx.fillStyle = palette.M;
    ctx.fillRect(1, 1, 44, 10);
    ctx.fillStyle = palette.W;
    ctx.fillRect(2, 1, 42, 2);
    ctx.fillStyle = palette.G;
    ctx.fillRect(2, 4, 42, 5);
    ctx.fillStyle = palette.D;
    for (let n = 4;n < 43; n += 8) {
      ctx.fillRect(n, 4, 4, 2);
      ctx.fillRect(n + 2, 6, 4, 3);
    }
  }
  ctx.restore();
}
function drawArcadeBonus(ctx, state, palette) {
  if (state.mode !== "flycatch" || !state.bonus)
    return;
  const bonus = state.bonus;
  const flyX = Math.round(bonus.flyX);
  const flyY = Math.round(bonus.flyY);
  const aimX = Math.round(bonus.aimX);
  const aimY = Math.round(bonus.aimY);
  const wing = Math.floor(state.elapsedMs / 60) % 2 ? 3 : 0;
  ctx.fillStyle = palette.M;
  ctx.fillRect(flyX - 9, flyY - 7 - wing, 7, 5);
  ctx.fillRect(flyX + 2, flyY - 7 - wing, 7, 5);
  ctx.fillStyle = palette.k;
  ctx.fillRect(flyX - 4, flyY - 4, 8, 11);
  ctx.fillStyle = palette.G;
  ctx.fillRect(flyX - 3, flyY - 3, 6, 3);
  ctx.fillStyle = palette.W;
  ctx.fillRect(flyX - 3, flyY - 5, 2, 2);
  ctx.fillRect(flyX + 1, flyY - 5, 2, 2);
  ctx.strokeStyle = palette.G;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(aimX, aimY, 25, 0, Math.PI * 2);
  ctx.stroke();
  const spread = bonus.pinchMs ? 2 : 15;
  for (let n = 0;n < 42; n++) {
    ctx.fillStyle = palette.s;
    ctx.fillRect(aimX + n, aimY - spread - Math.floor(n / 3), 3, 3);
    ctx.fillRect(aimX + n, aimY + spread + Math.floor(n / 3), 3, 3);
    ctx.fillStyle = palette.S;
    ctx.fillRect(aimX + n, aimY - spread - Math.floor(n / 3), 2, 1);
    ctx.fillRect(aimX + n, aimY + spread + Math.floor(n / 3), 2, 1);
  }
  ctx.fillStyle = palette.W;
  ctx.font = "12px monospace";
  ctx.textAlign = "center";
  ctx.fillText(`FLYCATCH · ${Math.ceil(bonus.remainingMs / 1000)}s · ${bonus.caught} caught · +${bonus.caught * 50}`, Math.round(state.width / 2), 16);
  if (bonus.pinchMs)
    ctx.fillText("PINCH", aimX, Math.max(32, aimY - 32));
}
function mountAgentArcade(host, scorePort) {
  const root = document.createElement("section");
  root.className = "agent-arcade";
  root.hidden = true;
  root.setAttribute("aria-label", "LUCID run arcade");
  root.innerHTML = `
    <button type="button" class="agent-arcade-reveal" aria-expanded="false" data-tip="Arcade|A local ninja obstacle course. Nothing leaves this machine; play while you think or while the agent works.">Arcade</button>
    <div class="agent-arcade-panel" hidden>
      <div class="agent-arcade-toolbar">
        <label class="agent-arcade-game">Game <select aria-label="Arcade game" data-game-select></select></label>
        <label class="agent-arcade-character">Ninja <select aria-label="Arcade character"></select></label>
        <output class="agent-arcade-score" aria-label="Arcade score">Level 1 · Run 0 · Hearts 3</output>
        <output class="agent-arcade-total" aria-label="Combined arcade and trivia score">Total 0</output>
        <button type="button" class="agent-arcade-start">Start</button>
        <button type="button" class="agent-arcade-exit">Exit</button>
      </div>
      <canvas class="agent-arcade-canvas" tabindex="0" aria-label="Ninja obstacle course. Arrow keys move, Up or Alt jumps, Down ducks, Control punches, Down plus Control kicks."></canvas>
      <div class="agent-arcade-controls" role="group" aria-label="Arcade controls">
        <button type="button" data-action="left" aria-label="Move left">Left</button>
        <button type="button" data-action="right" aria-label="Move right">Right</button>
        <button type="button" data-action="jump">Jump</button>
        <button type="button" data-action="duck" aria-pressed="false">Duck</button>
        <button type="button" data-action="punch">Punch</button>
        <button type="button" data-action="kick">Kick</button>
        <span class="agent-arcade-status" role="status">Local only. Play any time, including while the agent works.</span>
      </div>
      <p class="agent-arcade-help">Arrows move · Up / Alt jump · Down duck · Ctrl punch · Down + Ctrl kick. Crate lids are solid: land on one and jump again. Duck bars and stars, smash flower pots. Five clears unlock Flycatch.</p>
      <div class="agent-arcade-alt" hidden></div>
    </div>`;
  host.appendChild(root);
  host.hidden = true;
  const reveal = root.querySelector(".agent-arcade-reveal");
  const panel = root.querySelector(".agent-arcade-panel");
  const chooser = root.querySelector(".agent-arcade-character select");
  const gameSelect = root.querySelector("[data-game-select]");
  const altHost = root.querySelector(".agent-arcade-alt");
  const start = root.querySelector(".agent-arcade-start");
  const exit = root.querySelector(".agent-arcade-exit");
  const canvas = root.querySelector("canvas");
  const score = root.querySelector(".agent-arcade-score");
  const totalOutput = root.querySelector(".agent-arcade-total");
  const help = root.querySelector(".agent-arcade-help");
  const jumpButton = root.querySelector('[data-action="jump"]');
  const punchButton = root.querySelector('[data-action="punch"]');
  const kickButton = root.querySelector('[data-action="kick"]');
  const status = root.querySelector(".agent-arcade-status");
  const controls = Array.from(root.querySelectorAll("[data-action]"));
  const duckButton = root.querySelector('[data-action="duck"]');
  const context = canvas.getContext("2d");
  const events = new AbortController;
  const listenerOptions = { signal: events.signal };
  for (const [id, theme2] of Object.entries(MASCOT_THEMES))
    chooser.add(new Option(theme2.name, id));
  let state = createArcadeState();
  let theme = "lucid";
  let eligible = false;
  let disposed = false;
  let playing = false;
  let started = false;
  let raf = 0;
  let resizeRaf = 0;
  let lastTime = 0;
  let dpr = 1;
  let lastScore = -1;
  let lastHearts = -1;
  let sessionTotal = 0;
  let lastTotal = -1;
  let lastMode = null;
  const keys = new Set;
  const pulses = new Map;
  let activeGame = "course";
  let miniHandle = null;
  const controlsRow = root.querySelector(".agent-arcade-controls");
  const characterLabel = root.querySelector(".agent-arcade-character");
  const courseHelp = help.textContent;
  const miniPort = {
    total: () => scorePort ? scorePort.total() : sessionTotal,
    award: (points) => {
      if (points <= 0)
        return;
      if (scorePort)
        scorePort.award(points);
      else
        sessionTotal += points;
      lastTotal = -1;
    }
  };
  function switchGame(id) {
    if (miniHandle) {
      miniHandle.dispose();
      miniHandle = null;
    }
    altHost.hidden = true;
    altHost.replaceChildren();
    activeGame = id;
    const course = id === "course";
    canvas.hidden = !course;
    controlsRow.hidden = !course;
    characterLabel.hidden = !course;
    score.hidden = !course;
    start.hidden = !course;
    totalOutput.hidden = !course;
    help.hidden = !course;
    start.textContent = "Start";
    stop();
    if (course) {
      started = false;
      state = createArcadeState(state.width);
      lastMode = null;
      lastScore = -1;
      lastHearts = -1;
      lastTotal = -1;
      help.textContent = courseHelp;
      resize();
    } else {
      const def = MINI_GAMES.find((g) => g.id === id);
      miniHandle = def.mount(altHost, miniPort);
      altHost.hidden = false;
    }
    totalOutput.textContent = `Total ${miniPort.total()}`;
  }
  function acceptState(next) {
    const earned = Math.max(0, next.score - state.score);
    state = next;
    if (earned) {
      if (scorePort)
        scorePort.award(earned);
      else
        sessionTotal += earned;
    }
  }
  function clearInput() {
    keys.clear();
    pulses.clear();
    state = {
      ...state,
      held: { left: false, right: false, duck: false },
      bonus: state.bonus ? { ...state.bonus, up: false } : null
    };
    duckButton.setAttribute("aria-pressed", "false");
  }
  function stop() {
    playing = false;
    cancelAnimationFrame(raf);
    cancelAnimationFrame(resizeRaf);
    raf = 0;
    resizeRaf = 0;
    lastTime = 0;
    clearInput();
    for (const button of controls)
      button.disabled = true;
  }
  function paint() {
    if (!context || panel.hidden || root.hidden)
      return;
    const ctx = context;
    const palette = MASCOT_THEMES[theme].palette;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = palette.B;
    ctx.fillRect(0, 0, state.width, CANVAS_HEIGHT2);
    ctx.fillStyle = palette.D;
    for (let x = -Math.floor(state.elapsedMs * 0.007) % 190;x < state.width; x += 190) {
      ctx.fillRect(x + 30, 76, 90, 67);
      ctx.fillRect(x + 20, 69, 110, 7);
      ctx.fillRect(x + 30, 63, 90, 6);
      ctx.fillRect(x + 42, 57, 66, 6);
      ctx.fillRect(x + 54, 51, 42, 6);
      ctx.fillStyle = palette.L;
      ctx.fillRect(x + 49, 84, 3, 45);
      ctx.fillRect(x + 96, 84, 3, 45);
      ctx.fillStyle = palette.D;
    }
    for (let x = -Math.floor(state.elapsedMs * 0.016) % 120;x < state.width; x += 120) {
      ctx.fillStyle = palette.g;
      ctx.fillRect(x + 14, 42, 4, 112);
      ctx.fillRect(x + 25, 59, 3, 95);
      for (let y = 55;y < 150; y += 24) {
        ctx.fillStyle = palette.G;
        ctx.fillRect(x + 14, y, 4, 2);
        ctx.fillStyle = palette.g;
        ctx.fillRect(x + 7, y + 5, 9, 3);
        ctx.fillRect(x + 18, y - 5, 12, 3);
      }
      ctx.fillStyle = palette.s;
      ctx.fillRect(x + 75, 79, 12, 17);
      ctx.fillStyle = palette.S;
      ctx.fillRect(x + 79, 81, 4, 12);
      ctx.fillStyle = palette.k;
      ctx.fillRect(x + 74, 77, 14, 3);
      ctx.fillRect(x + 74, 94, 14, 3);
      ctx.fillRect(x + 80, 69, 2, 8);
    }
    ctx.fillStyle = palette.L;
    ctx.fillRect(0, 148, state.width, 3);
    ctx.fillRect(0, 163, state.width, 3);
    for (let x = -Math.floor(state.elapsedMs * 0.03) % 24;x < state.width; x += 24)
      ctx.fillRect(x, 143, 3, 29);
    ctx.fillStyle = palette.g;
    ctx.fillRect(0, FLOOR_Y2, state.width, 2);
    ctx.fillStyle = palette.D;
    for (let x = -Math.floor(state.elapsedMs * 0.055) % 38;x < state.width; x += 38)
      ctx.fillRect(x, FLOOR_Y2 + 4, 28, 3);
    for (const obstacle of state.obstacles) {
      if (obstacle.handled && (obstacle.kind === "target" || obstacle.kind === "pot"))
        continue;
      paintObstacle(ctx, obstacle, palette, state.elapsedMs);
    }
    for (const chip of state.debris) {
      ctx.fillStyle = chip.color === "leaf" ? palette.G : palette.s;
      ctx.fillRect(Math.round(chip.x), Math.round(FLOOR_Y2 - chip.y), 4, 3);
    }
    const spriteScale = arcadeScale(state.width);
    if (!state.invulnerableMs || Math.floor(state.invulnerableMs / 90) % 2 === 0) {
      let frame = MASCOT_RUN_FRAMES[Math.floor(state.elapsedMs / 80) % MASCOT_RUN_FRAMES.length];
      if (!playing || state.mode === "flycatch")
        frame = "guard";
      if (state.attack) {
        const duration = state.attack === "kick" ? 330 : 230;
        const frames = state.attack === "kick" ? KICK_FRAMES : PUNCH_FRAMES;
        frame = frames[Math.min(3, Math.floor((duration - state.attackMs) / duration * 4))];
      }
      if (state.jumpY > state.groundY && !state.attack)
        frame = "kickA";
      const ducking = state.held.duck && state.velocityY === 0 && state.jumpY <= state.groundY;
      ctx.save();
      if (ducking) {
        ctx.beginPath();
        ctx.rect(state.x, FLOOR_Y2 - 24 * spriteScale, MASCOT_W * spriteScale, 24 * spriteScale);
        ctx.clip();
        frame = "kickA";
      }
      paintFrame(ctx, frame, spriteScale, Math.round(state.x), Math.round(FLOOR_Y2 - MASCOT_H * spriteScale - state.jumpY + (ducking ? 22 * spriteScale : 0)), palette);
      ctx.restore();
    }
    drawArcadeBonus(ctx, state, palette);
    if (!playing) {
      ctx.fillStyle = palette.W;
      ctx.font = "12px monospace";
      ctx.textAlign = "center";
      ctx.fillText(state.phase === "lost" ? "Course over. Restart for another run." : started ? "Paused. Choose Resume to continue." : "Choose your ninja, then Start.", Math.round(state.width / 2), state.mode === "flycatch" ? 34 : 20);
    }
    if (lastScore !== state.score || lastHearts !== state.hearts) {
      score.textContent = `Level ${state.level} · Run ${state.score} · Hearts ${state.hearts}`;
      lastScore = state.score;
      lastHearts = state.hearts;
    }
    const total = scorePort ? scorePort.total() : sessionTotal;
    if (lastTotal !== total) {
      totalOutput.textContent = `Total ${total}`;
      lastTotal = total;
    }
    if (lastMode !== state.mode) {
      const bonus = state.mode === "flycatch";
      lastMode = state.mode;
      jumpButton.textContent = bonus ? "Aim up" : "Jump";
      duckButton.textContent = bonus ? "Aim down" : "Duck";
      punchButton.textContent = bonus ? "Pinch" : "Punch";
      kickButton.textContent = bonus ? "Pinch" : "Kick";
      help.textContent = bonus ? "Flycatch bonus: arrows aim the chopsticks. Ctrl / Alt pinch when the fly is inside the ring. 50 points per catch. No damage. 12 seconds." : "Arrows move · Up / Alt jump · Down duck · Ctrl punch · Down + Ctrl kick. Crate lids are solid: land on one and jump again. Duck bars and stars, smash flower pots. Five clears unlock Flycatch.";
      if (playing)
        status.textContent = bonus ? "Five clears! Flycatch bonus unlocked." : "Course resumed. Keep your earned bonus points.";
      canvas.setAttribute("aria-label", bonus ? "Flycatch bonus. Arrow keys aim, Control or Alt pinches. Fifty points per catch. Twelve seconds, no damage." : "Ninja obstacle course. Arrow keys move, Up or Alt jumps, Down ducks, Control punches, Down plus Control kicks.");
    }
  }
  function resize() {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = 0;
    if (disposed || !eligible || panel.hidden || root.hidden || activeGame !== "course")
      return;
    const style = getComputedStyle(panel);
    const padding = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
    const width = Math.max(260, Math.floor(panel.clientWidth - padding));
    dpr = Math.min(2, Math.max(1, Math.ceil(window.devicePixelRatio || 1)));
    const pixelWidth = width * dpr;
    const pixelHeight = CANVAS_HEIGHT2 * dpr;
    if (canvas.width !== pixelWidth)
      canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight)
      canvas.height = pixelHeight;
    if (state.width !== width)
      state = { ...state, width, x: Math.min(state.x, width * 0.45, width - 150) };
    paint();
  }
  function pause() {
    if (!playing)
      return;
    stop();
    start.textContent = "Resume";
    status.textContent = "Paused. Resume when ready.";
    paint();
  }
  function tick(time) {
    raf = 0;
    if (!playing || !eligible || disposed || document.hidden) {
      pause();
      return;
    }
    const previousMode = state.mode;
    acceptState(stepArcade(state, lastTime ? time - lastTime : 0));
    if (previousMode !== state.mode)
      clearInput();
    lastTime = time;
    for (const [action, until] of pulses) {
      if (state.elapsedMs >= until) {
        pulses.delete(action);
        const key = action === "left" ? "ArrowLeft" : action === "right" ? "ArrowRight" : action === "aim-up" ? "ArrowUp" : "ArrowDown";
        state = applyArcadeInput(state, action, keys.has(key));
        if (action === "duck")
          duckButton.setAttribute("aria-pressed", String(state.held.duck));
      }
    }
    if (state.phase === "lost") {
      stop();
      start.textContent = "Restart";
      status.textContent = `Course over. Score ${state.score}. Restart or exit.`;
    }
    paint();
    if (playing)
      raf = requestAnimationFrame(tick);
  }
  function begin() {
    if (!eligible || document.hidden || disposed)
      return;
    if (activeGame !== "course") {
      miniHandle?.start();
      start.textContent = "Restart";
      return;
    }
    if (!context)
      return;
    if (playing) {
      pause();
      return;
    }
    if (!started || state.phase === "lost")
      state = createArcadeState(state.width);
    started = true;
    playing = true;
    lastTime = 0;
    start.textContent = "Pause";
    status.textContent = "Jump crates. Duck bars. Strike targets.";
    for (const button of controls)
      button.disabled = false;
    canvas.focus({ preventScroll: true });
    raf = requestAnimationFrame(tick);
  }
  function close() {
    stop();
    if (activeGame !== "course") {
      gameSelect.value = "course";
      switchGame("course");
    }
    started = false;
    panel.hidden = true;
    reveal.hidden = false;
    reveal.setAttribute("aria-expanded", "false");
    start.textContent = "Start";
    state = createArcadeState(state.width);
  }
  reveal.addEventListener("click", () => {
    if (!eligible)
      return;
    panel.hidden = false;
    reveal.hidden = true;
    reveal.setAttribute("aria-expanded", "true");
    status.textContent = context ? "Local only. Play any time, including while the agent works." : "Canvas is unavailable in this window.";
    start.disabled = !context;
    for (const button of controls)
      button.disabled = true;
    resize();
    start.focus({ preventScroll: true });
  }, listenerOptions);
  start.addEventListener("click", begin, listenerOptions);
  exit.addEventListener("click", () => {
    close();
    reveal.focus({ preventScroll: true });
  }, listenerOptions);
  chooser.addEventListener("change", () => {
    theme = chooser.value;
    paint();
  }, listenerOptions);
  gameSelect.add(new Option("Obstacle course", "course"));
  for (const def of MINI_GAMES)
    gameSelect.add(new Option(def.name, def.id));
  gameSelect.addEventListener("change", () => switchGame(gameSelect.value), listenerOptions);
  for (const button of controls) {
    button.addEventListener("click", () => {
      if (!playing || !eligible)
        return;
      let action = button.dataset.action;
      if (state.mode === "flycatch" && action === "jump")
        action = "aim-up";
      acceptState(applyArcadeInput(state, action, true));
      if (action === "left" || action === "right" || action === "duck" || action === "aim-up") {
        pulses.set(action, state.elapsedMs + (action === "duck" && state.mode === "runner" ? 800 : 180));
      }
      duckButton.setAttribute("aria-pressed", String(state.held.duck));
      canvas.focus({ preventScroll: true });
      paint();
    }, listenerOptions);
  }
  const keyAction = (event) => {
    switch (event.key) {
      case "ArrowLeft":
        return "left";
      case "ArrowRight":
        return "right";
      case "ArrowDown":
        return "duck";
      case "ArrowUp":
        return state.mode === "flycatch" ? "aim-up" : "jump";
      case "Alt":
        return "jump";
      case "Control":
        return keys.has("ArrowDown") ? "kick" : "punch";
      default:
        return null;
    }
  };
  canvas.addEventListener("keydown", (event) => {
    if (!playing || !eligible || document.activeElement !== canvas)
      return;
    const action = keyAction(event);
    if (!action)
      return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat)
      return;
    keys.add(event.key);
    acceptState(applyArcadeInput(state, action, true));
    duckButton.setAttribute("aria-pressed", String(state.held.duck));
  }, listenerOptions);
  canvas.addEventListener("keyup", (event) => {
    if (!playing || !eligible || document.activeElement !== canvas)
      return;
    const action = keyAction(event);
    if (!action)
      return;
    event.preventDefault();
    event.stopPropagation();
    keys.delete(event.key);
    state = applyArcadeInput(state, action, false);
    duckButton.setAttribute("aria-pressed", String(state.held.duck));
  }, listenerOptions);
  root.addEventListener("focusout", (event) => {
    if (!(event.relatedTarget instanceof Node) || !root.contains(event.relatedTarget))
      pause();
    else if (event.target === canvas)
      clearInput();
  }, listenerOptions);
  window.addEventListener("blur", pause, listenerOptions);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden)
      pause();
  }, listenerOptions);
  const observer = new ResizeObserver(() => {
    if (!disposed && eligible && !panel.hidden && !resizeRaf)
      resizeRaf = requestAnimationFrame(resize);
  });
  observer.observe(host);
  return {
    update(agentMode) {
      if (disposed)
        return;
      if (eligible === agentMode)
        return;
      eligible = agentMode;
      if (!eligible) {
        const active = document.activeElement;
        if (active instanceof HTMLElement && root.contains(active))
          active.blur();
        close();
      }
      root.hidden = !eligible;
      host.hidden = !eligible;
    },
    dispose() {
      if (disposed)
        return;
      disposed = true;
      const active = document.activeElement;
      if (active instanceof HTMLElement && root.contains(active))
        active.blur();
      stop();
      if (miniHandle) {
        miniHandle.dispose();
        miniHandle = null;
      }
      events.abort();
      observer.disconnect();
      root.remove();
      host.hidden = true;
    }
  };
}

// desktop/.mascot-qa/cabinet.ts
var games = ["course", "shuriken", "kata", "stack"];
for (const id of games) {
  const wrap = document.createElement("div");
  const label = document.createElement("h2");
  label.textContent = id;
  const host = document.createElement("div");
  wrap.append(label, host);
  document.body.appendChild(wrap);
  const handle = mountAgentArcade(host);
  handle.update(true);
  const reveal = host.querySelector(".agent-arcade-reveal");
  reveal.click();
  if (id !== "course") {
    const select = host.querySelector("[data-game-select]");
    select.value = id;
    select.dispatchEvent(new Event("change"));
    host.querySelector(".mini-game-start")?.click();
  }
}
