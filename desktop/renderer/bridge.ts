// desktop/renderer/bridge.ts
//
// The single seam between the UI and the outside world. In Electron, the preload
// injects `window.lucid` (real omp ACP over IPC + native data). In a browser
// (dev/preview), we fall back to the HTTP `/api/*` endpoints and a simulated
// chat stream — so the exact same renderer is screenshot-verifiable without
// Electron.

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

export interface LucidBridge {
  isElectron: boolean;
  security(): Promise<SecuritySnapshot | null>;
  memory(): Promise<MemorySnapshot | null>;
  /** Stream an assistant turn. onEvent gets {type:'token'|'tool'|'block'|'done', ...}. */
  sendPrompt(text: string, onEvent: (e: ChatEvent) => void): Promise<void>;
  setModel?(model: string): Promise<void>;
}

export type ChatEvent =
  | { type: "token"; text: string }
  | { type: "tool"; name: string; detail: string }
  | { type: "block"; tool: string; reason: string; severity: string; findings: string }
  | { type: "done" };

declare global {
  interface Window { lucid?: LucidBridge }
}

const native = typeof window !== "undefined" ? window.lucid : undefined;

async function getJSON(path: string): Promise<any> {
  const r = await fetch(path, { cache: "no-store" });
  const j = await r.json();
  return j?.data ?? null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A scripted, on-theme assistant turn for browser/preview mode — it deliberately
 *  demonstrates the security gate blocking a poisoned command. */
async function simulatePrompt(text: string, onEvent: (e: ChatEvent) => void): Promise<void> {
  const reply =
    "I'll read `repos/project-alpha/untrusted-demo.md` and check the cleanup command it contains before running anything.";
  for (const word of reply.split(" ")) {
    onEvent({ type: "token", text: word + " " });
    await sleep(28);
  }
  await sleep(260);
  onEvent({ type: "tool", name: "read", detail: "repos/project-alpha/untrusted-demo.md" });
  await sleep(420);
  onEvent({
    type: "block",
    tool: "bash",
    reason: "zero-width characters hidden inside a shell command",
    severity: "high",
    findings: "zero-width, mixed-script-homoglyph",
  });
  await sleep(160);
  const tail = "That command hid a zero-width payload, so the gate quarantined it. I won't run it — want me to show the sanitized version instead?";
  for (const word of tail.split(" ")) {
    onEvent({ type: "token", text: word + " " });
    await sleep(26);
  }
  onEvent({ type: "done" });
}

export const bridge: LucidBridge = native ?? {
  isElectron: false,
  security: () => getJSON("/api/security"),
  memory: () => getJSON("/api/memory"),
  sendPrompt: simulatePrompt,
};
