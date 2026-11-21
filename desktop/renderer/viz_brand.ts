// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_brand.ts - P-VIZ.7 (ADR-0641): who "sponsors" a Visualize figure, from the model it runs.
//
// Every node runs a model; its provider decides the sponsor emblem a figure wears (the anime cast's shirt and
// pants patches, the office cast's spinning desk emblem and lanyard), its size class decides the figure's scale
// (a flagship stands a little taller than a mini), and a stable hash of the model id picks a variant (a weapon
// or an outfit). A model on no known cloud provider (a local engine, a self-hosted endpoint, a custom gateway)
// is PRIVATE and wears the TL187 emblem.
//
// The emblems are ORIGINAL geometric marks in each provider's colors (a sunburst, a hexagon, a four-color ring,
// a bold X ...), drawn here, never copies of a provider's logo artwork: a sponsor patch that reads as the
// provider without shipping a trademark. Licensed art, if it ever exists, replaces `drawGlyph` per key.
//
// Pure apart from drawEmblem/emblemCanvas, which paint on a 2D canvas (no three.js here).

export type VizBrandKey = "anthropic" | "openai" | "google" | "xai" | "github" | "meta" | "mistral" | "deepseek" | "qwen" | "tl187";
export type VizSizeClass = "large" | "mid" | "small";

export interface VizBrand {
  key: VizBrandKey;
  /** The sponsor word under the mark on a patch: "CLAUDE", "GPT", "TL187". */
  word: string;
  primary: string;
  secondary: string;
  /** Ink for the mark and the word on the primary field. */
  ink: string;
  size: VizSizeClass;
  /** The figure's scale factor for its size class (1 = as before). */
  scale: number;
  /** 0..3, stable per model id: picks a weapon (anime) or an outfit and desk set (office). */
  variant: number;
  /** True for the TL187 emblem: a model on no known cloud provider. */
  private: boolean;
}

interface Sponsor { word: string; primary: string; secondary: string; ink: string }

const SPONSORS: Record<VizBrandKey, Sponsor> = {
  anthropic: { word: "CLAUDE", primary: "#d97757", secondary: "#f4e9dc", ink: "#fffaf3" },
  openai: { word: "GPT", primary: "#101418", secondary: "#10a37f", ink: "#ffffff" },
  google: { word: "GEMINI", primary: "#ffffff", secondary: "#4285f4", ink: "#1f2937" },
  xai: { word: "GROK", primary: "#0b0b0c", secondary: "#e5e7eb", ink: "#ffffff" },
  github: { word: "COPILOT", primary: "#24292f", secondary: "#8957e5", ink: "#ffffff" },
  meta: { word: "LLAMA", primary: "#0866ff", secondary: "#c9dcff", ink: "#ffffff" },
  mistral: { word: "MISTRAL", primary: "#fa520f", secondary: "#ffd800", ink: "#1a1a1a" },
  deepseek: { word: "DEEPSEEK", primary: "#4d6bfe", secondary: "#dfe6ff", ink: "#ffffff" },
  qwen: { word: "QWEN", primary: "#615ced", secondary: "#e6e4ff", ink: "#ffffff" },
  tl187: { word: "TL187", primary: "#0d1117", secondary: "#e11d48", ink: "#5eead4" },
};

// Provider prefixes (omp route ids) to sponsor. A gateway route (AskSage, OpenRouter, Bedrock, Vertex, Azure,
// Copilot) carries another lab's model: the model's own family wins there (see FAMILY below).
const ROUTES: Record<string, VizBrandKey> = {
  anthropic: "anthropic", "claude-code": "anthropic",
  openai: "openai", "openai-codex": "openai", azure: "openai", "azure-openai": "openai",
  google: "google", "google-gemini-cli": "google", "google-vertex": "google", "google-antigravity": "google", gemini: "google",
  xai: "xai", "xai-oauth": "xai",
  "github-copilot": "github",
  meta: "meta", mistral: "mistral", deepseek: "deepseek", "qwen-portal": "qwen", qwen: "qwen", alibaba: "qwen",
};
/** Cloud gateways that resell other labs' models: never private, sponsor from the model's family. */
const GATEWAYS = new Set(["openrouter", "amazon-bedrock", "bedrock", "asksage", "groq", "together", "fireworks", "vertex", "perplexity", "moonshot", "zai", "minimax", "cerebras"]);
/** The model family inside the id, for gateway routes and Copilot (which runs Claude and GPT too). */
const FAMILY: readonly [RegExp, VizBrandKey][] = [
  [/claude|anthropic/, "anthropic"], [/gpt|o[1-9](?![a-z])|codex|openai/, "openai"], [/gemini|gemma/, "google"], [/grok/, "xai"],
  [/llama/, "meta"], [/mistral|mixtral|codestral|devstral/, "mistral"], [/deepseek/, "deepseek"], [/qwen|qwq/, "qwen"],
];

/** Size class from the model id: a flagship, a workhorse, or a small fast model. */
export function sizeClassOf(model: string): VizSizeClass {
  const id = model.toLowerCase().slice(model.lastIndexOf("/") + 1);
  // Words only as whole id segments ("gemini" is not "mini"); parameter counts as a segment like "8b" or "70b".
  if (/(?:^|[-_.:])(?:haiku|mini|nano|flash|lite|small|tiny|(?:[1-9]|1[0-4])b)(?![a-z0-9])/.test(id)) return "small";
  if (/(?:^|[-_.:])(?:opus|ultra|max|large|pro|mythos|fable|terra|(?:[7-9]\d|[1-9]\d\d)b)(?![a-z0-9])/.test(id)) return "large";
  return "mid";
}

const SCALE: Record<VizSizeClass, number> = { large: 1.1, mid: 1, small: 0.88 };

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
}

/** The sponsor, size and variant for a node running `model`; null while the model is not known yet (the figure
 *  then wears no emblem rather than a guessed one). */
export function vizBrandFor(model: string): VizBrand | null {
  const m = model.trim().toLowerCase();
  if (!m) return null;
  const slash = m.indexOf("/");
  const route = slash > 0 ? m.slice(0, slash) : "";
  const family = FAMILY.find(([re]) => re.test(m.slice(slash + 1)))?.[1];
  let key: VizBrandKey;
  if (route === "github-copilot") key = family ?? "github";
  else if (ROUTES[route]) key = ROUTES[route]!;
  else if (GATEWAYS.has(route) || route.startsWith("asksage")) key = family ?? "tl187";
  else if (!route && family) key = family; // a bare model id from a cloud lab
  else key = "tl187"; // local engines, self-hosted endpoints, custom providers: private
  const size = sizeClassOf(m);
  return { key, ...SPONSORS[key], size, scale: SCALE[size], variant: hash(m) % 4, private: key === "tl187" };
}

// ----------------------------------------------------------------------------------------------- drawing

/** The provider's mark, centered at (cx, cy) inside radius r, in `ink` over whatever is below. */
function drawGlyph(ctx: CanvasRenderingContext2D, b: VizBrand, cx: number, cy: number, r: number): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.fillStyle = b.ink;
  ctx.strokeStyle = b.ink;
  switch (b.key) {
    case "anthropic": { // a twelve-ray sunburst: rounded, tapered rays of alternating length
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        const len = r * (i % 2 ? 0.62 : 0.92);
        ctx.lineWidth = r * (i % 2 ? 0.12 : 0.16);
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * r * 0.14, Math.sin(a) * r * 0.14);
        ctx.lineTo(Math.cos(a) * len, Math.sin(a) * len);
        ctx.stroke();
      }
      break;
    }
    case "openai": { // a hexagon ring around a smaller rotated hexagon
      ctx.lineWidth = r * 0.14;
      for (const [rr, rot] of [[0.82, 0], [0.42, Math.PI / 6]] as const) {
        ctx.beginPath();
        for (let i = 0; i < 6; i++) { const a = rot + (i / 6) * Math.PI * 2; ctx[i ? "lineTo" : "moveTo"](Math.cos(a) * r * rr, Math.sin(a) * r * rr); }
        ctx.closePath();
        ctx.stroke();
      }
      ctx.strokeStyle = b.secondary;
      ctx.lineWidth = r * 0.06;
      ctx.beginPath(); ctx.arc(0, 0, r * 0.2, 0, Math.PI * 2); ctx.stroke();
      break;
    }
    case "google": { // a four-color ring with a four-point star
      const cols = ["#4285f4", "#ea4335", "#fbbc04", "#34a853"];
      ctx.lineWidth = r * 0.2;
      for (let i = 0; i < 4; i++) { ctx.strokeStyle = cols[i]!; ctx.beginPath(); ctx.arc(0, 0, r * 0.78, (i / 4) * Math.PI * 2 + 0.12, ((i + 1) / 4) * Math.PI * 2 - 0.12); ctx.stroke(); }
      ctx.fillStyle = "#4285f4";
      ctx.beginPath();
      for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2 - Math.PI / 2, rr = i % 2 ? r * 0.12 : r * 0.46; ctx[i ? "lineTo" : "moveTo"](Math.cos(a) * rr, Math.sin(a) * rr); }
      ctx.closePath(); ctx.fill();
      break;
    }
    case "xai": { // a bold slanted X with one long stroke
      ctx.lineWidth = r * 0.2;
      ctx.beginPath(); ctx.moveTo(-r * 0.62, -r * 0.7); ctx.lineTo(r * 0.62, r * 0.7); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(r * 0.62, -r * 0.7); ctx.lineTo(r * 0.12, -r * 0.1); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-r * 0.12, r * 0.12); ctx.lineTo(-r * 0.62, r * 0.7); ctx.stroke();
      break;
    }
    case "github": { // a rounded visor with two eyes (a pilot's helmet)
      ctx.lineWidth = r * 0.13;
      ctx.beginPath(); ctx.arc(0, r * 0.08, r * 0.72, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke();
      ctx.beginPath(); ctx.roundRect(-r * 0.66, -r * 0.08, r * 1.32, r * 0.62, r * 0.24); ctx.stroke();
      ctx.fillStyle = b.secondary;
      for (const x of [-0.26, 0.26]) { ctx.beginPath(); ctx.ellipse(x * r, r * 0.22, r * 0.09, r * 0.14, 0, 0, Math.PI * 2); ctx.fill(); }
      break;
    }
    case "meta": { // a loop (a figure eight on its side)
      ctx.lineWidth = r * 0.17;
      ctx.beginPath();
      for (let i = 0; i <= 64; i++) { const t = (i / 64) * Math.PI * 2; const d = 1 + Math.sin(t) ** 2; ctx[i ? "lineTo" : "moveTo"]((r * 0.86 * Math.cos(t)) / d, (r * 0.86 * Math.sin(t) * Math.cos(t)) / d); }
      ctx.stroke();
      break;
    }
    case "tl187": { // the house mark: a shield with TL over 187
      ctx.lineWidth = r * 0.08;
      ctx.strokeStyle = b.secondary;
      ctx.beginPath();
      ctx.moveTo(0, -r * 0.9); ctx.lineTo(r * 0.78, -r * 0.6); ctx.lineTo(r * 0.66, r * 0.3); ctx.lineTo(0, r * 0.92); ctx.lineTo(-r * 0.66, r * 0.3); ctx.lineTo(-r * 0.78, -r * 0.6);
      ctx.closePath(); ctx.stroke();
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.font = `900 ${Math.round(r * 0.62)}px system-ui, sans-serif`;
      ctx.fillText("TL", 0, -r * 0.2);
      ctx.fillStyle = b.secondary;
      ctx.font = `800 ${Math.round(r * 0.36)}px system-ui, sans-serif`;
      ctx.fillText("187", 0, r * 0.38);
      break;
    }
    default: { // a monogram on a ring (Mistral, DeepSeek, Qwen)
      ctx.lineWidth = r * 0.1;
      ctx.beginPath(); ctx.arc(0, 0, r * 0.8, 0, Math.PI * 2); ctx.stroke();
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.font = `900 ${Math.round(r * 0.9)}px system-ui, sans-serif`;
      ctx.fillText(b.word[0]!, 0, r * 0.06);
    }
  }
  ctx.restore();
}

/** A sponsor patch on a w x h canvas region at (x, y): a rounded field in the primary color with the mark, and
 *  the sponsor word beside it (wide) or under it (tall). `word: false` draws the mark alone (a round badge). */
export function drawEmblem(ctx: CanvasRenderingContext2D, b: VizBrand, x: number, y: number, w: number, h: number, opts: { word?: boolean } = {}): void {
  const word = opts.word ?? true;
  ctx.save();
  ctx.fillStyle = b.primary;
  ctx.strokeStyle = b.secondary;
  ctx.lineWidth = Math.max(2, Math.min(w, h) * 0.05);
  ctx.beginPath();
  if (word) ctx.roundRect(x + ctx.lineWidth, y + ctx.lineWidth, w - 2 * ctx.lineWidth, h - 2 * ctx.lineWidth, Math.min(w, h) * 0.2);
  else ctx.arc(x + w / 2, y + h / 2, Math.min(w, h) / 2 - ctx.lineWidth, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  if (!word) { drawGlyph(ctx, b, x + w / 2, y + h / 2, Math.min(w, h) * 0.34); ctx.restore(); return; }
  const wide = w >= h * 1.6;
  const r = wide ? h * 0.32 : Math.min(w, h * 0.62) * 0.34;
  const gx = wide ? x + h * 0.52 : x + w / 2;
  const gy = wide ? y + h / 2 : y + h * 0.4;
  drawGlyph(ctx, b, gx, gy, r);
  ctx.fillStyle = b.ink;
  ctx.textBaseline = "middle";
  const room = wide ? w - h * 1.0 - h * 0.18 : w * 0.86;
  let px = Math.round(wide ? h * 0.42 : h * 0.17);
  ctx.font = `900 ${px}px system-ui, sans-serif`;
  while (px > 6 && ctx.measureText(b.word).width > room) { px--; ctx.font = `900 ${px}px system-ui, sans-serif`; }
  ctx.textAlign = wide ? "left" : "center";
  ctx.fillText(b.word, wide ? x + h * 1.0 : x + w / 2, wide ? y + h / 2 : y + h * 0.8);
  ctx.restore();
}

/** A fresh canvas holding one patch (for a THREE.CanvasTexture). */
export function emblemCanvas(b: VizBrand, w: number, h: number, opts: { word?: boolean } = {}): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (ctx) drawEmblem(ctx, b, 0, 0, w, h, opts);
  return c;
}
