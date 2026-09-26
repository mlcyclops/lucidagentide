// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  publish?: { provider: string; owner?: string; repo?: string; url?: string; channel?: string }[];
}
const cfg = creator as BuilderConfig;
const base = pkg.build as unknown as BuilderConfig;

// Stated here as a literal rather than imported, so this file is an independent statement of the
// contract: the overlay, the workflow and this test must all three say the same tag.
const CREATOR_ROLLING_TAG = "creator-latest";
const CREATOR_WORKFLOW = join(import.meta.dir, "..", "..", ".github", "workflows", "build-creator.yml");

interface WorkflowStep {
  name?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface WorkflowJob {
  steps?: WorkflowStep[];
  strategy?: { matrix?: { include?: { script?: string }[] } };
}

// Parsed, not substring-matched: a YAML indentation error would otherwise surface only as a failed CI
// run on a release tag, which is the worst possible moment to find out.
const wfDoc = Bun.YAML.parse(readFileSync(CREATOR_WORKFLOW, "utf8")) as Record<string, unknown>;
// YAML 1.1 reads a bare `on` as the boolean true; GitHub's parser reads it as the string. Accept either,
// so this asserts the workflow's meaning rather than the parser's spec version.
const wfTriggers = (wfDoc.on ?? wfDoc.true) as { push?: { tags?: string[] } } | undefined;
const wfJobs = (wfDoc.jobs ?? {}) as Record<string, WorkflowJob>;
const wfSteps = Object.values(wfJobs).flatMap((j) => j.steps ?? []);
const wfReleaseSteps = wfSteps.filter((s) => (s.uses ?? "").startsWith("softprops/action-gh-release"));

describe("Creator packaging overlay (CREATOR-0, ADR-0279)", () => {
  test("the overlay never mutates the standard build config", () => {
    expect(base.appId).toBe(AGENT_FLAVOR.appId);
    expect(base.productName).toBe(AGENT_FLAVOR.productName);
    expect(base.directories?.output).toBe("release");
    expect(base.nsis?.artifactName).toBe("LucidAgent-Setup.${ext}");
    expect(base.extraMetadata).toBeUndefined();
    expect(base.protocols).toBeUndefined();
    expect(base.publish?.[0]?.provider).toBe("github");
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

  // The defect that killed the first creator-v0.1.0 tag build: electron-builder streams the repo copy
  // into <output>/.../resources/repo while the filter walks the live tree, so an output directory the
  // filter does not exclude gets copied INTO itself (repo/desktop/release-creator/.../repo/...) until
  // the OS refuses with ENAMETOOLONG. Agent was protected by `!desktop/release/**`; the overlay moved
  // the output to release-creator and inherited a filter that had never heard of it.
  test("the repo copy excludes EVERY flavor's output dir, so no build can package itself", () => {
    const repoFilter = (c: BuilderConfig): string[] =>
      ((c.extraResources ?? []).find((r) => (r as { to?: string }).to === "repo") as { filter?: string[] } | undefined)
        ?.filter ?? [];
    for (const flavor of [base, cfg]) {
      const filter = repoFilter(flavor);
      // Rename-proof: derived from the flavor's own output setting, not a hardcoded twin list.
      expect(filter).toContain(`!desktop/${flavor.directories?.output}/**`);
      // And both output trees stay excluded for both flavors, since one checkout can hold both.
      expect(filter).toContain("!desktop/release/**");
      expect(filter).toContain("!desktop/release-creator/**");
    }
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

  // The defect this guards, found while building the Creator release pipeline: the deep clone also
  // copied Agent's github `publish` block. electron-updater's GitHub provider takes its tag from
  // GET /<owner>/<repo>/releases/latest, ONE latest-release pointer for the whole repo, then fetches
  // `releases/download/<that tag>/latest.yml`. Both products emit a file named exactly `latest.yml`,
  // and updater.ts sets autoDownload + autoInstallOnAppQuit, so an installed Creator would have
  // resolved AGENT's rolling release and replaced itself with Agent bytes on the next quit.
  test("Creator updates from its OWN feed, never through the shared release pointer", () => {
    expect(cfg.publish).toHaveLength(1);
    const feed = cfg.publish?.[0];
    // generic fetches <url>/<channel>.yml at a fixed URL; there is no release lookup to get wrong.
    expect(feed?.provider).toBe("generic");
    expect(feed?.owner).toBeUndefined();
    expect(feed?.repo).toBeUndefined();
    expect(feed?.url).toBe(
      `https://github.com/${base.publish?.[0]?.owner}/${base.publish?.[0]?.repo}/releases/download/${CREATOR_ROLLING_TAG}`,
    );
    // The specific wrong answer: Agent's rolling tag is `latest`, and pointing here would reintroduce
    // the whole defect while still looking like a Creator-specific config.
    expect(feed?.url?.endsWith("/download/latest")).toBe(false);
  });

  test("the Creator workflow owns its own tag namespace and feeds the tag Creator reads", () => {
    // Reacting to `v*` would make one Agent tag build both products.
    expect(wfTriggers?.push?.tags).toEqual(["creator-v*"]);
    const rolling = wfReleaseSteps.find((s) => s.with?.tag_name !== undefined);
    expect(rolling?.with?.tag_name).toBe(CREATOR_ROLLING_TAG);
    // Drift between the workflow and the packaged feed fails no build. It just leaves every installed
    // Creator permanently un-updatable, silently.
    expect(cfg.publish?.[0]?.url?.split("/").pop()).toBe(CREATOR_ROLLING_TAG);
  });

  // The REVERSE hazard. electron-updater resolves AGENT's tag from that same repo-wide pointer, so a
  // Creator release that moved it would send every installed Agent to Creator's feed. This workflow
  // could break users who never installed Creator at all.
  test("no Creator release can become the repo pointer Agent's installed base follows", () => {
    expect(wfReleaseSteps).toHaveLength(2); // the versioned creator-v* release, and the rolling one
    for (const step of wfReleaseSteps) {
      expect(step.with?.make_latest).toBe("false");
    }
    // Second, independent guarantee: GitHub excludes prereleases from that pointer outright, so the
    // rolling release stays harmless even if a future edit drops make_latest.
    expect(wfReleaseSteps.find((s) => s.with?.tag_name === CREATOR_ROLLING_TAG)?.with?.prerelease).toBe(true);
  });

  test("both release gates run against CREATOR bytes, not whatever sits in desktop/release", () => {
    const gates = wfSteps.filter((s) => (s.run ?? "").includes("-smoke.ts"));
    expect(gates.map((s) => s.run)).toEqual(["bun run build/airgap-smoke.ts", "bun run build/pf-boot-smoke.ts"]);
    // Both scripts default to desktop/release. Unset, they would fail on a missing dir or, on a runner
    // that also built Agent, pass by inspecting Agent's tree and report green about bytes they never
    // opened. That second case is the dangerous one: a green gate proving nothing.
    for (const step of gates) {
      expect(step.env?.LUCID_RELEASE_DIR).toBe("release-creator");
    }
    expect(gates.find((s) => (s.run ?? "").includes("pf-boot"))?.env?.LUCID_PF_SMOKE_STRICT).toBe("1");
    const scripts = wfJobs.build?.strategy?.matrix?.include?.map((m) => m.script) ?? [];
    expect(scripts.toSorted()).toEqual(["dist:linux:creator", "dist:mac:creator", "dist:win:creator"]);
  });
});
