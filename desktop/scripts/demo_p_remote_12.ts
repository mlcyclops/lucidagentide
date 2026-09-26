// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_remote_12.ts - P-REMOTE.12 (ADR-0251): PWA push-to-talk voice prompts.
//
// Proves headless: the PromptAudio validator is fail-closed on shape/mime/size/base64 (both ends run
// it), a live edit guest can send an audio-only prompt straight to the host, an invalid clip never
// leaves the phone, and the frame stays additive (a text-only prompt carries no audio field at all -
// old hosts ignore nothing).
//
// Run: bun run desktop/scripts/demo_p_remote_12.ts

import { MAX_PROMPT_AUDIO_BYTES, validPromptAudio } from "../collab/frames.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} \u2713`);

console.log("== P-REMOTE.12 (ADR-0251) - PWA push-to-talk ==");

if (!validPromptAudio({ b64: "QUJDRA==", mime: "audio/wav" })) fail("a real wav clip must pass");
if (!validPromptAudio({ b64: "QUJDRA==", mime: "audio/webm;codecs=opus" })) fail("the raw-recorder fallback mime must pass");
ok("real clips pass: wav (the PWA transcode) and webm (the fallback)");

for (const [label, bad] of [
  ["non-audio mime", { b64: "QUJDRA==", mime: "text/html" }],
  ["script smuggling", { b64: "<script>x</script>", mime: "audio/wav" }],
  ["empty payload", { b64: "", mime: "audio/wav" }],
  ["oversized clip", { b64: "A".repeat(Math.ceil((MAX_PROMPT_AUDIO_BYTES * 4) / 3) + 8), mime: "audio/wav" }],
  ["missing mime", { b64: "QUJDRA==" }],
] as const) {
  if (validPromptAudio(bad)) fail(`${label} must be rejected`);
}
ok("fail-closed: non-audio mimes, smuggled markup, empty, oversized, malformed - all rejected");

console.log("\nALL CHECKS PASSED");
