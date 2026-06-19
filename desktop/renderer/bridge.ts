// desktop/renderer/bridge.ts
//
// The single seam between the UI and the outside world. Dashboards, chat, and
// session config all go over the dev server's HTTP API — which is backed by a
// REAL `omp acp` session (desktop/acp_backend.ts), so prompts produce genuine
// model replies in both the browser build and Electron. The only thing that is
// native-only is window controls + crisp text zoom, exposed by the Electron
// preload as `window.lucid`; in a plain browser those fall back to CSS zoom.

export interface SecuritySnapshot {
  findings: any[]; unicode: any[]; approvals: any[]; quarantine: any[];
  promotion: any[]; exports: any[]; runs: any[];
}
export interface MemorySnapshot {
  session: null | {
    path: string; model: string; turns: number; window: number;
    current: number; peak: number; prompts: number[];
    cache: { read: number; write: number; fresh: number; hit: number }; cost: number; started: string;
  };
  compaction: Record<string, string> | null;
  budgets: { label: string; used: number; status: string; resetsAt: number | null }[] | null;
  harness: null | {
    counts: { working: number; archive: number; entities: number; facts: number };
    layers: { layer: string; rows: string; detail: string }[];
    facts: { entity: string; statement: string; trust_label: string }[];
    gate: { promoted: number; blocked: number };
  };
}
export interface ConfigOption {
  id: string; name: string; category: string; type: string;
  currentValue: string; options: { value: string; name: string }[];
}
export interface OmpCommand { name: string; description?: string; hint?: string }
export interface SessionInfo { id: string; title: string; model: string; updatedAt: number; turns: number }
export interface ProviderAuth {
  id: string; name: string; env: string; oauthId: string; canOauth: boolean;
  oauthActive: boolean; oauthIdentity?: string; keySet: boolean; keyLast4?: string;
}
export interface AuthStatus { majors: ProviderAuth[]; others: ProviderAuth[] }
export interface HeadroomStatus {
  installed: boolean; version: string | null; running: boolean; enabled: boolean;
  port: number; url: string; installHint: string;
}
export interface WorkspaceInfo {
  current: string; name: string; isGit: boolean;
  recent: { path: string; name: string; isGit: boolean }[];
  cloned?: boolean; error?: string;
}

export type ChatEvent =
  | { type: "token"; text: string }
  | { type: "tool"; name: string; detail: string }
  | { type: "block"; tool: string; reason: string; severity: string; findings: string }
  | { type: "usage"; used: number; size: number; cost: number }
  | { type: "done" };

export interface LucidBridge {
  isElectron: boolean;
  security(): Promise<SecuritySnapshot | null>;
  memory(): Promise<MemorySnapshot | null>;
  budget(): Promise<{ label: string; used: number; status: string; resetsAt: number | null }[] | null>;
  sendPrompt(text: string, onEvent: (e: ChatEvent) => void): Promise<void>;
  config(): Promise<ConfigOption[]>;
  setConfig(configId: string, value: string): Promise<ConfigOption[]>;
  commands(): Promise<OmpCommand[]>;
  skills(): Promise<{ name: string; description: string; source: string }[] | null>;
  sessions(): Promise<SessionInfo[] | null>;
  sessionMessages(id: string): Promise<{ role: string; text: string }[] | null>;
  resumeSession(id: string): Promise<void>;
  newSession(): Promise<void>;
  setZoom(factor: number): void;
  // settings + provider auth
  getSettings(): Promise<{ username: string } | null>;
  saveUsername(username: string): Promise<{ username: string } | null>;
  auth(): Promise<AuthStatus | null>;
  saveKey(env: string, key: string): Promise<AuthStatus | null>;
  oauthLogin(oauthId: string): Promise<{ started: boolean; url: string; output: string } | null>;
  oauthLogout(oauthId: string): Promise<AuthStatus | null>;
  // AskSage gov gateway (ADR-0007)
  asksage(): Promise<{ configured: boolean; base: string; only: boolean; limit: number; datasets: string[]; queryModel: string; persona: string } | null>;
  saveAsksage(opts: { baseUrl?: string; only?: boolean; limit?: number; datasets?: string[]; queryModel?: string; persona?: string }): Promise<{ configured: boolean; base: string; only: boolean; limit: number; datasets: string[]; queryModel: string; persona: string } | null>;
  asksageTokens(): Promise<{ used: number; limit: number } | null>;
  asksageDatasets(): Promise<string[] | null>;
  asksagePersonas(): Promise<{ id: string; description: string }[] | null>;
  applyPersona(id: string | null): Promise<{ applied?: boolean; cleared?: boolean; scan?: { ok: boolean; reason?: string; findings: number } } | null>;
  // headroom token-compression proxy (opt-in, on-device)
  headroom(): Promise<HeadroomStatus | null>;
  setHeadroom(enabled: boolean): Promise<HeadroomStatus | null>;
  // workspace (folder the agent works in; local or cloned remote)
  workspace(): Promise<WorkspaceInfo | null>;
  setWorkspace(path: string): Promise<WorkspaceInfo | null>;
  cloneWorkspace(url: string): Promise<WorkspaceInfo | null>;
  pickFolder(): Promise<string | null>; // native dialog in Electron; null in browser
}

/** Native shell injected by the Electron preload (window controls + crisp zoom). */
interface NativeShell {
  isElectron?: boolean;
  setZoom?(factor: number): void;
  pickFolder?(): Promise<string | null>;
  win?: { minimize(): void; toggleMaximize(): void; close(): void };
}
declare global { interface Window { lucid?: NativeShell } }
const shell: NativeShell | undefined = typeof window !== "undefined" ? window.lucid : undefined;

async function getData(path: string): Promise<any> {
  try { return (await (await fetch(path, { cache: "no-store" })).json())?.data ?? null; } catch { return null; }
}
async function post(path: string, body: unknown): Promise<any> {
  try { return (await (await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json())?.data ?? null; } catch { return null; }
}

// Mock config only as a last resort if the backend can't be reached (no omp).
const FALLBACK_CONFIG: ConfigOption[] = [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: "anthropic/claude-opus-4-8", options: [
    { value: "anthropic/claude-opus-4-8", name: "Claude Opus 4.8" }, { value: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6" }, { value: "anthropic/claude-haiku-4-5", name: "Claude Haiku 4.5" },
  ] },
  { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "default", options: [{ value: "default", name: "Default" }, { value: "plan", name: "Plan" }] },
  { id: "thinking", name: "Thinking", category: "thought_level", type: "select", currentValue: "high", options: [
    { value: "off", name: "Off" }, { value: "auto", name: "Auto" }, { value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "high", name: "High" }, { value: "xhigh", name: "X-High" },
  ] },
];

async function streamChat(text: string, onEvent: (e: ChatEvent) => void): Promise<void> {
  let res: Response;
  try {
    res = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
  } catch {
    onEvent({ type: "token", text: "[chat backend unreachable — is the GUI server running?]" });
    onEvent({ type: "done" });
    return;
  }
  if (res.status === 404) { onEvent({ type: "token", text: "[chat backend is out of date — close the GUI server window and relaunch (launcher → G)]" }); onEvent({ type: "done" }); return; }
  if (!res.ok || !res.body) { onEvent({ type: "token", text: `[chat backend error ${res.status}]` }); onEvent({ type: "done" }); return; }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const flush = (line: string) => { const s = line.trim(); if (s) { try { onEvent(JSON.parse(s)); } catch { /* skip */ } } };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) { flush(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
  }
  flush(buf);
}

export const bridge: LucidBridge = {
  isElectron: !!shell?.isElectron,
  security: () => getData("/api/security"),
  memory: () => getData("/api/memory"),
  budget: () => getData("/api/budget"),
  sendPrompt: streamChat,
  config: async () => (await getData("/api/config")) ?? FALLBACK_CONFIG,
  setConfig: async (id, value) => (await post("/api/setConfig", { configId: id, value })) ?? FALLBACK_CONFIG,
  commands: async () => (await getData("/api/commands")) ?? [],
  skills: () => getData("/api/skills"),
  sessions: async () => {
    try {
      const r = await fetch("/api/sessions", { cache: "no-store" });
      if (r.status === 404) return null; // server predates the sessions route → out of date
      return (await r.json())?.data ?? [];
    } catch { return null; }
  },
  sessionMessages: (id) => getData(`/api/session?id=${encodeURIComponent(id)}`),
  resumeSession: async (id) => { await post("/api/session/load", { id }); },
  newSession: async () => { await post("/api/newSession", {}); },
  getSettings: () => getData("/api/settings"),
  saveUsername: (username) => post("/api/settings", { username }),
  auth: () => getData("/api/auth"),
  saveKey: (env, key) => post("/api/auth/key", { env, key }),
  oauthLogin: (oauthId) => post("/api/auth/oauth", { oauthId }),
  oauthLogout: (oauthId) => post("/api/auth/logout", { oauthId }),
  asksage: () => getData("/api/asksage"),
  saveAsksage: (opts) => post("/api/asksage", opts),
  asksageTokens: () => getData("/api/asksage/tokens"),
  asksageDatasets: () => getData("/api/asksage/datasets"),
  asksagePersonas: () => getData("/api/asksage/personas"),
  applyPersona: (id) => post("/api/asksage/persona", id ? { id } : { clear: true }),
  headroom: () => getData("/api/headroom"),
  setHeadroom: (enabled) => post("/api/headroom", { enabled }),
  workspace: () => getData("/api/workspace"),
  setWorkspace: (path) => post("/api/workspace", { path }),
  cloneWorkspace: (url) => post("/api/workspace/clone", { url }),
  pickFolder: () => (shell?.pickFolder ? shell.pickFolder() : Promise.resolve(null)),
  setZoom: (f) => {
    if (shell?.setZoom) { shell.setZoom(f); return; } // Electron: crisp native zoom
    // Browser: zoom #app and counter-scale its height so it still fills the viewport
    // exactly (so the layout reflows and the chat keeps its own scroll).
    const app = document.getElementById("app");
    if (app) { (app.style as any).zoom = String(f); app.style.height = `calc(100vh / ${f})`; }
  },
};
