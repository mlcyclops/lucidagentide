// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/spoke_prefs.ts - P-SCROLL.1 (ADR-0405): the two fleet preferences a spoke switch or a
// spawn reads, shared by the orbit, the grid and the main composer.
//
// 1. The spawn model. Both "new spoke" forms used to preselect the MASTER's model, so a user who runs
//    spokes on a different model re-picked it on every spawn. The default is now the model the last
//    spoke was created or switched to, falling back to the master's while nothing is remembered or the
//    remembered model is no longer offered (provider signed out, model retired).
// 2. Where a spoke switch lands: the newest message (default) or where the reader left off.
//
// Renderer-local view state in localStorage (the `lucid.*` convention). Storage failures (private mode,
// quota) degrade to the defaults and never throw.

export interface ModelOption { value: string; label?: string }

const SPOKE_MODEL_KEY = "lucid.spoke-model";
const SWITCH_SCROLL_KEY = "lucid.spoke-switch-scroll";

function read(key: string): string {
  try { return localStorage.getItem(key) ?? ""; } catch { return ""; }
}
function write(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable: the default stands */ }
}

/** Provider prefix of a model id (`xai-oauth/grok-4.7` -> `xai-oauth`). Bare ids have none. */
export function providerRoute(value: string): string {
  const v = value.trim();
  const i = v.indexOf("/");
  return i === -1 ? "" : v.slice(0, i);
}

/** Model id with the provider prefix removed, compared case-insensitively. */
export function bareModelId(value: string): string {
  const v = value.trim();
  const i = v.lastIndexOf("/");
  return (i === -1 ? v : v.slice(i + 1)).toLowerCase();
}

/** The model a new spoke form preselects. Pure: the remembered spoke model when it is still offered,
 *  else the master's model (the forms list it even when the catalog has not loaded yet), else the first
 *  offered model, else "" (the engine then uses its own default).
 *
 *  A remembered id that is the same bare model on a different provider is an auth twin
 *  (`xai/grok-4.7` vs `xai-oauth/grok-4.7`), not a model choice. Main's route wins: that is the
 *  credential that is signed in. Following the twin is how a lane landed on a dead API key. */
export function spawnModelDefault(options: readonly ModelOption[], remembered: string, master: string): string {
  const r = remembered.trim();
  const m = master.trim();
  const bare = bareModelId(m);
  if (m && r && r !== m && bare !== "" && bareModelId(r) === bare) return m;
  if (r && options.some((o) => o.value === r)) return r;
  if (m) return m;
  return options[0]?.value ?? "";
}

/** What a colliding route IS, in the words a person picks a login with. Raw prefixes (`xai-oauth`)
 *  read as a second model. Unknown routes fall back to the prefix with hyphens as spaces. */
const LOGIN_LABEL: Record<string, string> = {
  "xai-oauth": "X sign-in",
  xai: "API key",
  anthropic: "Anthropic",
  "openai-codex": "Codex",
  openai: "OpenAI API key",
  "github-copilot": "Copilot",
  "google-gemini-cli": "Gemini sign-in",
};

/** Fleet `<select>` labels. A display name that appears once stays as the catalog wrote it. A name
 *  shared by two logins leads with the login (`X sign-in: Grok 4.7`, `API key: Grok 4.7`), because a
 *  native option has no separate tag and a parenthetical suffix looks like a second model. */
export function fleetModelOptions(options: readonly ModelOption[]): { value: string; label: string }[] {
  const nameOf = (o: ModelOption): string => (o.label ?? o.value).trim() || o.value;
  const counts = new Map<string, number>();
  for (const o of options) counts.set(nameOf(o), (counts.get(nameOf(o)) ?? 0) + 1);
  return options.map((o) => {
    const name = nameOf(o);
    const route = providerRoute(o.value);
    const login = LOGIN_LABEL[route] ?? route.replace(/-/g, " ");
    const label = (counts.get(name) ?? 0) > 1 && route ? `${login}: ${name}` : name;
    return { value: o.value, label };
  });
}

/** The last model a spoke was created with or switched to ("" when none yet). */
export function rememberedSpokeModel(): string { return read(SPOKE_MODEL_KEY).trim(); }

/** Record a model the user just ran a spoke on. Blank values never clobber a real one. */
export function rememberSpokeModel(model: string): void {
  const m = (model ?? "").trim();
  if (m) write(SPOKE_MODEL_KEY, m);
}

/** Where switching between Main and a spoke (or spoke to spoke) lands the chat. */
export type SpokeSwitchScroll = "latest" | "resume";

export function spokeSwitchScroll(): SpokeSwitchScroll {
  return read(SWITCH_SCROLL_KEY) === "resume" ? "resume" : "latest";
}

export function setSpokeSwitchScroll(v: SpokeSwitchScroll): void {
  write(SWITCH_SCROLL_KEY, v === "resume" ? "resume" : "latest");
}
