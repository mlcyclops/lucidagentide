// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-LOC.5: a scripted offline model runs real omp tools through the real quarantine hook.
// The engine's ACP mapper supplies actual inputs, statuses and applied diffs to the GUI ledger.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { mapAgentSessionEventToAcpSessionUpdates } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-event-mapper";
import { makeQuarantineExtension } from "../../harness/hooks/quarantine_hook.ts";
import { ScannerClient } from "../../harness/security/scanner_client.ts";
import { AiLocCaptureTracker } from "../ailoc_capture.ts";
import { readAiLocSamples } from "../ailoc_read.ts";
import { toolCode } from "../tool_code.ts";

registerMockApi();
const cwd = mkdtempSync(join(tmpdir(), "lucid-loc5-"));
const logPath = join(cwd, "lucid-ailoc.jsonl");
const tracker = new AiLocCaptureTracker({ logPath });
const scanner = new ScannerClient();
const auth = await AuthStorage.create(join(cwd, "auth.db"));
const context = { model: "echo/loc5", identity: "smoke@example.invalid", identitySource: "email", repo: cwd };
const cart = "export const total = 1;\n";
const added = "export function formatCents(cents: number) {\n  return (cents / 100).toFixed(2);\n}\n\n";
writeFileSync(join(cwd, "cart.ts"), cart);
writeFileSync(join(cwd, "repeat.txt"), "red\nred\nred\n");
writeFileSync(join(cwd, "delete.txt"), "keep\nremove\n");
const calls: { name: string; arguments: Record<string, unknown> }[] = [
  { name: "read", arguments: { path: "cart.ts" } },
  { name: "edit", arguments: { path: "cart.ts", old_string: cart, new_string: cart + added } },
  { name: "read", arguments: { path: "repeat.txt" } },
  { name: "edit", arguments: { path: "repeat.txt", old_string: "red", new_string: "blue", replace_all: true } },
  { name: "read", arguments: { path: "delete.txt" } },
  { name: "edit", arguments: { path: "delete.txt", old_string: "remove\n", new_string: "" } },
  { name: "edit", arguments: { path: "cart.ts", old_string: "this text does not exist", new_string: "never applied" } },
  { name: "write", arguments: { path: "large.txt", content: "line\n".repeat(20_000) } },
  { name: "write", arguments: { path: "blocked.txt", content: `release ships${String.fromCodePoint(0x200b)} today` } },
];
const model = createMockModel({
  id: "loc5", provider: "echo",
  responses: [...calls.map(call => ({ content: [{ type: "toolCall" as const, ...call }] })), { content: ["Finished."] }],
});
auth.keys.setRuntime("echo", "offline-smoke-key");
const registry = new ModelRegistry(auth, join(cwd, "models.yml"), {
  fetch: (() => Promise.reject(new Error("Offline demo"))) as typeof fetch,
});
let blocked = false;
let largePreviewContent: string | undefined;
let largePreviewPath: string | undefined;
let cartPreview: { oldText?: string; newText?: string } | undefined;
const terminalUpdates: unknown[] = [];
let session: AgentSession | undefined;
try {
  scanner.start();
  ({ session } = await createAgentSession({
    cwd, agentDir: join(cwd, "agent"), authStorage: auth, modelRegistry: registry, model,
    settings: Settings.isolated({ "edit.mode": "replace" }), systemPrompt: "Execute the scripted local tool calls.",
    toolNames: ["read", "edit", "write"], preloadedCustomToolPaths: [],
    disableExtensionDiscovery: true, enableMCP: false, enableLsp: false, enableIrc: false,
    skipPythonPreflight: true, cacheWarming: false, skills: [], rules: [], contextFiles: [],
    extensions: [makeQuarantineExtension({ scanner, onBlock: () => { blocked = true; } })],
  }));
  const live = session;
  live.subscribe(event => {
    for (const notification of mapAgentSessionEventToAcpSessionUpdates(event, live.sessionId, { cwd })) {
      const update = notification.update;
      if (update.sessionUpdate === "tool_call") {
        const preview = toolCode(update, path => join(cwd, path));
        if (preview?.path === join(cwd, "large.txt")) {
          largePreviewContent = preview.content;
          largePreviewPath = preview.path;
        }
        if (preview?.path === join(cwd, "cart.ts") && preview.oldText === cart) cartPreview = preview;
      }
      if (update.sessionUpdate === "tool_call_update" && update.status === "completed") terminalUpdates.push(update);
      const samples = tracker.observe(live.sessionId, update, context);
      for (const sample of samples) console.log(`${sample.tool} ${basename(sample.filePath ?? "")} +${sample.added}/-${sample.removed}`);
    }
  });
  await live.prompt("Run the local attribution smoke.");
  const samples = readAiLocSamples(logPath);
  assert.deepEqual(samples.map(s => [basename(s.filePath ?? ""), s.added, s.removed]), [
    ["cart.ts", 4, 0], ["repeat.txt", 3, 3], ["delete.txt", 0, 1], ["large.txt", 20_000, 0],
  ]);
  assert.equal(readFileSync(join(cwd, "cart.ts"), "utf8"), cart + added);
  assert.equal(readFileSync(join(cwd, "repeat.txt"), "utf8"), "blue\nblue\nblue\n");
  assert.equal(readFileSync(join(cwd, "delete.txt"), "utf8"), "keep\n");
  assert.equal(readFileSync(join(cwd, "large.txt"), "utf8"), "line\n".repeat(20_000));
  assert.equal(blocked, true);
  assert.equal(existsSync(join(cwd, "blocked.txt")), false);
  assert.equal(cartPreview?.newText, cart + added, "canonical replacement supplies its authored preview");
  assert.equal(largePreviewPath, join(cwd, "large.txt"));
  assert.equal(largePreviewContent, "line\n".repeat(20_000).slice(0, 64 * 1024), "display bytes are capped independently of ledger counts");
  tracker.clear();
  for (const update of terminalUpdates) tracker.observe(live.sessionId, update, context);
  const completed = terminalUpdates[0];
  assert.ok(completed && typeof completed === "object");
  tracker.observe(live.sessionId, { ...completed, toolCallId: "never-started-orphan" }, context);
  assert.equal(readAiLocSamples(logPath).length, 4, "duplicates and a fresh orphaned completion add nothing");
  console.log("P-LOC.5 passed: actual disk changes match counts; blocked and failed calls add no sample; duplicate completions add none.");
} finally {
  await session?.dispose();
  auth.close();
  scanner.stop();
  rmSync(cwd, { recursive: true, force: true });
}
