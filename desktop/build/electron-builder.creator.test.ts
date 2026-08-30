// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import pkg from "../package.json";
import { AGENT_FLAVOR, CREATOR_FLAVOR } from "../build_flavor.ts";
import creator from "./electron-builder.creator.cjs";

interface BuilderConfig {
  appId: string;
  productName: string;
  directories?: { output?: string };
  extraMetadata?: { name?: string; productName?: string; lucidBuildFlavor?: string };
  protocols?: { name: string; schemes: string[] }[];
  files?: string[];
  extraResources?: unknown[];
  mac?: { artifactName?: string; extendInfo?: Record<string, string> };
  pkg?: { mustClose?: string[] };
  nsis?: { artifactName?: string; shortcutName?: string; perMachine?: boolean; oneClick?: boolean };
  portable?: { artifactName?: string };
  linux?: { artifactName?: string; desktop?: Record<string, string> };
  deb?: { artifactName?: string };
  rpm?: { artifactName?: string };
}
const cfg = creator as BuilderConfig;
const base = pkg.build as unknown as BuilderConfig;

describe("Creator packaging overlay (CREATOR-0, ADR-0279)", () => {
  test("the overlay never mutates the standard build config", () => {
    expect(base.appId).toBe(AGENT_FLAVOR.appId);
    expect(base.productName).toBe(AGENT_FLAVOR.productName);
    expect(base.directories?.output).toBe("release");
    expect(base.nsis?.artifactName).toBe("LucidAgent-Setup.${ext}");
    expect(base.extraMetadata).toBeUndefined();
    expect(base.protocols).toBeUndefined();
  });

  test("Creator carries its own app identity, matching the flavor contract", () => {
    expect(cfg.appId).toBe(CREATOR_FLAVOR.appId);
    expect(cfg.productName).toBe(CREATOR_FLAVOR.productName);
    expect(cfg.extraMetadata?.lucidBuildFlavor).toBe("creator");
    expect(cfg.extraMetadata?.name).toBe("lucidcreator-desktop");
    expect(cfg.directories?.output).toBe("release-creator");
  });

  test("Creator claims lucid-creator and NEVER lucid", () => {
    expect(cfg.protocols?.[0]?.schemes).toEqual([CREATOR_FLAVOR.authProtocol]);
    expect(JSON.stringify(cfg.protocols)).not.toContain('"lucid"');
  });

  test("every installer artifact is renamed, so two installers coexist", () => {
    expect(cfg.nsis?.artifactName).toBe("LucidCreator-Setup.${ext}");
    expect(cfg.portable?.artifactName).toBe("LucidCreator-portable.${ext}");
    expect(cfg.mac?.artifactName).toBe("LucidCreator-mac-${arch}.${ext}");
    expect(cfg.linux?.artifactName).toBe("LucidCreator-x86_64.${ext}");
    expect(cfg.deb?.artifactName).toContain("lucidcreator-desktop");
    expect(cfg.rpm?.artifactName).toContain("lucidcreator-desktop");
    for (const name of [cfg.nsis?.artifactName, cfg.portable?.artifactName, cfg.mac?.artifactName, cfg.linux?.artifactName]) {
      expect(name).not.toContain("LucidAgent");
    }
  });

  test("display names and mac uninstall targeting follow the Creator identity", () => {
    expect(cfg.mac?.extendInfo?.CFBundleDisplayName).toBe("Lucid Creator");
    expect(cfg.linux?.desktop?.Name).toBe("Lucid Creator");
    expect(cfg.nsis?.shortcutName).toBe("Lucid Creator");
    expect(cfg.pkg?.mustClose).toEqual([CREATOR_FLAVOR.appId]);
  });

  test("packaging PAYLOAD is inherited unchanged - only identity differs", () => {
    expect(cfg.files).toEqual(base.files);
    expect(JSON.stringify(cfg.extraResources)).toBe(JSON.stringify(base.extraResources));
    expect(cfg.nsis?.perMachine).toBe(base.nsis?.perMachine);
    expect(cfg.nsis?.oneClick).toBe(base.nsis?.oneClick);
  });

  test("the Creator dist scripts exist and use the overlay, and the standard ones are untouched", () => {
    const scripts = pkg.scripts as Record<string, string>;
    for (const s of ["dist:win:creator", "dist:mac:creator", "dist:linux:creator"]) {
      expect(scripts[s]).toContain("build/electron-builder.creator.cjs");
      expect(scripts[s]).toContain("bun run build:creator");
      expect(scripts[s]).toContain("--publish never");
    }
    expect(scripts["dist:win"]).not.toContain("creator");
    expect(scripts["dist:win"]).toContain("bun run build ");
    expect(scripts["build:creator"]).toBe("bun run build/build-creator.ts");
  });
});
