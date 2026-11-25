// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/fleet_demo/start_qa_fleet.mjs - an ISOLATED engine over the scripted fake agent, for QA and
// video footage. Never used by the product at runtime.
//
//   bun desktop/scripts/fleet_demo/start_qa_fleet.mjs [port]      (default port 7811)
//
// Everything lives under <tmp>/lucid-qa-fleet-<port>/ (wiped at start): a temp HOME (HOME and USERPROFILE, so
// os.homedir() moves on Windows too), the engine data root, the omp shim, and a sample git workspace the lanes
// and the main chat work in. Every LUCID_*, PI_*, OMP_* and FAKE_* variable of the caller is dropped; only the
// ones set here reach the engine. LUCID_OMP_BIN names a shim (bun's omp.exe launcher on Windows, a bun shebang
// script on POSIX; see demo_fake_omp.ts) that runs harness/mcp/testing/fake_acp_agent.ts in FAKE_ACP_MODE=script
// over the JSON scripts beside this file. Ctrl+C stops every lane and the engine.

import { mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildFakeOmp } from "../demo_fake_omp.ts";

if (typeof Bun === "undefined") {
  console.error("Run this with bun: bun desktop/scripts/fleet_demo/start_qa_fleet.mjs [port]");
  process.exit(2);
}

const REPO = join(import.meta.dir, "..", "..", "..");
const SCRIPT_DIR = join(import.meta.dir, "scripts");
const port = Number(process.argv[2] ?? 7811);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error(`Bad port ${process.argv[2]}: give a number from 1024 to 65535.`);
  process.exit(2);
}

const ROOT = join(tmpdir(), `lucid-qa-fleet-${port}`);
try { rmSync(ROOT, { recursive: true, force: true }); }
catch (e) {
  console.error(`Could not clear ${ROOT}. Is a previous QA engine on port ${port} still running? (${e.message})`);
  process.exit(1);
}
const HOME = join(ROOT, "home");
const DATA = join(ROOT, "data");
const WS = join(ROOT, "workspace", "sample-platform");
const SETTINGS = join(HOME, ".omp", "lucid-gui.json");
for (const d of [join(HOME, ".omp"), DATA, WS]) mkdirSync(d, { recursive: true });

// ── the sample workspace ────────────────────────────────────────────────────────────────────────────────

const SAMPLE = {
  "README.md": "# sample-platform\n\nA small multi-service platform used for QA footage: an HTTP API, an admin console, a checkout service and a few mini games.\n\n- `bun test` runs the suite\n- `bun run scan:sast`, `scan:deps`, `scan:secrets` are the security gates\n",
  "SECURITY.md": "# Security policy\n\nReport vulnerabilities to the security team. Every merge passes SAST, dependency and secret scans.\n",
  "CHANGELOG.md": "# Changelog\n\nAll notable changes to this project are documented here. Format: Keep a Changelog. Versioning: SemVer.\n\n## [2.3.0] - 2026-10-14\n### Added\n- Admin user list export.\n### Fixed\n- Health check timeout under load.\n",
  "package.json": `${JSON.stringify({ name: "sample-platform", version: "2.3.0", private: true, type: "module", scripts: { test: "bun test", "scan:sast": "bun tools/scan/sast.ts", "scan:deps": "bun tools/scan/deps.ts", "scan:secrets": "bun tools/scan/secrets.ts" } }, null, 2)}\n`,
  ".gitignore": "node_modules/\ndist/\nevidence/\n",
  "src/server.ts": "import { routes } from './api/routes';\n\nBun.serve({ port: Number(process.env.PORT ?? 3000), fetch: (req) => routes.handle(req) });\n",
  "src/api/routes.ts": "import { Router } from './router';\nimport { requireSession } from '../auth/session';\n\nexport const routes = new Router();\nroutes.get('/health', () => ({ ok: true }));\nroutes.use('/admin', requireSession({ role: 'admin' }));\n",
  "src/auth/session.ts": "export function createSession(userId: string): Session {\n  const id = randomUUID();\n  sessions.set(id, { userId, createdAt: Date.now() });\n  return { id, cookie: `sid=${id}; Path=/` };\n}\n",
  "src/auth/login.ts": "export async function login(req: Request): Promise<Response> {\n  const { email, password } = await req.json();\n  const user = await verifyPassword(email, password);\n  const s = req.session ?? createSession(user.id);\n  return redirect('/', { 'set-cookie': s.cookie });\n}\n",
  "src/audit/log.ts": "export interface AuditEvent { actor: string; action: string; target: string; at: string }\nconst events: AuditEvent[] = [];\nexport function audit(e: AuditEvent): void { events.push(e); console.log(JSON.stringify(e)); }\n",
  "src/files/upload.ts": "export async function upload(req: Request): Promise<Response> {\n  const form = await req.formData();\n  const file = form.get('file') as File;\n  const dest = join(UPLOAD_DIR, file.name);\n  await Bun.write(dest, file);\n  return Response.json({ url: `/files/${file.name}`, type: file.type });\n}\n",
  "src/admin/users.ts": "export async function listUsers(): Promise<AdminUser[]> { return db.users.all(); }\n",
  "tests/smoke.test.ts": "import { expect, test } from 'bun:test';\n\ntest('health', () => { expect(1 + 1).toBe(2); });\n",
  "docs/compliance/soc2-controls.md": "CC6.1 Logical access: production deploy requires an approver distinct from the author.\nCC7.1 Vulnerability monitoring: SAST, dependency and secret scans gate every merge.\nCC8.1 Change management: every production change has a reviewed PR and passing checks.\n",
  "games/README.md": "# Mini games\n\nEach game is one HTML file under games/<name>/index.html.\nRules: no external scripts, no network, no storage, must fit 480x320, pointer input only.\n",
};
for (const [rel, body] of Object.entries(SAMPLE)) {
  const p = join(WS, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
}
// The scripts' HTML deliverables (the mini game) exist on disk, so the Preview panel a write opens can render them.
for (const f of readdirSync(SCRIPT_DIR).filter((n) => n.endsWith(".json"))) {
  const steps = JSON.parse(readFileSync(join(SCRIPT_DIR, f), "utf8")).steps ?? [];
  for (const s of steps) {
    if (s.type !== "create" || !/\.html$/i.test(s.path)) continue;
    mkdirSync(dirname(join(WS, s.path)), { recursive: true });
    writeFileSync(join(WS, s.path), s.content);
  }
}
const git = (...args) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=QA Fleet", "-c", "user.email=qa-fleet@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: WS, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) { console.error(`git ${args.join(" ")} failed: ${r.stderr.toString().trim()}`); process.exit(1); }
};
git("init", "-q", "-b", "main");
git("add", "-A");
git("commit", "-q", "-m", "sample-platform 2.3.0");

// ── the engine ──────────────────────────────────────────────────────────────────────────────────────────

writeFileSync(SETTINGS, JSON.stringify({ workspace: WS }));
const shim = buildFakeOmp(join(ROOT, "shim"), REPO);
const env = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(LUCID_|PI_|OMP_|FAKE_)/i.test(k)) env[k] = v;
Object.assign(env, {
  HOME, USERPROFILE: HOME, PORT: String(port),
  LUCID_DATA_ROOT: DATA, LUCID_GUI_SETTINGS_FILE: SETTINGS, LUCID_OMP_BIN: shim,
  FAKE_ACP_MODE: "script", FAKE_ACP_SCRIPT_DIR: SCRIPT_DIR,
  // P-SPINUP.1: QA_AGENT_START_MS=<ms> slows every fake agent's handshake like a real one (spin-up UI demos).
  ...(process.env.QA_AGENT_START_MS ? { FAKE_ACP_INIT_MS: process.env.QA_AGENT_START_MS } : {}),
  // P-WORLDS.UPDATE1: QA_PLUGIN_DEV_LOOPBACK=1 lets this QA engine download a plugin package over plain http from
  // 127.0.0.1 (the install smoke switch), so demo_p_worlds_update_1.mjs can serve a newer signed world from a fake store.
  ...(process.env.QA_PLUGIN_DEV_LOOPBACK === "1" ? { LUCID_PLUGIN_DEV_LOOPBACK: "1" } : {}),
});

const OUT_LOG = join(ROOT, "engine.out.log");
const ERR_LOG = join(ROOT, "engine.err.log");
let stopping = false;
const engine = Bun.spawn([process.execPath, join(REPO, "desktop", "dev.ts")], { cwd: REPO, env, stdin: "ignore", stdout: openSync(OUT_LOG, "w"), stderr: openSync(ERR_LOG, "w") });
let exited = false;
void engine.exited.then((code) => { exited = true; if (!stopping) { console.error(`Engine exited (${code}). See ${ERR_LOG}`); process.exit(1); } });

const url = `http://127.0.0.1:${port}/`;
let token = "";
for (const deadline = Date.now() + 120_000; !token && !exited && Date.now() < deadline;) {
  try {
    const html = await (await fetch(url)).text();
    token = /<meta name="lucid-token" content="([^"]+)"/.exec(html)?.[1] ?? "";
  } catch { /* not listening yet */ }
  if (!token) await Bun.sleep(500);
}
if (!token) {
  console.error(`The engine did not serve ${url} with a token in time. See ${ERR_LOG}`);
  engine.kill();
  process.exit(1);
}
writeFileSync(join(ROOT, "fleet.json"), JSON.stringify({ url, workspace: WS, root: ROOT }, null, 2));

console.log(`QA fleet engine ready (scripted fake agent, isolated home)

  URL:        ${url}
  workspace:  ${WS}
  temp root:  ${ROOT}
  logs:       ${OUT_LOG}
              ${ERR_LOG}

Seed the fleet from another terminal:
  bun desktop/scripts/fleet_demo/seed_fleet.mjs ${url} --every 150

Ctrl+C stops every lane and the engine.`);

async function shutdown() {
  if (stopping) return;
  stopping = true;
  const headers = { "x-lucid-token": token, "content-type": "application/json" };
  try {
    const status = await (await fetch(`${url}api/fleet/status`, { headers, signal: AbortSignal.timeout(3000) })).json();
    for (const lane of status?.data?.lanes ?? []) {
      await fetch(`${url}api/fleet/stop`, { method: "POST", headers, body: JSON.stringify({ laneId: lane.id }), signal: AbortSignal.timeout(3000) }).catch(() => {});
    }
  } catch { /* the engine is already gone */ }
  engine.kill();
  await engine.exited;
  process.exit(0);
}
process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
