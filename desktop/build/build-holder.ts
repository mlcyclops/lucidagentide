// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/build/build-holder.ts - P-HOLDER.1 (ADR-0533, ADR-0534): build native/lucid-holder (Rust) for this machine
// and stage it as bin/lucid-holder(.exe), which electron-builder ships under `<resources>/repo/bin` (the same folder
// as lucid-engine) and lane_holder.ts holderBinary() finds there.
//
// `cargo build --release --locked`: the crate's Cargo.lock is committed, so a release builds the exact dependency
// versions the tests ran. Fails the build (exit 1) when cargo is missing or the build fails: a dist without the
// holder would ship lanes that end with the engine again, silently.
//
// Usage: `bun run build-holder` (from desktop/). Needs Rust (rustup; on Windows the MSVC toolchain).
//
// Cross-target (#614, ADR-0569; build/stage-mac-arch.ts builds both mac arches on one runner):
//   bun run build/build-holder.ts --target=x86_64-apple-darwin --outdir=bin-darwin-x64
// `--target` is a rustup target triple (`rustup target add` it first); `--outdir` is relative to the repo root
// (default `bin`). A binary built for another arch is not run here; the caller checks its Mach-O arch instead.

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const CRATE = join(REPO, "native", "lucid-holder");
const EXE = process.platform === "win32" ? "lucid-holder.exe" : "lucid-holder";

const flag = (name: string): string | null => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const TARGET = flag("target");
const OUTDIR = flag("outdir") ?? "bin";
// The triple this machine runs natively, for the platforms that cross-build (macOS); elsewhere a --target is
// only ever this machine's own, so it is run like the default build.
const HOST_TRIPLE = process.platform === "darwin" ? (process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin") : TARGET;
const RUNNABLE = TARGET === null || TARGET === HOST_TRIPLE;

const cargoName = process.platform === "win32" ? "cargo.exe" : "cargo";
const cargo = Bun.which("cargo") ?? [join(homedir(), ".cargo", "bin", cargoName)].find((p) => existsSync(p));
if (!cargo) {
  console.error("build-holder: cargo was not found. Install Rust (https://rustup.rs), then run `bun run build-holder` again.");
  process.exit(1);
}

const args = [cargo, "build", "--release", "--locked", ...(TARGET ? ["--target", TARGET] : [])];
const build = Bun.spawnSync(args, { cwd: CRATE, stdout: "inherit", stderr: "inherit" });
if (build.exitCode !== 0) {
  console.error(`build-holder: cargo build failed (exit ${build.exitCode})`);
  process.exit(1);
}
const built = TARGET ? join(CRATE, "target", TARGET, "release", EXE) : join(CRATE, "target", "release", EXE);
if (!existsSync(built)) {
  console.error(`build-holder: ${built} is missing after the build`);
  process.exit(1);
}
let label = `lucid-holder (${TARGET}, cross-built, not run here)`;
if (RUNNABLE) {
  const version = Bun.spawnSync([built, "--version"], { stdout: "pipe" });
  if (version.exitCode !== 0 || !version.stdout.toString().startsWith("lucid-holder ")) {
    console.error("build-holder: the built binary does not run (`--version` failed)");
    process.exit(1);
  }
  label = version.stdout.toString().trim();
}
mkdirSync(join(REPO, OUTDIR), { recursive: true });
copyFileSync(built, join(REPO, OUTDIR, EXE));
console.log(`build-holder: ${label} -> ${OUTDIR}/${EXE}`);
