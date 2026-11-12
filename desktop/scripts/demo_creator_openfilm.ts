// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// demo-CREATOR-OPENFILM (ADR-0457): OpenFilm as an on-device Creator provider, proven with a FAKE spawn over real
// temp folders and the real job + artifact ledgers, so the proof needs no node, no Chromium, and no FFmpeg.
//
//   [1] the launcher: shell shims, package runners (npx and friends), and refused subcommands (get, open, update,
//       skill, skills, doctor) are refused before anything runs, and the fake spawn is never called
//   [2] the argv is exact: look with a time, a range and a count; render with --workers 1 and --alpha only for
//       webm / mov
//   [3] the env: secrets and proxies stripped, the opt-outs forced, the lockdown download host pinned
//   [4] the project scan: an external URL in a page refuses under CUI lockdown and is a note unlocked
//   [5] .film/opened is written before the CLI runs, so it never starts a detached Studio server
//   [6] the look verdict: continuation lines joined, untrusted text sanitized, only PNGs inside
//       .film/cache/look stored
//   [7] render: the video is stored, the job settles done
//   [8] exit 2 fails the job with the CLI's own words
//
// Run with: bun run desktop/scripts/demo_creator_openfilm.ts   (make demo-CREATOR-OPENFILM)

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SpawnResult } from "../creator_blender.ts";
import { foldArtifacts, artifactLedger, type ArtifactIo } from "../creator_image.ts";
import { createJob, foldJobs, jobsLedger, startJob, type JobIo } from "../creator_jobs.ts";
import {
  OPENFILM_LOCKED_DOWNLOAD_HOST, openfilmEnv, planOpenfilmLook, planOpenfilmRender, preflightOpenfilm, runOpenfilmLook,
  runOpenfilmRender, type OpenfilmDeps, type OpenfilmDirEntry, type OpenfilmSpawn,
} from "../creator_openfilm.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  ok " : "  FAIL"} ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

const dir = mkdtempSync(join(tmpdir(), "lucid-openfilm-demo-"));
const fwd = (p: string): string => p.replace(/\\/g, "/");
const BASE = fwd(join(dir, "creator"));
const HOME = `${BASE}/openfilm/home`;
const PROJECT = fwd(join(dir, "teaser"));
const NODE = fwd(join(dir, "node.exe"));
const CLI = fwd(join(dir, "node_modules/openfilm/bin/openfilm.mjs"));

const PNG = (w: number, h: number): Uint8Array => {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
};

let ids = 0;
const jobIo: JobIo = {
  ensureDir: (d) => mkdirSync(d, { recursive: true }),
  readText: (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } },
  appendLine: (p, l) => { mkdirSync(dirname(p), { recursive: true }); appendFileSync(p, `${l}\n`); },
  now: () => Date.now(),
  id: () => `job_demo_${++ids}`,
};
const artifactIo: ArtifactIo = {
  ensureDir: (d) => mkdirSync(d, { recursive: true }),
  writeBytes: (p, b) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, b); },
  writeText: (p, t) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); },
  appendLine: (p, l) => { mkdirSync(dirname(p), { recursive: true }); appendFileSync(p, `${l}\n`); },
  readText: (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } },
  now: () => Date.now(),
  id: () => `art_demo_${++ids}`,
};

/** The fake CLI: records each call, then does what the scripted step says. */
interface Step { result: SpawnResult; write?: Record<string, Uint8Array> }
const calls: { argv: readonly string[]; cwd: string; env: Record<string, string>; markerAtSpawn: boolean }[] = [];
let script: Step[] = [];
const fakeSpawn: OpenfilmSpawn = async (argv, opts) => {
  calls.push({ argv, cwd: opts.cwd, env: opts.env, markerAtSpawn: existsSync(join(opts.cwd, ".film/opened")) });
  const step = script.shift() ?? { result: { code: 0, stdout: "", stderr: "" } };
  for (const [p, bytes] of Object.entries(step.write ?? {})) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, bytes); }
  return step.result;
};

const deps: OpenfilmDeps = {
  spawn: fakeSpawn,
  exists: (p) => existsSync(p),
  readText: (p) => readFileSync(p, "utf8"),
  readBytes: (p) => new Uint8Array(readFileSync(p)),
  fileSize: (p) => statSync(p).size,
  listDir: (d) => readdirSync(d, { withFileTypes: true }).map((e): OpenfilmDirEntry => ({ name: e.name, kind: e.isDirectory() ? "dir" : e.isFile() ? "file" : "other" })),
  writeText: (p, t) => writeFileSync(p, t),
  ensureDir: (d) => { mkdirSync(d, { recursive: true }); },
  jobIo, artifactIo,
  env: { PATH: "/usr/bin", LOCALAPPDATA: "C:/Users/n/AppData/Local", ELEVENLABS_API_KEY: "sk-demo-secret", HTTPS_PROXY: "http://proxy:3128", OPENFILM_NO_BROWSER: "0" },
  now: () => Date.now(),
};

const job = (kind: "test" | "render", label: string): string => {
  const j = createJob(jobIo, BASE, { kind, label, provider: "openfilm" });
  startJob(jobIo, BASE, j.id);
  return j.id;
};
const jobState = (id: string) => foldJobs(jobIo.readText(jobsLedger(BASE))).find((j) => j.id === id);

try {
  mkdirSync(`${PROJECT}/pages`, { recursive: true });
  mkdirSync(dirname(CLI), { recursive: true });
  writeFileSync(NODE, "");
  writeFileSync(CLI, "");
  writeFileSync(`${PROJECT}/film.html`, `<section><iframe src="pages/title.html#t=0,2"></iframe></section>`);
  writeFileSync(`${PROJECT}/pages/title.html`, `<canvas></canvas><script>window.film = { duration: 2, frame(t) { document.body.style.opacity = String(t / 2); } };</script>`);

  console.log("[1] the launcher is checked before anything runs");
  for (const exe of [`${dir}/node_modules/.bin/openfilm.cmd`, "C:/x/run.bat", "C:/x/of.ps1", "C:/x/of.vbs", "/usr/bin/of.sh"]) {
    const r = planOpenfilmLook({ exe, projectDir: PROJECT });
    check(`shell shim refused: ${exe.split("/").pop()}`, !r.ok && r.error.includes("shell launcher"));
  }
  for (const exe of ["C:/node/npx.exe", "/usr/bin/pnpm", "/usr/bin/pnpx", "/usr/bin/bunx", "C:/x/yarn.exe", "/usr/bin/dlx", "/usr/bin/npm"]) {
    const r = planOpenfilmRender({ exe, projectDir: PROJECT, outPath: `${BASE}/openfilm/of_x/render.mp4` });
    check(`package runner refused: ${exe.split("/").pop()}`, !r.ok && r.error.includes("package runner"));
  }
  for (const word of ["get", "open", "update", "skill", "skills", "doctor", "Get"]) {
    const r = planOpenfilmLook({ exe: NODE, prefixArgs: [CLI, word], projectDir: PROJECT });
    check(`refused subcommand in the declared args: ${word}`, !r.ok && r.error.includes("never runs"));
  }
  check("the fake spawn was never called", calls.length === 0);

  console.log("\n[2] the argv is exact");
  const l1 = planOpenfilmLook({ exe: NODE, prefixArgs: [CLI], projectDir: PROJECT, at: 1.5 });
  check("look at one time", l1.ok && JSON.stringify(l1.plan.argv) === JSON.stringify([NODE, CLI, "look", "1.5"]));
  const l2 = planOpenfilmLook({ exe: NODE, prefixArgs: [CLI], projectDir: PROJECT, range: [0, 2], count: 4 });
  check("look at a range with a count", l2.ok && JSON.stringify(l2.plan.argv) === JSON.stringify([NODE, CLI, "look", "0-2", "--count", "4"]));
  check("look refuses a backwards range", !planOpenfilmLook({ exe: NODE, prefixArgs: [CLI], projectDir: PROJECT, range: [2, 1] }).ok);
  check("look refuses count 201", !planOpenfilmLook({ exe: NODE, prefixArgs: [CLI], projectDir: PROJECT, count: 201 }).ok);
  const OUT = `${BASE}/openfilm/of_demo/render.mp4`;
  const r1 = planOpenfilmRender({ exe: NODE, prefixArgs: [CLI], projectDir: PROJECT, outPath: OUT });
  check("render mp4: one worker, no --alpha", r1.ok && JSON.stringify(r1.plan.argv) === JSON.stringify([NODE, CLI, "render", "--out", OUT, "--fps", "30", "--workers", "1"]));
  const WEBM = `${BASE}/openfilm/of_demo/render.webm`;
  const r2 = planOpenfilmRender({ exe: NODE, prefixArgs: [CLI], projectDir: PROJECT, outPath: WEBM, format: "webm", fps: 24, fourK: true, blur: true });
  check("render webm: --alpha, --4k, --blur", r2.ok && JSON.stringify(r2.plan.argv) === JSON.stringify([NODE, CLI, "render", "--out", WEBM, "--fps", "24", "--workers", "1", "--alpha", "--4k", "--blur"]));
  check("a relative project folder is refused", !planOpenfilmLook({ exe: NODE, prefixArgs: [CLI], projectDir: "teaser" }).ok);
  check("a project outside the managed roots is refused", !planOpenfilmLook({ exe: NODE, prefixArgs: [CLI], projectDir: PROJECT, roots: ["D:/approved"] }).ok);

  console.log("\n[3] the child env");
  const open = openfilmEnv(deps.env, { home: HOME, locked: false });
  check("secrets and proxies are stripped", !("ELEVENLABS_API_KEY" in open) && !("HTTPS_PROXY" in open));
  check("the opt-outs are forced", open.OPENFILM_NO_BROWSER === "1" && open.OPENFILM_NO_UPDATE_CHECK === "1" && open.DO_NOT_TRACK === "1" && open.OPENFILM_HOME === HOME);
  check("unlocked, the download host is Playwright's own", !("PLAYWRIGHT_DOWNLOAD_HOST" in open));
  const shut = openfilmEnv(deps.env, { home: HOME, locked: true });
  check("locked, the browser download goes to a dead loopback port", shut.PLAYWRIGHT_DOWNLOAD_HOST === OPENFILM_LOCKED_DOWNLOAD_HOST && shut.PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST === OPENFILM_LOCKED_DOWNLOAD_HOST, OPENFILM_LOCKED_DOWNLOAD_HOST);

  console.log("\n[4] the project scan");
  if (!l1.ok || !r1.ok) throw new Error("plans did not build");
  check("a clean project passes locked with no note", JSON.stringify(preflightOpenfilm(deps, l1.plan, NODE, true)) === JSON.stringify({ ok: true, note: "" }));
  writeFileSync(`${PROJECT}/pages/font.css`, `@import "https://fonts.example.com/inter.css";`);
  const locked = preflightOpenfilm(deps, l1.plan, NODE, true);
  check("locked: an external URL in a stylesheet refuses at stage external-refs", !locked.ok && locked.stage === "external-refs" && locked.error.startsWith("CUI lockdown:"), locked.ok ? "" : locked.error.slice(0, 90));
  const unlocked = preflightOpenfilm(deps, l1.plan, NODE, false);
  check("unlocked: the same URL is a note", unlocked.ok && unlocked.note.includes("not offline and not deterministic"));
  rmSync(`${PROJECT}/pages/font.css`);
  check("a missing film.html refuses", !preflightOpenfilm(deps, { ...l1.plan, projectDir: `${dir}/empty` }, NODE, false).ok);

  console.log("\n[5] .film/opened");
  const SHEET = `${PROJECT}/.film/cache/look/sheet.png`;
  script = [{
    result: {
      code: 1, stderr: "",
      stdout: [
        "film  640×360 · 2s · 0 sounds",
        "✗ pages/title.html draws a different picture at 1.5 s the second time",
        "        (the page reads Math.random; draw from t)",
        "! text cut off: \u202eesrever\u200b caption \u0007",
        "✓ no page errors",
        "→ .film/cache/look/sheet.png",
        "→ .film/cache/look/fake.png",
        `→ ${dir}/elsewhere.png`,
      ].join("\n"),
    },
    write: { [SHEET]: PNG(640, 360), [`${PROJECT}/.film/cache/look/fake.png`]: new Uint8Array(64), [`${dir}/elsewhere.png`]: PNG(1, 1) },
  }];
  check("no marker before the run", !existsSync(`${PROJECT}/.film/opened`));
  const lookJob = job("test", "OpenFilm look: teaser");
  const lr = await runOpenfilmLook(deps, BASE, lookJob, l1.plan, { label: "OpenFilm look: teaser", home: HOME, locked: false });
  check("the marker existed when the CLI started", calls.at(-1)?.markerAtSpawn === true);
  check("the CLI ran in the project folder", calls.at(-1)?.cwd === PROJECT);
  check("the spawned env carried no secret", !("ELEVENLABS_API_KEY" in (calls.at(-1)?.env ?? {})));

  console.log("\n[6] the look verdict");
  const v = lr.verdict;
  check("job done, verdict not ok (the film has an error)", lr.ok && jobState(lookJob)?.state === "done" && v?.ok === false && v.exitCode === 1);
  check("the continuation line joined its error", v?.errors[0] === "pages/title.html draws a different picture at 1.5 s the second time (the page reads Math.random; draw from t)", v?.errors[0]);
  check("bidi, zero-width, and control characters are gone", v?.warnings[0] === "text cut off: esrever caption", v?.warnings[0]);
  check("one sheet stored (fake PNG and outside path refused)", v?.sheets.length === 1 && lr.note.includes("2 listed pictures not stored"), lr.note);
  const arts = foldArtifacts(artifactIo.readText(artifactLedger(BASE)));
  check("the stored sheet is an image/png from openfilm, sized from its header", arts.length === 1 && arts[0]!.kind === "image" && arts[0]!.mime === "image/png" && arts[0]!.source === "openfilm" && arts[0]!.width === 640);
  check("the job lists the sheet", JSON.stringify(jobState(lookJob)?.artifacts) === JSON.stringify(v?.sheets));

  console.log("\n[7] render");
  script = [{ result: { code: 0, stdout: `→ ${OUT}`, stderr: "" }, write: { [OUT]: new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]) } }];
  const renderJob = job("render", "OpenFilm mp4: teaser");
  const rr = await runOpenfilmRender(deps, BASE, renderJob, r1.plan, { label: "OpenFilm mp4: teaser", home: HOME, locked: true });
  check("render stored a video artifact", rr.ok && rr.artifact?.kind === "video" && rr.artifact.mime === "video/mp4" && rr.artifact.source === "openfilm");
  check("the job settled done with the video", jobState(renderJob)?.state === "done" && jobState(renderJob)?.artifacts[0] === rr.artifact?.id);
  check("the locked render pinned the download host", calls.at(-1)?.env.PLAYWRIGHT_DOWNLOAD_HOST === OPENFILM_LOCKED_DOWNLOAD_HOST);

  console.log("\n[8] exit 2");
  script = [{ result: { code: 2, stdout: "", stderr: "openfilm look: needs ffmpeg and ffprobe on the PATH" } }];
  const badJob = job("test", "OpenFilm look: teaser");
  const br = await runOpenfilmLook(deps, BASE, badJob, l1.plan, { label: "OpenFilm look: teaser", home: HOME, locked: false });
  check("exit 2 fails the job with the CLI's words", !br.ok && br.stage === "look" && jobState(badJob)?.state === "failed" && (jobState(badJob)?.error ?? "").includes("needs ffmpeg"), jobState(badJob)?.error);
  check("no verdict for a failed look", br.verdict === null);
} catch (e) {
  check("the demo ran to the end", false, String(e));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
