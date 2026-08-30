// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import {
  AGENT_FLAVOR, CREATOR_FLAVOR, buildInfoView, flavorInfo, normalizeBuildFlavor, normalizeUiMode,
  resolveBuildFlavor, uiModePosture,
} from "./build_flavor.ts";

describe("build flavor identity (CREATOR-0, ADR-0279)", () => {
  test("the two flavors never share an identity that would collide side by side", () => {
    expect(AGENT_FLAVOR.appId).not.toBe(CREATOR_FLAVOR.appId);
    expect(AGENT_FLAVOR.productName).not.toBe(CREATOR_FLAVOR.productName);
    expect(AGENT_FLAVOR.artifactStem).not.toBe(CREATOR_FLAVOR.artifactStem);
    expect(AGENT_FLAVOR.defaultPort).not.toBe(CREATOR_FLAVOR.defaultPort);
    expect(AGENT_FLAVOR.defaultRelayPort).not.toBe(CREATOR_FLAVOR.defaultRelayPort);
    expect(AGENT_FLAVOR.defaultWhisperPort).not.toBe(CREATOR_FLAVOR.defaultWhisperPort);
    expect(AGENT_FLAVOR.authProtocol).not.toBe(CREATOR_FLAVOR.authProtocol);
  });

  test("the standard build keeps its shipped values (a Creator change must never move them)", () => {
    expect(AGENT_FLAVOR.appId).toBe("com.lucidagentide.desktop");
    expect(AGENT_FLAVOR.productName).toBe("LucidAgentIDE");
    expect(AGENT_FLAVOR.defaultPort).toBe(5319);
    expect(AGENT_FLAVOR.defaultRelayPort).toBe(8790);
    expect(AGENT_FLAVOR.defaultWhisperPort).toBe(9111);
    expect(AGENT_FLAVOR.authProtocol).toBe("lucid");
    expect(AGENT_FLAVOR.creatorBuild).toBe(false);
  });

  test("Creator runs on 5320 and claims its own scheme, never lucid://", () => {
    expect(CREATOR_FLAVOR.defaultPort).toBe(5320);
    expect(CREATOR_FLAVOR.authProtocol).toBe("lucid-creator");
    expect(CREATOR_FLAVOR.creatorBuild).toBe(true);
  });

  test("only the Creator flavor carries Creator features", () => {
    for (const on of Object.values(CREATOR_FLAVOR.features)) expect(on).toBe(true);
    for (const off of Object.values(AGENT_FLAVOR.features)) expect(off).toBe(false);
  });
});

describe("flavor resolution", () => {
  test("anything unrecognized is the STANDARD build (a typo can never unlock Creator)", () => {
    for (const raw of ["", "  ", "Creatorr", "creater", "nonsense", null, undefined, 7, {}]) {
      expect(normalizeBuildFlavor(raw)).toBe("agent");
    }
    expect(normalizeBuildFlavor("Creator")).toBe("creator");
    expect(normalizeBuildFlavor(" creator ")).toBe("creator");
  });

  test("env wins, then packaged metadata, then standard", () => {
    expect(resolveBuildFlavor({ LUCID_BUILD_FLAVOR: "creator" })).toBe("creator");
    expect(resolveBuildFlavor({}, "creator")).toBe("creator");
    expect(resolveBuildFlavor({ LUCID_BUILD_FLAVOR: "agent" }, "creator")).toBe("agent");
    expect(resolveBuildFlavor({})).toBe("agent");
    expect(resolveBuildFlavor(null, null)).toBe("agent");
  });

  test("flavorInfo round-trips the constants", () => {
    expect(flavorInfo("creator")).toBe(CREATOR_FLAVOR);
    expect(flavorInfo("agent")).toBe(AGENT_FLAVOR);
  });
});

describe("UI mode gating + posture", () => {
  test("creator is accepted only in a Creator build; a standard build folds it to agent", () => {
    expect(normalizeUiMode("creator", true)).toBe("creator");
    expect(normalizeUiMode("creator", false)).toBe("agent");
    expect(normalizeUiMode("CREATOR", true)).toBe("creator");
  });

  test("ask and plan are unchanged in both builds, and garbage is agent", () => {
    for (const creatorBuild of [true, false]) {
      expect(normalizeUiMode("ask", creatorBuild)).toBe("ask");
      expect(normalizeUiMode("plan", creatorBuild)).toBe("plan");
      expect(normalizeUiMode("bogus", creatorBuild)).toBe("agent");
      expect(normalizeUiMode(undefined, creatorBuild)).toBe("agent");
    }
  });

  test("Creator posture is byte-identical to Agent - it is a workspace, never a permission change", () => {
    expect(uiModePosture("creator")).toEqual(uiModePosture("agent"));
    expect(uiModePosture("creator")).toEqual({ ompMode: "default", permissionMode: "auto" });
  });

  test("ask still forwards every tool permission and plan is still read-only", () => {
    expect(uiModePosture("ask")).toEqual({ ompMode: "default", permissionMode: "ask" });
    expect(uiModePosture("plan")).toEqual({ ompMode: "plan", permissionMode: "auto" });
  });
});

describe("build-info view", () => {
  const runtime = { version: "1.14.0", port: 5320, dataRoot: "/data/LucidCreator", settingsFile: "/data/LucidCreator/lucid-gui.json", personalDir: "/data/LucidCreator/personal" };

  test("reports the running port beside the flavor default and scopes the vault", () => {
    const v = buildInfoView(CREATOR_FLAVOR, runtime);
    expect(v.flavor).toBe("creator");
    expect(v.creatorBuild).toBe(true);
    expect(v.defaultPort).toBe(5320);
    expect(v.port).toBe(5320);
    expect(v.vaultScope).toBe("creator");
    expect(v.features.cpuGpuOdometer).toBe(true);
  });

  test("carries no credential-shaped field at all (paths only)", () => {
    const json = JSON.stringify(buildInfoView(CREATOR_FLAVOR, runtime));
    for (const banned of ["token", "secret", "apiKey", "vaultRef", "password"]) expect(json.includes(banned)).toBe(false);
  });
});
