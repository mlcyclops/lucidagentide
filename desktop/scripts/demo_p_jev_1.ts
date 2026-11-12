// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-JEV.1 (ADR-0374) - Jev / TypeSafe judgment backend in Settings. Proves, against the REAL
// modules and the PINNED omp package, that:
//   (1) the TypeSafe key provider is registered key-only under the env name omp's own auth rule reads, and the
//       mode values LUCID offers are exactly the ones omp's settings schema accepts;
//   (2) TypeSafe is excluded from every chat-model provider surface (hub open section + configured count);
//   (3) the stored choice round-trips through the settings store (default none, P-JEV.5), and the lockdown
//       clamp pins `llm`;
//   (4) the omp argv every child gets carries the LUCID overlay AFTER the isolation overlay, and the overlay's
//       bytes (the judge MODEL ROLE, ADR-0416) follow the LIVE lock state: lockdown on -> never Jev even with
//       `typesafe` saved; lock off -> Jev first; none -> no judge model.

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
  // P-JEV.5 (ADR-0416): omp 18.2.10 answers judgments through the `judge` MODEL ROLE; the old
  // providers.judgmentProvider key is legacy there (migrated into that role), so LUCID writes the role.
  const settingsSrc = readFileSync(join(REPO, "node_modules", "@oh-my-pi", "pi-coding-agent", "src", "config", "settings.ts"), "utf8");
  check("omp migrates the legacy providers.judgmentProvider into the judge role (the key LUCID no longer writes)", settingsSrc.includes('"judgmentProvider", "providers.judgmentProvider"') && settingsSrc.includes('setRoleChain("judge"'));
  const judgeSrc = readFileSync(join(REPO, "node_modules", "@oh-my-pi", "pi-coding-agent", "src", "judgment", "index.ts"), "utf8");
  check("omp resolves the judge through resolveRoleChain(\"judge\", ...) and rethrows a timeout (no fallback past it)", judgeSrc.includes('resolveRoleChain("judge"') && judgeSrc.includes("if (isAbortOrTimeout(error)) throw error;"));

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
  check("default stored choice is none (P-JEV.5: judging is opt-in)", judgmentProvider() === "none");
  setJudgmentProvider("typesafe");
  check("stored choice round-trips (typesafe)", judgmentProvider() === "typesafe");
  setJudgmentProvider("bogus");
  check("an unknown value stores as none, never typesafe", judgmentProvider() === "none");
  setJudgmentProvider("typesafe");
  check("lockdown clamps typesafe -> llm and says so", (() => { const r = resolveJudgmentProvider(judgmentProvider(), true); return r.effective === "llm" && r.clamped && r.locked; })());

  // (4) the argv + overlay bytes follow the LIVE lock state.
  setAsksage({ only: true });
  const lockedArgs = fleetLaneArgv().args;
  const overlay = judgmentOverlayFile();
  const cfgIdx = lockedArgs.reduce<number[]>((acc, a, i) => (a === "--config" ? [...acc, i] : acc), []);
  check("argv carries the LUCID overlay as the LAST --config (deep-merges over the isolation overlay)", cfgIdx.length >= 1 && lockedArgs[cfgIdx[cfgIdx.length - 1]! + 1] === overlay);
  const lockedOverlay = readFileSync(overlay, "utf8");
  check("lockdown ON + typesafe saved -> the judge role never names Jev", !lockedOverlay.includes("typesafe/jev-latest") && lockedOverlay.includes("modelRoles:") && !lockedOverlay.includes("judgmentProvider"));
  setAsksage({ only: false });
  fleetLaneArgv();
  check("lockdown OFF -> the judge role is Jev first again", readFileSync(overlay, "utf8").includes('judge: "typesafe/jev-latest"'));
  setJudgmentProvider("none");
  fleetLaneArgv();
  const noneOverlay = readFileSync(overlay, "utf8");
  check("none -> a judge selector nothing matches and an empty fallback chain (omp's @tiny default cannot pick a local model)", noneOverlay.includes('judge: "lucid-none/none"') && noneOverlay.includes("judge: []"));
  check("overlay lives beside the settings file (isolation seam covers it)", overlay.startsWith(dir));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
