// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-STT.2 - guided, on-device Whisper (offline STT). Proves the verified core end to end with NO
// network and NO binary: the hardware-capability gate, the install/serve plan, binary resolution order, and
// the download-with-integrity flow (injected IO). The physical model download + whisper.cpp spawn are the
// on-device step (P-STT.2b); everything decided here is pure + covered.
//
// Run: bun run desktop/scripts/demo_p_stt_2.ts

import { whisperCapability } from "../whisper_capability.ts";
import { looksLikeWhisperModel, planWhisperInstall, WHISPER_MODELS, whisperServeUrl, whisperServerArgs } from "../whisper_install.ts";
import { downloadWhisperModel, resolveWhisperBin, type DownloadIO } from "../whisper_manager.ts";

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}`);
  if (!ok) failures++;
}

console.log("== P-STT.2 - guided on-device Whisper ==");

// (1) capability gate: run only where the hardware fits.
const laptop = whisperCapability({ arch: "arm64", platform: "darwin", totalRamGB: 8, cpuCores: 8, accel: "metal" });
const ultra = whisperCapability({ arch: "arm64", platform: "darwin", totalRamGB: 512, cpuCores: 28, accel: "metal" });
const potato = whisperCapability({ arch: "x64", platform: "linux", totalRamGB: 1, cpuCores: 2 });
check("8GB laptop recommends the 'small' model", laptop.recommended === "small");
check("M3 Ultra (512GB) recommends 'large-turbo'", ultra.recommended === "large-turbo");
check("1GB box is NOT capable (fail-closed)", potato.capable === false && potato.recommended === null);

// (2) install/serve plan.
const plan = planWhisperInstall(laptop);
check("plan picks the recommended model with a real HF url", plan.ok && plan.model.tier === "small" && plan.model.url.startsWith("https://huggingface.co/"));
check("serve URL is loopback with no /v1 (the STT backend appends it)", whisperServeUrl(9111) === "http://127.0.0.1:9111");
check("spawn argv binds the model to loopback", JSON.stringify(whisperServerArgs("/m/ggml-small.en.bin", 9111)) === JSON.stringify(["-m", "/m/ggml-small.en.bin", "--host", "127.0.0.1", "--port", "9111"]));
check("an incapable machine is refused a plan", planWhisperInstall(potato).ok === false);

// (3) binary resolution order (env -> bundled -> PATH -> none).
check("env LUCID_WHISPER_BIN wins", resolveWhisperBin({ env: { LUCID_WHISPER_BIN: "/opt/ws" }, exists: (p) => p === "/opt/ws", which: () => null, platform: "darwin" })?.source === "env");
check("bundled binary next", resolveWhisperBin({ env: {}, exists: (p) => p === "/res/whisper/whisper-server", which: () => null, resourcesPath: "/res", platform: "darwin" })?.source === "bundled");
check("PATH binary next", resolveWhisperBin({ env: {}, exists: () => false, which: (n) => (n === "whisper-server" ? "/usr/bin/whisper-server" : null), platform: "darwin" })?.source === "path");
check("none resolves -> null (UI flags the bundle step)", resolveWhisperBin({ env: {}, exists: () => false, which: () => null, platform: "darwin" }) === null);

// (4) download-with-integrity (injected IO; no network).
const BIG = 200 * 1024 * 1024;
function res(ok: boolean, status: number): Response {
  const body = new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
  const r = { ok, status, headers: { get: () => String(BIG) }, body };
  return r as unknown as Response;
}
const okIO: DownloadIO = {
  fetch: (async () => res(true, 200)) as unknown as typeof fetch,
  writeStream: async (_p, _b, onBytes) => { onBytes(BIG); return BIG; },
  readHead: async () => new Uint8Array([0x00, 0x01]),
  rename: async () => {},
  remove: async () => {},
};
const good = await downloadWhisperModel(WHISPER_MODELS.base, "/m/ggml-base.en.bin", okIO);
check("a healthy download commits (atomic rename)", good.ok === true);
const htmlIO: DownloadIO = { ...okIO, readHead: async () => new Uint8Array([0x3c]) }; // '<' = HTML error page
const bad = await downloadWhisperModel(WHISPER_MODELS.base, "/m/x.bin", htmlIO);
check("an HTML error page saved as .bin is rejected fail-closed", bad.ok === false);
check("integrity floor rejects a truncated file", looksLikeWhisperModel(new Uint8Array([0]), 1024, 148).ok === false);

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
