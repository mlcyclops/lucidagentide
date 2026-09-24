// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/omp/stderr_notice.test.ts - P-RECOVER.1 (ADR-0385): a process whose stderr reader has gone away
// keeps running after writing gate notices. The field crash (omp log 2026-09-23 01:39:00) was an uncaught
// `EPIPE: broken pipe, write` from process.stderr.write in the security gate, after the engine that held the
// read end of omp's stderr had exited.
//
// The topology matters: destroying the reader's stream inside a live parent does not close the OS pipe, so
// a plain write "passes". Here the reader is a middle process that EXITS, exactly like the engine did, and
// the writer is a detached child that outlives it. With a bare process.stderr.write the child dies on an
// uncaught EPIPE; with writeStderrNotice it survives.

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DIR = mkdtempSync(join(tmpdir(), "lucid-stderr-notice-"));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

test("a notice written after the stderr reader's process exited does not crash the writer", async () => {
  const marker = join(DIR, "marker.txt");
  const child = join(DIR, "child.ts");
  const middle = join(DIR, "middle.ts");
  writeFileSync(child, [
    `import { appendFileSync } from "node:fs";`,
    `import { writeStderrNotice } from ${JSON.stringify(pathToFileURL(join(import.meta.dir, "stderr_notice.ts")).href)};`,
    `const mark = (s) => appendFileSync(${JSON.stringify(marker)}, s + "\\n");`,
    `process.on("uncaughtException", (e) => { mark("uncaught " + e.message); process.exit(7); });`,
    `mark("started");`,
    // Real time inside the CHILD process: it must outlive the middle process, whose exit is what closes the pipe.
    `await Bun.sleep(1500);`,
    `for (let i = 0; i < 4000; i++) writeStderrNotice("blocked tool_call ".repeat(64) + "\\n");`,
    `await Bun.sleep(300);`,
    `mark("survived");`,
  ].join("\n"));
  writeFileSync(middle, [
    `import { spawn } from "node:child_process";`,
    `const c = spawn(process.execPath, [${JSON.stringify(child)}], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: true });`,
    `c.unref();`,
    `await Bun.sleep(500);`,
    `process.exit(0);`,
  ].join("\n"));
  const mid = Bun.spawn([process.execPath, middle], { stdout: "ignore", stderr: "ignore" });
  await mid.exited;
  const end = Date.now() + 15_000;
  const settled = () => existsSync(marker) && /survived|uncaught/.test(readFileSync(marker, "utf8"));
  while (!settled() && Date.now() < end) await Bun.sleep(50);
  const log = existsSync(marker) ? readFileSync(marker, "utf8") : "";
  expect(log).toContain("started");
  expect(log).not.toContain("uncaught");
  expect(log).toContain("survived");
}, 20_000);
