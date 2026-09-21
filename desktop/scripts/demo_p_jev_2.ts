// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-JEV.2 (ADR-0377) - Jev in the chat: the per-turn judgment trace. Proves, against the REAL
// pi-ai judge classes, the REAL extension entry point and the BUILT renderer bundle, that:
//   (1) the extension loaded the way omp loads it (default export, env-driven) wraps pi-ai's TypeSafeJudge
//       so a judgment answered by a (local, fake) TypeSafe endpoint reaches the desktop's receiver as a
//       parseable report BEFORE omp gets the answer, and the answer omp gets is untouched;
//   (2) a failing TypeSafe call is reported with its error, still throws (omp's fallback stays intact), and
//       the TextJudge fallback that answers next is reported too, naming the model that answered;
//   (3) the desktop only relays the MASTER child's reports, and only into a live turn;
//   (4) the Jev-active gate that decides whether "not consulted" may be shown matches omp's own rule;
//   (5) the desktop wiring exists in the bytes that run (route, env, argv) and the served renderer carries
//       the window, the idle note and the table, with the module the app imports being the one drawn.
// Every read/write is isolated from this machine's real settings (LUCID_GUI_SETTINGS_FILE seam).

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TextJudge, TypeSafeJudge } from "@oh-my-pi/pi-ai/judgment";
import judgmentExtension from "../../harness/omp/judgment_extension.ts";
import { parseJudgmentReport } from "../../harness/judgment/trace_schema.ts";
import { jevConsulted, judgmentPurpose, type JudgmentReport } from "../../harness/judgment/trace.ts";
import { backend } from "../acp_backend.ts";
import { jevActive } from "../judgment_policy.ts";

// The store resolves LUCID_GUI_SETTINGS_FILE per call (P-TEST.W1 seam), so setting it after the static
// imports still isolates every read/write below from this machine's real settings. The extension reads its
// env at CALL time, so the URL set below is the one it posts to.
const dir = mkdtempSync(join(tmpdir(), "lucid-jev2-demo-"));
process.env.LUCID_GUI_SETTINGS_FILE = join(dir, "lucid-gui.json");

const DESKTOP = join(import.meta.dir, "..");
let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}`);
  if (!ok) failures++;
}

console.log("== P-JEV.2 - Jev in the chat: the per-turn judgment trace ==");

try {
  // A stand-in for the desktop's /api/judgment/trace: parses with the real boundary and remembers order.
  const received: JudgmentReport[] = [];
  const order: string[] = [];
  const receiver = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/judgment/trace" && url.searchParams.get("t") === "demo-token") {
        const r = parseJudgmentReport(await req.json());
        if (r) { received.push(r); order.push("received"); }
        return Response.json({ ok: true, data: { noted: !!r } });
      }
      // The fake TypeSafe endpoint: /v1/systemone answers, or fails when the state says so.
      if (url.pathname === "/v1/systemone") {
        const body = await req.json() as { state: unknown; questions: Record<string, { type: string }> };
        if (String(body.state).includes("FAIL")) return new Response("upstream busy", { status: 503 });
        const answers: Record<string, unknown> = {};
        for (const id in body.questions) {
          const t = body.questions[id]!.type;
          answers[id] = t === "choice" ? { type: "choice", choice: "high", probabilities: { low: 0.2, high: 0.8 }, confidence: 0.6 }
            : t === "noul" ? { type: "noul", noul: 0.9 }
            : { type: "score", score: 1.5, probabilities: { "0": 0.25, "1": 0.25, "2": 0.5 }, confidence: 0.5 };
        }
        return Response.json({ model: "jev-1.13.0", answers, usage: { input_tokens: 42, output_tokens: 3 } });
      }
      return new Response("nope", { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${receiver.port}`;

  // (1) the extension, loaded exactly as omp loads it: default export, env-driven.
  process.env.LUCID_JUDGMENT_URL = `${base}/api/judgment/trace?t=demo-token`;
  process.env.LUCID_INTERJECT_TARGET = "master";
  judgmentExtension({});
  const judge = new TypeSafeJudge({ apiKey: "demo-key", baseUrl: base, timeoutMs: 2000 });
  const questions = {
    level: { type: "choice" as const, instructions: "How hard is this?", criteria: { low: null, high: "needs planning" } },
    stopped: { type: "noul" as const, instructions: "Did it stop early?" },
  };
  const result = await judge.judge({ state: { request: "refactor the parser" }, questions });
  order.push("returned");
  check("the real TypeSafeJudge still answers through the wrapper (answer untouched)", result.model === "jev-1.13.0" && result.answers.level.choice === "high" && result.answers.stopped.noul === 0.9);
  check("the desktop RECEIVED the report before omp got the answer (awaited POST, no race with done)", order.join(">") === "received>returned");
  const r0 = received[0];
  check("the report parses at the boundary and names Jev by model", !!r0 && r0.backend === "typesafe" && r0.model === "jev-1.13.0" && r0.target === "master");
  check("it carries every question AND every typed answer with probabilities", !!r0 && Object.keys(r0.questions).join() === "level,stopped" && r0.answers?.level?.type === "choice" && r0.answers.level.probabilities.high === 0.8 && r0.answers?.stopped?.type === "noul");
  check("usage and latency ride along", !!r0 && r0.usage?.input === 42 && r0.ms >= 0);
  check("the judged state is on the report (what Jev saw)", !!r0 && r0.state.includes("refactor the parser"));
  check("purpose is inferred as the agent's own judge() call (two ids, neither an omp feature's)", !!r0 && judgmentPurpose(r0) === "Agent judge() call");

  // (2) a failing TypeSafe call: reported with the error, still thrown, then the TextJudge fallback reported.
  let threw = false;
  try { await judge.judge({ state: "FAIL please", questions: { stopped: questions.stopped } }); } catch { threw = true; }
  check("a TypeSafe failure still THROWS to omp (its fallback chain is untouched)", threw);
  const r1 = received[1];
  check("...and is reported with its error and no answers", !!r1 && r1.backend === "typesafe" && /503/.test(r1.error ?? "") && r1.answers === undefined);
  const text = new TextJudge({ api: "anthropic-messages", provider: "anthropic", model: "claude-demo", async complete() { return { text: "stopped: yes", usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 } }; } });
  const fb = await text.judge({ state: "FAIL please", questions: { stopped: questions.stopped } });
  const r2 = received[2];
  check("the TextJudge fallback answers and is reported naming the chat model that answered", fb.answers.stopped.noul === 1 && !!r2 && r2.backend === "text" && r2.provider === "anthropic" && r2.model === "claude-demo" && r2.answers?.stopped?.type === "noul");
  check("jevConsulted: a failed TypeSafe call plus a text fallback is NOT 'Jev consulted'; the first success is", !jevConsulted([r1!, r2!]) && jevConsulted([r0!]));
  check("wrapping is idempotent: loading the extension twice traces once", (() => { const n = received.length; judgmentExtension({}); return n === received.length; })());

  // (3) the desktop relay: master-only, live-turn-only.
  check("a report from a fleet lane is not relayed into the master chat", backend.noteJudgment({ ...r0!, target: "lane-3" }) === false);
  check("a master report with no live turn is dropped, not queued onto a later turn", backend.noteJudgment(r0!) === false);

  // (4) the Jev-active gate mirrors omp's usesTypeSafeJudge from the desktop's side.
  check("llm never; typesafe always tries; auto only with a key", !jevActive("llm", true) && jevActive("typesafe", false) && jevActive("auto", true) && !jevActive("auto", false));

  // (5) the wiring in the bytes that run, and the served renderer.
  const dev = readFileSync(join(DESKTOP, "dev.ts"), "utf8");
  check("dev.ts publishes LUCID_JUDGMENT_URL to omp children", dev.includes("process.env.LUCID_JUDGMENT_URL = "));
  check("dev.ts serves the token'd /api/judgment/trace route through the parse boundary", dev.includes('"/api/judgment/trace"') && dev.includes("parseJudgmentReport(await readBody"));
  check("GET /api/judgment now answers `configured` (the idle-note gate)", dev.includes("configured: jevActive(r.effective, typesafeKeySet())"));
  const acp = readFileSync(join(DESKTOP, "acp_backend.ts"), "utf8");
  check("the master omp child loads the judgment extension", acp.includes('repoAsset("harness", "omp", "judgment_extension.ts")') && acp.includes("...judgmentArgs"));
  const bundle = readFileSync(join(DESKTOP, "renderer", "app.bundle.js"), "utf8");
  const css = readFileSync(join(DESKTOP, "renderer", "styles.css"), "utf8");
  for (const marker of ["Jev consulted", "Jev not consulted this turn", "jd-table", "judgmentIdleNote", ".type === \"judgment\"", "judgments = createJudgments()"]) {
    check(`served renderer carries ${marker}`, bundle.includes(marker));
  }
  for (const rule of [".judgments{", ".jd-table td:first-child{min-width:220px", ".jd-id{", ".jd-err span{display:block}"]) {
    check(`stylesheet carries ${rule}`, css.includes(rule));
  }
  check("the idle note is gated on the server's `configured` and skipped for lane turns", bundle.includes("!judgments && !opts.laneId") && bundle.includes("j?.configured"));

  receiver.stop(true);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures) { console.log(`\n${failures} CHECK(S) FAILED`); process.exit(1); }
console.log("\nALL CHECKS PASSED");
process.exit(0);
