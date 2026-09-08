// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/voice/voice_endpoint.test.ts - P-VOICE.7: the portable endpoint contract's fail-closed gate.
// Load-bearing bits: version/kind discipline (never guess at foreign files), the NO-SECRETS rule
// (credential-ish keys anywhere, or userinfo URLs, reject the whole file), and slug guarding (the id
// doubles as a filename stem, so it must never be able to path-traverse).

import { describe, expect, test } from "bun:test";
import { parseVoiceEndpointConfig } from "./voice_endpoint.ts";

const valid = () => ({
  kind: "lucid-voice-endpoint", version: 1, id: "nick-dgx", label: "Nick DGX",
  engine: "dots-tts", url: "http://127.0.0.1:8084", model: "rednote-hilab/dots.tts-soar",
  transport: { kind: "ssh-forward", command: "ssh -J alex@10.0.0.21 -N -L 8084:127.0.0.1:8084 nick@10.0.0.8" },
  exportedAt: 1757200000000, source: "dgx-loader 1.2.1",
});

describe("parseVoiceEndpointConfig", () => {
  test("accepts a full valid export and normalizes the url", () => {
    const r = parseVoiceEndpointConfig({ ...valid(), url: "http://127.0.0.1:8084/" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.url).toBe("http://127.0.0.1:8084");
      expect(r.config.label).toBe("Nick DGX");
      expect(r.config.transport?.kind).toBe("ssh-forward");
      expect(r.config.transport?.command).toContain("ssh -J");
    }
  });

  test("rejects foreign kinds and future versions instead of guessing", () => {
    expect(parseVoiceEndpointConfig({ ...valid(), kind: "something-else" }).ok).toBe(false);
    const v2 = parseVoiceEndpointConfig({ ...valid(), version: 2 });
    expect(v2.ok).toBe(false);
    if (!v2.ok) expect(v2.reason).toContain("version 1");
  });

  test("rejects credential-like keys ANYWHERE in the payload", () => {
    for (const bad of [
      { ...valid(), apiKey: "sk-123" },
      { ...valid(), transport: { kind: "https-proxy", bearerToken: "abc" } },
      { ...valid(), nested: { deep: { password: "hunter2" } } },
    ]) {
      const r = parseVoiceEndpointConfig(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain("credential-like");
    }
  });

  test("rejects urls with embedded userinfo or non-http schemes", () => {
    expect(parseVoiceEndpointConfig({ ...valid(), url: "http://user:pw@10.0.0.8:8084" }).ok).toBe(false);
    expect(parseVoiceEndpointConfig({ ...valid(), url: "ssh://10.0.0.8" }).ok).toBe(false);
    expect(parseVoiceEndpointConfig({ ...valid(), url: "not a url" }).ok).toBe(false);
  });

  test("slug-guards the id (it becomes a filename stem)", () => {
    for (const id of ["../escape", "UPPER", "a b", "", "x".repeat(65)]) {
      expect(parseVoiceEndpointConfig({ ...valid(), id }).ok).toBe(false);
    }
    expect(parseVoiceEndpointConfig({ ...valid(), id: "lab-spark-2" }).ok).toBe(true);
  });

  test("optional fields degrade gracefully; oversized free text is capped", () => {
    const minimal = parseVoiceEndpointConfig({ kind: "lucid-voice-endpoint", version: 1, id: "box", label: "Box", engine: "dots-tts", url: "https://dgx.example/voice" });
    expect(minimal.ok).toBe(true);
    if (minimal.ok) {
      expect(minimal.config.model).toBeUndefined();
      expect(minimal.config.transport).toBeUndefined();
    }
    const big = parseVoiceEndpointConfig({ ...valid(), transport: { kind: "ssh-forward", command: "x".repeat(2000) } });
    expect(big.ok).toBe(true);
    if (big.ok) expect(big.config.transport!.command!.length).toBeLessThanOrEqual(500);
  });
});
