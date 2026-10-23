// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/kg_device_unlock.ts
//
// P-KGBIO.1 (ADR-0454): unlock the personal knowledge graph with the OS's own user verification -
// Windows Hello (face camera, fingerprint, or Hello PIN) or macOS Touch ID / Apple Watch - instead of
// typing the passphrase every launch. The passphrase stays the root of custody: it creates the store,
// it is the only way to ENROLL a device unlock, and it always still opens the store. A device unlock is a
// second, OS-gated copy of the store's data-encryption key (DEK), kept next to the store as
// `lucid-personal.kg.device.json`:
//
//   wrappedDek = AES-256-GCM(DEK, KEK)            KEK never touches disk in the clear
//   Windows:  KEK = HKDF-SHA256(sig, salt)        sig = a Windows Hello (TPM-backed, non-exportable RSA) key's
//                                                 PKCS#1 v1.5 signature over a random per-enrollment challenge.
//                                                 Deterministic, and only producible after a live Hello check.
//   macOS:    KEK = random, sealed by safeStorage (Keychain, bound to the app's code signature) and only
//             unsealed after systemPreferences.promptTouchID (Touch ID, a paired Apple Watch, or the login
//             password). That is an app-enforced gate, not a hardware binding; the ADR says so.
//
// MAIN-PROCESS ONLY. The DEK is derived here from the passphrase at enrollment, released here after the OS
// check, and handed to the engine's /api/personal/unlock-key over loopback. It never reaches the renderer.
// The CUI store is deliberately out of scope (ADR-0014: returning to CUI requires its passphrase).
//
// Dependency-injected (provider + io) so it unit-tests with no TPM, no Keychain, and no real filesystem.

import { createHash, hkdfSync, randomBytes } from "node:crypto";
import { decrypt, deriveKey, encrypt, KEY_LEN, type Sealed } from "../harness/personal/crypto.ts";
import type { Envelope } from "../harness/personal/store.ts";
import { runToText } from "./native_dialog.ts";

export const DEVICE_UNLOCK_VERSION = "lucid-kg-device.v1" as const;
const MAIN_STORE_VERSION = "personal-kg.v1"; // the CUI store (personal-cui.v1) is never device-unlocked

export type DeviceProviderKind = "windows-hello" | "macos-touch-id";

/** Why a device unlock did not produce a key. `cancelled` is the user's choice and is never an error toast. */
export type DeviceUnlockCode = "unsupported" | "cancelled" | "not-enrolled" | "stale" | "wrong-passphrase" | "no-store" | "failed";

export class DeviceUnlockError extends Error {
  constructor(readonly code: DeviceUnlockCode, message: string) { super(message); this.name = "DeviceUnlockError"; }
}

/** One OS-verification mechanism. Every create/open shows exactly one OS prompt. */
export interface DeviceKeyProvider {
  readonly kind: DeviceProviderKind;
  /** User-facing name: "Windows Hello", "Touch ID". */
  readonly label: string;
  available(): Promise<boolean>;
  /** Enroll: create the OS-bound secret and return the 32-byte KEK plus the NON-secret params to recover it. */
  create(storeId: string): Promise<{ kek: Buffer; params: Record<string, string> }>;
  /** Recover the KEK after a live OS check. Throws DeviceUnlockError (cancelled / not-enrolled / failed). */
  open(params: Record<string, string>): Promise<Buffer>;
  /** Remove any OS-side key material. Best-effort; the record file is removed by the caller regardless. */
  destroy(params: Record<string, string>): Promise<void>;
}

/** The on-disk device-unlock record. Nothing in it opens the store without the OS check. */
export interface DeviceRecord {
  v: typeof DEVICE_UNLOCK_VERSION;
  provider: DeviceProviderKind;
  /** Fingerprint of the store's passphrase envelope: a re-created store is detected as stale WITHOUT a prompt. */
  storeId: string;
  params: Record<string, string>;
  wrappedDek: Sealed;
  /** Unlock with the OS check as LUCID opens (the default once enrolled). */
  autoUnlock: boolean;
  createdAt: string;
}

export interface DeviceStatus {
  /** This machine offers a usable OS verification (Hello configured / Touch ID present). */
  supported: boolean;
  provider: DeviceProviderKind | null;
  label: string | null;
  enrolled: boolean;
  autoUnlock: boolean;
  /** A record exists but belongs to a different (re-created) store; it is ignored until re-enrolled. */
  stale: boolean;
}

export interface DeviceIo {
  /** File text, or null when absent/unreadable. One read; never exists-then-read (TOCTOU). */
  read(path: string): string | null;
  write(path: string, text: string): void;
  remove(path: string): void;
}

/** Stable, non-secret fingerprint of a passphrase-sealed store (format + KDF salt). */
export function storeIdOf(env: Pick<Envelope, "v" | "kdf">): string {
  return createHash("sha256").update(`${env.v}\n${env.kdf?.salt ?? ""}`).digest("hex").slice(0, 32);
}

function parseEnvelope(text: string | null): Envelope {
  if (text === null) throw new DeviceUnlockError("no-store", "There is no knowledge graph store yet - create one with a passphrase first.");
  let env: Envelope;
  try { env = JSON.parse(text) as Envelope; } catch { throw new DeviceUnlockError("failed", "The knowledge graph store could not be read."); }
  if (env.v !== MAIN_STORE_VERSION) throw new DeviceUnlockError("failed", `Device unlock only covers the main store (file is ${String(env.v)}).`);
  return env;
}

/** Recover the DEK from the passphrase envelope. THROWS wrong-passphrase (GCM auth) - the passphrase proof. */
export function dekFromPassphrase(storeText: string | null, passphrase: string): { dek: Buffer; storeId: string } {
  const env = parseEnvelope(storeText);
  if (env.custody !== "passphrase" || !env.kdf || !env.wrappedDek) throw new DeviceUnlockError("failed", "This store is not passphrase-sealed.");
  const kek = deriveKey(passphrase, Buffer.from(env.kdf.salt, "base64"), env.kdf.iters);
  try { return { dek: decrypt(env.wrappedDek, kek), storeId: storeIdOf(env) }; }
  catch { throw new DeviceUnlockError("wrong-passphrase", "Wrong passphrase."); }
  finally { kek.fill(0); }
}

function parseRecord(text: string | null): DeviceRecord | null {
  if (text === null) return null;
  try {
    const r = JSON.parse(text) as DeviceRecord;
    if (r?.v !== DEVICE_UNLOCK_VERSION || !r.wrappedDek || typeof r.storeId !== "string" || !r.params) return null;
    return r;
  } catch { return null; }
}

/** The device unlock for one store. `provider` is null where the platform has no supported mechanism. */
export class KgDeviceUnlock {
  constructor(private readonly deps: {
    provider: DeviceKeyProvider | null;
    io: DeviceIo;
    storePath: () => string;
    recordPath: () => string;
  }) {}

  #record(): DeviceRecord | null { return parseRecord(this.deps.io.read(this.deps.recordPath())); }
  #currentStoreId(): string | null {
    try { const env = parseEnvelope(this.deps.io.read(this.deps.storePath())); return env.custody === "passphrase" && env.kdf ? storeIdOf(env) : null; }
    catch { return null; }
  }

  async status(): Promise<DeviceStatus> {
    const p = this.deps.provider;
    const supported = p ? await p.available().catch(() => false) : false;
    const rec = this.#record();
    const matches = !!rec && !!p && rec.provider === p.kind && rec.storeId === this.#currentStoreId();
    return {
      supported, provider: p?.kind ?? null, label: p?.label ?? null,
      enrolled: matches, autoUnlock: matches && rec!.autoUnlock, stale: !!rec && !matches,
    };
  }

  /** Enroll (or re-enroll) this device. Proves the passphrase, shows ONE OS prompt, persists the record, and
   *  returns the DEK so the caller can unlock the engine right away. Replaces any prior record + OS key. */
  async enroll(passphrase: string, opts: { autoUnlock?: boolean } = {}): Promise<Buffer> {
    const p = this.deps.provider;
    if (!p || !(await p.available().catch(() => false))) throw new DeviceUnlockError("unsupported", "Device unlock is not available on this machine.");
    const { dek, storeId } = dekFromPassphrase(this.deps.io.read(this.deps.storePath()), passphrase);
    const prior = this.#record();
    if (prior && prior.provider === p.kind && prior.storeId !== storeId) await p.destroy(prior.params).catch(() => {});
    const { kek, params } = await p.create(storeId);
    try {
      const rec: DeviceRecord = {
        v: DEVICE_UNLOCK_VERSION, provider: p.kind, storeId, params, wrappedDek: encrypt(dek, kek),
        autoUnlock: opts.autoUnlock ?? true, createdAt: new Date().toISOString(),
      };
      this.deps.io.write(this.deps.recordPath(), JSON.stringify(rec));
      return dek;
    } finally { kek.fill(0); }
  }

  /** One OS prompt -> the store DEK. Throws DeviceUnlockError; never prompts for a stale record. */
  async unlock(): Promise<Buffer> {
    const p = this.deps.provider;
    if (!p) throw new DeviceUnlockError("unsupported", "Device unlock is not available on this machine.");
    const rec = this.#record();
    if (!rec || rec.provider !== p.kind) throw new DeviceUnlockError("not-enrolled", `${p.label} unlock is not set up - unlock with your passphrase and turn it on.`);
    if (rec.storeId !== this.#currentStoreId()) throw new DeviceUnlockError("stale", `Your knowledge graph store changed since ${p.label} unlock was set up - unlock with your passphrase and turn it on again.`);
    const kek = await p.open(rec.params);
    try { return decrypt(rec.wrappedDek, kek); }
    catch { throw new DeviceUnlockError("stale", `The ${p.label} key no longer matches - unlock with your passphrase and turn it on again.`); }
    finally { kek.fill(0); }
  }

  /** Flip auto-unlock-at-launch on an enrolled record. Returns false when there is nothing enrolled. */
  setAutoUnlock(on: boolean): boolean {
    const rec = this.#record();
    if (!rec) return false;
    this.deps.io.write(this.deps.recordPath(), JSON.stringify({ ...rec, autoUnlock: on }));
    return true;
  }

  /** Turn device unlock off: remove the OS key (best-effort) and the record. The passphrase is unaffected. */
  async forget(): Promise<void> {
    const rec = this.#record();
    if (rec && this.deps.provider && rec.provider === this.deps.provider.kind) await this.deps.provider.destroy(rec.params).catch(() => {});
    this.deps.io.remove(this.deps.recordPath());
  }
}

// ── Windows Hello: a TPM-backed KeyCredential, driven through PowerShell's WinRT projection ─────────────────

/** Stdout marker so host noise can never be read as a result. */
export const HELLO_MARK = "LUCID_HELLO::";
const HKDF_INFO = "lucid-kg-device.v1/windows-hello";

/** The PowerShell 5.1 script (exported for tests). Inputs arrive by env var, never by string splicing:
 *  LUCID_HELLO_OP = available | create | sign | delete, LUCID_HELLO_KEY, LUCID_HELLO_CHALLENGE (base64).
 *  `create` makes (or replaces) the named Hello key, then signs; `sign` opens the existing key and signs.
 *  Each shows one Windows Security prompt (face, fingerprint, or PIN). */
export function helloScript(): string {
  return `$ErrorActionPreference = 'Stop'
function Out-Hello($o) { [Console]::Out.WriteLine('${HELLO_MARK}' + ($o | ConvertTo-Json -Compress)) }
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Security.Credentials.KeyCredentialManager, Windows.Security.Credentials, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.IBuffer, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $ext = [System.WindowsRuntimeSystemExtensions]
  $asOp = $ext.GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' } | Select-Object -First 1
  $asAct = $ext.GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' } | Select-Object -First 1
  $bufx = [System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions]
  $toArray = $bufx.GetMethods() | Where-Object { $_.Name -eq 'ToArray' -and $_.GetParameters().Count -eq 1 } | Select-Object -First 1
  $fg = $false
  try { Add-Type -Name HelloFg -Namespace Lucid -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string w); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);'; $fg = $true } catch { }
  function Wait-Op($op, [Type]$t, [bool]$prompt = $false) {
    $task = $asOp.MakeGenericMethod($t).Invoke($null, @($op))
    if ($prompt -and $fg) { for ($i = 0; $i -lt 60 -and -not $task.Wait(100); $i++) { $h = [Lucid.HelloFg]::FindWindow('Credential Dialog Xaml Host', $null); if ($h -ne [IntPtr]::Zero) { [void][Lucid.HelloFg]::SetForegroundWindow($h); break } } }
    $task.Wait(); $task.Result
  }
  $kcm = [Windows.Security.Credentials.KeyCredentialManager]
  $ok = [Windows.Security.Credentials.KeyCredentialStatus]::Success
  $op = $env:LUCID_HELLO_OP
  $name = $env:LUCID_HELLO_KEY
  if ($op -eq 'available') { Out-Hello @{ ok = $true; available = [bool](Wait-Op ($kcm::IsSupportedAsync()) ([bool])) }; exit 0 }
  if ($op -eq 'delete') { try { $asAct.Invoke($null, @($kcm::DeleteAsync($name))).Wait() } catch { }; Out-Hello @{ ok = $true }; exit 0 }
  $rt = [Windows.Security.Credentials.KeyCredentialRetrievalResult]
  if ($op -eq 'create') { $r = Wait-Op ($kcm::RequestCreateAsync($name, [Windows.Security.Credentials.KeyCredentialCreationOption]::ReplaceExisting)) $rt $true }
  elseif ($op -eq 'sign') { $r = Wait-Op ($kcm::OpenAsync($name)) $rt }
  else { Out-Hello @{ ok = $false; status = 'BadOp' }; exit 0 }
  if ($r.Status -ne $ok) { Out-Hello @{ ok = $false; status = [string]$r.Status }; exit 0 }
  $challenge = $bufx::AsBuffer([Convert]::FromBase64String($env:LUCID_HELLO_CHALLENGE))
  $s = Wait-Op ($r.Credential.RequestSignAsync($challenge)) ([Windows.Security.Credentials.KeyCredentialOperationResult]) $true
  if ($s.Status -ne $ok) { Out-Hello @{ ok = $false; status = [string]$s.Status }; exit 0 }
  $sig = [byte[]]$toArray.Invoke($null, @($s.Result))
  Out-Hello @{ ok = $true; signature = [Convert]::ToBase64String($sig) }
} catch { Out-Hello @{ ok = $false; status = 'Error'; error = $_.Exception.Message } }
`;
}

export interface HelloReply { ok: boolean; status?: string; error?: string; available?: boolean; signature?: string }

/** Parse the helper's marker line (exported for tests). Missing marker -> a failed reply carrying stderr. */
export function parseHelloReply(stdout: string, stderr = ""): HelloReply {
  const at = stdout.lastIndexOf(HELLO_MARK);
  if (at < 0) return { ok: false, status: /language mode/i.test(stderr) ? "ConstrainedLanguage" : "NoReply", error: stderr.trim().slice(0, 200) };
  try { return JSON.parse(stdout.slice(at + HELLO_MARK.length).split(/\r?\n/, 1)[0] ?? "") as HelloReply; }
  catch { return { ok: false, status: "NoReply" }; }
}

/** Map a non-ok helper reply to the error the UI shows (exported for tests). */
export function helloError(r: HelloReply): DeviceUnlockError {
  switch (r.status) {
    case "UserCanceled": return new DeviceUnlockError("cancelled", "Windows Hello was cancelled.");
    case "UserPrefersPassword": return new DeviceUnlockError("cancelled", "Use your passphrase instead.");
    case "NotFound": return new DeviceUnlockError("not-enrolled", "The Windows Hello key for LUCID is gone - unlock with your passphrase and turn Windows Hello unlock on again.");
    case "SecurityDeviceLocked": return new DeviceUnlockError("failed", "Windows Hello is locked out (too many attempts). Unlock with your passphrase.");
    case "ConstrainedLanguage": return new DeviceUnlockError("unsupported", "PowerShell is in Constrained Language Mode (Smart App Control or WDAC), which blocks the Windows Hello bridge.");
    default: return new DeviceUnlockError("failed", `Windows Hello did not complete${r.error ? `: ${r.error}` : r.status ? ` (${r.status})` : ""}.`);
  }
}

export type HelloRunner = (env: Record<string, string>) => Promise<{ stdout: string; stderr: string }>;

/** The real runner: powershell.exe with the script as -EncodedCommand (no stdin line-parsing quirks). */
export const powershellHelloRunner: HelloRunner = async (env) => {
  const encoded = Buffer.from(helloScript(), "utf16le").toString("base64");
  const r = await runToText(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { env });
  return { stdout: r.stdout, stderr: r.stderr };
};

export function windowsHelloProvider(run: HelloRunner = powershellHelloRunner): DeviceKeyProvider {
  const call = async (env: Record<string, string>): Promise<HelloReply> => { const r = await run(env); return parseHelloReply(r.stdout, r.stderr); };
  const sign = async (op: "create" | "sign", params: Record<string, string>): Promise<Buffer> => {
    const r = await call({ LUCID_HELLO_OP: op, LUCID_HELLO_KEY: params.keyName ?? "", LUCID_HELLO_CHALLENGE: params.challenge ?? "" });
    if (!r.ok || !r.signature) throw helloError(r);
    return Buffer.from(hkdfSync("sha256", Buffer.from(r.signature, "base64"), Buffer.from(params.salt ?? "", "base64"), HKDF_INFO, KEY_LEN));
  };
  return {
    kind: "windows-hello",
    label: "Windows Hello",
    available: async () => { const r = await call({ LUCID_HELLO_OP: "available" }); return r.ok && r.available === true; },
    create: async (storeId) => {
      const params = { keyName: `LUCID Knowledge Graph ${storeId.slice(0, 12)}`, challenge: randomBytes(32).toString("base64"), salt: randomBytes(32).toString("base64") };
      return { kek: await sign("create", params), params };
    },
    open: (params) => sign("sign", params),
    destroy: async (params) => { await call({ LUCID_HELLO_OP: "delete", LUCID_HELLO_KEY: params.keyName ?? "" }); },
  };
}

// ── macOS: Touch ID / Apple Watch gate over a safeStorage-sealed KEK ──────────────────────────────────────

/** The slices of Electron's systemPreferences + safeStorage this provider uses. */
export interface MacAuthLike {
  canPromptTouchID(): boolean;
  promptTouchID(reason: string): Promise<void>;
}
export interface MacSealLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

const TOUCH_ID_REASON = "unlock your LUCID knowledge graph";

export function macTouchIdProvider(auth: MacAuthLike, seal: MacSealLike): DeviceKeyProvider {
  const prompt = async (): Promise<void> => {
    try { await auth.promptTouchID(TOUCH_ID_REASON); }
    catch (e) { throw new DeviceUnlockError("cancelled", `Touch ID did not complete: ${String((e as Error)?.message ?? e)}`); }
  };
  return {
    kind: "macos-touch-id",
    label: "Touch ID",
    available: async () => { try { return auth.canPromptTouchID() && seal.isEncryptionAvailable(); } catch { return false; } },
    create: async () => {
      await prompt(); // enrollment proves presence the same way unlock will
      const kek = randomBytes(KEY_LEN);
      return { kek, params: { sealedKek: seal.encryptString(kek.toString("base64")).toString("base64") } };
    },
    open: async (params) => {
      await prompt();
      try { return Buffer.from(seal.decryptString(Buffer.from(params.sealedKek ?? "", "base64")), "base64"); }
      catch { throw new DeviceUnlockError("not-enrolled", "The Keychain no longer holds LUCID's Touch ID key - unlock with your passphrase and turn Touch ID unlock on again."); }
    },
    destroy: async () => { /* the sealed KEK lives only in the record, which the caller removes */ },
  };
}
