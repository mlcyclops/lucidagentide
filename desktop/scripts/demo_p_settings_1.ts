// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_settings_1.ts
//
// Increment P-SETTINGS.1 (ADR-0439): the settings file is never silently wiped. On 2026-10-05 the
// window force-restarted a frozen engine; the old in-place save() left lucid-gui.json empty, load()
// read that as "no settings", onboarding re-ran, and the Windows sandbox opt-out reverted to ON (which
// then blocked every agent turn). This demo uses REAL processes against a scratch settings file:
//   1) a writer process saving in a tight loop is hard-killed at random moments, many times;
//      after every kill the profile still loads intact.
//   2) a reader process loading concurrently with a writer never sees a torn or empty file.
//   3) a 0-byte file (what the old save left behind) is recovered from the backup, the opt-out holds.

import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load, save, setDeveloperMode } from "../settings_store.ts";

const PROFILE = { username: "Nick", sandboxWindowsMode: "off" as const, tourSeen: true, lastModel: "anthropic/claude-opus-5-5" };
const role = process.argv[2];

// ---- child roles ----------------------------------------------------------------------------------
if (role === "--writer") {
  // Big enough that a write spans real time; flips a field so every save changes bytes.
  const pad = "x".repeat(64 * 1024);
  for (let i = 0; ; i++) save({ ...PROFILE, developerMode: i % 2 === 0, pad });
}
if (role === "--reader") {
  const end = Date.now() + Number(process.argv[3] ?? 1500);
  let reads = 0;
  while (Date.now() < end) {
    const s = load();
    if (s.sandboxWindowsMode !== "off" || s.username !== "Nick") { console.log(`TORN after ${reads} reads`); process.exit(3); }
    reads++;
  }
  console.log(`CLEAN ${reads}`);
  process.exit(0);
}

// ---- driver -----------------------------------------------------------------------------------------
const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} - ok`);
const self = import.meta.path;

console.log("== ADR-0439 P-SETTINGS.1: settings survive a killed engine and concurrent readers ==");
const dir = mkdtempSync(join(tmpdir(), "lucid-settings1-"));
const file = join(dir, "lucid-gui.json");
process.env.LUCID_GUI_SETTINGS_FILE = file;
const env = { ...process.env, LUCID_GUI_SETTINGS_FILE: file };

try {
  save(PROFILE);

  // 1) hard-kill a writer mid-save, repeatedly
  const KILLS = 25;
  for (let k = 0; k < KILLS; k++) {
    const w = Bun.spawn([process.execPath, self, "--writer"], { env, stdout: "ignore", stderr: "ignore" });
    await Bun.sleep(40 + Math.floor(Math.random() * 120));
    w.kill(9);
    await w.exited;
    const s = load();
    if (s.sandboxWindowsMode !== "off" || s.username !== "Nick" || s.tourSeen !== true) {
      fail(`after hard kill #${k + 1} the profile came back as ${JSON.stringify(s).slice(0, 120)}`);
    }
  }
  const stray = readdirSync(dir).filter((f) => f.startsWith("lucid-gui.json.corrupt-"));
  ok(`${KILLS} hard kills of a process saving in a tight loop: the profile loaded intact every time (${stray.length} corrupt files needed recovery)`);

  // 2) a reader racing a writer never sees a torn file
  save(PROFILE);
  const writer = Bun.spawn([process.execPath, self, "--writer"], { env, stdout: "ignore", stderr: "ignore" });
  const reader = Bun.spawn([process.execPath, self, "--reader", "2000"], { env, stdout: "pipe", stderr: "inherit" });
  const out = (await new Response(reader.stdout).text()).trim();
  const code = await reader.exited;
  writer.kill(9); await writer.exited;
  if (code !== 0 || !out.startsWith("CLEAN")) fail(`concurrent reader saw a torn settings file: ${out}`);
  ok(`a separate process loaded the settings ${out.split(" ")[1]} times while another saved continuously: never torn, never empty`);

  // 3) the exact 2026-10-05 state: a 0-byte primary after a killed in-place save
  save(PROFILE); save(PROFILE);
  writeFileSync(file, "");
  const orig = console.error; let logged = ""; console.error = (m: string) => { logged += m; };
  const after = setDeveloperMode(true);
  console.error = orig;
  if (after.sandboxWindowsMode !== "off") fail("the 0-byte file reset the Windows sandbox opt-out");
  if (after.username !== "Nick" || after.tourSeen !== true) fail("the 0-byte file reset the profile (onboarding would re-run)");
  if (!logged.includes("restored the last good copy")) fail("the recovery must be logged, not silent");
  if (!readdirSync(dir).some((f) => f.startsWith("lucid-gui.json.corrupt-"))) fail("the torn bytes must be kept aside, not deleted");
  ok("the 2026-10-05 0-byte file: restored from the backup, sandbox stays off, onboarding does not re-run, recovery is logged");

  console.log("\nP-SETTINGS.1 demo: all checks passed - a killed engine can no longer wipe the user's settings.");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
