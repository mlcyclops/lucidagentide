// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/device_code.test.ts - P-PROV.3: the guarded device-code reader (issue #490's acceptance list).

import { describe, expect, test } from "bun:test";
import { DEVICE_LOGIN_ALIASES, DeviceCodeScanner, deviceUrlAllowed, extractDeviceCode, isShowCodeLogin, vaultProviderFor } from "./device_code.ts";

const OMP_OUT = "Initiating device authorization\u2026\n\nOpen this URL in your browser:\nhttps://auth.openai.com/codex/device\nEnter code: LT9B-4W72V\n\nWaiting for browser authorization (code: LT9B-4W72V)\u2026\n";

describe("extractDeviceCode", () => {
  test("reads omp's real broker transcript: the code after `Enter code:`, upper-cased", () => {
    expect(extractDeviceCode(OMP_OUT)).toBe("LT9B-4W72V");
    expect(extractDeviceCode(OMP_OUT.replace("LT9B-4W72V\n", "lt9b-4w72v\n"))).toBe("LT9B-4W72V");
  });

  test("#490: a code-shaped path BEFORE the instruction is never the code", () => {
    const gem = "Codex home: /tmp/gem-codex-login-abc123\nSession: CODEX-LOGIN\nEnter this one-time code: ABCD-EFGH\n";
    expect(extractDeviceCode(gem)).toBe("ABCD-EFGH");
    expect(extractDeviceCode("Codex home: /tmp/CODEX-LOGIN\nstill starting\n")).toBeNull();
  });

  test("the code may sit on its own line under the instruction, but not two lines down or after other words", () => {
    expect(extractDeviceCode("Enter code:\n  WXYZ-1234\n")).toBe("WXYZ-1234");
    expect(extractDeviceCode("Enter code:\n\nWXYZ-1234\n")).toBeNull();
    expect(extractDeviceCode("Enter code: your code is WXYZ-1234\n")).toBeNull();
    expect(extractDeviceCode("Enter code: WXYZ-1234 (expires soon)\n")).toBeNull();
  });

  test("ANSI colour and cursor sequences around the prompt and the code are invisible", () => {
    const colored = "\u001b[1;32mEnter code:\u001b[0m \u001b[36mLT9B-4W72V\u001b[0m\n";
    expect(extractDeviceCode(colored)).toBe("LT9B-4W72V");
    expect(extractDeviceCode("\u001b]0;title\u0007Enter code: AAAA-BBBB\n")).toBe("AAAA-BBBB");
  });

  test("a code cut by a chunk boundary is not accepted until its line completes (unless the stream ended)", () => {
    expect(extractDeviceCode("Enter code: LT9B-4W72")).toBeNull();
    expect(extractDeviceCode("Enter code: LT9B-4W72", true)).toBe("LT9B-4W72");
    expect(extractDeviceCode("Enter code: LT9B-4W72V\n")).toBe("LT9B-4W72V");
  });
});

describe("DeviceCodeScanner", () => {
  test("resolves across chunk splits in the URL, the instruction, and the code itself", () => {
    const s = new DeviceCodeScanner();
    expect(s.push("Open this URL in your browser:\nhttps://auth.open")).toBeNull();
    expect(s.push("ai.com/codex/device\nEnter co")).toBeNull();
    expect(s.push("de: LT9B-")).toBeNull();
    expect(s.push("4W72V\n\nWaiting")).toBe("LT9B-4W72V");
    expect(s.push("more output, Enter code: ZZZZ-9999\n")).toBe("LT9B-4W72V"); // first complete code wins
  });

  test("keeps a bounded tail: a long preamble never grows the buffer, and the code still resolves", () => {
    const s = new DeviceCodeScanner(256);
    for (let i = 0; i < 50; i++) expect(s.push("x".repeat(100) + "\n")).toBeNull();
    expect(s.push("Enter code: QQQQ-RRRR\n")).toBe("QQQQ-RRRR");
  });
});

describe("login aliases and the device URL allowlist", () => {
  test("openai-codex-device files its credential under openai-codex; plain ids map to themselves", () => {
    expect(vaultProviderFor("openai-codex-device")).toBe("openai-codex");
    expect(vaultProviderFor("openai-codex")).toBe("openai-codex");
    expect(vaultProviderFor("xai-oauth")).toBe("xai-oauth");
    expect(isShowCodeLogin("openai-codex-device")).toBe(true);
    expect(isShowCodeLogin("xai-oauth")).toBe(false);
    expect(Object.keys(DEVICE_LOGIN_ALIASES)).toEqual(["openai-codex-device"]);
  });

  test("only https on the alias's exact host may be opened", () => {
    expect(deviceUrlAllowed("openai-codex-device", "https://auth.openai.com/codex/device")).toBe(true);
    expect(deviceUrlAllowed("openai-codex-device", "http://auth.openai.com/codex/device")).toBe(false);
    expect(deviceUrlAllowed("openai-codex-device", "https://auth.openai.com.evil.example/codex/device")).toBe(false);
    expect(deviceUrlAllowed("openai-codex-device", "https://evil.example/?auth.openai.com")).toBe(false);
    expect(deviceUrlAllowed("openai-codex-device", "not a url")).toBe(false);
    expect(deviceUrlAllowed("xai-oauth", "https://auth.openai.com/codex/device")).toBe(false);
  });
});
