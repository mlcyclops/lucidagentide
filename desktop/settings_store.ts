// desktop/settings_store.ts
//
// Local GUI settings: username + provider API keys. Stored under
// ~/.omp/lucid-gui.json with user-only file perms, and injected into the
// environment so a spawned `omp acp` inherits the keys (env vars are omp's
// primary API-key mechanism). Keys never leave the machine; the HTTP API only
// ever returns masked status (set? + last-4), never the raw key.
//
// (OAuth is handled separately via omp's own credential vault / auth-broker -
//  that's the more secure path and omp owns the storage there.)

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const FILE = join(homedir(), ".omp", "lucid-gui.json");

export interface GuiSettings {
  username?: string;
  keys?: Record<string, string>;
  workspace?: string;
  recentWorkspaces?: string[];
  // AskSage gov gateway (ADR-0007): non-secret base URL + lockdown flag. The key
  // itself lives in `keys.ASKSAGE_API_KEY` like any other provider key.
  asksageBaseUrl?: string;
  asksageOnly?: boolean;
  // Monthly inference-token allowance. AskSage's API reports tokens USED but not
  // the ceiling (admins grant more in the AskSage console - no API to read it), so
  // the limit is a local, user-adjustable value. Everyone starts at 200k.
  asksageLimit?: number;
  // Datasets selected for RAG grounding via AskSage's /query route (ADR-0007).
  asksageDatasets?: string[];
  // Underlying model the "AskSage RAG" (/query) route uses. Default gpt-5.2.
  asksageQueryModel?: string;
  // Native AskSage persona id applied server-side on the /query (RAG) route. Unlike
  // the composer persona (scanned + delimited into the prompt), this is just an id
  // passed to AskSage - no untrusted text enters our prompt, so no scan is needed.
  asksagePersona?: string;
  // headroom token-compression proxy (opt-in, on-device). See ADR-0008.
  headroomEnabled?: boolean;
  // Personalization knowledge graph (ADR-0010, P9.x): opt-in, encrypted-at-rest.
  // OFF by default - no user-fact distillation, recall, or store until enabled.
  personalizationEnabled?: boolean;
  // Active compartment (ADR-0012): work | personal | cui | combined (view). Default personal.
  personalScope?: "work" | "personal" | "cui" | "combined";
}

export const ASKSAGE_DEFAULT_LIMIT = 200_000;

/** Default on-disk location of the encrypted personalization store (P9.1) — work + personal. */
export function personalStorePath(): string {
  return join(homedir(), ".omp", "lucid-personal.kg.enc");
}
/** The SEPARATE encrypted CUI store (P9.5a, ADR-0014) — its own file, DEK, and passphrase, so
 *  one key never decrypts both CUI and non-CUI. */
export function personalCuiStorePath(): string {
  return join(homedir(), ".omp", "lucid-cui.kg.enc");
}
/** Metadata-only audit log for personalization exports (P9.4). NDJSON; counts + hashes
 *  only, never fact content (the full, private trail lives encrypted inside the store). */
export function personalAuditPath(): string {
  return join(homedir(), ".omp", "lucid-personal-audit.ndjson");
}
/** Default export destinations (P9.4). The CUI archive is deliberately separate. */
export function personalVaultDir(): string { return join(homedir(), ".omp", "lucid-vault"); }
export function personalCuiArchiveDir(): string { return join(homedir(), ".omp", "lucid-cui-archive"); }
export function setPersonalization(enabled: boolean): GuiSettings {
  const s = load(); s.personalizationEnabled = enabled; save(s); return s;
}
export function setPersonalScope(scope: GuiSettings["personalScope"]): GuiSettings {
  const s = load(); s.personalScope = scope; save(s); return s;
}

export function load(): GuiSettings {
  try { return existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {}; } catch { return {}; }
}
export function save(s: GuiSettings): void {
  writeFileSync(FILE, JSON.stringify(s, null, 2), "utf8");
  try { chmodSync(FILE, 0o600); } catch { /* best-effort on Windows */ }
}

/** Push stored keys + AskSage base URL into process.env so child `omp acp`
 *  (and the AskSage extension) inherit them. */
export function applyEnv(): void {
  const s = load();
  for (const [k, v] of Object.entries(s.keys ?? {})) if (v) process.env[k] = v;
  if (s.asksageBaseUrl) process.env.ASKSAGE_BASE_URL = s.asksageBaseUrl;
  if (s.asksageDatasets?.length) process.env.ASKSAGE_DATASETS = s.asksageDatasets.join(",");
  if (s.asksageQueryModel) process.env.ASKSAGE_QUERY_MODEL = s.asksageQueryModel;
  if (s.asksagePersona) process.env.ASKSAGE_PERSONA = s.asksagePersona;
}
export function setAsksage(opts: { baseUrl?: string; only?: boolean; limit?: number; datasets?: string[]; queryModel?: string; persona?: string }): GuiSettings {
  const s = load();
  if (opts.baseUrl !== undefined) {
    s.asksageBaseUrl = opts.baseUrl || undefined;
    if (opts.baseUrl) process.env.ASKSAGE_BASE_URL = opts.baseUrl;
    else delete process.env.ASKSAGE_BASE_URL;
  }
  if (opts.only !== undefined) s.asksageOnly = opts.only;
  if (opts.limit !== undefined) s.asksageLimit = Math.max(0, Math.round(opts.limit)) || undefined;
  if (opts.datasets !== undefined) {
    s.asksageDatasets = opts.datasets.length ? opts.datasets : undefined;
    if (opts.datasets.length) process.env.ASKSAGE_DATASETS = opts.datasets.join(",");
    else delete process.env.ASKSAGE_DATASETS;
  }
  if (opts.queryModel !== undefined) {
    s.asksageQueryModel = opts.queryModel || undefined;
    if (opts.queryModel) process.env.ASKSAGE_QUERY_MODEL = opts.queryModel;
    else delete process.env.ASKSAGE_QUERY_MODEL;
  }
  if (opts.persona !== undefined) {
    s.asksagePersona = opts.persona || undefined;
    if (opts.persona) process.env.ASKSAGE_PERSONA = opts.persona;
    else delete process.env.ASKSAGE_PERSONA;
  }
  save(s); return s;
}
export function setUsername(name: string): GuiSettings {
  const s = load(); s.username = name; save(s); return s;
}
export function setKey(env: string, key: string): GuiSettings {
  const s = load(); s.keys = s.keys ?? {};
  if (key) { s.keys[env] = key; process.env[env] = key; }
  else { delete s.keys[env]; delete process.env[env]; }
  save(s); return s;
}
