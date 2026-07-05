// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_ptheme1.ts
//
// P-THEME.1 (ADR-0160): the LUCID skin for gated terminal sessions. Proves, without a live model:
// (1) themes/lucid.json is a valid omp theme whose every color resolves (vars → hex/index/default);
// (2) the extension's session_start handler provisions the theme into the custom-themes dir
//     (idempotently — second run writes nothing) and applies it via ctx.ui.setTheme("lucid");
// (3) the skin is FAIL-OPEN: a rejecting setTheme / LUCID_THEME=off degrade to "not applied",
//     never a throw — and it NEVER weakens fail-closed: a dead scanner still means zero spawns;
// (4) `lucid tui` carries the theme `-e` AFTER the mandatory gate `-e`, policy + passthru unmoved.
//
// Run: bun run harness/scripts/demo_ptheme1.ts

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assets, buildTuiArgs, runTui, type SpawnFn } from "../launcher/lucid_acp.ts";
import { applyLucidTheme, provisionTheme, THEME_SOURCE } from "../omp/lucid_theme_extension.ts";
import lucidThemeExtension from "../omp/lucid_theme_extension.ts";

const fail: (m: string) => never = (m) => {
  console.error(`FAIL: ${m}`);
  process.exit(1);
};
const ok = (m: string): void => console.log(`   ok — ${m}`);

console.log("1) themes/lucid.json — every token resolves to a paintable color");
const themeJson = readFileSync(THEME_SOURCE, "utf8");
const theme = JSON.parse(themeJson) as { name: string; vars: Record<string, string>; colors: Record<string, string | number> };
{
  if (theme.name !== "lucid") fail(`theme name must be "lucid", got ${theme.name}`);
  const paintable = (v: string | number): boolean =>
    v === "" || typeof v === "number" || /^#[0-9a-fA-F]{6}$/.test(v) || /^#[0-9a-fA-F]{6}$/.test(theme.vars[v] ?? "");
  const bad = Object.entries(theme.colors).filter(([, v]) => !paintable(v));
  if (bad.length) fail(`unresolvable color tokens: ${bad.map(([k]) => k).join(", ")}`);
  ok(`${Object.keys(theme.colors).length} tokens, ${Object.keys(theme.vars).length} vars, all resolve`);
}

console.log("2) session_start — provisions the theme (idempotent) and applies it");
{
  const dir = mkdtempSync(join(tmpdir(), "lucid-theme-demo-"));
  try {
    const setThemeCalls: string[] = [];
    type Handler = (e: unknown, ctx: { ui: { setTheme: (n: string) => Promise<{ success: boolean }> } }) => Promise<void>;
    let captured: { event: string; handler: Handler } | undefined;
    const pi = {
      on: (event: string, handler: Handler) => (captured = { event, handler }),
      logger: { debug: () => {} },
    };
    (lucidThemeExtension as unknown as (p: typeof pi) => void)(pi);
    const reg = captured;
    if (!reg || reg.event !== "session_start") fail("extension must register a session_start handler");
    const prev = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      await reg.handler(undefined, { ui: { setTheme: async (name) => (setThemeCalls.push(name), { success: true }) } });
    } finally {
      if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prev;
    }
    if (setThemeCalls.join() !== "lucid") fail(`expected one setTheme("lucid"), got [${setThemeCalls}]`);
    if (readFileSync(join(dir, "themes", "lucid.json"), "utf8") !== themeJson) fail("provisioned bytes must match the bundled asset");
    if (provisionTheme(join(dir, "themes"), themeJson) !== "unchanged") fail("second provision must be a no-op (idempotence)");
    ok(`provisioned ${join("<tmp>", "themes", "lucid.json")} + setTheme("lucid"); re-provision → unchanged`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("3) FAIL-OPEN (cosmetic) — but fail-closed (security) is untouched");
{
  const dir = mkdtempSync(join(tmpdir(), "lucid-theme-demo-"));
  try {
    const r = await applyLucidTheme({ dir, setTheme: async () => Promise.reject(new Error("UI exploded")) });
    if (r.applied !== false) fail("a rejecting setTheme must degrade to applied:false");
    const off = await applyLucidTheme({ dir, env: { LUCID_THEME: "off" }, setTheme: async () => fail("setTheme must not be called when disabled") });
    if (off.applied !== false) fail("LUCID_THEME=off must disable the skin");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const spawns: string[] = [];
  const spawnFn: SpawnFn = (cmd) => (spawns.push(cmd), { on: (ev, cb) => void (ev === "exit" && setImmediate(() => cb(0))) });
  const code = await runTui({ scannerProbe: async () => ({ ok: false, reason: "dead" }), spawnFn, stderr: () => {} });
  if (code !== 1 || spawns.length !== 0) fail("dead scanner must still mean exit 1 + zero spawns, skin or no skin");
  ok("setTheme rejection → not applied (no throw); LUCID_THEME=off honored; dead scanner → 0 spawns");
}

console.log("4) lucid tui argv — the skin -e rides BEHIND the mandatory gate -e");
{
  const a = assets("/repo");
  const args = buildTuiArgs({ gate: a.gate, mcpResultGate: a.mcpResultGate, asksage: a.asksage, lucidTheme: a.lucidTheme, passthru: ["-p", "hi"] });
  if (args[0] !== "-e" || args[1] !== a.gate) fail("the security gate must remain the FIRST -e");
  const themeIdx = args.indexOf(a.lucidTheme);
  if (themeIdx < 0 || args[themeIdx - 1] !== "-e") fail("the theme extension must be passed as -e");
  if (themeIdx < args.indexOf(a.gate)) fail("the theme -e must come after the gate -e");
  if (args.indexOf("--append-system-prompt") < themeIdx) fail("policy must follow the -e block");
  if (args.slice(-2).join(" ") !== "-p hi") fail("passthru must stay last");
  ok("-e gate … -e lucid_theme_extension.ts --append-system-prompt <policy> -p hi");
}

console.log("\npalette (truecolor swatches):");
{
  const swatch = (label: string, token: string): string => {
    const raw = theme.colors[token];
    const hex = typeof raw === "string" && raw.startsWith("#") ? raw : theme.vars[raw as string];
    if (!hex) return `  ${label}: (terminal default)`;
    const [r, g, b] = [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)].map((h) => parseInt(h, 16));
    return `  \x1b[48;2;${r};${g};${b}m      \x1b[0m ${label} ${hex}`;
  };
  for (const [label, token] of [
    ["accent  ", "accent"], ["heading ", "mdHeading"], ["link    ", "mdLink"],
    ["success ", "success"], ["warning ", "warning"], ["error   ", "error"],
    ["selected", "selectedBg"], ["status  ", "statusLineBg"],
  ] as const) console.log(swatch(label, token));
}

console.log("\ndemo_ptheme1 OK — gated terminals wear the LUCID skin; bare omp and fail-closed are untouched.");
process.exit(0);
