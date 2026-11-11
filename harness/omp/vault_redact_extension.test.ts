// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// SECRET-INTAKE-AGENT-ENV-READBACK (wave B security review, finding 2): vault values that reach a tool
// result through the agent's own env (`printenv`, `echo $NAME`) come back to the model as `[vault:NAME]`.
// The pure redactor carries the encoding cases; the registration tests fake pi the way
// tool_meta_extension.test.ts does and drive the registered handler with a fake tool_result.

import { describe, expect, test } from "bun:test";
import vaultRedactExtension, {
  buildRedactor, DETAILS_WITHHELD_NOTICE, MIN_REDACT_LENGTH, redactToolResult, redactVaultValues, WITHHELD_NOTICE, withheldResult,
} from "./vault_redact_extension.ts";

const TOKEN = "sk-test-9f8e7d6c5b4a3f2e1d0c";
const QUOTED = 'pa"ss\\word/with+chars?';
const SECRETS = [{ name: "OPENAI_API_KEY", value: TOKEN }];

describe("redactVaultValues", () => {
  test("plain value in printenv output", () => {
    const out = redactVaultValues(`PATH=/usr/bin\nOPENAI_API_KEY=${TOKEN}\nHOME=/home/u`, SECRETS);
    expect(out).toBe("PATH=/usr/bin\nOPENAI_API_KEY=[vault:OPENAI_API_KEY]\nHOME=/home/u");
    expect(out).not.toContain(TOKEN);
  });

  test("JSON-escaped value inside a JSON blob", () => {
    const blob = JSON.stringify({ env: { DB_PASSWORD: QUOTED }, ok: true });
    expect(blob).not.toContain(QUOTED); // the raw value is not in the blob, only its escaped form
    const out = redactVaultValues(blob, [{ name: "DB_PASSWORD", value: QUOTED }]);
    expect(out).toBe('{"env":{"DB_PASSWORD":"[vault:DB_PASSWORD]"},"ok":true}');
    expect(out).not.toContain(JSON.stringify(QUOTED).slice(1, -1));
  });

  test("base64, base64url and URL-encoded forms", () => {
    const b64 = Buffer.from(QUOTED).toString("base64");
    const b64url = Buffer.from(QUOTED).toString("base64url");
    const url = encodeURIComponent(QUOTED);
    const secrets = [{ name: "DB_PASSWORD", value: QUOTED }];
    for (const form of [b64, b64url, url]) {
      const out = redactVaultValues(`token: ${form} end`, secrets);
      expect(out).toContain("[vault:DB_PASSWORD]");
      expect(out).not.toContain(form.replace(/=+$/, ""));
    }
    expect(redactVaultValues(`echo ${Buffer.from(TOKEN).toString("base64")} | base64 -d`, SECRETS)).not.toContain(
      Buffer.from(TOKEN).toString("base64").replace(/=+$/, ""),
    );
  });

  test(`a value under ${MIN_REDACT_LENGTH} characters is not redacted`, () => {
    expect(redactVaultValues("mode=dev5 and dev5 again", [{ name: "MODE", value: "dev5" }])).toBe("mode=dev5 and dev5 again");
    expect(buildRedactor([{ name: "MODE", value: "abcde" }])("abcde")).toBe("abcde");
    expect(buildRedactor([{ name: "MODE", value: "abcdef" }])("abcdef")).toBe("[vault:MODE]");
  });

  test("longest value first: a value containing another redacts as a whole", () => {
    const inner = "abcdef123456";
    const outer = `${inner}-suffix-xyz`;
    const out = redactVaultValues(`a=${outer} b=${inner}`, [{ name: "SHORT", value: inner }, { name: "LONG", value: outer }]);
    expect(out).toBe("a=[vault:LONG] b=[vault:SHORT]");
  });

  test("a value that names an Object.prototype member is still redacted", () => {
    expect(redactVaultValues("v=toString", [{ name: "ODD", value: "toString" }])).toBe("v=[vault:ODD]");
    expect(redactVaultValues("v=__proto__", [{ name: "ODD", value: "__proto__" }])).toBe("v=[vault:ODD]");
  });

  test("regex metacharacters in a value are matched literally", () => {
    expect(redactVaultValues("x a.c*d+e(f) y", [{ name: "META", value: "a.c*d+e(f)" }])).toBe("x [vault:META] y");
    expect(redactVaultValues("x abbcdddef y", [{ name: "META", value: "a.c*d+e(f)" }])).toBe("x abbcdddef y");
  });
});

describe("redactToolResult", () => {
  const redact = buildRedactor(SECRETS);

  test("rewrites text parts and string details, leaves images and other fields alone", () => {
    const image = { type: "image" as const, data: "iVBORw0K", mimeType: "image/png" };
    const out = redactToolResult(redact, {
      type: "tool_result",
      toolName: "bash",
      content: [{ type: "text", text: `key=${TOKEN}` }, image],
      details: { exitCode: 0, output: [`${TOKEN}\n`], meta: { path: "/tmp/x" } },
      isError: false,
    });
    expect(out?.content).toEqual([{ type: "text", text: "key=[vault:OPENAI_API_KEY]" }, image]);
    expect(out?.content?.[1]).toBe(image);
    expect(out?.details).toEqual({ exitCode: 0, output: ["[vault:OPENAI_API_KEY]\n"], meta: { path: "/tmp/x" } });
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  test("returns undefined when nothing matched, so omp keeps the original result", () => {
    expect(redactToolResult(redact, { content: [{ type: "text", text: "clean" }], details: { a: 1 } })).toBeUndefined();
    expect(redactToolResult(redact, null)).toBeUndefined();
  });

  test("a cyclic details object does not throw, and cannot be checked, so it is dropped", () => {
    // The walk stops at the cycle, so the copy would still point at the original (unredacted) object.
    const details: Record<string, unknown> = { note: TOKEN };
    details.self = details;
    const out = redactToolResult(redact, { content: [], details });
    expect(out).toEqual({ details: null, content: [{ type: "text", text: DETAILS_WITHHELD_NOTICE }] });
  });

  test("a secret inside a class instance in details is caught by the serialized check: details dropped, content marked", () => {
    class Holder {
      #hidden = "not serialized";
      constructor(readonly env: string) {}
      toString(): string { return `Holder(${this.#hidden})`; }
    }
    class Opaque { toString(): string { return `opaque ${TOKEN}`; } }
    for (const inner of [new Holder(`OPENAI_API_KEY=${TOKEN}`), new Opaque(), new Map([["k", TOKEN]]), new Set([TOKEN])]) {
      const out = redactToolResult(redact, { content: [{ type: "text", text: "ran" }], details: { result: inner } });
      expect(out?.details).toBeNull();
      expect(out?.content).toEqual([{ type: "text", text: "ran" }, { type: "text", text: DETAILS_WITHHELD_NOTICE }]);
      expect(JSON.stringify(out)).not.toContain(TOKEN);
    }
    // A clean class instance (a Date, a buffer) keeps the details as they were.
    expect(redactToolResult(redact, { content: [{ type: "text", text: "ran" }], details: { at: new Date(0), buf: Buffer.from("clean") } })).toBeUndefined();
  });
});

describe("vaultRedactExtension registration", () => {
  const withEnv = <T>(vars: Record<string, string | undefined>, run: () => T): T => {
    const prior: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
      prior[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try { return run(); } finally {
      for (const [k, v] of Object.entries(prior)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  test("registers a tool_result handler that redacts a vault value from the agent's env", () => {
    withEnv({ LUCID_VAULT_REDACT_NAMES: "LUCID_TEST_WS_SECRET, LUCID_TEST_MISSING", LUCID_TEST_WS_SECRET: TOKEN, LUCID_TEST_MISSING: undefined }, () => {
      const events: string[] = [];
      let handler: ((event: unknown) => unknown) | undefined;
      vaultRedactExtension({ on: (event: string, h: (event: unknown) => unknown) => { events.push(event); handler = h; } });
      expect(events).toEqual(["tool_result"]);
      const blob = JSON.stringify({ value: TOKEN });
      const b64 = Buffer.from(TOKEN).toString("base64");
      const out = handler?.({
        type: "tool_result",
        toolName: "mcp__github_get_env",
        toolCallId: "c1",
        input: {},
        content: [{ type: "text", text: `$ printenv\nLUCID_TEST_WS_SECRET=${TOKEN}\n${blob}\n${b64}` }],
        details: undefined,
        isError: false,
      }) as { content: Array<{ type: string; text: string }> };
      const text = out.content[0]!.text;
      const padding = b64.slice(b64.replace(/=+$/, "").length); // unpadded needle: the "=" padding stays behind
      expect(text).toBe(`$ printenv\nLUCID_TEST_WS_SECRET=[vault:LUCID_TEST_WS_SECRET]\n{"value":"[vault:LUCID_TEST_WS_SECRET]"}\n[vault:LUCID_TEST_WS_SECRET]${padding}`);
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(b64.replace(/=+$/, ""));
    });
  });

  test("registers NOTHING without LUCID_VAULT_REDACT_NAMES", () => {
    withEnv({ LUCID_VAULT_REDACT_NAMES: undefined }, () => {
      const events: string[] = [];
      vaultRedactExtension({ on: (event: string) => { events.push(event); } });
      expect(events).toEqual([]);
    });
  });

  test("registers NOTHING when the named vars are unset, invalid, or shorter than the threshold", () => {
    withEnv({ LUCID_VAULT_REDACT_NAMES: " , LUCID_TEST_SHORT,LUCID_TEST_UNSET,bad-name", LUCID_TEST_SHORT: "abc", LUCID_TEST_UNSET: undefined }, () => {
      const events: string[] = [];
      vaultRedactExtension({ on: (event: string) => { events.push(event); } });
      expect(events).toEqual([]);
    });
  });

  const RESULT = { type: "tool_result", toolName: "bash", toolCallId: "c2", input: {}, content: [{ type: "text", text: `OPENAI_API_KEY=${TOKEN}` }], details: { stdout: TOKEN }, isError: false };

  test("FAIL-CLOSED: a result the redactor throws on is withheld, never passed through", () => {
    withEnv({ LUCID_VAULT_REDACT_NAMES: "LUCID_TEST_WS_SECRET", LUCID_TEST_WS_SECRET: TOKEN }, () => {
      let handler: ((event: unknown) => unknown) | undefined;
      const throwing = () => () => { throw new Error(`regex blew up near ${TOKEN}`); };
      vaultRedactExtension({ on: (_event: string, h: (event: unknown) => unknown) => { handler = h; } }, { build: throwing });
      const out = handler?.(RESULT);
      expect(out).toEqual(withheldResult());
      expect(out).toEqual({ content: [{ type: "text", text: WITHHELD_NOTICE }], details: null, isError: true });
      expect(JSON.stringify(out)).not.toContain(TOKEN);
    });
  });

  test("FAIL-CLOSED: a redactor that cannot be built withholds EVERY tool result", () => {
    withEnv({ LUCID_VAULT_REDACT_NAMES: "LUCID_TEST_WS_SECRET", LUCID_TEST_WS_SECRET: TOKEN }, () => {
      const events: string[] = [];
      let handler: ((event: unknown) => unknown) | undefined;
      const broken = () => { throw new Error("cannot compile"); };
      vaultRedactExtension({ on: (event: string, h: (event: unknown) => unknown) => { events.push(event); handler = h; } }, { build: broken });
      expect(events).toEqual(["tool_result"]); // registered, not skipped
      expect(handler?.(RESULT)).toEqual(withheldResult());
      expect(handler?.({ ...RESULT, content: [{ type: "text", text: "harmless" }], details: undefined })).toEqual(withheldResult());
    });
  });

  test("never throws: a junk pi, a throwing on(), or a junk event", () => {
    withEnv({ LUCID_VAULT_REDACT_NAMES: "LUCID_TEST_WS_SECRET", LUCID_TEST_WS_SECRET: TOKEN }, () => {
      expect(() => vaultRedactExtension({})).not.toThrow();
      expect(() => vaultRedactExtension(null)).not.toThrow();
      expect(() => vaultRedactExtension({ on: () => { throw new Error("boom"); } })).not.toThrow();
      let handler: ((event: unknown) => unknown) | undefined;
      vaultRedactExtension({ on: (_event: string, h: (event: unknown) => unknown) => { handler = h; } });
      for (const junk of [null, undefined, 7, "x", { content: "not-an-array" }, { content: [null, { type: "text", text: 5 }] }]) {
        expect(() => handler?.(junk)).not.toThrow();
      }
    });
  });
});
