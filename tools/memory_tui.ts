// tools/memory_tui.ts
//
// In-terminal MEMORY & CONTEXT dashboard — the rendering layer over
// memory_data.ts (which does all the READ-ONLY data collection). The web
// dashboard (web/server.ts) renders the SAME data in a browser.
//
//   bun run memory:tui            # auto-detect the current omp session
//   bun run memory:tui <file.jsonl>   # a specific session transcript

import { homedir } from "node:os";
import { C, banner, table, gauge, sparkline, fmtNum, fmtUSD } from "./_tui.ts";
import {
  ageStr,
  compactionPolicy,
  ctxWindow,
  findSession,
  harnessMemory,
  parseSession,
  rateLimits,
} from "./memory_data.ts";

async function main(): Promise<void> {
  console.log(banner("MEMORY & CONTEXT", "context window · kv-cache · compaction · semantic memory"));
  console.log();

  // 1) omp context window for the live session
  const sessionPath = findSession(process.argv[2]);
  if (!sessionPath) {
    console.log(`${C.yellow}  No omp session transcript found yet.${C.reset}`);
    console.log(`${C.dim}  Launch omp (LucidAgentIDE.bat -> 1), send a message, then re-run this.${C.reset}\n`);
  } else {
    const s = parseSession(sessionPath);
    const win = ctxWindow(s.model);
    const prompts = s.turns.map((t) => t.prompt);
    const current = prompts.at(-1) ?? 0;
    const peak = prompts.length ? Math.max(...prompts) : 0;
    const sumRead = s.turns.reduce((a, t) => a + t.cacheRead, 0);
    const sumWrite = s.turns.reduce((a, t) => a + t.cacheWrite, 0);
    const sumInput = s.turns.reduce((a, t) => a + t.input, 0);
    const sumCost = s.turns.reduce((a, t) => a + t.cost, 0);
    const hit = sumRead + sumWrite + sumInput > 0 ? sumRead / (sumRead + sumWrite + sumInput) : 0;

    console.log(`${C.cyan}${C.bold}▸ Context window${C.reset}  ${C.dim}model ${s.model} · ${s.turns.length} turns${C.reset}`);
    console.log(`    current   ${gauge(current / win)}  ${fmtNum(current)} / ${fmtNum(win)}`);
    console.log(`    peak      ${gauge(peak / win)}  ${fmtNum(peak)} / ${fmtNum(win)}`);
    console.log(`    growth    ${sparkline(prompts)}  ${C.dim}(prompt tokens per turn)${C.reset}`);
    console.log();
    console.log(`${C.cyan}${C.bold}▸ Prompt-cache savings${C.reset}  ${C.dim}(more reuse = lower token cost)${C.reset}`);
    console.log(`    cached input ${gauge(hit)}  ${fmtNum(sumRead)} cached vs ${fmtNum(sumWrite)} cache-build, ${fmtNum(sumInput)} full-price`);
    console.log(`    ${C.dim}session cost so far: ${fmtUSD(sumCost)}${C.reset}`);
    console.log(`    ${C.dim}source: ${sessionPath.replace(homedir(), "~")}${C.reset}`);
    console.log();
  }

  // 2) compaction policy (how omp keeps context bounded)
  const cp = compactionPolicy();
  if (cp) {
    console.log(
      table(
        "Compaction policy (omp keeps context bounded)",
        ["setting", "value"],
        Object.entries(cp).map(([setting, value]) => ({ setting, value })),
        C.blue,
      ),
    );
  } else {
    console.log(`${C.blue}${C.bold}▸ Compaction policy${C.reset}\n${C.dim}  (run inside omp, or with omp on PATH, to read config)${C.reset}`);
  }
  console.log();

  // 3) rate-limit budget
  const rl = rateLimits();
  if (rl && rl.length) {
    console.log(`${C.magenta}${C.bold}▸ Provider budget (rate-limit windows)${C.reset}`);
    for (const b of rl) console.log(`    ${b.label.padEnd(22)} ${gauge(b.used)}  ${C.dim}${b.status}, resets ${ageStr(b.resetsAt)}${C.reset}`);
    console.log();
  }

  // 4) Lucid harness memory layers + promotion gate
  const hm = await harnessMemory();
  if (hm) {
    console.log(table("Lucid memory layers", ["layer", "rows", "detail"], hm.layers, C.green));
    console.log();
    console.log(
      table(
        "Semantic promotion gate (keystone #2)",
        ["outcome", "n"],
        [
          { outcome: "promoted → semantic", n: String(hm.gate.promoted) },
          { outcome: "blocked (suspicious source)", n: String(hm.gate.blocked) },
        ],
        C.green,
      ),
    );
    if (hm.facts.length) {
      console.log();
      console.log(table("Semantic facts (most recent)", ["entity", "statement", "trust_label"], hm.facts, C.cyan));
    }
  } else {
    console.log(`${C.green}${C.bold}▸ Lucid memory layers${C.reset}`);
    console.log(`${C.dim}  No harness memory yet — agent_obs.duckdb appears once the gate runs (or a demo).`);
    console.log(`  Try:  bun run demo-P4.3   (poisoned memory is blocked from promotion)${C.reset}`);
  }

  console.log(`\n${C.dim}  refresh: re-run \`bun run memory:tui\`  ·  security view: \`bun run dashboard:tui\`  ·  web: \`bun run dashboard:web\`${C.reset}`);
}

await main();
process.exit(0);
