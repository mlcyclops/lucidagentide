// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_creator_whistle.ts - CREATOR-WHISTLE (ADR-0432): the runnable proof that LUCID
// measures word timing ON THIS MACHINE with the pinned Whistle model, against the REAL wasm and model.
//
//   (a) all three assets verify by size + sha256 with the engine's own verdict; one flipped byte in a
//       scratch copy of whistle.cact refuses the load, naming the file and both hashes
//   (b) the 16 kHz fixture transcribes with >= 90% token match; every word has start < end, starts monotonic
//   (c) a clip over 30 s is windowed into >= 2 calls, no word straddles a cut, offsets monotonic
//   (d) alignFromMeasured on the heard words with ONE substituted word: the rest measured, exactly one
//       derived item at or below DERIVED_CONFIDENCE_CEILING
//   (e) fetch / XMLHttpRequest / WebSocket were counting, throwing traps for load + every transcribe above
//       and recorded zero attempts; the wasm import table is exactly the 16 pinned names
//   (f) a hot CPU history refuses an align job with the measured percent and duration, written down as a
//       refused job
//   (g) the timeline validator rejects a measured item claiming confidence 1.2
//   (h) end to end: a scratch Creator engine (desktop/dev.ts) imports the fixture into its library and
//       POST /api/creator/align returns measured items, alignedBy whistle + the pinned model sha256, a
//       document the validator and the save gate accept, and that the editor paints with measured chips
//
// FAIL-CLOSED: no assets is exit 1 with the reason, never a skip. LUCID_WHISTLE_DIR, when set, is the ONLY
// directory considered: an operator who names a dir is asking about that dir, so a missing file there is a
// failure, not a fall-through to the bundled copy.
//
// Run with: bun run harness/scripts/demo_creator_whistle.ts   (make demo-CREATOR-WHISTLE)

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { WHISTLE_SAMPLE_RATE, WhistleEngine, windowPcm, type WhistleTranscript } from "../voice/whistle.ts";
import { FIXTURE_TEXT, FIXTURE_WAV, normalizedTokens, readFixturePcm16k, tokenMatch } from "../voice/whistle_test_assets.ts";
import {
  DERIVED_CONFIDENCE_CEILING, alignFromMeasured, docFromSource, durationOfWav, validateDoc, type TimelineItem,
} from "../creator/timeline.ts";
import { WHISTLE_ASSETS, WHISTLE_MODEL_SHA256, resolveWhistleDir, verifyWhistleAsset } from "../../desktop/whistle_assets.ts";
import { creatorAdmission, type CreatorSample, type GpuTelemetry } from "../../desktop/creator_monitor.ts";
import { createJob, foldJobs, jobsLedger, type JobAdmissionSnapshot, type JobIo } from "../../desktop/creator_jobs.ts";
import { decodeTimelineDoc } from "../../desktop/creator_editor.ts";
import { chipStripHtml, isEditorAlignData } from "../../desktop/renderer/creator_editor.ts";
import { listDiscoveries } from "../../desktop/engine_discovery.ts";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`   ${ok ? "ok" : "FAIL"} - ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures++;
};
/** A step everything after it stands on: stop with the reason instead of measuring the wrong thing. */
function stop(why: string): never {
  console.log(`\nCREATOR-WHISTLE demo FAILED: ${why}`);
  process.exit(1);
}

const REPO = join(import.meta.dir, "..", "..");
const sha256 = (b: Uint8Array): string => new Bun.CryptoHasher("sha256").update(b).digest("hex");
const ms = (samples: number): number => Math.round((samples * 1000) / WHISTLE_SAMPLE_RATE);

/** decision 7: the wasm's 16 imports, all file, clock and memory syscalls. ANY change is a re-pin. */
const PINNED_IMPORTS = [
  "___cxa_throw", "___syscall_fcntl64", "___syscall_ioctl", "___syscall_openat", "___syscall_rmdir", "___syscall_unlinkat",
  "__abort_js", "__munmap_js", "_clock_time_get", "_emscripten_resize_heap", "_environ_get", "_environ_sizes_get",
  "_fd_close", "_fd_read", "_fd_seek", "_fd_write",
];

/** The engine's own load gate (dev.ts startWhistle): read each pinned file, hash it, and take the
 *  `verifyWhistleAsset` verdict. The first refusal is returned verbatim and nothing reaches needle_load. */
function readVerified(dir: string): { ok: true; glue: string; wasm: Uint8Array; cact: Uint8Array; lines: string[] } | { ok: false; reason: string } {
  const bytes: Uint8Array[] = [];
  const lines: string[] = [];
  for (const spec of WHISTLE_ASSETS) {
    const data = new Uint8Array(readFileSync(join(dir, spec.name)));
    const got = sha256(data);
    const verdict = verifyWhistleAsset(spec, data, got);
    if (!verdict.ok) return { ok: false, reason: verdict.reason };
    lines.push(`${spec.name} ${data.byteLength} bytes sha256 ${got.slice(0, 12)}`);
    bytes.push(data);
  }
  return { ok: true, glue: join(dir, WHISTLE_ASSETS[0]!.name), wasm: bytes[1]!, cact: bytes[2]!, lines };
}

// ── locate the assets (fail-closed) ──────────────────────────────────────────
console.log("== CREATOR-WHISTLE (ADR-0432): in-process word timing with the pinned Whistle model ==\n");
const envDir = (process.env.LUCID_WHISTLE_DIR ?? "").trim();
let assetDir: string;
if (envDir) {
  const missing = WHISTLE_ASSETS.filter((s) => !existsSync(join(envDir, s.name))).map((s) => s.name);
  if (missing.length > 0) stop(`LUCID_WHISTLE_DIR=${envDir} is missing ${missing.join(", ")}; stage the pinned assets there (bun run whistle in desktop/) or unset it`);
  assetDir = envDir;
} else {
  const found = resolveWhistleDir({ env: {}, exists: existsSync, resourcesPath: join(REPO, "desktop"), stagedDir: join(homedir(), ".omp", "whistle") });
  if (!found) stop("no directory holds needle.js, needle.wasm and whistle.cact (checked desktop/whistle and ~/.omp/whistle); run `bun run whistle` in desktop/ or set LUCID_WHISTLE_DIR");
  assetDir = found.dir;
}
console.log(`assets: ${assetDir}\n`);

const scratch = mkdtempSync(join(tmpdir(), "lucid-whistle-demo-"));
try {
  // ── (a) ────────────────────────────────────────────────────────────────────
  console.log("(a) the three pinned assets verify by size + sha256; one flipped byte refuses the load");
  const good = readVerified(assetDir);
  if (!good.ok) stop(`the pinned assets do not verify: ${good.reason}`);
  check("needle.js, needle.wasm and whistle.cact all match their pins", good.lines.length === 3, good.lines.join("; "));
  const cactSpec = WHISTLE_ASSETS.find((s) => s.name === "whistle.cact")!;
  const flipped = new Uint8Array(good.cact);
  const flipAt = flipped.length >> 1;
  flipped[flipAt] = flipped[flipAt]! ^ 0xff;
  const tampered = join(scratch, "tampered");
  mkdirSync(tampered, { recursive: true });
  for (const spec of WHISTLE_ASSETS) {
    if (spec.name === "whistle.cact") writeFileSync(join(tampered, spec.name), flipped);
    else copyFileSync(join(assetDir, spec.name), join(tampered, spec.name));
  }
  const flippedHash = sha256(flipped);
  const refused = readVerified(tampered);
  check(`a scratch copy with byte ${flipAt} flipped is REFUSED before needle_load`, !refused.ok, refused.ok ? "it verified" : refused.reason);
  check("the refusal names the file and BOTH hashes (got and pinned)",
    !refused.ok && refused.reason.includes("whistle.cact") && refused.reason.includes(flippedHash.slice(0, 12)) && refused.reason.includes(cactSpec.sha256.slice(0, 12)),
    `got ${flippedHash.slice(0, 12)}, pinned ${cactSpec.sha256.slice(0, 12)}`);

  // ── load + transcribe under the egress traps (reported in (e)) ─────────────────
  const g = globalThis as unknown as Record<string, unknown>; // deliberate: swapping runtime globals for the trap
  const egress: string[] = [];
  const originals: Record<string, { had: boolean; value: unknown }> = {};
  for (const name of ["fetch", "XMLHttpRequest", "WebSocket"]) originals[name] = { had: name in g, value: g[name] };
  g.fetch = (...args: unknown[]) => { egress.push(`fetch ${String(args[0]).slice(0, 80)}`); throw new Error("egress blocked: fetch"); };
  g.XMLHttpRequest = class { constructor() { egress.push("XMLHttpRequest"); throw new Error("egress blocked: XMLHttpRequest"); } };
  g.WebSocket = class { constructor(url: unknown) { egress.push(`WebSocket ${String(url)}`); throw new Error("egress blocked: WebSocket"); } };
  let fixture: WhistleTranscript;
  let fixturePcm: Float32Array;
  let long: WhistleTranscript;
  let longPcm: Float32Array;
  let silence: WhistleTranscript;
  let loadMs: number;
  try {
    const t0 = performance.now();
    const engine = await WhistleEngine.load({ gluePath: good.glue, wasm: good.wasm, cact: good.cact });
    loadMs = Math.round(performance.now() - t0);
    silence = engine.transcribe(new Float32Array(WHISTLE_SAMPLE_RATE));
    fixturePcm = readFixturePcm16k();
    fixture = engine.transcribe(fixturePcm, { language: "en" });
    const gap = 20 * WHISTLE_SAMPLE_RATE;
    longPcm = new Float32Array(fixturePcm.length * 2 + gap);
    longPcm.set(fixturePcm, 0);
    longPcm.set(fixturePcm, fixturePcm.length + gap);
    long = engine.transcribe(longPcm, { language: "en" });
  } catch (e) {
    stop(`the real engine failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    for (const [name, o] of Object.entries(originals)) {
      if (o.had) g[name] = o.value;
      else delete g[name];
    }
  }

  // ── (b) ────────────────────────────────────────────────────────────────────
  console.log("\n(b) the 16 kHz fixture transcribes with word times");
  const clipMs = ms(fixturePcm.length);
  console.log(`   heard: ${fixture.text}`);
  const want = normalizedTokens(FIXTURE_TEXT);
  const match = tokenMatch(want, normalizedTokens(fixture.text));
  check("token match against the spoken sentence is at least 90%", match >= 0.9,
    `${(match * 100).toFixed(1)}% of ${want.length} tokens, ${clipMs} ms clip, load ${loadMs} ms, ttft ${Math.round(fixture.ttftMs)} ms, ${fixture.decodeTps.toFixed(1)} tok/s`);
  check("it decoded words with times, in one 30 s window", fixture.words.length > 0 && fixture.windows === 1, `${fixture.words.length} timed words, ${fixture.windows} window(s), language ${fixture.language}`);
  const zeroLen = fixture.words.filter((w) => !(w.startMs < w.endMs));
  check("EVERY word has start < end", zeroLen.length === 0,
    zeroLen.length ? zeroLen.map((w) => `${w.word} ${w.startMs}-${w.endMs}`).join(", ") : `first "${fixture.words[0]?.word}" ${fixture.words[0]?.startMs}-${fixture.words[0]?.endMs} ms`);
  const backwards = fixture.words.findIndex((w, i) => i > 0 && w.startMs < fixture.words[i - 1]!.startMs);
  check("starts never go backwards across the clip", backwards === -1,
    backwards === -1 ? `last "${fixture.words.at(-1)?.word}" starts ${fixture.words.at(-1)?.startMs} ms` : `word ${backwards} goes backwards`);
  check("one second of silence is empty text (the probe's witness)", silence.text === "" && silence.words.length === 0, `"${silence.text}"`);

  // ── (c) ────────────────────────────────────────────────────────────────────
  console.log("\n(c) a clip longer than 30 s is windowed; no word is split by a cut");
  const windows = windowPcm(longPcm);
  const cuts = windows.slice(1).map((w) => ms(w.start));
  check("fixture + 20 s silence + fixture becomes at least two model calls", windows.length >= 2 && long.windows === windows.length,
    `${ms(longPcm.length)} ms clip, ${long.windows} calls, cuts at ${cuts.join(", ")} ms`);
  check("every cut lands in the silent gap, never through speech",
    cuts.every((c) => c >= clipMs && c <= clipMs + 20000), `gap is ${clipMs}-${clipMs + 20000} ms`);
  const straddling = long.words.filter((w) => cuts.some((c) => w.startMs < c && w.endMs > c));
  check("no word straddles a cut", straddling.length === 0, straddling.map((w) => `${w.word} ${w.startMs}-${w.endMs}`).join(", "));
  const longBack = long.words.findIndex((w, i) => i > 0 && w.startMs < long.words[i - 1]!.startMs);
  const second = long.words.filter((w) => w.startMs >= cuts[0]!);
  check("offsets are applied: starts monotonic across windows, the second window lands after the cut",
    longBack === -1 && second.length > 0 && second[0]!.startMs >= clipMs + 20000 - 1000,
    `${long.words.length - second.length} words before the cut, ${second.length} after, first after at ${second[0]?.startMs} ms`);
  const doubled = tokenMatch([...want, ...want], normalizedTokens(long.text));
  check("both windows were heard", doubled >= 0.85, `${(doubled * 100).toFixed(1)}% of the doubled sentence`);

  // ── (d) ────────────────────────────────────────────────────────────────────
  console.log("\n(d) alignFromMeasured: one substituted word is the ONE derived item");
  const heardWords = fixture.words.map((w) => w.word);
  const sub = Math.floor(heardWords.length / 2);
  const userText = heardWords.map((w, i) => (i === sub ? "xylophone" : w)).join(" ");
  const aligned = alignFromMeasured(userText, fixture.words, clipMs, "Whistle");
  console.log(`   note: ${aligned.note}`);
  const derived = aligned.items.filter((it) => it.source === "derived");
  const measured = aligned.items.filter((it) => it.source === "measured");
  check(`"${heardWords[sub]}" replaced by "xylophone" is the only derived item`,
    derived.length === 1 && aligned.items[sub]?.source === "derived" && aligned.items[sub]?.text === "xylophone",
    `${derived.length} derived at index ${aligned.items.findIndex((it) => it.source === "derived")}`);
  check("every other word is measured, carrying the model's probability as its confidence",
    measured.length === aligned.items.length - 1 && aligned.matched === measured.length && aligned.interpolated === 1
    && measured.every((it) => it.confidence >= 0 && it.confidence <= 1),
    `${measured.length} measured of ${aligned.items.length}`);
  const d0 = derived[0];
  check(`the derived item is capped at or below ${DERIVED_CONFIDENCE_CEILING}`, !!d0 && d0.confidence <= DERIVED_CONFIDENCE_CEILING,
    d0 ? `confidence ${d0.confidence}, span ${d0.startMs}-${d0.endMs} ms between "${aligned.items[sub - 1]?.text}" and "${aligned.items[sub + 1]?.text}"` : "none");
  const alignedDoc = docFromSource({ sourceId: "fixture", fmt: { channels: 1, sampleRate: WHISTLE_SAMPLE_RATE, bitsPerSample: 16 }, durationMs: clipMs, items: aligned.items, alignedBy: { provider: "whistle", modelSha256: WHISTLE_MODEL_SHA256 } });
  check("the document it feeds validates", validateDoc(alignedDoc).length === 0, validateDoc(alignedDoc).join("; "));

  // ── (e) ────────────────────────────────────────────────────────────────────
  console.log("\n(e) zero egress: the traps counted nothing, and the import table is the pin");
  check("fetch / XMLHttpRequest / WebSocket traps recorded ZERO attempts across load + 3 transcribes", egress.length === 0,
    egress.length ? egress.join(", ") : "0 attempts");
  const compiled = await WebAssembly.compile(good.wasm);
  const imports = WebAssembly.Module.imports(compiled);
  check("the wasm declares exactly 16 imports, all from module \"a\"", imports.length === 16 && imports.every((i) => i.module === "a"),
    `${imports.length} imports from ${[...new Set(imports.map((i) => i.module))].join(",")}`);
  const glueText = readFileSync(good.glue, "utf8");
  const mapping = /wasmImports=\{([^}]*)\}/.exec(glueText);
  const names = (mapping?.[1] ?? "").split(",").map((pair) => pair.split(":")[1]?.trim() ?? "").filter((n) => n.length > 0);
  const sameSet = names.length === PINNED_IMPORTS.length && [...names].sort().join(",") === [...PINNED_IMPORTS].sort().join(",");
  check("the glue maps them to exactly the 16 pinned names", sameSet, names.join(" "));
  check("not one socket / connect / send / recv / fetch import", !names.some((n) => /socket|connect|send|recv|fetch/i.test(n)));
  check("the glue's ENV is empty", glueText.includes("var ENV={}"));

  // ── (f) ────────────────────────────────────────────────────────────────────
  console.log("\n(f) a hot CPU history refuses an align job with the measured reason");
  const noGpu: GpuTelemetry = { available: false, source: "none", devices: [], note: "" };
  const history = (cpuPct: number): CreatorSample[] =>
    Array.from({ length: 16 }, (_, i) => ({ at: 1_700_000_000_000 + i * 3000, cpuPct, memPct: 41, gpuPct: null, vramPct: null }));
  const label = "align: Quick fox";
  const hot = creatorAdmission(history(97), { label, gpu: false }, noGpu);
  check("97% CPU held for 45 s refuses the align job", !hot.ok, hot.reason);
  check("the reason carries the measured percent, the duration and the job",
    hot.reason.includes("97%") && hot.reason.includes("45s") && hot.reason.includes(label), `cpuHotMs ${hot.cpuHotMs}`);
  const cool = creatorAdmission(history(35), { label, gpu: false }, noGpu);
  check("the same 45 s at 35% CPU admits it (the refusal is the measurement, not a default)", cool.ok, `cpuPct ${cool.cpuPct}`);
  const ledger = new Map<string, string>();
  let clock = 1_700_000_100_000;
  const jobIo: JobIo = {
    ensureDir: () => {},
    readText: (p) => ledger.get(p) ?? "",
    appendLine: (p, line) => { ledger.set(p, (ledger.get(p) ?? "") + line + "\n"); },
    now: () => (clock += 1000),
    id: () => "job_align_1",
  };
  const snapshot: JobAdmissionSnapshot = { ok: hot.ok, cpuPct: hot.cpuPct, memPct: hot.memPct, gpuPct: hot.gpuPct, vramPct: hot.vramPct, gpuEvidenceMissing: hot.gpuEvidenceMissing, reason: hot.reason };
  const job = createJob(jobIo, "/creator", { kind: "align", label, provider: "whistle", admission: snapshot });
  check("it is written down as a REFUSED align job quoting the reason",
    job.state === "refused" && job.kind === "align" && job.error === hot.reason && job.admission?.cpuPct === 97, `${job.kind} ${job.state}`);

  // ── (g) ────────────────────────────────────────────────────────────────────
  console.log("\n(g) the validator rejects a measured item claiming confidence 1.2");
  const word = (confidence: number): TimelineItem => ({ id: "item-1", text: "quick", startMs: 0, endMs: 300, confidence, source: "measured", locked: false });
  const fmt16 = { channels: 1, sampleRate: WHISTLE_SAMPLE_RATE, bitsPerSample: 16 };
  const over = validateDoc(docFromSource({ sourceId: "s", fmt: fmt16, durationMs: 400, items: [word(1.2)] }));
  check("confidence 1.2 on a measured item is refused", over.some((p) => p.includes("out-of-range confidence")), over.join("; "));
  const fine = validateDoc(docFromSource({ sourceId: "s", fmt: fmt16, durationMs: 400, items: [word(0.93)] }));
  check("the same item at 0.93 validates", fine.length === 0, fine.join("; "));

  // ── (h) ────────────────────────────────────────────────────────────────────
  console.log("\n(h) end to end: POST /api/creator/align on a scratch Creator engine");
  await endToEnd(scratch, assetDir);
} finally {
  // Windows can hold a just-exited engine's files for a moment; a leftover temp dir is not a failed proof.
  try { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* temp dir, best effort */ }
}

/** The `{ id, title }` of every track in a `/api/creator/library` answer's `data`; anything else is none. */
function libraryTracks(data: unknown): { id: string; title: string }[] {
  if (!data || typeof data !== "object" || !("tracks" in data) || !Array.isArray(data.tracks)) return [];
  const out: { id: string; title: string }[] = [];
  for (const t of data.tracks) {
    if (t && typeof t === "object" && "id" in t && "title" in t && typeof t.id === "string" && typeof t.title === "string") out.push({ id: t.id, title: t.title });
  }
  return out;
}

async function endToEnd(root: string, whistleDir: string): Promise<void> {
  const dataRoot = join(root, "data");
  const home = join(root, "home");
  const creatorDir = join(root, "creator");
  // A concrete free port: the engine's Host gate checks against its CONFIGURED port (demo_p_tui_0's rule).
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port!;
  probe.stop(true);
  // Windows: a process the engine watches as its "main"; killing it is the clean exit (parent_watch.ts).
  const parent = process.platform === "win32" ? Bun.spawn(["bun", "-e", "setInterval(() => {}, 1_000_000)"], { stdout: "ignore", stderr: "ignore" }) : null;
  const engine = Bun.spawn(["bun", join(REPO, "desktop", "dev.ts")], {
    cwd: REPO,
    env: {
      ...process.env,
      PORT: String(port),
      LUCID_BUILD_FLAVOR: "creator",
      LUCID_DATA_ROOT: dataRoot,
      LUCID_CREATOR_DIR: creatorDir,
      LUCID_WHISTLE_DIR: whistleDir, // the same verified files: the engine never stages or downloads here
      HOME: home,
      ...(parent ? { LUCID_MAIN_PID: String(parent.pid), LUCID_PARENT_WATCH_MS: "250" } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  let log = "";
  const drain = async (s: ReadableStream<Uint8Array>) => { for await (const c of s) log += new TextDecoder().decode(c); };
  void drain(engine.stdout);
  void drain(engine.stderr);
  try {
    const deadline = Date.now() + 90_000;
    let found = listDiscoveries(dataRoot);
    while (found.length === 0 && Date.now() < deadline && engine.exitCode === null) {
      await Bun.sleep(250);
      found = listDiscoveries(dataRoot);
    }
    if (found.length === 0) {
      check("the scratch Creator engine boots and publishes its discovery file", false, `exit ${engine.exitCode}; log tail: ${log.slice(-800)}`);
      return;
    }
    const { token } = found[0]!.discovery;
    const post = async (path: string, body: unknown): Promise<{ status: number; json: { ok: boolean; error: string; data: unknown } }> => {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-lucid-token": token },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      });
      const raw: unknown = await r.json().catch(() => null);
      const o: object = raw && typeof raw === "object" ? raw : {};
      return {
        status: r.status,
        json: {
          ok: "ok" in o && o.ok === true,
          error: "error" in o && typeof o.error === "string" ? o.error : "",
          data: "data" in o ? o.data : undefined,
        },
      };
    };
    check("the scratch Creator engine boots", true, `pid ${engine.pid}, port ${port}, data root ${dataRoot}`);

    const TITLE = "Quick fox";
    const added = await post("/api/creator/library", { op: "add", sourcePath: FIXTURE_WAV, title: TITLE, origin: "local", lyrics: FIXTURE_TEXT });
    const track = libraryTracks(added.json.data).find((t) => t.title === TITLE);
    check("the fixture WAV is imported into the engine's library", added.status === 200 && added.json.ok === true && !!track,
      track ? track.id : `HTTP ${added.status} ${added.json.error ?? ""}`);
    if (!track) return;

    const t0 = performance.now();
    const res = await post("/api/creator/align", { trackId: track.id, language: "en" });
    const wall = Math.round(performance.now() - t0);
    check("POST /api/creator/align answers ok", res.status === 200 && res.json.ok === true, res.json.ok ? `${wall} ms wall` : `HTTP ${res.status} ${res.json.error ?? ""}`);
    const data = res.json.data;
    if (!isEditorAlignData(data)) {
      check("the answer is the shape the editor accepts (isEditorAlignData)", false, JSON.stringify(data ?? null).slice(0, 300));
      return;
    }
    check("the answer is the shape the editor accepts (isEditorAlignData)", true);
    console.log(`   note: ${data.note}`);
    const nMeasured = data.items.filter((it) => it.source === "measured").length;
    check("its items include source 'measured'", nMeasured > 0, `${nMeasured} measured, ${data.items.length - nMeasured} derived of ${data.items.length}`);
    check("alignedBy is provider whistle with the PINNED model sha256",
      data.alignedBy.provider === "whistle" && data.alignedBy.modelSha256 === WHISTLE_MODEL_SHA256,
      `${data.alignedBy.provider} ${data.alignedBy.modelSha256.slice(0, 12)}`);
    const wav = durationOfWav(new Uint8Array(readFileSync(FIXTURE_WAV)));
    const doc = docFromSource({ sourceId: track.id, fmt: wav.fmt, durationMs: wav.durationMs, items: data.items, alignedBy: data.alignedBy });
    const problems = validateDoc(doc);
    check("the document built from it validates", problems.length === 0, problems.join("; "));
    const wire = decodeTimelineDoc(JSON.parse(JSON.stringify(doc)));
    check("the save gate accepts it with alignedBy intact", wire.ok && wire.doc.alignedBy?.modelSha256 === WHISTLE_MODEL_SHA256, wire.ok ? "" : wire.error);
    const chips = (chipStripHtml(doc, -1, []).match(/class="ced-chip measured\b/g) ?? []).length;
    check("the editor paints it with measured chips", chips === nMeasured && chips > 0, `${chips} chips with class "ced-chip measured"`);
    const jobId = data.jobId;
    console.log(`   transcript: ${data.transcript} (${data.language}, ${data.windows} window(s), ${data.matched} matched, ${data.interpolated} interpolated)`);
    const ledgerJob = foldJobs(existsSync(jobsLedger(creatorDir)) ? readFileSync(jobsLedger(creatorDir), "utf8") : "").find((j) => j.id === jobId);
    check("the engine's job ledger holds the align job, admitted with its measurement and done",
      ledgerJob?.kind === "align" && ledgerJob.state === "done" && ledgerJob.provider === "whistle" && !!ledgerJob.admission?.ok,
      ledgerJob ? `${ledgerJob.id} ${ledgerJob.state}, cpu at admission ${ledgerJob.admission?.cpuPct ?? "unknown"}%` : `no job ${jobId}`);
  } finally {
    if (parent) parent.kill();
    else engine.kill("SIGTERM");
    const exited = await Promise.race([engine.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
    if (!exited) engine.kill();
  }
}

console.log(failures === 0
  ? "\nCREATOR-WHISTLE demo OK - the pinned assets verify and a one-byte flip refuses the load by name and hash; the real model transcribes the fixture at >= 90% token match with monotonic word times; a 44 s clip windows into two calls cut in silence with offsets applied; one substituted word is the only derived item, capped; load and every transcribe made zero network attempts against a 16-name import table; a hot CPU refuses an align job with the measured reason; confidence 1.2 is rejected; and a scratch Creator engine's /api/creator/align returns a validated, measured, model-pinned document the editor paints with measured chips."
  : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
