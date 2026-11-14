// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/result_window.ts - P-CTX.2b (ADR-0579): the tool-result window, sized to the chat model.
//
// omp shows the model at most `tools.artifactSpillThreshold` (default 50 KB) of any one tool result and
// saves the rest as a session artifact (ADR-0578). 50 KB is about 12,500 tokens. That suits a 200K-token
// cloud model and overflows a local model with an 8K or 32K window in one or two tool calls. This module
// decides a smaller window for a model whose context window LUCID knows, and writes it as an omp
// `--config` overlay at every spawn, like the judgment and model-roles overlays.
//
// THE RULE. One tool result may take one sixteenth of the context window. At about 4 bytes per token that
// is `contextWindow / 4` bytes: 2 KB for an 8K model, 8 KB for 32K, 32 KB for 128K. From 204,800 tokens up
// the rule reaches omp's own 50 KB default, and LUCID writes nothing. Head and tail keep omp's own
// proportions (40% of the threshold each).
//
// WHICH WINDOW. Only a model served by a LUCID Local Provider has a window this module trusts: the one the
// user's endpoint reported through Discover (ADR-0367), or the 8192-token default omp is given for a model
// with none. Every other model keeps omp's default.
//
// A CHANGE OF MODEL inside a running omp process is not seen: omp reads `--config` at spawn. The window
// follows the model at the next spawn, the same limit the model-roles overlay has (ADR-0448).
//
// PURE: no Node imports, because the renderer bundles this file for the Settings control and the tool
// chip. The file write lives in result_window_overlay.ts.

/** What the user chose: size the window to the model, leave omp's default, or a fixed threshold in KB. */
export type ResultWindowSetting = "auto" | "omp" | number;

/** The fixed thresholds the Settings control offers, in KB. */
export const RESULT_WINDOW_FIXED_KB = [2, 4, 8, 16, 32] as const;

/** omp's own `tools.artifactSpillThreshold` default, in KB. At or above it LUCID writes no overlay. */
export const OMP_DEFAULT_THRESHOLD_KB = 50;
/** The smallest window LUCID sets. Below this a result's head and tail stop being useful. */
export const MIN_THRESHOLD_KB = 2;
/** The context window omp is told for a local model that declares none (local_providers.ts). */
export const DEFAULT_LOCAL_CONTEXT_TOKENS = 8192;

/** The omp spill settings LUCID writes. Sizes in KB, as omp's settings take them. */
export interface ResultWindow {
  thresholdKb: number;
  headKb: number;
  tailKb: number;
  tailLines: number;
}

/** PURE: parse a stored or posted value into a setting. Anything unrecognized is "auto", the default. */
export function parseResultWindowSetting(v: unknown): ResultWindowSetting {
  if (v === "omp") return "omp";
  if (typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= OMP_DEFAULT_THRESHOLD_KB) return v;
  return "auto";
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** PURE: the spill threshold in KB for a context window of `tokens`: one sixteenth of the window at 4 bytes
 *  per token, in half-KB steps, never under MIN_THRESHOLD_KB and never over omp's default. */
export function thresholdKbForContext(tokens: number): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return MIN_THRESHOLD_KB;
  const kb = Math.floor((tokens / 4 / 1024) * 2) / 2;
  return Math.min(OMP_DEFAULT_THRESHOLD_KB, Math.max(MIN_THRESHOLD_KB, kb));
}

/** PURE: head, tail and line budget for a threshold, in omp's own proportions (20 KB head, 20 KB tail and
 *  500 tail lines at the 50 KB default). */
export function windowForThreshold(thresholdKb: number): ResultWindow {
  const share = round1(thresholdKb * 0.4);
  return { thresholdKb, headKb: share, tailKb: share, tailLines: Math.max(25, Math.round((500 * share) / 20)) };
}

/** PURE: the window to write, or null to leave omp's default. `contextTokens` is the chat model's context
 *  window when LUCID knows it (a Local Provider model), else null. */
export function resolveResultWindow(setting: ResultWindowSetting, contextTokens: number | null): ResultWindow | null {
  if (setting === "omp") return null;
  if (typeof setting === "number") return setting >= OMP_DEFAULT_THRESHOLD_KB ? null : windowForThreshold(setting);
  if (contextTokens === null) return null;
  const kb = thresholdKbForContext(contextTokens);
  return kb >= OMP_DEFAULT_THRESHOLD_KB ? null : windowForThreshold(kb);
}

/** The slice of a Local Provider this module reads. */
export interface WindowProvider {
  ompProvider: string;
  enabled?: boolean;
  models: readonly { id: string; contextWindow?: number }[];
}

/** PURE: the context window of `chatModel` (`provider/model`, as omp reports it) when an enabled Local
 *  Provider serves it, else null. A local model with no declared window gets the same 8192-token default
 *  omp is given for it, so the window is sized to what omp will actually enforce. */
export function chatModelContextWindow(chatModel: string, providers: readonly WindowProvider[]): number | null {
  const slash = chatModel.indexOf("/");
  if (slash <= 0) return null;
  const provider = chatModel.slice(0, slash);
  const model = chatModel.slice(slash + 1);
  for (const p of providers) {
    if (p.enabled === false || p.ompProvider !== provider) continue;
    const m = p.models.find((x) => x.id === model);
    if (m) return m.contextWindow && m.contextWindow > 0 ? m.contextWindow : DEFAULT_LOCAL_CONTEXT_TOKENS;
  }
  return null;
}

/** The omp `--config` overlay body. With no window it is an empty map, so a window written by an earlier
 *  spawn never lingers after a switch to a large model. */
export function resultWindowOverlayYaml(win: ResultWindow | null): string {
  const head = "# Written by LUCID at every omp spawn (P-CTX.2b). Do not edit: the chat model and Settings decide it.\n";
  if (!win) return `${head}{}\n`;
  return `${head}tools:\n  artifactSpillThreshold: ${win.thresholdKb}\n  artifactHeadBytes: ${win.headKb}\n  artifactTailBytes: ${win.tailKb}\n  artifactTailLines: ${win.tailLines}\n`;
}

/** PURE: a byte count for a person: `812 B`, `3.7 KB`, `2.1 MB`. */
export function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** How much of one tool result the model was shown, and where the rest is. */
export interface ResultSpill {
  /** Size of the whole result. */
  storedBytes: number;
  /** Size of the head and tail view the model received. */
  shownBytes: number;
  /** omp's session artifact id holding the whole result, when it was saved. */
  artifactId?: string;
}

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

/** PURE: read omp's spill metadata off a settled tool call's `rawOutput` (`details.meta.truncation`). Null
 *  when the result was not cut, or the numbers are not the two positive sizes a cut result carries. */
export function spillFromRawOutput(rawOutput: unknown): ResultSpill | null {
  const t = rec(rec(rec(rec(rawOutput)?.details)?.meta)?.truncation);
  if (!t) return null;
  const stored = t.totalBytes;
  const shown = t.outputBytes;
  if (typeof stored !== "number" || typeof shown !== "number") return null;
  if (!Number.isFinite(stored) || !Number.isFinite(shown) || stored <= 0 || shown < 0 || shown > stored) return null;
  const id = typeof t.artifactId === "string" && /^\d+$/.test(t.artifactId) ? t.artifactId : undefined;
  return { storedBytes: stored, shownBytes: shown, ...(id ? { artifactId: id } : {}) };
}
