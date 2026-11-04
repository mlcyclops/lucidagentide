// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/oauth_broker.ts - P-VAULT-KEYS.2 (ADR-0480): omp's own auth broker, run inside the engine over
// the vault-backed credential store, so omp's OAuth tokens are sealed at rest without forking omp.
//
// omp 18.8.6 ships both halves of a credential broker: `startAuthBroker` (pi-ai auth-broker/server.ts)
// wraps any AuthStorage in a loopback REST/SSE service, and every `omp acp` / `omp` started with
// OMP_AUTH_BROKER_URL + OMP_AUTH_BROKER_TOKEN reads and refreshes its credentials through it
// (RemoteAuthCredentialStore) and never opens agent.db for them. The engine:
//   1. opens VaultAuthCredentialStore (oauth_vault_store.ts) over the engine vault;
//   2. moves agent.db's credential rows into it (oauth_migration.ts) without a re-login;
//   3. wraps it in AuthStorage with the refresh hook omp's own `auth-broker serve` uses
//      (refreshBrokerOAuthCredential: per-provider refresh plus managed MCP OAuth rows);
//   4. boots startAuthBroker on 127.0.0.1 (an ephemeral port) with a per-launch random bearer token, and
//      puts URL + token in process.env, which every omp spawn inherits (acp.ts and acp_backend.ts spawn with
//      { ...process.env, ...overlay }: master, lanes and the util connection alike);
//   5. sets OMP_AUTH_BROKER_SNAPSHOT_TTL_MS=0: omp's client otherwise keeps an AES-GCM snapshot of the
//      ACCESS tokens in ~/.omp/cache/auth-broker-snapshot.enc keyed by the bearer token. The broker is
//      in-process and on loopback, so the cache buys no availability; with TTL 0 no access token is
//      written to disk at all (pi-ai auth-broker/discover.ts: no cache read, no cache write).
// LUCID's own sign-in runs IN-PROCESS against the same AuthStorage (`storage.oauth.login`, the primitive
// both `omp login` and `omp auth-broker login` drive), printing exactly what those CLIs print, so the
// existing URL capture, device-code scanner, pasted-code and Copilot-domain plumbing in dev.ts is unchanged.
//
// Modes: `vault` (all of the above), `off` (kill switch: LUCID_OAUTH_VAULT=0 or managed
// security.oauthVault=false, the old agent.db path), `legacy` (the vault was not usable and nothing had
// been moved yet: agent.db untouched, old path), `refused` (the vault once took the credentials and is not
// usable now: no broker, LUCID refuses OAuth sign-ins rather than write a token in plaintext).

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { AuthStorage, PASTE_CODE_LOGIN_PROVIDERS, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { startAuthBroker, type AuthBrokerServerHandle } from "@oh-my-pi/pi-ai/auth-broker";
import { refreshBrokerOAuthCredential } from "@oh-my-pi/pi-coding-agent/cli/auth-broker-cli";
import { VERSION } from "@oh-my-pi/pi-utils";
import { randomBytes } from "../harness/crypto/fips_crypto.ts"; // P-FIPS.1 (ADR-0473)
import { writeAtomic } from "./atomic_file.ts";
import { vaultPath } from "./auth_vault.ts";
import { migrateAgentDbOauth, type OauthMigrationResult } from "./oauth_migration.ts";
import { setOauthRowsTarget } from "./oauth_rows_target.ts";
import { OAUTH_VAULT_MARKER, oauthVaultKillSwitch, OauthVaultUnavailableError, VaultAuthCredentialStore } from "./oauth_vault_store.ts";
import { keyVaultDir } from "./settings_store.ts";

const LOGIN_TIMEOUT_MS = 15 * 60_000;

export type OauthVaultMode = "off" | "vault" | "legacy" | "refused";
export interface OauthVaultState {
  mode: OauthVaultMode;
  /** One line for the log and diagnostics. Never a token. */
  detail: string;
  /** The broker's loopback URL in `vault` mode. The bearer token is never exposed. */
  brokerUrl?: string;
  migration?: OauthMigrationResult;
}

export interface OauthVaultBootOptions {
  /** omp's credential db (default ~/.omp/agent/agent.db, the path auth_vault.ts reads). */
  agentDbPath?: string;
  /** Default: the engine vault of the current settings file. */
  vaultDir?: string;
  /** Record usage history into omp's own agent.db tables, where the budget reader looks (default true). */
  usageLedger?: boolean;
  /** Tests and demos: no background token refresher. */
  disableRefresher?: boolean;
}

let state: OauthVaultState = { mode: "off", detail: "not started" };
let running: { store: VaultAuthCredentialStore; storage: AuthStorage; handle: AuthBrokerServerHandle } | null = null;
const short = (e: unknown): string => String((e as Error)?.message ?? e).slice(0, 240);

export function oauthVaultState(): OauthVaultState {
  return state;
}

/** True while the engine's broker serves omp's credentials from the vault. */
export function oauthVaultActive(): boolean {
  return running !== null;
}

/** omp's agent.db is ONE file per OS account (~/.omp/agent/agent.db), shared by every LUCID profile on it.
 *  Only the default profile (its settings and engine vault in that same ~/.omp) moves it into its vault by
 *  default; any other profile (the Creator build, fleet profiles, a test or demo with its own settings file)
 *  keeps the agent.db path unless LUCID_OAUTH_VAULT=1 opts it in. Otherwise a scratch or side profile would
 *  carry the user's sign-ins off into a vault the main app never reads. */
function ownsDefaultAgentDb(): boolean {
  if (["1", "on", "true", "yes"].includes((process.env.LUCID_OAUTH_VAULT ?? "").trim().toLowerCase())) return true;
  const norm = (p: string): string => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  // engineVaultDir()'s default (beside ~/.omp/lucid-gui.json), spelled out: that helper would return a
  // LUCID_ENGINE_VAULT_DIR override instead, which is exactly the case this must tell apart.
  return norm(keyVaultDir()) === norm(join(homedir(), ".omp", "lucid-engine-vault"));
}

function settle(next: OauthVaultState): OauthVaultState {
  state = next;
  console.log(`[oauth-vault] ${next.mode}: ${next.detail}`);
  return next;
}

/** Boot the vault path once per engine, before any omp child is spawned. Never throws: every failure lands
 *  in `off`, `legacy` or `refused` with the reason in `detail`. */
export async function bootOauthVault(opts: OauthVaultBootOptions = {}): Promise<OauthVaultState> {
  if (running) return state;
  const vaultDir = opts.vaultDir ?? keyVaultDir();
  const marker = join(vaultDir, OAUTH_VAULT_MARKER);
  const authoritative = existsSync(marker);
  const off = oauthVaultKillSwitch();
  if (off) {
    // Never copied back to plaintext: sign-ins moved earlier wait sealed in the vault until the switch clears.
    const held = authoritative ? "; sign-ins moved into the vault earlier stay sealed there, unused, until the switch is cleared" : "";
    return settle({ mode: "off", detail: `OAuth credentials stay in omp's agent.db (${off})${held}` });
  }
  if (opts.agentDbPath === undefined && !ownsDefaultAgentDb()) {
    return settle({ mode: "off", detail: `this engine's vault (${vaultDir}) is not the default profile's, so omp's shared agent.db stays where it is (LUCID_OAUTH_VAULT=1 moves it into this vault)` });
  }
  const agentDbPath = opts.agentDbPath ?? vaultPath();

  let store: VaultAuthCredentialStore;
  try { store = VaultAuthCredentialStore.open({ vaultDir }); } catch (e) {
    return settle(authoritative
      ? { mode: "refused", detail: `the credential vault is not usable, so omp gets no stored sign-ins and new ones are refused (nothing falls back to plaintext): ${short(e)}` }
      : { mode: "legacy", detail: `the credential vault is not usable; OAuth credentials stay in omp's agent.db for now: ${short(e)}` });
  }
  if (!authoritative) {
    try {
      mkdirSync(vaultDir, { recursive: true, mode: 0o700 });
      writeAtomic(marker, JSON.stringify({ v: 1, since: Date.now() }));
    } catch (e) {
      store.close();
      return settle({ mode: "legacy", detail: `the vault directory is not writable; OAuth credentials stay in omp's agent.db for now: ${short(e)}` });
    }
  }
  const migration = migrateAgentDbOauth(store, agentDbPath);
  if (migration.refused && !authoritative) {
    store.close();
    try { rmSync(marker, { force: true }); } catch { /* an unremovable marker only makes a later unusable vault refuse */ }
    return settle({ mode: "legacy", detail: `OAuth credentials stay in omp's agent.db for now (${migration.refused})`, migration });
  }
  if (opts.usageLedger !== false) {
    try { store.setUsageLedger(await SqliteAuthCredentialStore.open(agentDbPath)); } catch (e) {
      console.warn(`[oauth-vault] usage history stays in memory (${short(e)})`);
    }
  }

  // The same AuthStorage shape `omp auth-broker serve` builds (pi-coding-agent cli/auth-broker-cli.ts).
  const storage = new AuthStorage(store, {
    refreshOAuthCredential: (provider, _credentialId, credential, signal) => refreshBrokerOAuthCredential(provider, credential, signal),
    refreshOAuthCredentialMints: true,
    sourceLabel: `LUCID engine vault ${vaultDir}`,
  });
  let handle: AuthBrokerServerHandle;
  try {
    await storage.credentials.reload();
    const token = randomBytes(32).toString("hex");
    handle = startAuthBroker({ storage, bind: "127.0.0.1:0", bearerTokens: [token], version: `${VERSION} (LUCID engine)`, disableRefresher: opts.disableRefresher });
    process.env.OMP_AUTH_BROKER_URL = handle.url;
    process.env.OMP_AUTH_BROKER_TOKEN = token;
    process.env.OMP_AUTH_BROKER_SNAPSHOT_TTL_MS = "0";
  } catch (e) {
    storage.close();
    store.close();
    // The marker stays: the rows are in the vault now, and the next boot serves them.
    return settle({ mode: "refused", detail: `the auth broker could not start, so omp gets no stored sign-ins this run: ${short(e)}`, migration });
  }
  setOauthRowsTarget({ db: store.db, write: (fn) => store.write(fn) });
  running = { store, storage, handle };
  const moved = migration.moved ? `; moved ${migration.moved} credential row(s) out of agent.db` : "";
  const left = migration.left ? `; ${migration.left} row(s) left in agent.db (${migration.refused ?? "rewritten during the move"}), retried next start` : "";
  const scrub = migration.scrubWarning ? `; ${migration.scrubWarning}` : "";
  return settle({ mode: "vault", detail: `omp's credentials are sealed in the engine vault and served by the auth broker at ${handle.url} (omp ${VERSION})${moved}${left}${scrub}`, brokerUrl: handle.url, migration });
}

/** Stop the broker and forget the env (tests, demos, an orderly shutdown). */
export async function stopOauthVault(): Promise<void> {
  const r = running;
  running = null;
  setOauthRowsTarget(null);
  delete process.env.OMP_AUTH_BROKER_URL;
  delete process.env.OMP_AUTH_BROKER_TOKEN;
  delete process.env.OMP_AUTH_BROKER_SNAPSHOT_TTL_MS;
  state = { mode: "off", detail: "stopped" };
  if (!r) return;
  await r.handle.close();
  r.storage.close();
  r.store.close();
}

// ── sign-in ──────────────────────────────────────────────────────────────────────────────────────────

/** What dev.ts's sign-in plumbing drives: a `Bun.spawn` of `omp auth-broker login` on the old path, or
 *  the in-process login below. Same streams, same text, same stdin protocol. */
export interface OauthLoginProcess {
  readonly stdin: { write(data: Uint8Array): unknown };
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
}

/** Start a sign-in for `oauthId`. Vault mode: in-process against the broker's AuthStorage (the credential
 *  lands sealed in the vault). Off / legacy: `legacy()` (omp's CLI, writing agent.db as before). Refused:
 *  throws, so no token is ever fetched that only plaintext could hold. */
export function startOauthLoginProcess(oauthId: string, legacy: () => OauthLoginProcess): OauthLoginProcess {
  if (state.mode === "refused") throw new OauthVaultUnavailableError(`sign-in refused: ${state.detail}`);
  return running ? inProcessLogin(running.storage, oauthId) : legacy();
}

/** `storage.oauth.login` behind the stream/stdin shape of the CLI it replaces, printing what
 *  runTerminalOAuthLogin (pi-coding-agent cli/oauth-terminal.ts) prints. Prompts read whole stdin lines in
 *  order; a line written before its prompt (Copilot's enterprise domain) waits for it. */
export function inProcessLogin(storage: AuthStorage, oauthId: string, timeoutMs = LOGIN_TIMEOUT_MS): OauthLoginProcess {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let out: ReadableStreamDefaultController<Uint8Array> | undefined;
  let err: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stdout = new ReadableStream<Uint8Array>({ start(c) { out = c; } });
  const stderr = new ReadableStream<Uint8Array>({ start(c) { err = c; } });
  // A reader that stopped reading (cancelled the stream) must never fail the sign-in itself.
  const emit = (c: ReadableStreamDefaultController<Uint8Array> | undefined, s: string): void => { try { c?.enqueue(enc.encode(s)); } catch { /* reader gone */ } };
  const print = (s: string): void => emit(out, s);

  let partial = "";
  const lines: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  const stdin = {
    write(data: Uint8Array): number {
      partial += dec.decode(data, { stream: true });
      for (let nl = partial.indexOf("\n"); nl >= 0; nl = partial.indexOf("\n")) {
        const line = partial.slice(0, nl).replace(/\r$/, "");
        partial = partial.slice(nl + 1);
        const take = waiters.shift();
        if (take) take(line); else lines.push(line);
      }
      return data.byteLength;
    },
  };

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error("Login timed out")), timeoutMs);
  timer.unref?.();
  const ask = (question: string, signal?: AbortSignal): Promise<string> => {
    print(question);
    const queued = lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise<string>((resolve, reject) => {
      const take = (line: string): void => { done(); resolve(line); };
      const cancel = (): void => {
        const i = waiters.indexOf(take);
        if (i >= 0) waiters.splice(i, 1);
        done();
        reject(new Error("Login cancelled"));
      };
      const done = (): void => { signal?.removeEventListener("abort", cancel); abort.signal.removeEventListener("abort", cancel); };
      waiters.push(take);
      signal?.addEventListener("abort", cancel, { once: true });
      abort.signal.addEventListener("abort", cancel, { once: true });
    });
  };

  const exited = storage.oauth.login(oauthId, {
    onAuth({ url, launchUrl, instructions }) {
      print(`\nOpen this URL in your browser:\n${url}\n`);
      if (launchUrl && launchUrl !== url) print(`Local shortcut (this machine only): ${launchUrl}\n`);
      if (instructions) print(`${instructions}\n`);
      print("\n");
    },
    onProgress(message) { print(`${message}\n`); },
    onPrompt(p) { return ask(`${p.message}${p.placeholder ? ` (${p.placeholder})` : ""}: `); },
    ...(PASTE_CODE_LOGIN_PROVIDERS.has(oauthId) ? { onManualCodeInput: (signal?: AbortSignal) => ask("Paste the authorization code (or full redirect URL): ", signal) } : {}),
    signal: abort.signal,
  }).then(
    (identity) => { print(identity ? "\nCredentials saved to the LUCID credential vault\n" : "No credentials were stored.\n"); return 0; },
    (e: unknown) => { emit(err, `Login failed: ${short(e)}\n`); return 1; },
  ).finally(() => {
    clearTimeout(timer);
    for (const c of [out, err]) { try { c?.close(); } catch { /* reader gone */ } }
  });
  return { stdin, stdout, stderr, exited };
}
