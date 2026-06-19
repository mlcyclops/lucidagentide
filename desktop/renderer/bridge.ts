// desktop/renderer/bridge.ts
//
// The single seam between the UI and the outside world. In Electron, the preload
// injects `window.lucid` (real omp ACP over IPC + native data + zoom). In a
// browser (dev/preview) we fall back to HTTP `/api/*`, a simulated chat, and a
// mock session config — so the exact same renderer is screenshot-verifiable.

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

/** A live omp session config option (model / mode / thinking) from ACP `session/new`. */
export interface ConfigOption {
  id: string; name: string; category: string; type: string;
  currentValue: string; options: { value: string; name: string }[];
}
export interface OmpCommand { name: string; description?: string; hint?: string }
export interface UsageUpdate { used: number; size: number; cost: number }

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
  sendPrompt(text: string, onEvent: (e: ChatEvent) => void): Promise<void>;
  /** live session config (model / mode / thinking) + omp commands. */
  config(): Promise<ConfigOption[]>;
  setConfig(configId: string, value: string): Promise<ConfigOption[]>;
  commands(): Promise<OmpCommand[]>;
  newSession(): Promise<void>;
  /** UI text zoom (Electron: webFrame; browser: CSS zoom). */
  setZoom(factor: number): void;
}

declare global { interface Window { lucid?: LucidBridge } }
const native = typeof window !== "undefined" ? window.lucid : undefined;

async function getJSON(path: string): Promise<any> {
  const r = await fetch(path, { cache: "no-store" });
  return (await r.json())?.data ?? null;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── browser-mode mock session config (real omp model list, trimmed) ───────────
const MOCK_CONFIG: ConfigOption[] = [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: "anthropic/claude-opus-4-8", options: [
    { value: "anthropic/claude-opus-4-8", name: "Claude Opus 4.8" },
    { value: "anthropic/claude-opus-4-7", name: "Claude Opus 4.7" },
    { value: "anthropic/claude-opus-4-6", name: "Claude Opus 4.6" },
    { value: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { value: "anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    { value: "anthropic/claude-haiku-4-5", name: "Claude Haiku 4.5" },
    { value: "anthropic/claude-fable-5", name: "Claude Fable 5" },
    { value: "anthropic/claude-mythos-5", name: "Claude Mythos 5" },
    { value: "anthropic/claude-3-7-sonnet-20250219", name: "Claude Sonnet 3.7" },
    { value: "anthropic/claude-3-5-haiku-latest", name: "Claude Haiku 3.5" },
  ] },
  { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "default", options: [
    { value: "default", name: "Default" }, { value: "plan", name: "Plan" },
  ] },
  { id: "thinking", name: "Thinking", category: "thought_level", type: "select", currentValue: "high", options: [
    { value: "off", name: "Off" }, { value: "auto", name: "Auto" }, { value: "minimal", name: "Minimal" },
    { value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "high", name: "High" }, { value: "xhigh", name: "X-High" },
  ] },
];
const MOCK_COMMANDS: OmpCommand[] = [
  { name: "context", description: "Show context usage" }, { name: "usage", description: "Show token usage" },
  { name: "tools", description: "Show available tools" }, { name: "compact", description: "Compact the conversation", hint: "[focus]" },
  { name: "memory", description: "Manage memory", hint: "<subcommand>" }, { name: "export", description: "Export session to HTML", hint: "[path]" },
  { name: "mcp", description: "Manage MCP servers", hint: "<subcommand>" }, { name: "todo", description: "Manage todos", hint: "<subcommand>" },
];
let mockCfg = structuredClone(MOCK_CONFIG);

async function simulatePrompt(text: string, onEvent: (e: ChatEvent) => void): Promise<void> {
  const reply = "I'll read `repos/project-alpha/untrusted-demo.md` and check the cleanup command it contains before running anything.";
  for (const w of reply.split(" ")) { onEvent({ type: "token", text: w + " " }); await sleep(26); }
  await sleep(220);
  onEvent({ type: "tool", name: "read", detail: "repos/project-alpha/untrusted-demo.md" });
  await sleep(380);
  onEvent({ type: "block", tool: "bash", reason: "zero-width characters hidden inside a shell command", severity: "high", findings: "zero-width, mixed-script-homoglyph" });
  await sleep(140);
  for (const w of "That command hid a zero-width payload, so the gate quarantined it. I won't run it — want the sanitized version instead?".split(" ")) { onEvent({ type: "token", text: w + " " }); await sleep(24); }
  onEvent({ type: "usage", used: 46000, size: 1_000_000, cost: 0.28 });
  onEvent({ type: "done" });
}

export const bridge: LucidBridge = native ?? {
  isElectron: false,
  security: () => getJSON("/api/security"),
  memory: () => getJSON("/api/memory"),
  sendPrompt: simulatePrompt,
  config: async () => structuredClone(mockCfg),
  setConfig: async (id, value) => { mockCfg = mockCfg.map((c) => (c.id === id ? { ...c, currentValue: value } : c)); return structuredClone(mockCfg); },
  commands: async () => MOCK_COMMANDS,
  newSession: async () => {},
  setZoom: (f) => { (document.body.style as any).zoom = String(f); },
};
