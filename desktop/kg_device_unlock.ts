// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/kg_device_unlock.ts
//
// P-KGBIO.1 (ADR-0454): unlock the personal knowledge graph with the OS's own user verification -
// Windows Hello (face camera, fingerprint, or Hello PIN) or macOS Touch ID (Secure Enclave) - instead of
// typing the passphrase every launch. Each mechanism is a PROTECTOR in the store's Lucid Vault Protector
// Spec v1 file (harness/personal/protectors.ts; the Hub's protectors.json format): one more AES-256-GCM
// wrapping of the store key (the spec's VMK), bound to its entry by the AAD. The password protector stays
// the mandatory recovery root: it is the only way to ENROLL a device protector, and it always still opens
// the store.
//
//   hello             spec §4.1. A Windows Hello KeyCredential (TPM-backed, non-exportable RSA) signs the
//                     entry's random 32-byte `challenge`; KEK = HKDF-SHA256(signature, info
//                     "lucid-vmk-v1|hello"). PKCS#1 v1.5 is deterministic, and the signature exists only
//                     after a live Hello check. Entry fields: challenge, key_name.
//   sep               spec §4.4. A Secure Enclave P-256 key-agreement key (CryptoKit, access control
//                     `.privateKeyUsage | .biometryCurrentSet`: Touch ID with the CURRENT fingers, no password
//                     fallback; adding a fingerprint kills the key). Created by bin/lucid-sep
//                     (tools/macsep/lucid_sep.swift). The private key never leaves the enclave; its opaque
//                     `se_key` blob works only on this Mac. KEK = HKDF-SHA256(ECDH(eph, enclave key), info
//                     "lucid-vmk-v1|sep"): the ephemeral private half is discarded at enrollment, so only a
//                     live Touch ID match inside the enclave can redo the agreement. Entry fields: se_key,
//                     eph_pub.
//   auto_unlock       IDE field on a device entry: unlock with that check as LUCID opens.
//
// MAIN-PROCESS ONLY. The VMK is unwrapped here (password at enrollment, the OS check at unlock) and handed
// to the engine's /api/personal/unlock-key over loopback. It never reaches the renderer. The CUI store has
// no protector file and is never device-unlocked (ADR-0014: returning to CUI requires its passphrase).
//
// The provider is injected, so this unit-tests with no TPM and no Secure Enclave.

import { createECDH, hkdfSync, randomBytes } from "node:crypto";
import { KEY_LEN } from "../harness/personal/crypto.ts";
import {
  newEntry, ProtectorError, readProtectors, unlockWithPassword, unwrapEntry, vmkCheckOk, withoutProtector, withProtector, writeProtectors,
  type ProtectorDoc, type ProtectorEntry, type ProtectorType,
} from "../harness/personal/protectors.ts";
import { runToText } from "./native_dialog.ts";

export type DeviceProtectorType = Exclude<ProtectorType, "password">;

/** Why a device unlock did not produce a key. `cancelled` is the user's choice and is never an error toast. */
export type DeviceUnlockCode = "unsupported" | "cancelled" | "not-enrolled" | "mismatch" | "wrong-passphrase" | "no-store" | "failed";

export class DeviceUnlockError extends Error {
  constructor(readonly code: DeviceUnlockCode, message: string) { super(message); this.name = "DeviceUnlockError"; }
}

/** One OS-verification mechanism. Every create/open shows exactly one OS prompt. */
export interface DeviceKeyProvider {
  readonly type: DeviceProtectorType;
  /** User-facing name: "Windows Hello", "Touch ID". */
  readonly label: string;
  available(): Promise<boolean>;
  /** A paired companion (Apple Watch) can also satisfy the check, and the name then shown. Absent = none. */
  readonly companion?: { label: string; available(): Promise<boolean> };
  /** Enroll: create the OS-bound secret for entry `entryId`, accepting the companion when asked; return the
   *  32-byte KEK and the entry's PUBLIC fields. */
  create(entryId: string, opts: { companion: boolean }): Promise<{ kek: Buffer; fields: Record<string, string> }>;
  /** Recover the KEK after a live OS check. Throws DeviceUnlockError (cancelled / not-enrolled / failed). */
  open(entry: ProtectorEntry): Promise<Buffer>;
  /** Remove any OS-side key material. Best-effort; the entry is removed by the caller regardless. */
  destroy(entry: ProtectorEntry): Promise<void>;
}

export interface DeviceStatus {
  /** This machine offers a usable OS verification (Hello configured / Touch ID present). */
  supported: boolean;
  provider: DeviceProtectorType | null;
  label: string | null;
  /** The protector file holds an entry of this provider's type. */
  enrolled: boolean;
  autoUnlock: boolean;
  /** A companion (Apple Watch) is set up on this machine, so enrollment can offer it. */
  companionAvailable: boolean;
  /** The enrolled entry also accepts the companion. */
  companion: boolean;
  /** Set when the protector file exists but is unusable (fail closed: nothing is offered). */
  problem: string | null;
}

/** The device protector for the main store's protector file. `provider` is null where the platform has none. */
export class KgDeviceUnlock {
  constructor(private readonly deps: { provider: DeviceKeyProvider | null; protectorsPath: () => string }) {}

  /** The protector file, or a DeviceUnlockError: none yet (no-store) or unusable (failed). */
  #doc(): ProtectorDoc {
    let doc: ProtectorDoc | null;
    try { doc = readProtectors(this.deps.protectorsPath()); }
    catch (e) { throw new DeviceUnlockError("failed", `The store's protector file is unusable: ${(e as Error).message}.`); }
    if (!doc) throw new DeviceUnlockError("no-store", "Unlock your knowledge graph with its passphrase first.");
    return doc;
  }
  #provider(): DeviceKeyProvider {
    if (!this.deps.provider) throw new DeviceUnlockError("unsupported", "Device unlock is not available on this machine.");
    return this.deps.provider;
  }

  async status(): Promise<DeviceStatus> {
    const p = this.deps.provider;
    const supported = p ? await p.available().catch(() => false) : false;
    let entry: ProtectorEntry | undefined;
    let problem: string | null = null;
    try { entry = p ? this.#doc().protectors.find((e) => e.type === p.type) : undefined; }
    catch (e) { if ((e as DeviceUnlockError).code !== "no-store") problem = (e as Error).message; }
    const companionAvailable = p?.companion ? await p.companion.available().catch(() => false) : false;
    const companion = entry?.companion === true;
    return {
      supported, provider: p?.type ?? null, label: companion && p?.companion ? p.companion.label : (p?.label ?? null),
      enrolled: !!entry, autoUnlock: !!entry && entry.auto_unlock !== false, companionAvailable, companion, problem,
    };
  }

  /** Enroll (or re-enroll) this device: prove the passphrase through the password protector, show ONE OS
   *  prompt, and add the entry (replacing this type's previous one, whose OS key is then destroyed). Returns
   *  the VMK, which the caller owns and must zero. `companion` also accepts a paired Apple Watch; it is fixed
   *  into the OS key at creation, so changing it later is a re-enrollment (passphrase again). */
  async enroll(passphrase: string, opts: { autoUnlock?: boolean; companion?: boolean } = {}): Promise<Buffer> {
    const p = this.#provider();
    if (!(await p.available().catch(() => false))) throw new DeviceUnlockError("unsupported", `${p.label} is not set up on this device.`);
    const companion = opts.companion === true;
    if (companion && !(p.companion && await p.companion.available().catch(() => false))) throw new DeviceUnlockError("unsupported", "Apple Watch unlock is not set up on this Mac (System Settings > Touch ID & Password > Apple Watch).");
    let vmk: Buffer;
    try { vmk = unlockWithPassword(this.#doc(), passphrase); }
    catch (e) {
      if (e instanceof DeviceUnlockError) throw e;
      throw e instanceof ProtectorError && e.code === "auth" ? new DeviceUnlockError("wrong-passphrase", "Wrong passphrase.") : new DeviceUnlockError("failed", (e as Error).message);
    }
    try {
      const id = randomBytes(8).toString("hex");
      const { kek, fields } = await p.create(id, { companion });
      const label = companion && p.companion ? p.companion.label : p.label;
      let entry: ProtectorEntry;
      try { entry = newEntry(kek, vmk, p.type, label, { ...fields, auto_unlock: opts.autoUnlock ?? true, ...(companion ? { companion: true } : {}) }, id); } finally { kek.fill(0); }
      // Re-read after the prompt: the file may have changed while the user looked at the camera. The entry is
      // added only to a document whose vmk_check this VMK still satisfies.
      const doc = this.#doc();
      if (!vmkCheckOk(vmk, doc.vmk_check)) throw new DeviceUnlockError("failed", "The store's key changed while enrolling - try again.");
      const prior = doc.protectors.find((e) => e.type === p.type);
      writeProtectors(this.deps.protectorsPath(), withProtector(doc, entry));
      if (prior) await p.destroy(prior).catch(() => {});
      return vmk;
    } catch (e) { vmk.fill(0); throw e; }
  }

  /** One OS prompt -> the VMK, proven against the file's vmk_check. Throws DeviceUnlockError. */
  async unlock(): Promise<Buffer> {
    const p = this.#provider();
    let doc: ProtectorDoc;
    try { doc = this.#doc(); }
    catch (e) { throw (e as DeviceUnlockError).code === "no-store" ? new DeviceUnlockError("not-enrolled", `${p.label} unlock is not set up.`) : e; }
    const entry = doc.protectors.find((e) => e.type === p.type);
    if (!entry) throw new DeviceUnlockError("not-enrolled", `${p.label} unlock is not set up - unlock with your passphrase and turn it on.`);
    const kek = await p.open(entry);
    try { return unwrapEntry(doc, entry, kek); }
    catch { throw new DeviceUnlockError("mismatch", `The ${p.label} key no longer matches - unlock with your passphrase and turn ${p.label} unlock on again.`); }
    finally { kek.fill(0); }
  }

  /** Flip auto-unlock-at-launch on the enrolled entry (a public field; the wrap is untouched). */
  setAutoUnlock(on: boolean): boolean {
    const found = this.#enrolledEntry();
    if (!found) return false;
    writeProtectors(this.deps.protectorsPath(), withProtector(found.doc, { ...found.entry, auto_unlock: on }));
    return true;
  }

  /** Turn device unlock off: drop the entry, then remove the OS key (best-effort). The password is unaffected. */
  async forget(): Promise<void> {
    const found = this.#enrolledEntry();
    if (!found) return;
    writeProtectors(this.deps.protectorsPath(), withoutProtector(found.doc, found.p.type));
    await found.p.destroy(found.entry).catch(() => {});
  }

  /** This provider's entry in a readable protector file, or null. */
  #enrolledEntry(): { p: DeviceKeyProvider; doc: ProtectorDoc; entry: ProtectorEntry } | null {
    const p = this.deps.provider;
    if (!p) return null;
    let doc: ProtectorDoc;
    try { doc = this.#doc(); } catch { return null; }
    const entry = doc.protectors.find((e) => e.type === p.type);
    return entry ? { p, doc, entry } : null;
  }
}

// ── Windows Hello: a TPM-backed KeyCredential, driven through PowerShell's WinRT projection ─────────────────

/** Stdout marker so host noise can never be read as a result. */
export const HELLO_MARK = "LUCID_HELLO::";
/** HKDF-SHA256 parameters for the hello KEK (spec §4.1 leaves them open; the Hub's Phase 2 must match). */
const HELLO_HKDF_INFO = "lucid-vmk-v1|hello";

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

/** One reply line from a native bridge (the Windows Hello PowerShell script or bin/lucid-sep). */
export interface BridgeReply {
  ok: boolean; status?: string; error?: string; available?: boolean;
  signature?: string; // hello
  se_key?: string; public_key?: string; shared?: string; watch?: boolean; // sep
}

/** Parse a bridge's marker line (exported for tests). Missing marker -> a failed reply carrying stderr. */
export function parseBridgeReply(mark: string, stdout: string, stderr = ""): BridgeReply {
  const at = stdout.lastIndexOf(mark);
  if (at < 0) return { ok: false, status: /language mode/i.test(stderr) ? "ConstrainedLanguage" : "NoReply", error: stderr.trim().slice(0, 200) };
  try { return JSON.parse(stdout.slice(at + mark.length).split(/\r?\n/, 1)[0] ?? "") as BridgeReply; }
  catch { return { ok: false, status: "NoReply" }; }
}

/** Map a non-ok helper reply to the error the UI shows (exported for tests). */
export function helloError(r: BridgeReply): DeviceUnlockError {
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
  const call = async (env: Record<string, string>): Promise<BridgeReply> => { const r = await run(env); return parseBridgeReply(HELLO_MARK, r.stdout, r.stderr); };
  const sign = async (op: "create" | "sign", keyName: string, challenge: string): Promise<Buffer> => {
    const r = await call({ LUCID_HELLO_OP: op, LUCID_HELLO_KEY: keyName, LUCID_HELLO_CHALLENGE: challenge });
    if (!r.ok || !r.signature) throw helloError(r);
    return Buffer.from(hkdfSync("sha256", Buffer.from(r.signature, "base64"), Buffer.alloc(0), HELLO_HKDF_INFO, KEY_LEN));
  };
  return {
    type: "hello",
    label: "Windows Hello",
    available: async () => { const r = await call({ LUCID_HELLO_OP: "available" }); return r.ok && r.available === true; },
    create: async (entryId) => {
      // One Hello key per entry: re-enrolling creates a new key, and only then is the old entry's key deleted.
      const fields = { key_name: `LucidVault-ide-${entryId}`, challenge: randomBytes(32).toString("base64") };
      return { kek: await sign("create", fields.key_name, fields.challenge), fields };
    },
    open: (entry) => sign("sign", String(entry.key_name ?? ""), String(entry.challenge ?? "")),
    destroy: async (entry) => { await call({ LUCID_HELLO_OP: "delete", LUCID_HELLO_KEY: String(entry.key_name ?? "") }); },
  };
}

// ── macOS: a Secure Enclave key behind Touch ID (spec §4.4 `sep`), via bin/lucid-sep ──────────────────────

/** Stdout marker of bin/lucid-sep. */
export const SEP_MARK = "LUCID_SEP::";
/** HKDF-SHA256 parameters for the sep KEK (spec §4.4 leaves them open; the Hub's Mac protector must match). */
const SEP_HKDF_INFO = "lucid-vmk-v1|sep";
const SEP_REASON = "unlock your LUCID knowledge graph";

/** Map a non-ok helper reply to the error the UI shows (exported for tests). */
export function sepError(r: BridgeReply): DeviceUnlockError {
  switch (r.status) {
    case "cancelled": return new DeviceUnlockError("cancelled", "Touch ID was cancelled.");
    case "lockout": return new DeviceUnlockError("failed", "Touch ID is locked out after too many attempts. Unlock with your passphrase; Touch ID comes back once you unlock the Mac with its password.");
    case "not-available": return new DeviceUnlockError("unsupported", "Touch ID is not available right now (no enrolled fingerprint, or no logged-in desktop session).");
    case "invalid-key": return new DeviceUnlockError("not-enrolled", "The Touch ID key no longer works, usually because the enrolled fingerprints changed. Unlock with your passphrase and turn Touch ID unlock on again.");
    default: return new DeviceUnlockError("failed", `Touch ID did not complete${r.error ? `: ${r.error}` : r.status ? ` (${r.status})` : ""}.`);
  }
}

export type SepRunner = (env: Record<string, string>) => Promise<{ stdout: string; stderr: string }>;

/** The real runner: the bundled helper, resolved at call time (main learns the repo root at app ready). A
 *  missing helper reads as no reply, so the option is simply unavailable. */
export function helperSepRunner(helperPath: () => string): SepRunner {
  return async (env) => { const r = await runToText([helperPath()], { env }); return { stdout: r.stdout, stderr: r.stderr }; };
}

export function macSecureEnclaveProvider(run: SepRunner): DeviceKeyProvider {
  const call = async (env: Record<string, string>): Promise<BridgeReply> => { const r = await run(env); return parseBridgeReply(SEP_MARK, r.stdout, r.stderr); };
  const kekOf = (shared: Buffer): Buffer => Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), SEP_HKDF_INFO, KEY_LEN));
  /** One Touch ID prompt: the enclave redoes ECDH(enclave key, eph_pub). */
  const agree = async (seKey: string, ephPub: string): Promise<Buffer> => {
    const r = await call({ LUCID_SEP_OP: "agree", LUCID_SEP_KEY: seKey, LUCID_SEP_PEER: ephPub, LUCID_SEP_REASON: SEP_REASON });
    if (!r.ok || !r.shared) throw sepError(r);
    const shared = Buffer.from(r.shared, "base64");
    try { return kekOf(shared); } finally { shared.fill(0); }
  };
  return {
    type: "sep",
    label: "Touch ID",
    available: async () => { const r = await call({ LUCID_SEP_OP: "available" }); return r.ok && r.available === true; },
    // Opt-in: the key ALSO accepts a double-click on the user's unlocked, worn Apple Watch (`.or .companion`).
    companion: { label: "Touch ID or Apple Watch", available: async () => { const r = await call({ LUCID_SEP_OP: "available" }); return r.ok && r.watch === true; } },
    create: async (_id, opts) => {
      const r = await call({ LUCID_SEP_OP: "create", LUCID_SEP_WATCH: opts.companion ? "1" : "0" }); // no prompt: creating the key needs no match
      if (!r.ok || !r.se_key || !r.public_key) throw sepError(r);
      const eph = createECDH("prime256v1");
      eph.generateKeys();
      const shared = eph.computeSecret(Buffer.from(r.public_key, "base64"));
      const kek = kekOf(shared);
      shared.fill(0);
      const fields = { se_key: r.se_key, eph_pub: eph.getPublicKey("base64") }; // the ephemeral private half is dropped here
      // One Touch ID match now, so turning it on proves the enclave reproduces the key with the current fingers.
      const proof = await agree(fields.se_key, fields.eph_pub).catch((e: unknown) => { kek.fill(0); throw e; });
      const same = proof.equals(kek);
      proof.fill(0);
      if (!same) { kek.fill(0); throw new DeviceUnlockError("failed", "The Secure Enclave did not reproduce the key - Touch ID unlock was not turned on."); }
      return { kek, fields };
    },
    open: (entry) => agree(String(entry.se_key ?? ""), String(entry.eph_pub ?? "")),
    destroy: async () => { /* the enclave key exists only as the entry's se_key blob, which the caller removes */ },
  };
}
