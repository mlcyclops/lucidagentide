// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-PROV.2 - the Provider Hub. Proves, against the REAL pure layer, that:
//   (1) the new native open-weight providers (Qwen / GLM / MiniMax) are registered with the right
//       auth method (Qwen has a real OAuth broker; GLM + MiniMax are key-only), alongside Kimi/Moonshot;
//   (2) the open-weight / non-U.S. section is LOCKED and emits NO providers until ACKNOWLEDGE is typed.

import { GATEWAY, MAJORS, OTHERS } from "../auth_status.ts";
import { buildHubSections, configuredProviderCount } from "../renderer/provider_hub.ts";
import type { AuthStatus, ProviderAuth } from "../renderer/bridge.ts";

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}`);
  if (!ok) failures++;
}

console.log("== P-PROV.2 - Provider Hub ==");

// (1) new providers registered with the correct auth method.
const byId = Object.fromEntries(OTHERS.map((p) => [p.id, p]));
check("Qwen (qwen-portal) registered with OAuth broker + key env", byId["qwen-portal"]?.canOauth === true && byId["qwen-portal"]?.env === "QWEN_PORTAL_API_KEY" && byId["qwen-portal"]?.oauthId === "qwen-portal");
check("GLM (zai) registered, key-only (no dead OAuth button)", byId["zai"]?.env === "ZAI_API_KEY" && byId["zai"]?.canOauth === false);
check("MiniMax registered, key-only", byId["minimax"]?.env === "MINIMAX_API_KEY" && byId["minimax"]?.canOauth === false);
check("Kimi (moonshot) still present", byId["moonshot"]?.env === "MOONSHOT_API_KEY");

// (2) the data-sovereignty gate: locked + empty until acknowledged; revealed after.
const auth: AuthStatus = {
  gateway: GATEWAY.map((p): ProviderAuth => ({ ...p, oauthActive: false, keySet: false })),
  majors: MAJORS.map((p): ProviderAuth => ({ ...p, oauthActive: false, keySet: false })),
  others: OTHERS.map((p): ProviderAuth => ({ ...p, oauthActive: false, keySet: false })),
};
const locked = buildHubSections(auth, { thirdPartyAck: false }).find((s) => s.key === "open")!;
check("open-weight section LOCKED before ACKNOWLEDGE", locked.locked === true);
check("open-weight section emits NO providers while locked", locked.providers.length === 0);
const unlocked = buildHubSections(auth, { thirdPartyAck: true }).find((s) => s.key === "open")!;
check("open-weight section reveals providers after ACKNOWLEDGE", unlocked.providers.length > 0);
check("Qwen/GLM/MiniMax appear in the revealed section", ["qwen-portal", "zai", "minimax"].every((id) => unlocked.providers.some((p) => p.id === id)));
check("voice-only provider (elevenlabs) excluded from the hub", !unlocked.providers.some((p) => p.id === "elevenlabs"));

// a configured provider is counted (drives the onboarding nudge)
const withKey: AuthStatus = { ...auth, majors: auth.majors.map((p) => (p.id === "anthropic" ? { ...p, keySet: true } : p)) };
check("configuredProviderCount reflects a saved key", configuredProviderCount(withKey) === 1);

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
