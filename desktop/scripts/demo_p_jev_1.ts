// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-JEV.1 (ADR-0374) - Jev / TypeSafe judgment backend in Settings. Proves, against the REAL
// modules and the PINNED omp package, that:
//   (1) the TypeSafe key provider is registered key-only under the env name omp's own auth rule reads, and the
//       mode values LUCID offers are exactly the ones omp's settings schema accepts;
//   (2) TypeSafe is excluded from every chat-model provider surface (hub open section + configured count);
//   (3) the stored choice round-trips through the settings store, and the lockdown clamp pins `llm`;
//   (4) the omp argv every child gets carries the LUCID overlay AFTER the isolation overlay, and the overlay's
//       bytes follow the LIVE lock state: lockdown on -> llm even with `typesafe` saved; lock off -> typesafe.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GATEWAY, MAJORS, OTHERS } from "../auth_status.ts";
import { buildHubSections, configuredProviderCount } from "../renderer/provider_hub.ts";
import { judgmentOverlayFile, judgmentProvider, setAsksage, setJudgmentProvider } from "../settings_store.ts";
import { resolveJudgmentProvider } from "../judgment_policy.ts";
import { fleetLaneArgv } from "../acp_backend.ts";
import type { AuthStatus, ProviderAuth } from "../renderer/bridge.ts";

// The store resolves LUCID_GUI_SETTINGS_FILE per call (P-TEST.W1 seam), so setting it after the static
// imports still isolates every read/write below from this machine's real settings.
const dir = mkdtempSync(join(tmpdir(), "lucid-jev-demo-"));
process.env.LUCID_GUI_SETTINGS_FILE = join(dir, "lucid-gui.json");

const REPO = join(import.meta.dir, "..", ".."); // the omp packages are pinned at the repo root
let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}`);
  if (!ok) failures++;
}

try {
  console.log("== P-JEV.1 - Jev / TypeSafe judgment backend ==");

  // (1) registration matches the pinned omp's contract, read from the package itself.
  const ts = OTHERS.find((p) => p.id === "typesafe");
  check("typesafe registered key-only (no dead OAuth button)", !!ts && ts.canOauth === false && ts.oauthId === "");
  const kdl = readFileSync(join(REPO, "node_modules", "@oh-my-pi", "pi-catalog", "src", "compat", "rules", "auth", "typesafe.kdl"), "utf8");
  check("key env is the one omp's auth rule reads (TYPESAFE_API_KEY)", ts?.env === "TYPESAFE_API_KEY" && kdl.includes(`env "${ts?.env}"`));
  const schema = readFileSync(join(REPO, "node_modules", "@oh-my-pi", "pi-coding-agent", "src", "config", "settings-schema.ts"), "utf8");
  const enumLine = schema.split("\n").find((l) => l.includes('"auto", "typesafe", "llm"'));
  check("omp's settings schema accepts exactly auto | typesafe | llm", !!enumLine);
  check("omp's schema has a providers.judgmentProvider path", schema.includes("judgmentProvider"));

  // (2) never a chat-model provider.
  const auth: AuthStatus = {
    gateway: GATEWAY.map((p): ProviderAuth => ({ ...p, oauthActive: false, keySet: false })),
    majors: MAJORS.map((p): ProviderAuth => ({ ...p, oauthActive: false, keySet: false })),
    others: OTHERS.map((p): ProviderAuth => ({ ...p, oauthActive: false, keySet: p.id === "typesafe" })),
  };
  const open = buildHubSections(auth, { thirdPartyAck: true }).find((s) => s.key === "open")!;
  check("typesafe excluded from the hub's open-weight section", !open.providers.some((p) => p.id === "typesafe"));
  check("a saved TypeSafe key does NOT count as a configured chat provider", configuredProviderCount(auth) === 0);

  // (3) store round-trip + clamp.
  check("default stored choice is auto", judgmentProvider() === "auto");
  setJudgmentProvider("typesafe");
  check("stored choice round-trips (typesafe)", judgmentProvider() === "typesafe");
  setJudgmentProvider("bogus");
  check("an unknown value stores as auto, never typesafe", judgmentProvider() === "auto");
  setJudgmentProvider("typesafe");
  check("lockdown clamps typesafe -> llm and says so", (() => { const r = resolveJudgmentProvider(judgmentProvider(), true); return r.effective === "llm" && r.clamped && r.locked; })());

  // (4) the argv + overlay bytes follow the LIVE lock state.
  setAsksage({ only: true });
  const lockedArgs = fleetLaneArgv().args;
  const overlay = judgmentOverlayFile();
  const cfgIdx = lockedArgs.reduce<number[]>((acc, a, i) => (a === "--config" ? [...acc, i] : acc), []);
  check("argv carries the LUCID overlay as the LAST --config (deep-merges over the isolation overlay)", cfgIdx.length >= 1 && lockedArgs[cfgIdx[cfgIdx.length - 1]! + 1] === overlay);
  check("lockdown ON + typesafe saved -> overlay pins llm", readFileSync(overlay, "utf8").includes("judgmentProvider: llm"));
  setAsksage({ only: false });
  fleetLaneArgv();
  check("lockdown OFF -> overlay restores the saved typesafe choice", readFileSync(overlay, "utf8").includes("judgmentProvider: typesafe"));
  check("overlay lives beside the settings file (isolation seam covers it)", overlay.startsWith(dir));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
