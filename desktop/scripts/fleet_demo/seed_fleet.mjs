// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/fleet_demo/seed_fleet.mjs - fills the QA engine started by start_qa_fleet.mjs with work:
// six named lanes on the sample workspace, each prompted with one scripted task, and the main chat prompted
// with another. With --every N it sends a fresh round every N seconds to every lane (and the main chat) that is
// idle, rotating through the scripts, so the fleet stays busy for footage. QA and video only.
//
//   bun desktop/scripts/fleet_demo/seed_fleet.mjs <engine url> [--every <seconds>] [--workspace <path>] [--lanes <1-8>] [--no-main]
//
// The token is read from the page's <meta name="lucid-token"> exactly as the browser renderer reads it; the
// workspace defaults to the one start_qa_fleet.mjs recorded in <tmp>/lucid-qa-fleet-<port>/fleet.json.
// Keep this running while turns stream: each prompt's NDJSON stream is read to its end here.

import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const base = (args.find((a) => /^https?:\/\//.test(a)) ?? "").replace(/\/*$/, "/");
if (!base) {
  console.error("Usage: bun desktop/scripts/fleet_demo/seed_fleet.mjs <engine url> [--every <seconds>] [--workspace <path>] [--lanes <1-8>] [--no-main]");
  process.exit(2);
}
const every = Number(flag("--every") ?? 0);
const laneCount = Math.min(8, Math.max(1, Number(flag("--lanes") ?? 6)));
const noMain = args.includes("--no-main"); // leave the main chat to whoever is driving the UI (a filmed walkthrough)
if (!Number.isFinite(every) || every < 0) { console.error("--every takes a number of seconds"); process.exit(2); }

let workspace = flag("--workspace") ?? "";
if (!workspace) {
  const port = new URL(base).port;
  try { workspace = JSON.parse(readFileSync(join(tmpdir(), `lucid-qa-fleet-${port}`, "fleet.json"), "utf8")).workspace; }
  catch { console.error(`No --workspace given and no fleet.json for port ${port}. Start the engine with start_qa_fleet.mjs first.`); process.exit(2); }
}

const html = await (await fetch(base)).text();
const token = /<meta name="lucid-token" content="([^"]+)"/.exec(html)?.[1];
if (!token) { console.error(`${base} serves no lucid-token meta (is it an Electron-launched engine?).`); process.exit(1); }
const headers = { "x-lucid-token": token, "content-type": "application/json" };

const SCRIPT_DIR = join(import.meta.dir, "scripts");
const scripts = readdirSync(SCRIPT_DIR).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(readFileSync(join(SCRIPT_DIR, f), "utf8")));
// Main chat opens on the mini game (its reply ends in a playable HTML block); the lanes take the rest in order.
const mainFirst = Math.max(0, scripts.findIndex((s) => s.id === "penalty-shootout-game"));
const laneOrder = scripts.filter((_, i) => i !== mainFirst);
const LANE_NAMES = {
  "hipaa-intake": "Intake API",
  "fedramp-access-reviews": "Access Reviews",
  "passkeys-session-rotation": "Auth Hardening",
  "soc2-evidence-pack": "SOC 2 Evidence",
  "pci-checkout": "Checkout Service",
  "upload-threat-model": "Upload Security",
  "release-notes": "Release Notes",
  "penalty-shootout-game": "Mini Games",
};

async function api(path, body) {
  const res = await fetch(new URL(path, base), body === undefined ? { headers } : { method: "POST", headers, body: JSON.stringify(body) });
  const parsed = await res.json();
  return parsed?.data ?? parsed;
}

/** POST and read the NDJSON stream to its end; resolves with the count of events and the last error, if any. */
async function stream(path, body) {
  const res = await fetch(new URL(path, base), { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.body) return { events: 0, error: `HTTP ${res.status}` };
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  let events = 0;
  let error;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += value;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      events++;
      try { const e = JSON.parse(line); if (e.type === "error") error = e.message; } catch { /* a torn line */ }
    }
  }
  return { events, error };
}

const at = () => new Date().toLocaleTimeString();
const pending = new Set();
const track = (label, p) => {
  const run = p.then((r) => console.log(`[${at()}] ${label}: finished (${r.events} events${r.error ? `, error: ${r.error}` : ""})`), (e) => console.log(`[${at()}] ${label}: stream failed: ${e.message}`));
  pending.add(run);
  void run.finally(() => pending.delete(run));
  return run;
};

// ── spawn ───────────────────────────────────────────────────────────────────────────────────────────────

const lanes = [];
for (let i = 0; i < laneCount && i < laneOrder.length; i++) {
  const name = LANE_NAMES[laneOrder[i].id] ?? laneOrder[i].title.slice(0, 24);
  const r = await api("/api/fleet/spawn", { cwd: workspace, name });
  if (!r?.ok || !r.lane?.id) { console.error(`[${at()}] spawn ${name} refused: ${r?.reason ?? JSON.stringify(r)}`); continue; }
  lanes.push({ id: r.lane.id, name, slot: i });
  console.log(`[${at()}] lane ${name} (${r.lane.id}) spawned`);
  await Bun.sleep(800); // lanes appear one by one on camera
}
if (!lanes.length) { console.error("No lane could be spawned."); process.exit(1); }

// ── prompt rounds ───────────────────────────────────────────────────────────────────────────────────────

let mainBusy = false;

async function round(n) {
  const status = await api("/api/fleet/status").catch(() => null);
  const byId = new Map((status?.lanes ?? []).map((l) => [l.id, l.status]));
  for (const lane of lanes) {
    const s = byId.get(lane.id);
    if (n > 0 && s !== "awaiting-input" && s !== "done") continue; // still working, waiting on approval, or gone
    const script = laneOrder[(lane.slot + n) % laneOrder.length];
    console.log(`[${at()}] ${lane.name} <- ${script.prompt}`);
    track(`${lane.name} (${script.id})`, stream("/api/fleet/prompt", { laneId: lane.id, text: script.prompt }));
    await Bun.sleep(1200);
  }
  if (!noMain && !mainBusy) {
    const script = scripts[(mainFirst + n) % scripts.length];
    mainBusy = true;
    console.log(`[${at()}] main chat <- ${script.prompt}`);
    void track(`main chat (${script.id})`, stream("/api/chat", { text: script.prompt, requestId: crypto.randomUUID() })).finally(() => { mainBusy = false; });
  }
}

await round(0);
if (every > 0) {
  console.log(`Repeating every ${every}s for idle lanes. Ctrl+C to stop seeding (lanes keep their current turn).`);
  for (let n = 1; ; n++) {
    await Bun.sleep(every * 1000);
    await round(n);
  }
}
while (pending.size) await Promise.race(pending);
console.log("All seeded turns finished.");
