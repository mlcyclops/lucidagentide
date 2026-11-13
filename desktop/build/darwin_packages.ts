// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/build/darwin_packages.ts - #614 (ADR-0569): the per-arch macOS npm packages both mac apps need.
//
// Native addons arrive as optional dependencies gated on os/cpu (`@oh-my-pi/pi-natives-darwin-arm64`,
// `@img/sharp-darwin-x64`, ...), so `bun install` on the arm64 runner installs only the arm64 half, and the x64
// app shipped arm64 addons in its node_modules. stage-mac-arch.ts installs the other half from the lockfile, and
// the mac `extraResources` in desktop/package.json then ships each app only its own `*-darwin-<arch>` packages.
//
// This file is the pure half: read bun.lock's package lines and pair every installed darwin package of the
// build machine's arch with its other-arch twin. The lockfile is the trust anchor: every twin is fetched by the
// exact version and sha512 integrity bun itself resolved, never by "latest".
//
// Fail-closed: a darwin package whose name does not end in `-darwin-<arch>` cannot be split by the packaging
// filter, a nested (non-hoisted) one is not covered by it, and one without a twin in the lockfile would leave the
// other app without it. Each is reported as a problem and the build stops.

import type { MacArch } from "./macho.ts";

export interface LockPackage {
  /** The bun.lock key: the package name, or `parent/name` for a nested install. */
  readonly key: string;
  readonly name: string;
  readonly version: string;
  /** "" = the default npm registry. */
  readonly registry: string;
  /** `sha512-<base64>`, as bun recorded it. */
  readonly integrity: string;
  /** The `os` / `cpu` gate when it is a single string; null when absent or a list. */
  readonly os: string | null;
  readonly cpu: string | null;
}

// One package per line: `"<key>": ["<name>@<version>", "<registry>", { <meta> }, "sha512-..."],`
const LOCK_LINE = /^\s*"([^"]+)": \["([^"]+)", "([^"]*)", (\{.*\}), "(sha512-[A-Za-z0-9+/=]+)"\],?\s*$/;

/** Every registry package in a bun.lock text. Workspace and git entries (no sha512 line shape) are skipped. */
export function parseBunLockPackages(text: string): LockPackage[] {
  const out: LockPackage[] = [];
  for (const line of text.split("\n")) {
    const m = LOCK_LINE.exec(line);
    if (!m) continue;
    const spec = m[2]!;
    const meta = m[4]!;
    const at = spec.lastIndexOf("@");
    if (at <= 0) continue;
    out.push({
      key: m[1]!,
      name: spec.slice(0, at),
      version: spec.slice(at + 1),
      registry: m[3]!,
      integrity: m[5]!,
      os: /"os": "([^"]+)"/.exec(meta)?.[1] ?? null,
      cpu: /"cpu": "([^"]+)"/.exec(meta)?.[1] ?? null,
    });
  }
  return out;
}

export const otherArch = (a: MacArch): MacArch => (a === "arm64" ? "x64" : "arm64");

/** Where `bun install` puts a top-level package, relative to the repo root. */
export function installDir(p: LockPackage): string {
  return `node_modules/${p.name}`;
}

/** The registry tarball npm serves for name@version (`@scope/pkg` -> `.../@scope/pkg/-/pkg-<v>.tgz`). */
export function tarballUrl(p: LockPackage): string {
  const base = p.name.slice(p.name.lastIndexOf("/") + 1);
  return `https://registry.npmjs.org/${p.name}/-/${base}-${p.version}.tgz`;
}

export interface DarwinTwin {
  readonly host: LockPackage;
  readonly twin: LockPackage;
}

/** Pair every INSTALLED darwin package of `host` arch with its other-arch twin from the same lockfile.
 *  `installed(p)` says whether `p` is on disk (only installed packages ship, so only they need a twin). */
export function darwinTwins(
  pkgs: readonly LockPackage[],
  host: MacArch,
  installed: (p: LockPackage) => boolean,
): { twins: DarwinTwin[]; problems: string[] } {
  const other = otherArch(host);
  const byKey = new Map(pkgs.map((p) => [p.key, p]));
  const twins: DarwinTwin[] = [];
  const problems: string[] = [];
  for (const p of pkgs) {
    if (p.os !== "darwin" || p.cpu !== host || !installed(p)) continue;
    const suffix = `-darwin-${host}`;
    if (!p.name.endsWith(suffix)) {
      problems.push(`${p.key}: a darwin/${host} package whose name does not end in "${suffix}", so the per-arch packaging filter cannot place it`);
      continue;
    }
    if (p.key !== p.name) {
      problems.push(`${p.key}: a nested darwin/${host} install; only top-level node_modules/<name> packages are split per arch`);
      continue;
    }
    const twinKey = `${p.name.slice(0, -suffix.length)}-darwin-${other}`;
    const twin = byKey.get(twinKey);
    if (!twin || twin.os !== "darwin" || twin.cpu !== other) {
      problems.push(`${p.key}: no darwin/${other} twin "${twinKey}" in bun.lock, so the ${other} app would ship without it`);
      continue;
    }
    if (twin.registry !== "") {
      problems.push(`${twin.key}: resolved from a non-default registry (${twin.registry}); only registry.npmjs.org tarballs are fetched`);
      continue;
    }
    twins.push({ host: p, twin });
  }
  return { twins, problems };
}
