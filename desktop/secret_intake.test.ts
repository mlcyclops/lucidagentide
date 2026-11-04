// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-SECRET-INTAKE.1 (ADR-0476): the agent-triggered secret flow, engine side. Load-bearing:
//   - the tool's result is only {stored, ref, envName} or {stored:false, reason}: the value is in no
//     result, event, audit line or HTTP response;
//   - cancel, timeout and an aborted call resolve stored:false and store nothing;
//   - a value pasted in chat (an extra argument, or a key inside name/purpose) is never what is stored;
//   - the notepad fallback's file sits outside synced folders and the workspace and is gone after the read;
//   - over HTTP, only a requester token (the master's, in the header) opens /api/secret/request and names
//     the requester; the UI routes take the header UI token only; the stored value is really in the vault;
//   - reserved env names are refused, only provider key envs may be global, replacing a saved entry needs
//     a second confirmation, and a reserved key:<ENV> never reaches process.env (security review);
//   - the "another secrets manager?" answer never fakes a destination;
//   - the built-in skill exists (the frozen prompt prefix is not touched by this slice).
// The OS key store is an in-memory fake and every path is a temp dir.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { _setVaultBackendForTest } from "./engine_vault.ts";
import { INSTALLED_SKILLS } from "./renderer/skills.ts";
import { startFallback } from "./secret_fallback.ts";
import {
  defaultIntakeDeps, MAX_PENDING_SECRET_REQUESTS, normalizeSecretValue, parseSecretRequest, readSecretManagerPreference,
  recordSecretManager, SecretIntake, type SecretIntakeDeps,
} from "./secret_intake.ts";
import type { SecretIntakeResult, SecretRequestView } from "./secret_intake_view.ts";
import { handleSecretRoutes } from "./secret_routes.ts";
import { isSyncedPath } from "./synced_path.ts";
import { _resetVaultEnvForTest } from "./vault_env.ts";
import { afterWrite } from "./vault_routes.ts";
import { vaultDelete, vaultGet, vaultPut, type VaultEntryMeta, type VaultPutInput } from "./vault_store.ts";

const ENV_KEYS = ["LUCID_GUI_SETTINGS_FILE", "LUCID_ENGINE_VAULT_DIR", "LUCID_OMP_MODELS_YAML", "LUCID_DATA_ROOT", "LUCID_ADDON_DIR", "OPENAI_API_KEY", "NODE_OPTIONS"] as const;
const ENV_BEFORE = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const dirs: string[] = [];
const scratch = (): string => { const d = mkdtempSync(join(tmpdir(), "lucid-intake-test-")); dirs.push(d); return d; };
afterEach(() => { _setVaultBackendForTest(null); _resetVaultEnvForTest(); });
afterAll(() => {
  for (const k of ENV_KEYS) { const v = ENV_BEFORE[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const CHAT_PASTED = "sk-pasted-into-chat-AAAAAAAAAAAAAAAAAAAAAAAA";
const DIALOG_VALUE = "sk-typed-into-dialog-BBBBBBBBBBBBBBBBBBBBBBBB";

/** In-memory deps: a Map vault, captured dialogs and audit lines. */
function fakeDeps(over: Partial<SecretIntakeDeps> = {}) {
  const vault = new Map<string, string>();
  const shown: SecretRequestView[] = [];
  const audit: string[] = [];
  const puts: VaultPutInput[] = [];
  const deps: SecretIntakeDeps = {
    emit: (v) => { shown.push(v); },
    put: (input) => {
      puts.push(input);
      vault.set(input.ref, input.value);
      const meta: VaultEntryMeta = { ref: input.ref, label: input.label ?? input.ref, kind: input.kind, source: input.source, addedAt: 1, updatedAt: 1, ...(input.envName ? { envName: input.envName } : {}) };
      return meta;
    },
    existing: (ref) => (vault.has(ref) ? { ref, label: `saved ${ref}`, kind: "apikey", source: "typed", addedAt: 1, updatedAt: 1, last4: "9999" } : null),
    deriveRef: (env, ws, label) => (env ? (ws ? `ws:test:${env}` : `key:${env}`) : `secret:${label.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`),
    afterWrite: () => {},
    workspace: () => tmpdir(),
    audit: (decision, reason) => { audit.push(`${decision} ${reason}`); },
    fallback: () => { throw new Error("no fallback in this test"); },
    now: () => 1_000,
    timeoutMs: 60_000,
    ...over,
  };
  return { deps, vault, shown, audit, puts };
}
const ask = { name: "OpenAI API key", kind: "apikey", purpose: "To run the embedding script.", envName: "OPENAI_API_KEY" };

/** Open a request and collect its answer in one long hold (what the route's poll loop amounts to). */
function collect(intake: SecretIntake, raw: unknown): Promise<SecretIntakeResult> {
  const opened = intake.open(raw, "Main agent");
  if ("result" in opened) return Promise.resolve(opened.result);
  return intake.wait(opened.id, 60_000).then((r) => r ?? { stored: false, reason: "still pending after the hold" });
}

describe("request_secret never returns a value", () => {
  test("stored: the result is exactly {stored, ref, envName}; the value is only in the vault", async () => {
    const f = fakeDeps();
    const intake = new SecretIntake(f.deps);
    const pending = collect(intake, ask);
    expect(f.shown.length).toBe(1);
    const view = f.shown[0]!;
    expect(intake.pending().map((p) => p.id)).toEqual([view.id]);
    const s = intake.submit(view.id, `  ${DIALOG_VALUE}\n`, "dialog");
    expect(s.ok).toBe(true);
    const result = await pending;
    expect(result).toEqual({ stored: true, ref: "key:OPENAI_API_KEY", envName: "OPENAI_API_KEY" });
    expect(f.vault.get("key:OPENAI_API_KEY")).toBe(DIALOG_VALUE); // trimmed, as stored
    expect(f.puts[0]!.source).toBe("agent-request");
    for (const surface of [JSON.stringify(result), JSON.stringify(f.shown), f.audit.join("\n")]) expect(surface).not.toContain(DIALOG_VALUE);
    expect(intake.pending()).toEqual([]);
  });

  test("a value pasted in chat is not what is stored: an extra `value` argument is ignored", async () => {
    const f = fakeDeps();
    const intake = new SecretIntake(f.deps);
    const pending = collect(intake, { ...ask, value: CHAT_PASTED, secret: CHAT_PASTED });
    expect(JSON.stringify(f.shown)).not.toContain(CHAT_PASTED);
    intake.submit(f.shown[0]!.id, DIALOG_VALUE, "dialog");
    await pending;
    expect([...f.vault.values()]).toEqual([DIALOG_VALUE]);
  });

  test("a secret pasted into the name or purpose is refused before any dialog opens", async () => {
    const f = fakeDeps();
    const intake = new SecretIntake(f.deps);
    const r = await collect(intake, { ...ask, purpose: `Use ${CHAT_PASTED} for the script` });
    expect(r.stored).toBe(false);
    expect(JSON.stringify(r)).not.toContain(CHAT_PASTED);
    expect(f.shown).toEqual([]);
    expect(f.vault.size).toBe(0);
  });
});

describe("stored:false outcomes store nothing", () => {
  test("the user cancels", async () => {
    const f = fakeDeps();
    const intake = new SecretIntake(f.deps);
    const pending = collect(intake, ask);
    expect(intake.cancel(f.shown[0]!.id)).toBe(true);
    expect(await pending).toEqual({ stored: false, reason: "cancelled" });
    expect(f.vault.size).toBe(0);
    expect(intake.submit(f.shown[0]!.id, DIALOG_VALUE, "dialog")).toMatchObject({ ok: false, code: "not-found" });
    expect(f.vault.size).toBe(0);
  });

  test("nobody answers before the deadline", async () => {
    const f = fakeDeps({ timeoutMs: 5 });
    const intake = new SecretIntake(f.deps);
    expect(await collect(intake, ask)).toEqual({ stored: false, reason: "timeout" });
    expect(intake.pending()).toEqual([]);
  });

  test("the agent's call is withdrawn (Stop)", async () => {
    const f = fakeDeps();
    const intake = new SecretIntake(f.deps);
    const pending = collect(intake, ask);
    expect(intake.withdraw(f.shown[0]!.id)).toBe(true);
    expect(await pending).toEqual({ stored: false, reason: "cancelled" });
    expect(intake.pending()).toEqual([]);
  });

  test("an answer that lands between two agent polls is kept for the next poll", async () => {
    const f = fakeDeps();
    const intake = new SecretIntake(f.deps);
    const opened = intake.open(ask, "Main agent");
    if (!("id" in opened)) throw new Error("not opened");
    expect(await intake.wait(opened.id, 0)).toBeNull(); // still waiting: the route answers {pending, id}
    intake.submit(opened.id, DIALOG_VALUE, "dialog");
    expect(await intake.wait(opened.id, 0)).toEqual({ stored: true, ref: "key:OPENAI_API_KEY", envName: "OPENAI_API_KEY" });
    expect(await intake.wait(opened.id, 0)).toMatchObject({ stored: false }); // collected once
  });

  test("an empty capture and a vault refusal keep the request open for another try", async () => {
    let refuse = true;
    const f = fakeDeps();
    const put = f.deps.put;
    f.deps.put = (i) => { if (refuse) throw new Error("vault unavailable"); return put(i); };
    const intake = new SecretIntake(f.deps);
    const pending = collect(intake, ask);
    const id = f.shown[0]!.id;
    expect(intake.submit(id, "   \n", "dialog")).toMatchObject({ ok: false, code: "empty" });
    expect(intake.submit(id, DIALOG_VALUE, "dialog")).toMatchObject({ ok: false, code: "refused" });
    expect(intake.pending().length).toBe(1);
    refuse = false;
    expect(intake.submit(id, DIALOG_VALUE, "dialog").ok).toBe(true);
    expect((await pending).stored).toBe(true);
  });

  test("invalid arguments and too many waiting requests are refused without a dialog", async () => {
    const f = fakeDeps();
    const intake = new SecretIntake(f.deps);
    expect((await collect(intake, { ...ask, envName: "BAD NAME" })).stored).toBe(false);
    expect((await collect(intake, { name: "x", kind: "token", purpose: "y", workspaceScoped: true })).stored).toBe(false);
    expect((await collect(intake, { kind: "token", purpose: "y" })).stored).toBe(false);
    expect(f.shown).toEqual([]);
    for (let i = 0; i < MAX_PENDING_SECRET_REQUESTS; i++) void collect(intake, { ...ask, envName: `K${i}` });
    expect(await collect(intake, ask)).toMatchObject({ stored: false });
    expect(f.shown.length).toBe(MAX_PENDING_SECRET_REQUESTS);
    for (const p of intake.pending()) intake.cancel(p.id);
  });
});

describe("text-file fallback through the intake", () => {
  test("the file is outside synced folders and the workspace, and is gone once the secret is stored", async () => {
    const base = scratch();
    const workspace = scratch();
    const opened: string[] = [];
    const ticks: Array<() => void> = [];
    const f = fakeDeps({
      workspace: () => workspace,
      fallback: (o) => startFallback({
        ...o, bases: [base], restrict: () => {}, userOnly: () => true,
        openEditor: (p) => { opened.push(p); }, ticker: (t) => { ticks.push(t); return () => {}; },
      }),
    });
    const intake = new SecretIntake(f.deps);
    const pending = collect(intake, { ...ask, kind: "pem", envName: "TLS_KEY", name: "TLS private key" });
    const id = f.shown[0]!.id;
    const start = intake.startFallback(id);
    if (!start.ok) throw new Error(start.error);
    expect(opened).toEqual([start.path]);
    expect(isSyncedPath(start.path)).toBe(false);
    expect(relative(workspace, start.path).startsWith("..")).toBe(true);
    const pem = "-----BEGIN PRIVATE KEY-----\r\nMIIB\r\n-----END PRIVATE KEY-----\r\n";
    writeFileSync(start.path, pem);
    for (const t of ticks) t();
    for (const t of ticks) t();
    const out = await intake.awaitFallback(id);
    expect(out.ok).toBe(true);
    // TLS_KEY is no provider key env, so it is kept to the workspace (SECRET-INTAKE-ENVNAME-UNRESTRICTED).
    expect(await pending).toEqual({ stored: true, ref: "ws:test:TLS_KEY", envName: "TLS_KEY" });
    expect(f.vault.get("ws:test:TLS_KEY")).toBe("-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----");
    expect(existsSync(start.path)).toBe(false);
    expect(existsSync(dirname(start.path))).toBe(false);
    expect(f.audit.join("\n")).not.toContain("MIIB");
  });

  test("cancelling while the text file is open wipes and deletes it", async () => {
    const base = scratch();
    const workspace = scratch(); // the default fake workspace is tmpdir() itself, which would rule out every base
    const f = fakeDeps({ workspace: () => workspace, fallback: (o) => startFallback({ ...o, bases: [base], restrict: () => {}, userOnly: () => true, openEditor: () => {}, ticker: () => () => {} }) });
    const intake = new SecretIntake(f.deps);
    const pending = collect(intake, ask);
    const id = f.shown[0]!.id;
    const start = intake.startFallback(id);
    if (!start.ok) throw new Error(start.error);
    writeFileSync(start.path, DIALOG_VALUE);
    intake.cancel(id);
    expect(await pending).toEqual({ stored: false, reason: "cancelled" });
    expect(existsSync(start.path)).toBe(false);
    expect(f.vault.size).toBe(0);
  });
});

describe("pure rules", () => {
  test("only the declared fields are parsed; unknown kinds fall back to other", () => {
    const r = parseSecretRequest({ name: "n\u202Eame", kind: "API_KEY", purpose: " p ", envName: "A_B", value: CHAT_PASTED });
    expect(r).toEqual({ ok: true, request: { name: "n ame", kind: "other", purpose: "p", envName: "A_B", workspaceScoped: true } });
  });
  test("normalizeSecretValue trims single-line secrets and keeps PEM lines with LF endings", () => {
    expect(normalizeSecretValue("\uFEFF tok \r\n", "token")).toBe("tok");
    expect(normalizeSecretValue("\r\n-----BEGIN X-----\r\nab\r\n-----END X-----\r\n", "pem")).toBe("-----BEGIN X-----\nab\n-----END X-----");
  });
});

describe("HTTP: tokens, the real vault, and no value on the wire", () => {
  function useVault(): void {
    const root = scratch();
    process.env.LUCID_GUI_SETTINGS_FILE = join(root, "lucid-gui.json");
    process.env.LUCID_OMP_MODELS_YAML = join(root, "models.yml");
    process.env.LUCID_DATA_ROOT = root;
    process.env.LUCID_ADDON_DIR = join(root, "no-addon");
    delete process.env.LUCID_ENGINE_VAULT_DIR;
    let held: Buffer | null = randomBytes(32);
    _setVaultBackendForTest(() => ({
      kind: "dpapi" as const,
      read: () => (held ? Buffer.from(held) : { missing: "absent" as const }),
      create: (k: Buffer) => { held = Buffer.from(k); return true; },
    }));
  }
  const ui = (path: string, body?: unknown, token = "ui-token"): Request =>
    new Request(`http://127.0.0.1${path}`, body === undefined
      ? { headers: { "x-lucid-token": token } }
      : { method: "POST", headers: { "x-lucid-token": token, "content-type": "application/json" }, body: JSON.stringify(body) });
  const MASTER = [{ token: "master-token", label: "Main agent" }];
  /** A request_secret POST as the master's extension sends it: the request token in the header. */
  const asMaster = (body: unknown, token = "master-token"): Request =>
    new Request("http://127.0.0.1/api/secret/request", { method: "POST", headers: { "x-lucid-token": token, "content-type": "application/json" }, body: JSON.stringify(body) });

  test("agent asks, user answers on the UI routes, the value lands in the vault and on no response", async () => {
    useVault();
    const shown = Promise.withResolvers<SecretRequestView>();
    const intake = new SecretIntake({ ...defaultIntakeDeps((v) => shown.resolve(v)), audit: () => {} });
    const ctx = { uiToken: "ui-token", requesters: MASTER, emit: () => {}, intake };
    const wire: string[] = [];
    const call = async (req: Request, path: string) => { const r = (await handleSecretRoutes(req, path, ctx))!; const t = await r.text(); wire.push(t); return { status: r.status, body: JSON.parse(t) }; };

    const agent = call(asMaster({ ...ask, value: CHAT_PASTED }), "/api/secret/request");
    const view = await shown.promise;
    expect(view.requester).toBe("Main agent");
    const listed = await call(ui("/api/secret/pending"), "/api/secret/pending");
    expect(listed.body.data.requests.map((r: SecretRequestView) => r.id)).toEqual([view.id]);
    const stored = await call(ui("/api/secret/submit", { id: view.id, value: DIALOG_VALUE }), "/api/secret/submit");
    expect(stored.status).toBe(200);
    expect(stored.body.data).toMatchObject({ stored: true, ref: "key:OPENAI_API_KEY", envName: "OPENAI_API_KEY" });
    const answered = await agent;
    expect(answered.body).toEqual({ ok: true, data: { stored: true, ref: "key:OPENAI_API_KEY", envName: "OPENAI_API_KEY" } });
    expect(vaultGet("key:OPENAI_API_KEY")).toBe(DIALOG_VALUE);
    for (const t of wire) { expect(t).not.toContain(DIALOG_VALUE); expect(t).not.toContain(CHAT_PASTED); }
  });

  test("the agent polls by id while the user decides, and a withdraw (Stop) ends the request", async () => {
    const f = fakeDeps();
    const intake = new SecretIntake(f.deps);
    const ctx = { uiToken: "ui-token", requesters: MASTER, emit: () => {}, intake, holdMs: 0 };
    const agent = async (b: unknown) => (await (await handleSecretRoutes(asMaster(b), "/api/secret/request", ctx))!.json()).data;
    const first = await agent(ask);
    expect(first).toEqual({ pending: true, id: f.shown[0]!.id });
    expect(await agent({ id: first.id })).toEqual({ pending: true, id: first.id });
    expect(await agent({ id: first.id, withdraw: true })).toEqual({ stored: false, reason: "cancelled" });
    expect(intake.pending()).toEqual([]);
    expect(f.vault.size).toBe(0);
  });

  test("only a requester token in the header opens the request route; UI routes take the header UI token only", async () => {
    useVault();
    const intake = new SecretIntake({ ...fakeDeps().deps });
    const ctx = { uiToken: "ui-token", requesters: MASTER, emit: () => {}, intake, holdMs: 0 };
    const status = async (req: Request, p: string) => (await handleSecretRoutes(req, p, ctx))!.status;
    expect(await status(new Request("http://127.0.0.1/api/secret/request?t=ui-token", { method: "POST", body: "{}" }), "/api/secret/request")).toBe(403);
    // SECRET-INTAKE-REQUESTER-SPOOF: the request token in a query string, the UI token or the shared agent
    // token in the header are all refused; only the master's own token opens a request.
    expect(await status(new Request("http://127.0.0.1/api/secret/request?t=master-token", { method: "POST", body: "{}" }), "/api/secret/request")).toBe(403);
    expect(await status(asMaster({}, "ui-token"), "/api/secret/request")).toBe(403);
    expect(await status(asMaster({}, "agent-token"), "/api/secret/request")).toBe(403);
    expect(await status(asMaster({}), "/api/secret/request")).toBe(200);
    expect(await status(ui("/api/secret/pending", undefined, "master-token"), "/api/secret/pending")).toBe(403);
    expect(await status(new Request("http://127.0.0.1/api/secret/pending?t=ui-token"), "/api/secret/pending")).toBe(403);
    expect(await status(ui("/api/secret/pending"), "/api/secret/pending")).toBe(200);
    expect(await handleSecretRoutes(ui("/api/other"), "/api/other", ctx)).toBeNull();
  });

  test("a picked key file is read by the engine, stored, and left unchanged", async () => {
    useVault();
    const f = fakeDeps();
    const intake = new SecretIntake(f.deps);
    const ctx = { uiToken: "ui-token", requesters: MASTER, emit: () => {}, intake };
    const pending = collect(intake, { ...ask, kind: "json", envName: "GCP_SA" });
    const keyFile = join(scratch(), "sa.json");
    writeFileSync(keyFile, "{\"type\":\"service_account\"}\n");
    const r = (await handleSecretRoutes(ui("/api/secret/submit-file", { id: f.shown[0]!.id, path: keyFile }), "/api/secret/submit-file", ctx))!;
    expect(r.status).toBe(200);
    expect(await r.text()).not.toContain("service_account");
    expect(await pending).toEqual({ stored: true, ref: "ws:test:GCP_SA", envName: "GCP_SA" }); // no provider key env: workspace-scoped
    expect(f.vault.get("ws:test:GCP_SA")).toBe("{\"type\":\"service_account\"}");
    expect(readFileSync(keyFile, "utf8")).toBe("{\"type\":\"service_account\"}\n");
  });

  test("SECRET-INTAKE-REQUESTER-SPOOF: the dialog names the caller bound to the token, never a body field", async () => {
    const f = fakeDeps();
    const intake = new SecretIntake(f.deps);
    const ctx = { uiToken: "ui-token", requesters: [...MASTER, { token: "lane-token", label: "Lane alpha" }], emit: () => {}, intake, holdMs: 0 };
    await handleSecretRoutes(asMaster({ ...ask, requester: "LUCID Security" }, "lane-token"), "/api/secret/request", ctx);
    expect(f.shown.map((v) => v.requester)).toEqual(["Lane alpha"]);
    for (const p of intake.pending()) intake.cancel(p.id);
  });

  test("SECRET-INTAKE-ENVNAME-UNRESTRICTED: a reserved key:<ENV> written to the vault never reaches process.env", () => {
    useVault();
    process.env.NODE_OPTIONS = "--before";
    vaultPut({ ref: "key:NODE_OPTIONS", value: "--require=/tmp/evil.js", kind: "other", source: "typed" });
    afterWrite("key:NODE_OPTIONS");
    expect(process.env.NODE_OPTIONS).toBe("--before");
    vaultDelete("key:NODE_OPTIONS");
    afterWrite("key:NODE_OPTIONS"); // a delete must not unset the engine's own value either
    expect(process.env.NODE_OPTIONS).toBe("--before");
    vaultPut({ ref: "key:OPENAI_API_KEY", value: DIALOG_VALUE, kind: "apikey", source: "typed" });
    afterWrite("key:OPENAI_API_KEY");
    expect(process.env.OPENAI_API_KEY).toBe(DIALOG_VALUE);
  });
});

describe("SECRET-INTAKE-ENVNAME-UNRESTRICTED: env names an agent may ask for", () => {
  test("reserved names are refused before any dialog opens", async () => {
    const reserved = ["NODE_OPTIONS", "PATH", "Path", "HTTPS_PROXY", "no_proxy", "OPENAI_BASE_URL", "AZURE_OPENAI_ENDPOINT", "LUCID_GIT_PAT", "GIT_SSH_COMMAND",
      "PYTHONPATH", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "NODE_EXTRA_CA_CERTS", "BASH_ENV", "ENV", "OMP_CONFIG", "LD_PRELOAD"];
    const f = fakeDeps();
    const intake = new SecretIntake(f.deps);
    for (const envName of reserved) {
      const parsed = parseSecretRequest({ ...ask, envName });
      expect(parsed.ok).toBe(false);
      expect((await collect(intake, { ...ask, envName, workspaceScoped: true })).stored).toBe(false);
    }
    expect(f.shown).toEqual([]);
  });
  test("only a provider key env may be global; any other name is kept to the workspace", () => {
    const provider = parseSecretRequest(ask);
    expect(provider.ok && provider.request.workspaceScoped).toBe(false);
    const other = parseSecretRequest({ ...ask, envName: "STRIPE_SECRET_KEY" });
    expect(other.ok && other.request.workspaceScoped).toBe(true);
    const f = fakeDeps();
    const intake = new SecretIntake(f.deps);
    void collect(intake, { ...ask, envName: "STRIPE_SECRET_KEY" });
    expect(f.shown[0]!.ref).toBe("ws:test:STRIPE_SECRET_KEY");
    expect(f.shown[0]!.workspace).not.toBeNull();
    intake.cancel(f.shown[0]!.id);
  });
  test("replacing a saved entry needs the second confirmation that names it", async () => {
    const f = fakeDeps();
    f.vault.set("key:OPENAI_API_KEY", "sk-the-users-own-key-CCCCCCCCCCCCCCCC");
    const intake = new SecretIntake(f.deps);
    const pending = collect(intake, ask);
    const view = f.shown[0]!;
    expect(view.replaces).toBe(true);
    expect(view.replacesLabel).toBe("saved key:OPENAI_API_KEY (ends in 9999)");
    const refused = intake.submit(view.id, DIALOG_VALUE, "dialog");
    expect(refused).toMatchObject({ ok: false, code: "confirm-replace" });
    expect(f.vault.get("key:OPENAI_API_KEY")).toBe("sk-the-users-own-key-CCCCCCCCCCCCCCCC");
    expect(intake.startFallback(view.id)).toMatchObject({ ok: false });
    expect(intake.pending().length).toBe(1);
    expect(intake.submit(view.id, DIALOG_VALUE, "dialog", true).ok).toBe(true);
    expect(await pending).toMatchObject({ stored: true, ref: "key:OPENAI_API_KEY" });
    expect(f.vault.get("key:OPENAI_API_KEY")).toBe(DIALOG_VALUE);
  });
});

describe("another secrets manager: never a fake destination", () => {
  const file = () => join(scratch(), "secret-intake.json");
  test("without the enterprise add-on the answer is recorded and called an Enterprise feature", () => {
    const f = file();
    const r = recordSecretManager({ answer: "azure-kv", name: "Prod KV" }, { kmsInstalled: false, store: null, file: f, now: 5 });
    expect(r).toMatchObject({ saved: false, recorded: true, enterprise: false });
    expect(r.detail).toContain("Enterprise");
    expect(readSecretManagerPreference(f)).toEqual({ answer: "azure-kv", name: "Prod KV", recordedAt: 5 });
  });
  test("with the add-on and a store, the destination is saved with non-secret config only", () => {
    const seen: unknown[] = [];
    const store = { upsert: (i: { name: string; kind: string; config: Record<string, string> }) => { seen.push(i); return { id: "d1", name: i.name, kind: i.kind }; } };
    const r = recordSecretManager({ answer: "azure-kv", name: "Prod KV", config: { vaultName: "kv-prod", cloud: "usgov", auth: "azure-cli", clientSecret: "x" } }, { kmsInstalled: true, store, file: file(), now: 5 });
    expect(r).toMatchObject({ saved: true, recorded: true, enterprise: true });
    expect(seen).toEqual([{ name: "Prod KV", kind: "azure-kv", config: { vaultName: "kv-prod", cloud: "usgov", auth: "azure-cli" } }]);
  });
  test("a store that refuses (incomplete config) is reported, not hidden; no store wired is reported too", () => {
    const refusing = { upsert: () => { throw new Error("vaultName is required"); } };
    const r = recordSecretManager({ answer: "azure-kv" }, { kmsInstalled: true, store: refusing, file: file(), now: 5 });
    expect(r).toMatchObject({ saved: false, recorded: true, enterprise: true });
    expect(r.detail).toContain("vaultName is required");
    expect(recordSecretManager({ answer: "aws-sm" }, { kmsInstalled: true, store: null, file: file(), now: 5 })).toMatchObject({ saved: false, recorded: true });
  });
  test("a secret-looking name or config value is refused and nothing is recorded", () => {
    const f = file();
    const r = recordSecretManager({ answer: "azure-kv", config: { clientId: CHAT_PASTED } }, { kmsInstalled: true, store: null, file: f, now: 5 });
    expect(r).toMatchObject({ saved: false, recorded: false });
    expect(existsSync(f)).toBe(false);
  });
});

describe("teaching the agent", () => {
  const DASH = /[\u2013\u2014]/;
  const HIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/;
  test("the long-form skill exists, names request_secret, and is clean text", () => {
    const md = readFileSync(join(import.meta.dir, "..", ".agents", "skills", "secret-intake", "SKILL.md"), "utf8");
    expect(md).toMatch(/^---\r?\nname: secret-intake\r?\n/);
    expect(md).toContain("request_secret");
    expect(DASH.test(md)).toBe(false);
    expect(HIDDEN.test(md)).toBe(false);
  });
  test("the built-in skill ships in every flavor and prefers request_secret over chat", () => {
    const s = INSTALLED_SKILLS.find((x) => x.command === "secret-intake");
    expect(s).toBeDefined();
    expect(s!.flavors).toBeUndefined();
    expect(s!.systemPrompt).toContain("request_secret");
    expect(DASH.test(s!.systemPrompt)).toBe(false);
  });
  test("the slice adds no prompt-prefix text: the assembler never mentions request_secret", () => {
    const assembler = readFileSync(join(import.meta.dir, "..", "harness", "prompt", "assembler.ts"), "utf8");
    expect(assembler).not.toContain("request_secret");
  });
});
