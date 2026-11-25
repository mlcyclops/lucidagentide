// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/settings_nav.ts
//
// P-SETUX.1 (ADR-0615): the Settings window's navigation data. Pure (no DOM, no bridge), so the category
// map, the deep-link resolver and the search are unit-tested. app.ts builds the shell FROM this list: one
// `<section class="set-cat" data-cat>` per category holding its cards in the order below, and every card it
// renders is keyed by a `sec` from here (a Record over SettingsSecId), so a card can never exist outside a
// category and silently vanish from the window.

export type SettingsLayout = "window" | "panel";
/** localStorage: which surface Settings opens as (`window` by default). */
export const SETTINGS_LAYOUT_KEY = "lucid.settings.layout";
/** localStorage: the last category the user looked at (a deep link always wins over it). */
export const SETTINGS_CAT_KEY = "lucid.settings.category";

export interface SettingsCategory { id: string; label: string; icon: string; blurb: string }

export const SETTINGS_CATEGORIES = [
  { id: "overview", label: "Overview", icon: "gauge", blurb: "What's connected" },
  { id: "workspace", label: "Workspace & profile", icon: "folder", blurb: "Folder, name, personalization" },
  { id: "models", label: "Models & providers", icon: "spark", blurb: "Providers, gateway, local models" },
  { id: "connectors", label: "Connectors", icon: "plugins", blurb: "MCP servers and remote agents" },
  { id: "knowledge", label: "Knowledge", icon: "graph", blurb: "Semantic search" },
  { id: "security", label: "Security & secrets", icon: "shield", blurb: "Vault, .env import, whitelist" },
  { id: "voice", label: "Voice", icon: "volume", blurb: "Read aloud and dictation" },
  { id: "appearance", label: "Appearance", icon: "eye", blurb: "Theme, background, layout" },
  { id: "developer", label: "Developer", icon: "logs", blurb: "Logs and diagnostics" },
] as const satisfies readonly SettingsCategory[];
export type SettingsCatId = (typeof SETTINGS_CATEGORIES)[number]["id"];

export interface SettingsSectionDef {
  sec: string;
  cat: SettingsCatId;
  title: string;
  sub: string;
  keywords: readonly string[];
  /** A helper strip with no header of its own (the AskSage quota bar): rendered, never listed or searched. */
  unlisted?: boolean;
}

export const SETTINGS_SECTIONS = [
  { sec: "overview", cat: "overview", title: "What's connected", sub: "status at a glance", keywords: ["status", "connected", "overview", "health", "summary"] },
  { sec: "workspace", cat: "workspace", title: "Workspace", sub: "folder, clone, git", keywords: ["folder", "project", "repo", "repository", "clone", "git", "token", "pat", "recent", "browse", "directory"] },
  { sec: "profile", cat: "workspace", title: "Profile", sub: "name and work email", keywords: ["name", "username", "email", "attribution", "identity", "role", "account"] },
  { sec: "personal", cat: "workspace", title: "Personalization", sub: "private, encrypted, opt-in", keywords: ["memory", "knowledge graph", "kg", "passphrase", "import", "history", "chatgpt", "claude", "gemini", "cui", "unlock", "windows hello", "touch id"] },
  { sec: "providers", cat: "models", title: "Providers", sub: "U.S. frontier, key or OAuth", keywords: ["api key", "oauth", "sign in", "login", "anthropic", "claude", "openai", "chatgpt", "gemini", "google", "grok", "xai", "copilot", "azure", "bedrock", "vertex", "model", "account"] },
  { sec: "asksage", cat: "models", title: "AskSage gov gateway", sub: "accredited proxy", keywords: ["asksage", "gov", "government", "cui", "lockdown", "gateway", "datasets", "persona", "rag", "civ"] },
  { sec: "asksageQuota", cat: "models", title: "AskSage monthly tokens", sub: "", keywords: [], unlisted: true },
  { sec: "localProviders", cat: "models", title: "Local Providers", sub: "self-hosted, Ollama, vLLM, VPN", keywords: ["local", "self-hosted", "ollama", "vllm", "lm studio", "llama", "offline", "air-gap", "endpoint", "tool output window"] },
  { sec: "others", cat: "models", title: "More providers", sub: "third-party, non-U.S., custom", keywords: ["third-party", "openrouter", "mistral", "deepseek", "custom", "open models"] },
  { sec: "sovereignty", cat: "models", title: "Restricted-origin models", sub: "data sovereignty", keywords: ["china", "sovereignty", "restricted", "qwen", "deepseek", "acknowledge"] },
  { sec: "subagents", cat: "models", title: "Subagents", sub: "per-call model", keywords: ["subagent", "task", "delegate", "per call", "model"] },
  { sec: "judgment", cat: "models", title: "Judgment", sub: "Jev and your models", keywords: ["judge", "judgment", "jev", "typesafe", "verdict", "ban list"] },
  { sec: "compression", cat: "models", title: "Token compression", sub: "headroom, on-device", keywords: ["headroom", "compression", "tokens", "context", "savings"] },
  { sec: "mcpQuick", cat: "connectors", title: "Quick connect", sub: "official MCP servers", keywords: ["mcp", "connect", "catalog", "github", "slack", "notion", "linear", "cloud", "saas", "social", "official", "oauth"] },
  { sec: "mcp", cat: "connectors", title: "MCP connectors", sub: "model context protocol", keywords: ["mcp", "server", "connector", "tools", "sse", "http", "bearer", "token"] },
  { sec: "agents", cat: "connectors", title: "Remote agents", sub: "hermes, openclaw, ACP firewall", keywords: ["remote", "agent", "hermes", "openclaw", "acp", "firewall"] },
  { sec: "embeddings", cat: "knowledge", title: "Semantic search", sub: "knowledge RAG, your own embeddings", keywords: ["embeddings", "semantic", "rag", "vector", "ollama", "nomic", "reindex", "knowledge"] },
  { sec: "vault", cat: "security", title: "Credential vault", sub: "names only, encrypted backup", keywords: ["vault", "credentials", "secrets", "keys", "rotate", "backup", "dpapi", "keychain"] },
  { sec: "vaultDest", cat: "security", title: "Vault destinations (Enterprise)", sub: "push and pull secrets", keywords: ["vault", "destination", "enterprise", "hashicorp", "azure key vault", "aws secrets", "push", "pull"] },
  { sec: "vaultEnv", cat: "security", title: "Import from .env", sub: "workspace secrets, names only", keywords: [".env", "env", "dotenv", "import", "secrets"] },
  { sec: "whitelist", cat: "security", title: "Network Whitelist", sub: "domains, IPs, trust-scoped", keywords: ["network", "whitelist", "allowlist", "domain", "ip", "cidr", "egress", "firewall"] },
  { sec: "voice", cat: "voice", title: "Voice", sub: "TTS, STT, ElevenLabs", keywords: ["voice", "speech", "tts", "stt", "dictation", "read aloud", "elevenlabs", "whisper", "microphone", "mic"] },
  { sec: "theme", cat: "appearance", title: "Theme", sub: "light and dark", keywords: ["theme", "dark", "light", "color", "season", "holiday"] },
  { sec: "appearance", cat: "appearance", title: "Chat background", sub: "personalize", keywords: ["background", "image", "wallpaper", "ambient", "flashlight"] },
  { sec: "chatScroll", cat: "appearance", title: "Chat scrolling", sub: "follow, agent switching", keywords: ["scroll", "follow", "spoke", "switch"] },
  { sec: "workingStatus", cat: "appearance", title: "Working status", sub: "one line, details, estimate", keywords: ["status", "progress", "estimate", "eta", "footer"] },
  { sec: "miniLucid", cat: "appearance", title: "Mini Lucid", sub: "the prompt-bar mascot", keywords: ["mascot", "mini", "lucid", "suggestions", "sight"] },
  { sec: "floatingAgents", cat: "appearance", title: "Floating Agents", sub: "buddies over the composers", keywords: ["buddy", "floating", "agents", "ideas", "suggestions"] }, // P-BUDDY.1 (ADR-0667)
  { sec: "trivia", cat: "appearance", title: "Trivia Wire", sub: "status-bar game", keywords: ["trivia", "game", "ticker", "points"] },
  { sec: "settingsLayout", cat: "appearance", title: "Settings window", sub: "window or side panel", keywords: ["settings", "layout", "flyout", "panel", "window", "dialog"] },
  { sec: "developer", cat: "developer", title: "Developer", sub: "logs, diagnostics", keywords: ["developer", "logs", "diagnostics", "debug", "telemetry"] },
] as const satisfies readonly SettingsSectionDef[];
export type SettingsSecId = (typeof SETTINGS_SECTIONS)[number]["sec"];

const SEC_BY_ID = new Map<string, SettingsSectionDef>(SETTINGS_SECTIONS.map((s) => [s.sec, s] as const));
const CAT_IDS = new Set<string>(SETTINGS_CATEGORIES.map((c) => c.id));

export const isSettingsCat = (v: unknown): v is SettingsCatId => typeof v === "string" && CAT_IDS.has(v);
export const settingsCategory = (cat: string): SettingsCategory | undefined => SETTINGS_CATEGORIES.find((c) => c.id === cat);
/** The section ids of one category, in display order. */
export const sectionsOf = (cat: SettingsCatId): SettingsSecId[] => SETTINGS_SECTIONS.filter((s) => s.cat === cat).map((s) => s.sec);

/** Where a deep link lands: a card id resolves to its category and that card; a category id to the category
 *  alone; anything unknown to the Overview (never a blank pane). */
export function resolveSettingsTarget(target: string): { cat: SettingsCatId; sec: SettingsSecId | null } {
  const s = SEC_BY_ID.get(target);
  if (s) return { cat: s.cat, sec: s.sec as SettingsSecId };
  if (isSettingsCat(target)) return { cat: target, sec: null };
  return { cat: "overview", sec: null };
}

export const parseSettingsLayout = (raw: unknown): SettingsLayout => (raw === "panel" ? "panel" : "window");
export const parseSettingsCat = (raw: unknown): SettingsCatId | null => (isSettingsCat(raw) ? raw : null);

/** Sections whose title, sub, keywords or category label contain EVERY word of the query (case-insensitive).
 *  Title matches rank first, then keyword/sub matches; display order breaks ties. Empty query: no results. */
export function searchSettings(query: string): SettingsSectionDef[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits: { s: SettingsSectionDef; rank: number; i: number }[] = [];
  SETTINGS_SECTIONS.forEach((s: SettingsSectionDef, i) => {
    if (s.unlisted) return;
    const title = s.title.toLowerCase();
    const hay = [title, s.sub.toLowerCase(), ...s.keywords, settingsCategory(s.cat)?.label.toLowerCase() ?? ""].join(" \u0000 ");
    if (!words.every((w) => hay.includes(w))) return;
    const rank = title.startsWith(words[0]!) ? 0 : words.every((w) => title.includes(w)) ? 1 : 2;
    hits.push({ s, rank, i });
  });
  return hits.sort((a, b) => a.rank - b.rank || a.i - b.i).map((h) => h.s);
}
