// harness/scripts/demo_paskage1.ts
//
// P-ASKSAGE.1 (ADR-0055): AskSage tool-loop diagnostics + tolerant response extraction. AskSage serves
// Claude/Gemini NON-streamed through our streamSimple adapter; when the agentic loop "gives up too soon"
// the usual cause is invisible — a follow-up response whose content we drop (the proxy wrapped it
// differently) becomes an EMPTY turn, and omp concludes the model finished. This demo proves, with a
// mocked AskSage endpoint, that: (1) a non-standard (wrapped) response is still parsed instead of
// dropped; (2) a genuinely empty response is flagged as the `empty-response` anomaly in the diagnostics;
// (3) diagnostics are silent unless LUCID_ASKSAGE_DEBUG is set.
//
// Run with: bun run harness/scripts/demo_paskage1.ts

import { makeAsksageStream } from "../omp/asksage_stream.ts";

const cfg = { base: "https://asksage.demo", key: "k" };
const anthropic = makeAsksageStream("anthropic", () => cfg);
const model = { id: "claude-x", api: "asksage-anthropic", provider: "asksage-anthropic", maxTokens: 1000 };

const origFetch = globalThis.fetch;
const fail = (m: string): never => { globalThis.fetch = origFetch; console.error(`FAIL: ${m}`); process.exit(1); };
const mockJson = (json: any) => { globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => json })) as any; };

async function collect(stream: any): Promise<any[]> { const ev: any[] = []; for await (const e of stream) ev.push(e); return ev; }
function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  (process.stderr as any).write = (s: any) => { lines.push(String(s)); return true; };
  return { lines, restore: () => { (process.stderr as any).write = orig; } };
}
const diagsFrom = (lines: string[]) => lines.filter((l) => l.includes("[ASKSAGE_DIAG]")).map((l) => JSON.parse(l.slice(l.indexOf("{"))));

try {
  console.log("== [1/3] a NON-STANDARD (wrapped) response is recovered, not dropped ==");
  // A proxy that returns the Anthropic body nested under `response` — the strict parser would see no
  // top-level `content` and emit an empty turn (→ omp gives up). Tolerant extraction recovers it.
  mockJson({ response: { content: [{ type: "text", text: "Recovered the wrapped answer." }] }, usage: {} });
  const done = (await collect(anthropic(model, { messages: [{ role: "user", content: "continue the task" }] }))).find((e) => e.type === "done");
  if (!done || !done.message.content.length) fail("wrapped response should have been recovered into a non-empty turn");
  if (done.message.content[0].text !== "Recovered the wrapped answer.") fail(`unexpected recovered text: ${JSON.stringify(done.message.content)}`);
  console.log(`   recovered: "${done.message.content[0].text}"  (would otherwise be an empty 'done' → premature stop)`);

  console.log("\n== [2/3] a genuinely EMPTY response is flagged as the `empty-response` anomaly ==");
  process.env.LUCID_ASKSAGE_DEBUG = "1";
  let cap = captureStderr();
  mockJson({ id: "msg_x", usage: {} }); // no content, no tool calls
  await collect(anthropic(model, { messages: [{ role: "user", content: "x" }] }));
  cap.restore();
  const anomalies = diagsFrom(cap.lines);
  if (anomalies[0]?.anomaly !== "empty-response") fail(`expected empty-response anomaly; got ${JSON.stringify(anomalies[0])}`);
  if (typeof anomalies[0].raw !== "string") fail("anomaly diag should capture a raw snippet for inspection");
  console.log(`   diag flagged: anomaly=${anomalies[0].anomaly} · via=${anomalies[0].via} · raw snippet captured (${String(anomalies[0].raw).length} chars)`);

  console.log("\n== [3/3] diagnostics are SILENT unless LUCID_ASKSAGE_DEBUG is set ==");
  delete process.env.LUCID_ASKSAGE_DEBUG;
  cap = captureStderr();
  mockJson({ content: [{ type: "text", text: "ok" }], usage: {} });
  await collect(anthropic(model, { messages: [{ role: "user", content: "x" }] }));
  cap.restore();
  if (diagsFrom(cap.lines).length !== 0) fail("no diagnostics should be emitted without the env flag");
  console.log("   no [ASKSAGE_DIAG] lines without the flag — zero overhead in normal use.");

  globalThis.fetch = origFetch;
  console.log("\nPASS: AskSage tool-loop diagnostics + tolerant extraction — wrapped replies recovered, empty turns flagged, off by default.");
} catch (e) {
  fail(String((e as Error)?.stack ?? e));
}
process.exit(0);
