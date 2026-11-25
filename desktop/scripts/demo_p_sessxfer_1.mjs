// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_sessxfer_1.mjs
//
// P-SESSXFER.1 (ADR-0682): real-UI proof of offline session history export and import, against an ISOLATED QA engine
// (its own temp HOME, so its own omp sessions root), driven with real mouse input:
//   1. two sessions are seeded into the QA engine's sessions root for its workspace (one quotes the QA home path and
//      a key-shaped value); they appear in the Sessions list;
//   2. the Sessions header's History button and the menu's Export history... are topmost at their centers
//      (document.elementFromPoint); the export dialog's controls are topmost and the dialog passes auditBoxes;
//   3. a marking is typed and Export is clicked: the browser downloads `<project>-<date>.lucidhistory.json`, which is
//      printable ASCII and LF only, `lucid-history/1`, carries the marking and both sessions, and holds neither the
//      home path nor the key;
//   4. the seeded files are wiped; the sessions leave the list;
//   5. Import history... takes the downloaded file through the real file chooser; the result dialog says 2 imported
//      and passes auditBoxes; both sessions reappear, labeled imported;
//   6. importing the same file again imports nothing and skips both (idempotent).
// The served /app.js must carry the new UI (`sxImportFile`). Seeded, downloaded and imported files are removed at the end.
//
// Setup (never a user's session): bun desktop/scripts/fleet_demo/start_qa_fleet.mjs 7811, the QA page open in a browser
// with remote debugging, past the first-run gates.
// Run: LUCID_DEMO_BROWSER_URL=http://127.0.0.1:<cdp> LUCID_DEMO_URL=http://127.0.0.1:7811/ node desktop/scripts/demo_p_sessxfer_1.mjs

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditBoxes, MIN_GAP } from "./demo_p_spacing_1.mjs";

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };

export async function verifySessionTransfer(page, base) {
  const port = new URL(base).port;
  const fleet = JSON.parse(readFileSync(join(process.env.LUCID_DEMO_QA_ROOT ?? join(tmpdir(), `lucid-qa-fleet-${port}`), "fleet.json"), "utf8"));
  const HOME = join(fleet.root, "home");
  const ROOT = join(HOME, ".omp", "agent", "sessions");
  const token = await page.$eval('meta[name="lucid-token"]', (m) => m.content);
  const api = (path, body) => page.evaluate(async (p, b, t) => {
    const r = await fetch(p, { method: b ? "POST" : "GET", headers: { "content-type": "application/json", "x-lucid-token": t }, ...(b ? { body: JSON.stringify(b) } : {}) });
    const j = await r.json();
    return j?.data ?? j;
  }, path, body ?? null, token);
  const until = async (read, what, ms = 25_000, every = 250) => {
    for (const end = Date.now() + ms; ; await pause(every)) {
      const v = await read();
      if (v) return v;
      assert(Date.now() < end, what);
    }
  };
  const center = (sel) => page.evaluate((s) => {
    const n = document.querySelector(s);
    if (!n) return null;
    const r = n.getBoundingClientRect();
    if (r.width === 0) return null;
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: !!at && (at === n || n.contains(at)) };
  }, sel);
  const dismissToasts = () => page.evaluate(() => document.querySelectorAll("#toasts .toast .h button").forEach((b) => b.click()));
  const clickReal = async (sel, what) => {
    let c = await until(() => center(sel), `${what}: not on screen (${sel})`, 8000);
    if (!c.top) { await dismissToasts(); await pause(400); c = await center(sel); }
    assert(c?.top, `${what}: covered at its center (${sel})`);
    await page.mouse.click(c.x, c.y);
    await pause(250);
  };
  const topmost = async (sels, what) => {
    for (const s of sels) assert((await center(s))?.top, `${what}: ${s} is not topmost at its center`);
  };
  const audit = async (sel) => { const bad = await page.evaluate(auditBoxes, sel, MIN_GAP); assert(bad.length === 0, `auditBoxes on ${sel}:\n${bad.join("\n")}`); };
  const listed = (ids) => page.evaluate((xs) => xs.map((id) => {
    const row = document.querySelector(`#sessList .sess[data-sid="${id}"]`);
    return row ? { id, imported: row.hasAttribute("data-imported") && !!row.querySelector(".sess-imported") } : null;
  }), ids);
  const repaint = async () => { await page.goto(base, { waitUntil: "domcontentloaded" }); await page.waitForSelector("#sessList", { timeout: 30000 }); };

  // 0. the served bundle carries this UI
  const js = await page.evaluate(async () => (await fetch("/app.js", { cache: "no-store" })).text());
  assert(js.includes("sxImportFile") && js.includes("sessHistory"), "the served /app.js does not carry the history transfer UI (rebuild the renderer)");

  const ws = (await api("/api/workspace"))?.current;
  assert(typeof ws === "string" && ws, "the QA engine reported no workspace");
  const stamp = Date.now().toString(36);
  const ids = [`sxdemo-${stamp}-a`, `sxdemo-${stamp}-b`];
  const SECRET = "sk-demoDEMOdemo1234567890abcdefXYZ";
  const seedDir = join(ROOT, "sxdemo-seed");
  mkdirSync(seedDir, { recursive: true });
  const ln = (o) => JSON.stringify(o);
  const seed = (id, title, said) => [
    ln({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: ws }),
    ln({ type: "message", message: { role: "user", content: [{ type: "text", text: title }], timestamp: Date.now() } }),
    ln({ type: "message", message: { role: "assistant", provider: "anthropic", model: "claude-demo", usage: { input: 1, output: 1 }, content: [{ type: "text", text: said }], timestamp: Date.now() } }),
  ].join("\n");
  const seeded = [join(seedDir, `${ids[0]}.jsonl`), join(seedDir, `${ids[1]}.jsonl`)];
  writeFileSync(seeded[0], seed(ids[0], `SX demo alpha ${stamp}`, `Notes are in ${HOME}\\notes.txt and api_key=${SECRET}`));
  writeFileSync(seeded[1], seed(ids[1], `SX demo beta ${stamp}`, "Second session reply."));
  const dl = mkdtempSync(join(tmpdir(), "lucid-sxdemo-dl-"));
  const cdp = await page.target().createCDPSession();
  const results = {};
  try {
    // 0. clear first-run gates a fresh QA profile shows, with their own skip controls
    for (let i = 0; i < 10; i++) {
      const skip = await page.$("#roleGateSkip, #emailGateSkip, #govGate [data-gov=no], #provChoice [data-prov=later], .coach-card [data-coach-skip]");
      if (!skip) { await new Promise((r) => setTimeout(r, 500)); continue; }
      await skip.click().catch(() => {});
      await new Promise((r) => setTimeout(r, 400));
    }

    // 1. seeded sessions are listed
    await repaint();
    await until(async () => (await listed(ids)).every(Boolean), "the seeded sessions never appeared in the Sessions list");

    // 2. History button, menu, export dialog
    await clickReal("#sessHistory", "History button");
    await until(() => page.$(".popover.sx-pop.show"), "the History menu did not open", 5000);
    await topmost(['.popover.sx-pop [data-sx="export"]', '.popover.sx-pop [data-sx="import"]'], "History menu");
    await clickReal('.popover.sx-pop [data-sx="export"]', "Export history...");
    await until(() => page.$("#sxExport .modal"), "the export dialog did not open", 8000);
    await topmost(["#sxExport [data-sx-scope]", "#sxExport [data-sx-marking]", "#sxExport [data-sx-images]", "#sxExport [data-sx-act='export']", "#sxExport [data-sx-act='cancel']"], "export dialog");
    await audit("#sxExport .modal");
    assert(!(await page.$eval("#sxExport [data-sx-images]", (n) => n.checked)), "Include images must be off by default");
    await clickReal("#sxExport [data-sx-marking]", "Marking field");
    await page.keyboard.type("UNCLASSIFIED//DEMO");

    // 3. export: the download is the file
    await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dl }).catch(() => cdp.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: dl }));
    await clickReal("#sxExport [data-sx-act='export']", "Export");
    const name = await until(() => readdirSync(dl).find((n) => n.endsWith(".lucidhistory.json")), "no .lucidhistory.json was downloaded", 30_000);
    const filePath = join(dl, name);
    const text = await until(() => { try { const t = readFileSync(filePath, "utf8"); return t.endsWith("\n") ? t : null; } catch { return null; } }, "the download never completed", 10_000);
    assert(/^[\x20-\x7e\n]*$/.test(text), "the exported file holds bytes other than printable ASCII and LF");
    const file = JSON.parse(text);
    assert(file.format === "lucid-history/1", `format is ${file.format}`);
    assert(file.manifest.marking === "UNCLASSIFIED//DEMO", `marking is ${JSON.stringify(file.manifest.marking)}`);
    assert(file.manifest.include_images === false, "images were included");
    for (const id of ids) assert(file.sessions.some((s) => s.id === id), `${id} is not in the exported file`);
    const low = text.toLowerCase();
    for (const v of [HOME, HOME.replace(/\\/g, "/"), HOME.replace(/\\/g, "\\\\")]) assert(!low.includes(v.toLowerCase()), `the exported file holds the home path (${v})`);
    assert(!text.includes(SECRET), "the exported file holds the key-shaped value");
    assert(!(await page.$("#sxExport")), "the export dialog stayed open after the download");
    results.export = { file: name, bytes: text.length, sessions: file.manifest.session_count, payloadSha256: file.manifest.payload_sha256 };

    // 4. wipe
    for (const p of seeded) rmSync(p, { force: true });
    await repaint();
    await until(async () => (await listed(ids)).every((x) => x === null), "the wiped sessions are still listed");

    // 5. import through the real file chooser
    const importOnce = async () => {
      await dismissToasts();
      await clickReal("#sessHistory", "History button");
      await until(() => page.$(".popover.sx-pop.show"), "the History menu did not open", 5000);
      const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 10_000 }), clickReal('.popover.sx-pop [data-sx="import"]', "Import history...")]);
      await chooser.accept([filePath]);
      await until(() => page.$("#sxImport .modal"), "the import result dialog did not open", 30_000);
      const counts = await page.$eval("#sxImport [data-sx-counts]", (n) => n.textContent ?? "");
      await topmost(["#sxImport [data-sx-act='ok']"], "import result");
      await audit("#sxImport .modal");
      await clickReal("#sxImport [data-sx-act='ok']", "OK");
      return counts;
    };
    const first = await importOnce();
    assert(/^2 imported \u00b7 0 already here \u00b7 0 id conflicts \u00b7 0 quarantined$/.test(first), `first import said "${first}"`);
    await repaint();
    const back = await until(async () => { const l = await listed(ids); return l.every(Boolean) ? l : null; }, "the imported sessions did not reappear", 25_000);
    assert(back.every((x) => x.imported), `an imported session is not labeled imported: ${JSON.stringify(back)}`);
    results.import = { counts: first, listed: back };

    // 6. idempotent
    const second = await importOnce();
    assert(/^0 imported \u00b7 2 already here \u00b7 0 id conflicts \u00b7 0 quarantined$/.test(second), `second import said "${second}"`);
    results.reimport = second;
  } finally {
    for (const p of seeded) rmSync(p, { force: true });
    rmSync(seedDir, { recursive: true, force: true });
    if (existsSync(ROOT)) {
      for (const d of readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isDirectory())) {
        for (const f of readdirSync(join(ROOT, d.name)).filter((n) => ids.some((id) => n.endsWith(`_${id}.jsonl`)))) rmSync(join(ROOT, d.name, f), { force: true });
      }
    }
    rmSync(dl, { recursive: true, force: true });
    await cdp.detach().catch(() => {});
  }
  return results;
}

if (import.meta.main || (typeof process !== "undefined" && process.argv[1]?.endsWith("demo_p_sessxfer_1.mjs"))) {
  const endpoint = process.env.LUCID_DEMO_CDP_URL;
  const browserURL = process.env.LUCID_DEMO_BROWSER_URL;
  const url = process.env.LUCID_DEMO_URL;
  if ((!endpoint && !browserURL) || !url) throw new Error("Set LUCID_DEMO_CDP_URL (or LUCID_DEMO_BROWSER_URL) and LUCID_DEMO_URL to an isolated QA engine.");
  assert(new URL(url).hostname === "127.0.0.1", "LUCID_DEMO_URL must be an isolated QA engine on 127.0.0.1");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ ...(endpoint ? { browserWSEndpoint: endpoint } : { browserURL }), defaultViewport: null, protocolTimeout: 180_000 });
  try {
    const page = (await browser.pages()).find((p) => p.url().startsWith(url)) ?? (await browser.newPage());
    await page.setViewport({ width: 1400, height: 900 });
    if (!page.url().startsWith(url)) await page.goto(url, { waitUntil: "domcontentloaded" });
    console.log(JSON.stringify(await verifySessionTransfer(page, url), null, 2));
    console.log("P-SESSXFER.1 passed: Export history downloads one ASCII-only lucid-history/1 file with the marking, both sessions, no home path and no key; after a wipe, Import history through the file chooser brings both back labeled imported, and a second import skips them.");
  } finally { await browser.disconnect(); }
}
