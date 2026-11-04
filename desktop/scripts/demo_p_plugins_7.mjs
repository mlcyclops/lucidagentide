// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-PLUGINS.7 (ADR-0486) - live smoke of a PRIVATE plugin install against a RUNNING engine.
//
// 1. Packs an unsigned free "hello-private" server plugin with the real packer (no key), plus a tampered
//    copy of it, as .lplugin.zip files on disk.
// 2. Drives the engine's real routes: inspect-file refuses the tampered copy at the hash gate; install-file
//    refuses the good one without the unsigned acceptance, then installs it with it; GET /api/plugins shows it
//    as source private, unsigned.
// 3. With LUCID_DEMO_CDP_URL and LUCID_DEMO_URL (an already-running isolated QA browser on that engine's UI),
//    the drawer is driven for real: rail Plugins button, Installed tab, the row's unsigned chip, Open, and the
//    plugin Preview tab's iframe on its loopback origin. Without them the plugin is started over the API.
// 4. Stops and uninstalls it, and proves it is gone from the list.
//
//   bun desktop/scripts/demo_p_plugins_7.mjs --engine http://127.0.0.1:5399 --token <LUCID_MAIN_TOKEN>

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipEntries } from "../../harness/kb/zip.ts";
import { readAllZipEntries } from "../../harness/personal/unzip.ts";
import { buildPlugin } from "../../tools/build_plugin.ts";
import { writeStage } from "../plugins/fixtures.ts";

const ID = "hello-private";
const HELLO_JS = `
const http = require("http");
http.createServer((req, res) => {
  if (req.url === "/api/health") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, id: process.env.LUCID_PLUGIN_ID })); return; }
  res.writeHead(200, { "content-type": "text/html" }); res.end("<h1>hello from a private LUCID plugin</h1>");
}).listen(Number(process.env.PORT), process.env.HOST);
`;

function args() {
  const a = process.argv.slice(2);
  const out = { engine: "", token: "" };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--engine") out.engine = a[++i] ?? "";
    else if (a[i] === "--token") out.token = a[++i] ?? "";
    else throw new Error(`unknown argument ${a[i]}`);
  }
  if (!out.engine || !out.token) throw new Error("--engine and --token are required");
  return out;
}

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

async function drawerSmoke() {
  const endpoint = process.env.LUCID_DEMO_CDP_URL, url = process.env.LUCID_DEMO_URL;
  if (!endpoint || !url) return null;
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ browserWSEndpoint: endpoint });
  try {
    const page = (await browser.pages()).find((p) => p.url() === url);
    if (!page) throw new Error(`No existing QA page at ${url}`);
    await page.click("#railMarket");
    await page.waitForSelector(".plg-drawer", { visible: true });
    await page.click('[data-plg-tier="installed"]');
    const card = `[data-plg-card="${ID}"][data-plg-source="private"]`;
    await page.waitForSelector(`${card} .plg-chip[data-status="unsigned"]`, { visible: true });
    const chip = await page.$eval(`${card} .plg-chip`, (el) => el.textContent);
    assert(chip === "Private, unsigned", `chip reads ${JSON.stringify(chip)}`);
    assert(await page.$(`[data-plg-iremove="${ID}"]`), "a private row offers Remove");
    const shot = join(tmpdir(), "p-plugins-7-installed.png");
    await page.screenshot({ path: shot });
    await page.click(`[data-plg-iopen="${ID}"]`);
    const src = await page.waitForFunction(() => {
      const f = [...document.querySelectorAll("iframe.preview-frame")].find((x) => x.title === "Hello Private plugin");
      return f && /^http:\/\/(localhost|127\.0\.0\.1):\d+\/?$/.test(f.src) ? f.src : null;
    }, { timeout: 30_000 }).then((h) => h.jsonValue());
    return { shot, src };
  } finally { await browser.disconnect(); }
}

async function main() {
  const { engine, token } = args();
  const api = async (path, body) => {
    const res = await fetch(`${engine}${path}`, body === undefined
      ? { headers: { "x-lucid-token": token } }
      : { method: "POST", headers: { "x-lucid-token": token, "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await res.json();
    return j.data ?? j;
  };

  const src = writeStage({ "LICENSE": "Private smoke fixture\n", "app/server.cjs": HELLO_JS }, {
    schema: 1, id: ID, name: "Hello Private", version: "0.1.0", publisher: "Smoke Test", license: "Proprietary",
    tier: "free", section: "civilian", kind: "server", entry: { main: "app/server.cjs", healthPath: "/api/health" }, permissions: ["network:loopback"],
  });
  const dir = mkdtempSync(join(tmpdir(), "lplugin-private-"));
  const built = buildPlugin({ src, out: dir });
  assert(!built.signed, "the private fixture is unsigned");
  const tamperedPath = join(dir, `${ID}-tampered.lplugin.zip`);
  writeFileSync(tamperedPath, zipEntries(readAllZipEntries(readFileSync(built.zipPath), { maxTotalBytes: 1 << 30 })
    .map((e) => e.name === "app/server.cjs" ? { ...e, data: Buffer.from(e.data.toString() + "\n// injected") } : e)));
  console.log(`built ${built.zipPath} (unsigned) and ${tamperedPath}`);

  const tampered = await api("/api/plugins/inspect-file", { path: tamperedPath });
  console.log("inspect tampered:", JSON.stringify(tampered));
  assert(tampered.ok === false && tampered.gate === "hash", "a tampered package is refused at the hash gate");

  const seen = await api("/api/plugins/inspect-file", { path: built.zipPath });
  console.log("inspect:", JSON.stringify(seen));
  assert(seen.ok && seen.signed === false && seen.id === ID, "the good package inspects as unsigned");

  const refused = await api("/api/plugins/install-file", { path: built.zipPath, sha256: seen.sha256, acceptUnsigned: false });
  console.log("install without acceptance:", JSON.stringify(refused));
  assert(refused.ok === false && refused.gate === "signature", "unsigned needs the explicit acceptance");

  const inst = await api("/api/plugins/install-file", { path: built.zipPath, sha256: seen.sha256, acceptUnsigned: true });
  console.log("install:", JSON.stringify(inst));
  assert(inst.ok && inst.signed === false, "installed, unsigned");

  const row = (await api("/api/plugins")).plugins.find((p) => p.id === ID);
  console.log("list row:", JSON.stringify(row));
  assert(row && row.source === "private" && row.signed === false, "listed as a private unsigned install");

  let port = "";
  try {
    const drawer = await drawerSmoke();
    if (drawer) {
      console.log(`drawer: Installed tab screenshot ${drawer.shot}; plugin tab iframe ${drawer.src}`);
      port = new URL(drawer.src).port;
    } else {
      const start = await api("/api/plugins/start", { id: ID });
      console.log("start:", JSON.stringify(start));
      assert(start.ok, "the private plugin starts through the runtime");
      port = new URL(start.url).port;
    }
    const h = await fetch(`http://127.0.0.1:${port}/api/health`);
    const health = await h.json();
    console.log(`GET :${port}/api/health -> ${h.status} ${JSON.stringify(health)}`);
    assert(h.ok && health.id === ID, "health answers with the plugin id");
  } finally {
    console.log("stop:", JSON.stringify(await api("/api/plugins/stop", { id: ID })));
    console.log("uninstall:", JSON.stringify(await api("/api/plugins/uninstall", { id: ID, keepData: false })));
  }
  assert(!(await api("/api/plugins")).plugins.some((p) => p.id === ID), "gone after uninstall");
  console.log("\nSMOKE OK");
}

main().catch((e) => { console.error(`SMOKE FAILED: ${e.message}`); process.exitCode = 1; });
