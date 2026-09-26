// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// The Provider Hub grouping + the data-sovereignty gate (provider_hub.ts). The load-bearing property: the
// open-weight / non-U.S. section stays LOCKED with NO providers emitted until the user types ACKNOWLEDGE, so a
// China-origin provider never renders before opt-in. Frontier + gov gateway are always shown.

import { describe, expect, it } from "bun:test";
import type { AuthStatus, ProviderAuth } from "./bridge.ts";
import { buildHubSections, configuredProviderCount, providerConfigured } from "./provider_hub.ts";

function prov(id: string, over: Partial<ProviderAuth> = {}): ProviderAuth {
  return { id, name: id, env: `${id.toUpperCase()}_KEY`, oauthId: "", canOauth: false, oauthActive: false, keySet: false, ...over };
}

const auth: AuthStatus = {
  gateway: [prov("asksage")],
  majors: [prov("openai", { canOauth: true, oauthActive: true }), prov("anthropic", { canOauth: true })],
  others: [prov("qwen-portal", { canOauth: true }), prov("zai"), prov("minimax"), prov("elevenlabs", { keySet: true })],
};

describe("providerConfigured", () => {
  it("is true for an active OAuth login, a saved key, or any field set", () => {
    expect(providerConfigured(prov("a", { oauthActive: true }))).toBe(true);
    expect(providerConfigured(prov("b", { keySet: true }))).toBe(true);
    expect(providerConfigured(prov("c", { fields: [{ env: "X", label: "x", set: true }] }))).toBe(true);
    expect(providerConfigured(prov("d"))).toBe(false);
    expect(providerConfigured(prov("e", { fields: [{ env: "X", label: "x", set: false }] }))).toBe(false);
  });
});

describe("buildHubSections", () => {
  it("locks the open-weight section and emits NO providers until acknowledged", () => {
    const secs = buildHubSections(auth, { thirdPartyAck: false });
    const open = secs.find((s) => s.key === "open")!;
    expect(open.locked).toBe(true);
    expect(open.providers).toEqual([]); // nothing about non-U.S. providers renders before opt-in
    // frontier + gateway are always available
    expect(secs.find((s) => s.key === "frontier")!.providers.map((p) => p.id)).toEqual(["openai", "anthropic"]);
    expect(secs.find((s) => s.key === "gateway")!.providers.map((p) => p.id)).toEqual(["asksage"]);
  });

  it("reveals the open-weight providers once acknowledged, minus the voice-only provider", () => {
    const open = buildHubSections(auth, { thirdPartyAck: true }).find((s) => s.key === "open")!;
    expect(open.locked).toBe(false);
    expect(open.providers.map((p) => p.id)).toEqual(["qwen-portal", "zai", "minimax"]); // elevenlabs excluded
  });

  it("carries per-provider configured + canOauth state through to the tiles", () => {
    const frontier = buildHubSections(auth, { thirdPartyAck: true }).find((s) => s.key === "frontier")!;
    const openai = frontier.providers.find((p) => p.id === "openai")!;
    expect(openai).toEqual({ id: "openai", name: "openai", configured: true, canOauth: true });
    expect(frontier.providers.find((p) => p.id === "anthropic")!.configured).toBe(false);
  });

  it("still returns the locked open section for an empty/None auth so its gate can render", () => {
    const secs = buildHubSections(null, { thirdPartyAck: false });
    expect(secs.map((s) => s.key)).toEqual(["open"]);
    expect(secs[0].locked).toBe(true);
  });
});

describe("configuredProviderCount", () => {
  it("counts configured chat providers across groups, excluding the voice-only provider", () => {
    // openai (oauth) configured; anthropic not; qwen/zai/minimax not; elevenlabs (keySet) EXCLUDED.
    expect(configuredProviderCount(auth)).toBe(1);
    expect(configuredProviderCount(null)).toBe(0);
  });
});
