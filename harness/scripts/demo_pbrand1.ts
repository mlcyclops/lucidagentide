// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_pbrand1.ts
//
// P-BRAND.1 (issue #314): the LUCID TUI welcome branding. Proves, without a live model:
// (1) harness/omp/lucid_tui.config.yml is a nested `startup.quiet: true` overlay — the supported knob
//     that suppresses omp's own welcome box (the block-Π logo + the "omp v…" title);
// (2) renderWelcomeLines names LUCID and NEVER omp, and carries the LUCID version + model when known;
// (3) FAIL-OPEN: LUCID_WELCOME=off disables the welcome, a throwing setWidget degrades to "not applied"
//     (never throws), and fail-CLOSED is untouched (a dead scanner still => exit 1, zero omp spawns);
// (4) `lucid tui` argv: the welcome `-e` rides AFTER the mandatory gate `-e` and the theme `-e`, with the
//     `--config` suppression overlay present; policy + passthru unmoved.
//
// Run: bun run harness/scripts/demo_pbrand1.ts

import { readFileSync } from "node:fs";
import { assets, buildTuiArgs, runTui, type SpawnFn } from "../launcher/lucid_acp.ts";
import {
  applyWelcome,
  lucidVersion,
  renderWelcomeLines,
  WELCOME_ENV,
  welcomeEnabled,
  type WelcomePaint,
} from "../omp/lucid_welcome_extension.ts";

const fail: (m: string) => never = (m) => {
  console.error(`   FAIL — ${m}`);
  process.exit(1);
};
const ok = (m: string): void => console.log(`   ok — ${m}`);
const IDENTITY: WelcomePaint = { accent: (s) => s, muted: (s) => s, bold: (s) => s };

console.log("1) lucid_tui.config.yml — a nested startup.quiet:true overlay suppresses omp's welcome box");
{
  const yml = readFileSync(assets().lucidTuiConfig, "utf8");
  if (!/^startup:\s*$/m.test(yml) || !/^\s+quiet:\s*true\s*$/m.test(yml)) {
    fail("overlay must set startup.quiet: true (nested — omp resolves the key as ['startup','quiet'])");
  }
  ok("startup.quiet: true present in the nested shape omp reads via --config");
}

console.log("2) renderWelcomeLines — names LUCID, never omp; carries version + model");
{
  const brand = renderWelcomeLines({ paint: IDENTITY, version: "1.2.3" }).join("\n");
  if (!brand.includes("LUCID")) fail("banner must name LUCID");
  if (/omp/i.test(brand)) fail("banner must NOT mention omp");
  if (!brand.includes("LUCID v1.2.3")) fail("banner must carry the LUCID version");
  const withModel = renderWelcomeLines({ paint: IDENTITY, version: "1.2.3", model: "Claude Opus 4.8" }).join("\n");
  if (!withModel.includes("Claude Opus 4.8")) fail("banner must carry the model when known");
  ok("LUCID present, omp absent, version + model carried");
}

console.log("3) FAIL-OPEN cosmetics — but fail-CLOSED security is untouched");
{
  if (!welcomeEnabled({})) fail("default (unset) must enable the welcome");
  if (welcomeEnabled({ [WELCOME_ENV]: "off" })) fail("LUCID_WELCOME=off must disable");
  const thrown = applyWelcome({
    hasUI: true,
    paint: IDENTITY,
    setWidget: () => {
      throw new Error("boom");
    },
  });
  if (thrown.applied) fail("a throwing setWidget must degrade to not-applied");
  const disabled = applyWelcome({
    hasUI: true,
    env: { [WELCOME_ENV]: "off" },
    paint: IDENTITY,
    setWidget: () => fail("disabled must not paint"),
  });
  if (disabled.applied) fail("LUCID_WELCOME=off must not paint");
  // fail-closed: a dead scanner still means exit 1 and ZERO omp spawns — welcome or no welcome.
  const spawns: string[][] = [];
  const spy: SpawnFn = (_cmd, args) => {
    spawns.push(args);
    return {
      on(ev, cb) {
        if (ev === "exit") queueMicrotask(() => cb(0));
      },
    };
  };
  const code = await runTui({
    scannerProbe: async () => ({ ok: false, reason: "dead" }),
    spawnFn: spy,
    env: {},
    proxyStart: async () => null,
    stderr: () => {},
  });
  if (code !== 1 || spawns.length !== 0) fail("dead scanner must still mean exit 1 + zero spawns");
  ok("throwing setWidget → not applied (no throw); LUCID_WELCOME=off disables; dead scanner → 0 spawns");
}

console.log("4) lucid tui argv — the welcome -e rides BEHIND the gate + theme -e, with --config suppression");
{
  const a = assets("/repo");
  const args = buildTuiArgs({
    gate: a.gate,
    mcpResultGate: a.mcpResultGate,
    asksage: a.asksage,
    lucidTheme: a.lucidTheme,
    lucidWelcome: a.lucidWelcome,
    quietConfig: a.lucidTuiConfig,
    passthru: ["-p", "hi"],
  });
  if (args[0] !== "-e" || args[1] !== a.gate) fail("the security gate must be the first -e");
  const iTheme = args.indexOf(a.lucidTheme);
  const iWelcome = args.indexOf(a.lucidWelcome);
  if (!(iTheme > 0 && iWelcome > iTheme)) fail("the welcome -e must ride AFTER the theme -e (and the gate)");
  const iCfg = args.indexOf("--config");
  if (iCfg < 0 || args[iCfg + 1] !== a.lucidTuiConfig) fail("--config <startup.quiet overlay> must be present");
  if (!args.includes("--append-system-prompt")) fail("the appended policy must be intact");
  if (args[args.length - 2] !== "-p" || args[args.length - 1] !== "hi") fail("user passthru must stay last");
  ok("gate → theme → welcome; --config quiet overlay present; policy + passthru intact");
}

console.log("\nLUCID welcome preview (identity paint):\n");
console.log(renderWelcomeLines({ version: lucidVersion(), model: "Claude Opus 4.8" }).join("\n"));

console.log(
  "\ndemo_pbrand1 OK — the gated TUI wears the LUCID welcome; omp branding is gone; bare omp + fail-closed untouched.",
);
process.exit(0);
