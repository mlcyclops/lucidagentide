// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/build/fetch-whisper.ts - P-STT.2c: stage the whisper.cpp `whisper-server` binary (+ its whisper/ggml
// shared libs) into desktop/whisper/, which electron-builder bundles into `<resources>/whisper/` so the app
// resolves it with zero prereqs (see whisper_manager.ts `resolveWhisperBin`).
//
// Same supply-chain posture as fetch-runtimes.ts:
//   Windows + Linux -> download the PINNED release archive, VERIFY size + SHA-256 (fail-closed), extract only
//                      the server binary + whisper/ggml libs (keep-filter), preserving symlinks + mode.
//   macOS           -> BUILD FROM SOURCE (no server binary is published; only an xcframework). Needs cmake +
//                      a C++ toolchain on the build host; produces a universal (arm64 + x86_64) Metal build.
//                      `LUCID_WHISPER_SRC=<checkout>` reuses an existing build (its `build/bin`) instead.
//
// electron-builder packages on the matching OS, so by default only the current platform is staged
// (WHISPER_OS / WHISPER_ARCH override). REFRESH=1 downloads a prebuilt + PRINTS its SHA-256 (writes nothing)
// to refresh the pinned hash after a version bump - then cross-check it against the release API `digest`.

import { $ } from "bun";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, lstatSync, readlinkSync, symlinkSync, copyFileSync, chmodSync, rmSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { WHISPER_VERSION, whisperBinarySpec, keepWhisperMember, type WhisperBinarySpec } from "../whisper_binaries.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "whisper"); // desktop/whisper -> extraResources `from: "whisper"`
const REFRESH = process.env.REFRESH === "1";
const OS = process.env.WHISPER_OS ?? process.platform;
const ARCH = process.env.WHISPER_ARCH ?? process.arch;

const sha256 = (buf: Uint8Array): string => createHash("sha256").update(buf).digest("hex");
const die = (msg: string): never => { console.error(`fetch-whisper: ${msg}`); process.exit(1); };

/** Recursively collect files/symlinks under `root` whose basename the keep-filter wants. */
function keptMembers(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (keepWhisperMember(name)) out.push(p);
    }
  };
  walk(root);
  return out;
}

/** Copy a set of files into OUT (flat), preserving symlinks (SONAME chains) + the executable bit. */
function stage(paths: string[]): void {
  for (const p of paths) {
    const dest = join(OUT, basename(p));
    const st = lstatSync(p);
    if (st.isSymbolicLink()) { try { rmSync(dest); } catch { /* fresh */ } symlinkSync(readlinkSync(p), dest); continue; }
    copyFileSync(p, dest);
    chmodSync(dest, st.mode); // keep +x on the server binary
  }
}

async function extract(archive: string, dest: string): Promise<void> {
  mkdirSync(dest, { recursive: true });
  if (archive.endsWith(".tar.gz")) { await $`tar -xzf ${archive} -C ${dest}`.quiet(); return; }
  // .zip: bsdtar (Windows 10+ `tar.exe`, macOS) handles it; fall back to `unzip` where present.
  try { await $`tar -xf ${archive} -C ${dest}`.quiet(); }
  catch { await $`unzip -q ${archive} -d ${dest}`.quiet(); }
}

async function doPrebuilt(spec: Extract<WhisperBinarySpec, { kind: "prebuilt" }>): Promise<void> {
  console.log(`fetch-whisper: ${OS}-${ARCH} -> ${spec.asset} (pinned v${WHISPER_VERSION})`);
  const res = await fetch(spec.url);
  if (!res.ok) die(`download failed: HTTP ${res.status} for ${spec.url}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const got = sha256(buf);
  if (REFRESH) { console.log(`  ${spec.asset}\n  bytes: ${buf.length}\n  sha256: ${got}`); return; }
  // FAIL-CLOSED verification: size + committed hash must match exactly.
  if (buf.length !== spec.bytes) die(`size mismatch for ${spec.asset}: got ${buf.length}, expected ${spec.bytes}`);
  if (got !== spec.sha256) die(`SHA-256 MISMATCH for ${spec.asset}\n  got:      ${got}\n  expected: ${spec.sha256}\n  (refusing to bundle an unverified binary)`);

  const work = join(tmpdir(), `lucid-whisper-${Date.now()}`);
  const archive = join(work, spec.asset);
  mkdirSync(work, { recursive: true });
  Bun.write(archive, buf);
  const extractDir = join(work, "x");
  await extract(archive, extractDir);

  const kept = keptMembers(extractDir);
  if (!kept.some((p) => basename(p) === spec.member)) die(`archive ${spec.asset} did not contain ${spec.member}`);
  stage(kept);
  try { rmSync(work, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`fetch-whisper: staged ${kept.length} files into ${OUT} (server: ${spec.member})`);
}

/** macOS relocation: ensure @loader_path is an rpath, then delete absolute (build-dir) rpaths that won't
 *  exist on the user's machine, so the co-located dylibs are the only ones dyld can load. */
async function hardenRpath(file: string): Promise<void> {
  try { await $`install_name_tool -add_rpath @loader_path ${file}`.quiet(); } catch { /* already present */ }
  const dump = await $`otool -l ${file}`.text().catch(() => "");
  const abs = [...dump.matchAll(/LC_RPATH[\s\S]{0,160}?path (\/[^\s]+)/g)].map((m) => m[1]);
  for (const p of abs) { try { await $`install_name_tool -delete_rpath ${p} ${file}`.quiet(); } catch { /* best-effort */ } }
}

async function doSource(spec: Extract<WhisperBinarySpec, { kind: "source" }>): Promise<void> {
  // Reuse an existing checkout's build if provided (fast path; the packaging build clones fresh).
  let binDir = process.env.LUCID_WHISPER_SRC ? join(process.env.LUCID_WHISPER_SRC, "build", "bin") : "";
  if (!binDir || !existsSync(join(binDir, spec.member))) {
    if (!Bun.which("cmake")) die(`macOS builds whisper.cpp from source and needs cmake on PATH (brew install cmake), or set LUCID_WHISPER_SRC to a prebuilt checkout.`);
    const src = join(tmpdir(), `lucid-whisper-src-${Date.now()}`);
    console.log(`fetch-whisper: building whisper.cpp v${WHISPER_VERSION} from source (universal, Metal)...`);
    await $`git clone --depth 1 -b v${WHISPER_VERSION} https://github.com/ggml-org/whisper.cpp ${src}`.quiet();
    await $`cmake -S ${src} -B ${join(src, "build")} -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON -DCMAKE_OSX_ARCHITECTURES=${"arm64;x86_64"}`.quiet();
    await $`cmake --build ${join(src, "build")} -j --config Release --target whisper-server`.quiet();
    binDir = join(src, "build", "bin");
  } else {
    console.log(`fetch-whisper: reusing prebuilt whisper.cpp at ${binDir}`);
  }
  if (!existsSync(join(binDir, spec.member))) die(`built binary not found at ${join(binDir, spec.member)}`);
  stage(keptMembers(binDir));
  // Make the co-located dylibs loadable after relocation: @rpath must resolve to the binary's own dir, and
  // strip any ABSOLUTE build-dir rpath (dead on a user's machine) so @loader_path is the only search path.
  for (const name of readdirSync(OUT)) {
    if (name === ".gitkeep") continue;
    await hardenRpath(join(OUT, name));
  }
  console.log(`fetch-whisper: staged macOS build into ${OUT}`);
}

const spec = whisperBinarySpec(OS, ARCH);
if (!spec) { console.warn(`fetch-whisper: no whisper binary spec for ${OS}-${ARCH} - nothing to bundle.`); process.exit(0); }

mkdirSync(OUT, { recursive: true });
// Clear stale binaries (keep the committed .gitkeep) so a rebuild is clean.
if (!REFRESH) for (const name of readdirSync(OUT)) { if (name !== ".gitkeep") rmSync(join(OUT, name), { recursive: true, force: true }); }

if (spec.kind === "prebuilt") await doPrebuilt(spec);
else if (!REFRESH) await doSource(spec);
else console.log("fetch-whisper: REFRESH only refreshes prebuilt hashes; macOS builds from source (nothing to refresh).");
