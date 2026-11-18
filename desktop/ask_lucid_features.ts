// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/ask_lucid_features.ts - P-ASKLUCID.6 (ADR-0587): what LUCID can do, and which of it this user has not touched.
//
// There is a lot in LUCID that a user never finds. When Lucid's suggestions from the work run dry, he
// brings up one feature the user has not used, says what it would do for them, and offers to open it or
// set it up (as a proposal the user confirms).
//
// "Not used" is decided from things the app already knows: whether a lane, a goal or a knowledge graph
// exists, whether a setting is on, and a small ledger of which panels have ever been open (panel kinds
// only, never their content).
//
// The catalog is short on purpose and every entry is something this build really has. An entry names the
// view Lucid may propose opening, or the setting he may propose changing, so a recommendation always ends
// in something the user can confirm.
//
// Pure, and without imports: the renderer bundles this file.

export interface AskFeature {
  id: string;
  title: string;
  /** What it does for the user. One or two sentences. */
  pitch: string;
  /** Panel kinds (screen_digest.ts) whose being open proves the feature was found. */
  surfaces: readonly string[];
  /** The view Lucid may propose opening (an `open_view` view). */
  view?: string;
  /** The setting Lucid may propose changing (a `set_setting` key and value). */
  setting?: { key: string; value: string };
}

export const ASK_FEATURES: readonly AskFeature[] = [
  { id: "fleet", title: "Fleet agents", pitch: "Run several agents side by side, each with its own task, and watch them all from one grid.", surfaces: ["Fleet grid", "Fleet Orbit map"], view: "fleet" },
  { id: "knowledge", title: "The knowledge graph", pitch: "Import chat history or notes so the agent and Lucid can draw on what you already know. It is private and encrypted.", surfaces: ["Knowledge graph"], view: "knowledge" },
  { id: "preview", title: "The Preview panel", pitch: "See an HTML page beside the chat. The agent can inspect it and take a screenshot of it, so it can check its own work.", surfaces: ["Preview panel"], view: "preview" },
  { id: "orbit-goal", title: "A Fleet Orbit goal", pitch: "Give the fleet one standing goal with tasks and success criteria. Agents pick up the tasks and you tick off the criteria.", surfaces: [], view: "orbit" },
  { id: "skills", title: "Skills", pitch: "Reusable instructions the agent loads for a kind of task, so you do not repeat yourself.", surfaces: ["Skills"], view: "skills" },
  { id: "local-models", title: "Local models", pitch: "Connect a self-hosted model such as Ollama, llama.cpp or vLLM. LUCID sizes tool output to its context window.", surfaces: [], view: "local-models" },
  { id: "voice", title: "Voice input", pitch: "Talk instead of typing: Ctrl or Cmd+D toggles the microphone, and Ctrl or Cmd+G starts a hands-free conversation.", surfaces: [], view: "voice" },
  { id: "holiday-theme", title: "Holiday themes", pitch: "LUCID can follow the calendar and dress for the season by itself.", surfaces: [], setting: { key: "season.follow", value: "on" } },
  { id: "auto-archive", title: "Auto-archive old sessions", pitch: "Sessions you have not touched for a while move to an Archived group, so the list stays short. Nothing is deleted.", surfaces: [], setting: { key: "sessions.autoArchive", value: "on" } },
];

export const FEATURES_SEEN_KEY = "lucid.features.seen.v1";
const IDS = new Set(ASK_FEATURES.map((f) => f.id));

/** PURE: the ledger of feature ids the user has found, from storage. Unknown ids are dropped. */
export function parseSeen(text: string | null): string[] {
  let raw: unknown = null;
  try { raw = text ? JSON.parse(text) : null; } catch { raw = null; }
  const out: string[] = [];
  for (const v of Array.isArray(raw) ? raw : []) if (typeof v === "string" && IDS.has(v) && !out.includes(v)) out.push(v);
  return out;
}

/** PURE: the features proven found by these open panels. */
export function featuresFromSurfaces(kinds: readonly string[]): string[] {
  return ASK_FEATURES.filter((f) => f.surfaces.some((s) => kinds.includes(s))).map((f) => f.id);
}

/** PURE: the ledger with `ids` added, and whether anything changed. */
export function addSeen(seen: readonly string[], ids: readonly string[]): { seen: string[]; changed: boolean } {
  const next = [...seen];
  for (const id of ids) if (IDS.has(id) && !next.includes(id)) next.push(id);
  return { seen: next, changed: next.length !== seen.length };
}

export interface FeatureSignals {
  /** The ledger. */
  seen: readonly string[];
  lanes: number;
  orbitGoal: boolean;
  knowledge: boolean;
  /** The calendar is followed, or a special theme is on. */
  seasonOn: boolean;
  autoArchive: boolean;
  localModels: boolean;
}

/** PURE: the features this user has not used, in catalog order. */
export function unusedFeatures(sig: FeatureSignals): AskFeature[] {
  const used = new Set(sig.seen);
  if (sig.lanes > 0) used.add("fleet");
  if (sig.orbitGoal) { used.add("orbit-goal"); used.add("fleet"); }
  if (sig.knowledge) used.add("knowledge");
  if (sig.seasonOn) used.add("holiday-theme");
  if (sig.autoArchive) used.add("auto-archive");
  if (sig.localModels) used.add("local-models");
  return ASK_FEATURES.filter((f) => !used.has(f.id));
}

/** PURE: what a feature suggestion asks when its chip is pressed. */
export function featureQuestion(f: AskFeature): string {
  return `Tell me about ${f.title}: what it would do for what I am working on. If it makes sense, propose opening it or setting it up.`;
}

/** Added to the brief. */
export const ASK_FEATURES_BRIEF = [
  "LUCID has features this user may never have found. You are shown the ones they have not used yet.",
  "When nothing in the snapshot points to a useful next step, when the user asks what else LUCID can do, or when they seem unsure what to ask, bring up ONE of those features: say in one or two sentences what it would do for them given what they are working on, then offer to open it or set it up as a proposal.",
  "Mention a feature only from that list, and never more than one in a reply unless the user asked for a list.",
].join("\n");

/** PURE: the unused features as text for Lucid, from ids the renderer posted. Only catalog ids count, and
 *  every word shown comes from the catalog, never from the post. */
export function unusedFeaturesContext(ids: unknown): { text: string; features: number } {
  const want = Array.isArray(ids) ? ids.filter((v): v is string => typeof v === "string") : [];
  const list = ASK_FEATURES.filter((f) => want.includes(f.id));
  if (list.length === 0) return { text: "", features: 0 };
  const rows = list.map((f) => {
    const how = f.view ? `open_view "${f.view}"` : f.setting ? `set_setting ${f.setting.key} = ${f.setting.value}` : "explain it";
    return `- ${f.title}: ${f.pitch} (to offer it: ${how})`;
  });
  return { text: `Features this user has not used yet:\n${rows.join("\n")}`, features: list.length };
}
