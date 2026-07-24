// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/build/copy-natives.ts — put omp's native addon where the COMPILED launcher can find it.
//
// `compile-lucid` produces bin/lucid[.exe] with `bun build --compile`. That binary is a bunfs image:
// it has NO node_modules resolution, so the @oh-my-pi/pi-natives loader falls back to a fixed list of
// filesystem paths — ~/.omp/natives/<ver>/, ~/.local/bin/, /$bunfs/native/, and THE BINARY'S OWN DIR.
// The addon ships only under node_modules/@oh-my-pi/pi-natives-<plat>-<arch>/, which is on none of
// them, and the self-extract to ~/.omp/natives never fires. So every packaged `lucid acp` died at
// startup with:
//
//     Error: Failed to load pi_natives native addon for linux-x64 (modern)
//
// That is the sanctioned fail-closed ACP entrypoint the marketplace IDE extensions spawn (P-EXT.1,
// ADR-0038) — VS Code / JetBrains / Neovim resolve it via installedAppLauncherPaths() at
// /opt/LucidAgentIDE/resources/repo/bin/lucid. The desktop app was unaffected: it runs omp through
// the node_modules/.bin/omp shim, which resolves natives normally. One broken path, one working one,
// which is why this shipped.
//
// The addon is ~118 MB per variant and is ALREADY inside the package. Copying it would add ~236 MB to
// every artifact to duplicate bytes we ship anyway, so on POSIX we LINK: a RELATIVE symlink from bin/
// into node_modules. Both live under resources/repo/, so the link stays valid wherever the app is
// installed. Windows gets real copies (symlink creation needs privilege/dev-mode and the installers
// don't preserve them reliably).
//
// If electron-builder dereferences the symlink, the artifact just carries a copy — correct, only
// bigger. If it ever BREAKS the link, desktop/build/airgap-smoke.ts fails the build: it asserts the
// addon resolves next to the packaged binary and that the launcher does not die loading it. Both
// outcomes are safe; only a silent brick is not.
//
//   bun run build/copy-natives.ts                  # host platform/arch, link on POSIX
//   bun run build/copy-natives.ts --copy           # force real copies
//   bun run build/copy-natives.ts --platform=linux --arch=arm64   # cross-target

import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)); // desktop/build
const REPO = join(HERE, "..", ".."); // repo root — where `bun install` hoists node_modules
const BIN = join(REPO, "bin"); // compile-lucid's --outfile dir

const argv = process.argv.slice(2);
const flag = (name: string): string | null => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const PLAT = (flag("platform") ?? process.platform) as NodeJS.Platform;
const ARCH = flag("arch") ?? process.arch;
// Windows: no reliable symlinks through the installers. Otherwise honour --copy.
const COPY = argv.includes("--copy") || PLAT === "win32";

function fail(msg: string): never {
  console.error(`\n✗ copy-natives: ${msg}\n`);
  process.exit(1);
}

// The published per-platform packages (see @oh-my-pi/pi-natives optionalDependencies). Listed
// explicitly so an unsupported target fails HERE, at build time, instead of at a user's startup.
const SUPPORTED = new Set(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"]);
const triple = `${PLAT}-${ARCH}`;
if (!SUPPORTED.has(triple)) {
  fail(`no @oh-my-pi/pi-natives package exists for ${triple} (have: ${[...SUPPORTED].join(", ")})`);
}

const pkgDir = join(REPO, "node_modules", "@oh-my-pi", `pi-natives-${triple}`);
if (!existsSync(pkgDir)) {
  fail(
    `@oh-my-pi/pi-natives-${triple} is not installed at ${pkgDir}\n` +
      `  It is an OPTIONAL dependency gated on os/cpu, so a host that isn't ${triple} never installs it.\n` +
      `  Cross-building? Install it explicitly: bun add --optional @oh-my-pi/pi-natives-${triple}`,
  );
}

// Ship every variant the package carries: the loader tries `-modern` first and falls back to
// `-baseline` on older CPUs, so dropping one silently breaks that fallback.
const addons = readdirSync(pkgDir).filter((f) => f.endsWith(".node"));
if (!addons.length) fail(`no *.node addon inside ${pkgDir} — the package looks corrupt, refusing to ship a launcher that cannot start`);

mkdirSync(BIN, { recursive: true });

let linked = 0;
let copied = 0;
for (const name of addons) {
  const src = join(pkgDir, name);
  const dst = join(BIN, name);
  // lstat, not existsSync: a BROKEN symlink from an earlier run fails existsSync but still occupies
  // the path, so unlink unconditionally before re-creating.
  try {
    lstatSync(dst);
    rmSync(dst, { force: true });
  } catch {
    /* nothing there — fine */
  }
  if (COPY) {
    copyFileSync(src, dst);
    copied++;
  } else {
    symlinkSync(relative(BIN, src), dst); // RELATIVE: survives the move into resources/repo/
    linked++;
  }
  // Verify through the link: a symlink that doesn't resolve is exactly the brick we're preventing.
  if (!existsSync(dst) || statSync(dst).size === 0) fail(`${dst} does not resolve to a non-empty addon after ${COPY ? "copy" : "link"}`);
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(0)} MB`;
const bytes = addons.reduce((sum, n) => sum + statSync(join(pkgDir, n)).size, 0);
console.log(
  `  natives OK (${triple}) - ${addons.length} addon${addons.length === 1 ? "" : "s"} ${COPY ? `copied (+${mb(bytes)})` : `linked (0 MB added; ${mb(bytes)} referenced)`} into bin/`,
);
for (const name of addons) {
  const dst = join(BIN, name);
  const via = COPY ? "copy" : `-> ${readlinkSync(dst)}`;
  console.log(`    ${name}  ${via}`);
}
