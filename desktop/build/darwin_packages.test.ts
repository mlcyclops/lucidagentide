// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Tests for build/darwin_packages.ts (#614, ADR-0569): pairing each installed darwin addon package with its
// other-arch twin from bun.lock, so both mac apps get addons for their own CPU.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { darwinTwins, installDir, type LockPackage, parseBunLockPackages, tarballUrl } from "./darwin_packages.ts";

// Real bun.lock lines (bun.lock at 18.18.6 / 0.34.5), plus a linux entry and a workspace line that must be skipped.
const LOCK = [
  `{`,
  `  "lockfileVersion": 1,`,
  `  "workspaces": { "": { "name": "lucidagentide" } },`,
  `  "packages": {`,
  `    "@img/sharp-darwin-arm64": ["@img/sharp-darwin-arm64@0.34.5", "", { "optionalDependencies": { "@img/sharp-libvips-darwin-arm64": "1.2.4" }, "os": "darwin", "cpu": "arm64" }, "sha512-imtQ3WMJXbMY4fxb/Ndp6HBTNVtWCUI0WdobyheGf5+ad6xX8VIDO8u2xE4qc/fr08CKG/7dDseFtn6M6g/r3w=="],`,
  `    "@img/sharp-darwin-x64": ["@img/sharp-darwin-x64@0.34.5", "", { "optionalDependencies": { "@img/sharp-libvips-darwin-x64": "1.2.4" }, "os": "darwin", "cpu": "x64" }, "sha512-YNEFAF/4KQ/PeW0N+r+aVVsoIY0/qxxikF2SWdp+NRkmMB7y9LBZAVqQ4yhGCm/H3H270OSykqmQMKLBhBJDEw=="],`,
  `    "@oh-my-pi/pi-natives-darwin-arm64": ["@oh-my-pi/pi-natives-darwin-arm64@18.18.6", "", { "os": "darwin", "cpu": "arm64" }, "sha512-PCYYbpU6Z2FjMgtAnbMoT8kwb+mm1+gjliNnm34GgL8NN5a6gpSv0eiJHt7091g7RrHF9yZocX2B0AU5f7HFDg=="],`,
  `    "@oh-my-pi/pi-natives-darwin-x64": ["@oh-my-pi/pi-natives-darwin-x64@18.18.6", "", { "os": "darwin", "cpu": "x64" }, "sha512-oUC/d031dyJO5lu55qppOv6s93MqQoMW3QIfUJh1lcvwP0Zh9daDy0suxYPk5w2jyYqrlNqmSbJBgq+t6PHKBw=="],`,
  `    "@oh-my-pi/pi-natives-linux-arm64": ["@oh-my-pi/pi-natives-linux-arm64@18.18.6", "", { "os": "linux", "cpu": "arm64" }, "sha512-Fdf73sm9M5fToBD4lB4tVciD9vG0NpkRRG5Gt/ieppsIYfE3okQ/Diopsi3tYUBVTtKKlgYmYRNCKCWKVH0seA=="],`,
  `    "onnxruntime-node": ["onnxruntime-node@1.24.3", "", { "os": [ "linux", "win32", "darwin", ] }, "sha512-JH7+czbc8ALA819vlTgcV+Q214/+VjGeBHDjX81+ZCD0PCVCIFGFNtT0V4sXG/1JXypKPgScQcB3ij/hk3YnTg=="],`,
  `    "lucid-local": ["lucid-local@workspace:packages/local"],`,
  `  }`,
  `}`,
].join("\r\n");

const byName = (pkgs: LockPackage[], name: string): LockPackage => {
  const p = pkgs.find((x) => x.name === name);
  if (!p) throw new Error(`missing ${name}`);
  return p;
};

describe("parseBunLockPackages", () => {
  test("reads name, version, integrity and a single-string os/cpu gate; skips workspace lines", () => {
    const pkgs = parseBunLockPackages(LOCK);
    expect(pkgs.map((p) => p.key)).toEqual([
      "@img/sharp-darwin-arm64",
      "@img/sharp-darwin-x64",
      "@oh-my-pi/pi-natives-darwin-arm64",
      "@oh-my-pi/pi-natives-darwin-x64",
      "@oh-my-pi/pi-natives-linux-arm64",
      "onnxruntime-node",
    ]);
    const x64 = byName(pkgs, "@oh-my-pi/pi-natives-darwin-x64");
    expect(x64.version).toBe("18.18.6");
    expect(x64.integrity.startsWith("sha512-oUC/d031")).toBe(true);
    expect([x64.os, x64.cpu]).toEqual(["darwin", "x64"]);
    expect(byName(pkgs, "onnxruntime-node").os).toBeNull(); // a list gate is not a per-arch package
  });

  test("the repo's own bun.lock parses, and pi-natives has both darwin halves", () => {
    const pkgs = parseBunLockPackages(readFileSync(join(import.meta.dir, "..", "..", "bun.lock"), "utf8"));
    expect(pkgs.length).toBeGreaterThan(100);
    const names = new Set(pkgs.map((p) => p.name));
    expect(names.has("@oh-my-pi/pi-natives-darwin-arm64")).toBe(true);
    expect(names.has("@oh-my-pi/pi-natives-darwin-x64")).toBe(true);
  });

  test("tarball URL and install dir follow npm's layout for scoped names", () => {
    const p = byName(parseBunLockPackages(LOCK), "@img/sharp-darwin-x64");
    expect(tarballUrl(p)).toBe("https://registry.npmjs.org/@img/sharp-darwin-x64/-/sharp-darwin-x64-0.34.5.tgz");
    expect(installDir(p)).toBe("node_modules/@img/sharp-darwin-x64");
  });
});

describe("darwinTwins", () => {
  const pkgs = parseBunLockPackages(LOCK);

  test("an arm64 runner pairs each installed arm64 package with its x64 twin", () => {
    const { twins, problems } = darwinTwins(pkgs, "arm64", () => true);
    expect(problems).toEqual([]);
    expect(twins.map((t) => [t.host.name, t.twin.name])).toEqual([
      ["@img/sharp-darwin-arm64", "@img/sharp-darwin-x64"],
      ["@oh-my-pi/pi-natives-darwin-arm64", "@oh-my-pi/pi-natives-darwin-x64"],
    ]);
  });

  test("an x64 runner pairs the other way; packages not installed are not needed", () => {
    const { twins } = darwinTwins(pkgs, "x64", (p) => p.name.startsWith("@oh-my-pi/"));
    expect(twins.map((t) => t.twin.name)).toEqual(["@oh-my-pi/pi-natives-darwin-arm64"]);
  });

  test("a missing twin, a nested install and an unsplittable name each stop the build", () => {
    const broken: LockPackage[] = [
      { key: "lonely-darwin-arm64", name: "lonely-darwin-arm64", version: "1.0.0", registry: "", integrity: "sha512-a", os: "darwin", cpu: "arm64" },
      { key: "host/inner-darwin-arm64", name: "inner-darwin-arm64", version: "1.0.0", registry: "", integrity: "sha512-b", os: "darwin", cpu: "arm64" },
      { key: "fsevents-like", name: "fsevents-like", version: "1.0.0", registry: "", integrity: "sha512-c", os: "darwin", cpu: "arm64" },
    ];
    const { twins, problems } = darwinTwins(broken, "arm64", () => true);
    expect(twins).toEqual([]);
    expect(problems.length).toBe(3);
    expect(problems[0]).toContain('no darwin/x64 twin "lonely-darwin-x64"');
    expect(problems[1]).toContain("nested");
    expect(problems[2]).toContain("does not end in");
  });
});
