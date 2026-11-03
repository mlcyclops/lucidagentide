// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/crypto/fips_crypto.ts: the FIPS crypto provider (ADR-0473, P-FIPS.1, Contract A).
//
// Every at-rest primitive LUCID uses (AES-256-GCM, PBKDF2-HMAC-SHA256, SHA-256, HMAC-SHA256, the DRBG)
// goes through this module, which routes it to the operating system's FIPS 140-validated module when
// one is usable:
//   win32  Windows CNG (bcrypt.dll) through bun:ffi
//   darwin Apple corecrypto through CommonCrypto (libcommonCrypto.dylib) through bun:ffi
//   linux  OpenSSL 3 (libcrypto.so.3) through bun:ffi, ONLY when its FIPS provider is active
// `fips` is reported true only when the claim is justified: on Windows when the OS FIPS mode policy is on
// or the build is a Microsoft-listed validated release that self-tests without it (windowsCngClaim); on
// Linux only with the OpenSSL FIPS provider active. CNG on an unlisted build with the policy off still
// performs the operations, but reports `fips: false` (and so fails closed when FIPS is required).
// Anything else (Electron main / Node, a module that cannot be bound, a failed self-test) falls back to
// node:crypto ("bun-boringssl") and reports `fips: false`. When fipsRequired() (env LUCID_FIPS_REQUIRED=1
// or managed policy security.crypto.requireFips) and no validated module is usable, every operation
// throws FipsRequiredError: there is no silent non-validated path.
//
// AES-256-GCM and PBKDF2 are deterministic, so every module produces byte-identical output for the same
// inputs: existing ciphertext needs no re-encryption, swapping the module IS the migration.
//
// A native module is used only after a one-time power-on self-test (known-answer tests: a NIST GCM
// vector, a PBKDF2-HMAC-SHA256 vector, SHA-256("abc"), an HMAC-SHA256 vector, a tag-mismatch check and a
// DRBG sanity check). bun:ffi is required lazily under an opaque specifier and only when `Bun` exists, so
// a --target=node bundle (Electron main) neither resolves nor loads it.

import { spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, createHmac, pbkdf2Sync, randomBytes as nodeRandomBytes } from "node:crypto";
import { release } from "node:os";
import { managedConfig, managedRequireFips } from "../../desktop/managed_config.ts";

export type CryptoModule = "windows-cng" | "macos-corecrypto" | "openssl-fips" | "bun-boringssl";
export interface CryptoProviderInfo {
  module: CryptoModule;
  fips: boolean;            // true only when a FIPS 140-validated OS module performs the operations
  detail: string;           // human text: module name, version, CMVP certificate reference if known
  osFipsPolicy: boolean | null; // Windows FipsAlgorithmPolicy / OpenSSL fips provider enabled; null = unknown/not applicable
  required: boolean;        // fipsRequired() at the time of the probe
}

/** Thrown by every operation when FIPS-validated crypto is required and no validated module is usable. */
export class FipsRequiredError extends Error {
  constructor(message: string) { super(message); this.name = "FipsRequiredError"; }
}
/** Thrown by aesGcmDecrypt when the tag does not verify (wrong key, wrong AAD or tampered data). */
export class CryptoAuthError extends Error {
  constructor(message = "AES-GCM authentication failed (wrong key or tampered data)") { super(message); this.name = "CryptoAuthError"; }
}

const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;
const SHA256_LEN = 32;
const INT32_MAX = 0x7fffffff;

/** One cryptographic implementation. Inputs are validated by the public functions before they get here. */
interface Provider {
  readonly module: CryptoModule;
  readonly fips: boolean;
  readonly detail: string;
  random(n: number): Buffer;
  gcmEncrypt(key: Buffer, iv: Buffer, pt: Buffer, aad: Buffer | undefined): { ct: Buffer; tag: Buffer };
  gcmDecrypt(key: Buffer, iv: Buffer, ct: Buffer, tag: Buffer, aad: Buffer | undefined): Buffer;
  pbkdf2(password: Buffer, salt: Buffer, iterations: number, keyLen: number): Buffer;
  sha256(data: Buffer): Buffer;
  hmac(key: Buffer, data: Buffer): Buffer;
}

// ── node:crypto fallback ("bun-boringssl") ────────────────────────────────────────────────────────────

function nodeProvider(detail: string): Provider {
  return {
    module: "bun-boringssl",
    fips: false,
    detail,
    random: (n) => nodeRandomBytes(n),
    gcmEncrypt(key, iv, pt, aad) {
      const c = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LEN });
      if (aad?.length) c.setAAD(aad);
      const ct = Buffer.concat([c.update(pt), c.final()]);
      return { ct, tag: c.getAuthTag() };
    },
    gcmDecrypt(key, iv, ct, tag, aad) {
      const d = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LEN });
      if (aad?.length) d.setAAD(aad);
      d.setAuthTag(tag);
      const head = d.update(ct);
      let tail: Buffer;
      try { tail = d.final(); } catch { head.fill(0); throw new CryptoAuthError(); }
      return Buffer.concat([head, tail]);
    },
    pbkdf2: (password, salt, iterations, keyLen) => pbkdf2Sync(password, salt, iterations, keyLen, "sha256"),
    sha256: (data) => createHash("sha256").update(data).digest(),
    hmac: (key, data) => createHmac("sha256", key).update(data).digest(),
  };
}

// ── bun:ffi plumbing ─────────────────────────────────────────────────────────────────────────────────

/** The slice of bun:ffi this module uses, typed locally so the Node-typed Electron program never needs
 *  bun:ffi's declarations. FFI types are given by their documented string names. */
interface BunFfi {
  dlopen(lib: string, symbols: Record<string, { args: string[]; returns: string }>): { symbols: unknown };
  ptr(view: ArrayBufferView): number;
}
type Arg = number | bigint | null;
type IntFn = (...args: Arg[]) => number;
type PtrFn = (...args: Arg[]) => number | null;
type VoidFn = (...args: Arg[]) => void;

/** An own, offset-0 copy of `b`, at least one byte long: the native side never sees a NULL or a
 *  pool-shared pointer (a zero-length input still gets a valid address, passed with length 0; CNG treats
 *  a NULL output buffer as a size query, so this matters for empty plaintext). Callers zero it after use,
 *  which also keeps it reachable until the native call has returned. */
function own(b: Uint8Array): Uint8Array {
  const o = new Uint8Array(Math.max(b.length, 1));
  o.set(b);
  return o;
}
/** A NUL-terminated byte string for C APIs (`const char*`). */
const cstr = (s: string): Uint8Array => new Uint8Array(Buffer.from(`${s}\0`, "latin1"));
const errText = (e: unknown): string => String((e as Error)?.message ?? e).slice(0, 160);

// ── win32: Windows CNG (bcrypt.dll) ───────────────────────────────────────────────────────────────────

interface Cng {
  BCryptOpenAlgorithmProvider: IntFn;
  BCryptSetProperty: IntFn;
  BCryptGenerateSymmetricKey: IntFn;
  BCryptDestroyKey: IntFn;
  BCryptEncrypt: IntFn;
  BCryptDecrypt: IntFn;
  BCryptGenRandom: IntFn;
  BCryptDeriveKeyPBKDF2: IntFn;
  BCryptHash: IntFn;
}
const BCRYPT_ALG_HANDLE_HMAC_FLAG = 0x00000008;
const BCRYPT_USE_SYSTEM_PREFERRED_RNG = 0x00000002;
const BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO_VERSION = 1;
const STATUS_AUTH_TAG_MISMATCH = 0xc000a002;
/** sizeof(BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO) on 64-bit Windows (x64 and arm64 share the LLP64 layout). */
const AUTH_INFO_SIZE = 88;

function cngProvider(ffi: BunFfi, claim: { fips: boolean; basis: string }): Provider {
  const P = "ptr", U32 = "u32", U64 = "u64", I32 = "i32";
  const s = ffi.dlopen("bcrypt.dll", {
    // NTSTATUS BCryptOpenAlgorithmProvider(BCRYPT_ALG_HANDLE*, LPCWSTR alg, LPCWSTR impl, ULONG flags)
    BCryptOpenAlgorithmProvider: { args: [P, P, P, U32], returns: I32 },
    // NTSTATUS BCryptSetProperty(BCRYPT_HANDLE, LPCWSTR prop, PUCHAR in, ULONG cbIn, ULONG flags)
    BCryptSetProperty: { args: [P, P, P, U32, U32], returns: I32 },
    // NTSTATUS BCryptGenerateSymmetricKey(alg, BCRYPT_KEY_HANDLE*, PUCHAR keyObj, ULONG cbKeyObj, PUCHAR secret, ULONG cbSecret, ULONG flags)
    BCryptGenerateSymmetricKey: { args: [P, P, P, U32, P, U32, U32], returns: I32 },
    BCryptDestroyKey: { args: [P], returns: I32 },
    // NTSTATUS BCryptEncrypt/BCryptDecrypt(key, PUCHAR in, ULONG cbIn, VOID* padding, PUCHAR iv, ULONG cbIv, PUCHAR out, ULONG cbOut, ULONG* cbResult, ULONG flags)
    BCryptEncrypt: { args: [P, P, U32, P, P, U32, P, U32, P, U32], returns: I32 },
    BCryptDecrypt: { args: [P, P, U32, P, P, U32, P, U32, P, U32], returns: I32 },
    // NTSTATUS BCryptGenRandom(alg, PUCHAR buf, ULONG cb, ULONG flags)
    BCryptGenRandom: { args: [P, P, U32, U32], returns: I32 },
    // NTSTATUS BCryptDeriveKeyPBKDF2(prf, PUCHAR pw, ULONG cbPw, PUCHAR salt, ULONG cbSalt, ULONGLONG iters, PUCHAR out, ULONG cbOut, ULONG flags)
    BCryptDeriveKeyPBKDF2: { args: [P, P, U32, P, U32, U64, P, U32, U32], returns: I32 },
    // NTSTATUS BCryptHash(alg, PUCHAR secret, ULONG cbSecret, PUCHAR in, ULONG cbIn, PUCHAR out, ULONG cbOut) (Windows 10+)
    BCryptHash: { args: [P, P, U32, P, U32, P, U32], returns: I32 },
  }).symbols as Cng;

  const check = (status: number, what: string): void => {
    if (status !== 0) throw new Error(`${what} failed (NTSTATUS 0x${(status >>> 0).toString(16)})`);
  };
  const wstr = (v: string): Uint8Array => new Uint8Array(Buffer.from(`${v}\0`, "utf16le"));
  const openAlg = (alg: string, flags: number): number => {
    const out = new BigUint64Array(1);
    const name = wstr(alg);
    check(s.BCryptOpenAlgorithmProvider(ffi.ptr(out), ffi.ptr(name), null, flags), `BCryptOpenAlgorithmProvider(${alg})`);
    name.fill(0);
    return Number(out[0]);
  };
  // Algorithm handles are opened once and cached for the process lifetime.
  const hAes = openAlg("AES", 0);
  const prop = wstr("ChainingMode");
  const mode = wstr("ChainingModeGCM");
  check(s.BCryptSetProperty(hAes, ffi.ptr(prop), ffi.ptr(mode), mode.byteLength, 0), "BCryptSetProperty(ChainingModeGCM)");
  prop.fill(0); mode.fill(0);
  const hSha = openAlg("SHA256", 0);
  const hHmac = openAlg("SHA256", BCRYPT_ALG_HANDLE_HMAC_FLAG);

  // BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO, 64-bit layout (88 bytes), as BCRYPT_INIT_AUTH_MODE_INFO + fields:
  //   0 ULONG cbSize | 4 ULONG dwInfoVersion | 8 PUCHAR pbNonce | 16 ULONG cbNonce | 20 pad
  //  24 PUCHAR pbAuthData | 32 ULONG cbAuthData | 36 pad | 40 PUCHAR pbTag | 48 ULONG cbTag | 52 pad
  //  56 PUCHAR pbMacContext | 64 ULONG cbMacContext | 68 ULONG cbAAD | 72 ULONGLONG cbData
  //  80 ULONG dwFlags | 84 pad. No call chaining: MAC context, cbAAD, cbData and dwFlags stay zero.
  const authInfo = (nonce: Uint8Array, aad: Uint8Array | null, aadLen: number, tag: Uint8Array): Uint8Array => {
    const info = new Uint8Array(AUTH_INFO_SIZE);
    const dv = new DataView(info.buffer);
    dv.setUint32(0, AUTH_INFO_SIZE, true);
    dv.setUint32(4, BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO_VERSION, true);
    dv.setBigUint64(8, BigInt(ffi.ptr(nonce)), true);
    dv.setUint32(16, IV_LEN, true);
    if (aad) {
      dv.setBigUint64(24, BigInt(ffi.ptr(aad)), true);
      dv.setUint32(32, aadLen, true);
    }
    dv.setBigUint64(40, BigInt(ffi.ptr(tag)), true);
    dv.setUint32(48, TAG_LEN, true);
    return info;
  };
  const withKey = <T>(key: Buffer, fn: (hKey: number) => T): T => {
    const out = new BigUint64Array(1);
    const k = own(key);
    try {
      // pbKeyObject NULL / cbKeyObject 0: CNG allocates and owns the key object (Windows 7+).
      check(s.BCryptGenerateSymmetricKey(hAes, ffi.ptr(out), null, 0, ffi.ptr(k), key.length, 0), "BCryptGenerateSymmetricKey");
    } finally { k.fill(0); }
    const hKey = Number(out[0]);
    try { return fn(hKey); } finally { s.BCryptDestroyKey(hKey); }
  };
  /** Shared GCM body: `input` is the plaintext (encrypt) or ciphertext (decrypt), `tag` the tag buffer. */
  const gcm = (op: "enc" | "dec", key: Buffer, iv: Buffer, input: Buffer, tag: Uint8Array, aad: Buffer | undefined): Uint8Array =>
    withKey(key, (hKey) => {
      const nonce = own(iv);
      const data = own(input);
      const a = aad?.length ? own(aad) : null;
      const out = new Uint8Array(Math.max(input.length, 1));
      const info = authInfo(nonce, a, aad?.length ?? 0, tag);
      const cb = new Uint32Array(1);
      let status: number;
      try {
        const fn = op === "enc" ? s.BCryptEncrypt : s.BCryptDecrypt;
        status = fn(hKey, ffi.ptr(data), input.length, ffi.ptr(info), null, 0, ffi.ptr(out), input.length, ffi.ptr(cb), 0);
      } finally { data.fill(0); nonce.fill(0); a?.fill(0); info.fill(0); }
      if (status !== 0) {
        out.fill(0);
        if (op === "dec" && status >>> 0 === STATUS_AUTH_TAG_MISMATCH) throw new CryptoAuthError();
        check(status, op === "enc" ? "BCryptEncrypt" : "BCryptDecrypt");
      }
      if (cb[0] !== input.length) { out.fill(0); throw new Error(`BCrypt GCM returned ${cb[0]} bytes, expected ${input.length}`); }
      return out;
    });

  return {
    module: "windows-cng",
    fips: claim.fips,
    detail: `Windows CNG (bcrypt.dll over bcryptprimitives.dll, Windows ${release()}): AES-256-GCM, PBKDF2-HMAC-SHA256, SHA-256, HMAC-SHA256 and the system-preferred DRBG; ${claim.basis}; see CMVP for the module certificate of your OS build`,
    random(n) {
      const out = new Uint8Array(Math.max(n, 1));
      check(s.BCryptGenRandom(null, ffi.ptr(out), n, BCRYPT_USE_SYSTEM_PREFERRED_RNG), "BCryptGenRandom");
      return Buffer.from(out.buffer, 0, n);
    },
    gcmEncrypt(key, iv, pt, aad) {
      const tag = new Uint8Array(TAG_LEN);
      const out = gcm("enc", key, iv, pt, tag, aad);
      return { ct: Buffer.from(out.buffer, 0, pt.length), tag: Buffer.from(tag.buffer) };
    },
    gcmDecrypt(key, iv, ct, tag, aad) {
      const t = own(tag);
      try { return Buffer.from(gcm("dec", key, iv, ct, t, aad).buffer, 0, ct.length); } finally { t.fill(0); }
    },
    // An empty HMAC key (PBKDF2 password) is passed as the single byte 0x00: HMAC zero-pads the key to the
    // 64-byte block (FIPS 198-1, K0 = K || 0...), so both give the same K0 and the same output, and CNG
    // never sees a zero-length secret.
    pbkdf2(password, salt, iterations, keyLen) {
      const pw = own(password);
      const sa = own(salt);
      const out = new Uint8Array(keyLen);
      try {
        check(s.BCryptDeriveKeyPBKDF2(hHmac, ffi.ptr(pw), pw.length, ffi.ptr(sa), salt.length, BigInt(iterations), ffi.ptr(out), keyLen, 0), "BCryptDeriveKeyPBKDF2");
      } finally { pw.fill(0); sa.fill(0); }
      return Buffer.from(out.buffer);
    },
    sha256(data) {
      const d = own(data);
      const out = new Uint8Array(SHA256_LEN);
      try { check(s.BCryptHash(hSha, null, 0, ffi.ptr(d), data.length, ffi.ptr(out), SHA256_LEN), "BCryptHash(SHA256)"); } finally { d.fill(0); }
      return Buffer.from(out.buffer);
    },
    hmac(key, data) {
      const k = own(key);
      const d = own(data);
      const out = new Uint8Array(SHA256_LEN);
      try { check(s.BCryptHash(hHmac, ffi.ptr(k), k.length, ffi.ptr(d), data.length, ffi.ptr(out), SHA256_LEN), "BCryptHash(HMAC-SHA256)"); } finally { k.fill(0); d.fill(0); }
      return Buffer.from(out.buffer);
    },
  };
}

/** One REG_DWORD through reg.exe: its value, "absent" when reg.exe reports it does not exist (exit 1),
 *  null when reg.exe could not be asked or answered something unexpected. */
function regDword(key: string, name: string): number | "absent" | null {
  try {
    const r = spawnSync("reg", ["query", key, "/v", name], {
      encoding: "utf8", windowsHide: true, timeout: 4000, stdio: ["ignore", "pipe", "ignore"],
    });
    if (r.error) return null;
    const m = new RegExp(`^\\s*${name}\\s+REG_DWORD\\s+0x([0-9a-f]+)\\s*$`, "im").exec(r.stdout ?? "");
    if (m) return parseInt(m[1]!, 16);
    return r.status === 1 ? "absent" : null;
  } catch { return null; }
}

let winPolicy: boolean | null | undefined;
/** HKLM\System\CurrentControlSet\Control\Lsa\FipsAlgorithmPolicy\Enabled (cached): true/false when
 *  reg.exe answered (an absent value = policy off), null when it could not be asked. */
function windowsFipsPolicy(): boolean | null {
  if (winPolicy !== undefined) return winPolicy;
  const v = regDword("HKLM\\System\\CurrentControlSet\\Control\\Lsa\\FipsAlgorithmPolicy", "Enabled");
  return (winPolicy = v === null ? null : v === "absent" ? false : v !== 0);
}

/** Windows releases Microsoft lists as having a FIPS 140 validated Cryptographic Primitives Library
 *  (bcryptprimitives.dll, the user-mode CNG module), by build number, per
 *  learn.microsoft.com/windows/security/security-foundations/certification/fips-140-validation. */
const CNG_LISTED_RELEASES: Readonly<Record<number, string>> = {
  10240: "Windows 10 1507", 10586: "Windows 10 1511", 14393: "Windows 10 1607 / Server 2016", 15063: "Windows 10 1703",
  16299: "Windows 10 1709", 17134: "Windows 10 1803", 17763: "Windows 10 1809 / Server 2019", 18362: "Windows 10 1903",
  18363: "Windows 10 1909", 19041: "Windows 10 2004", 19042: "Windows 10 20H2", 19043: "Windows 10 21H1",
  20348: "Windows Server 2022", 22000: "Windows 11 21H2", 22621: "Windows 11 22H2",
};
/** The listed releases whose module runs its FIPS 140 self-tests WITHOUT the legacy FIPS policy: Microsoft
 *  made that automatic in the April 2024 quality updates KB5036893 (OS build 22621.3447) and KB5036909
 *  (OS build 20348.2402). Before those, and on every Windows 10 release, the self-tests (and so the
 *  approved mode) need FipsAlgorithmPolicy enabled. */
const CNG_AUTO_SELFTEST: Readonly<Record<number, { minUbr: number; cert: string }>> = {
  22621: { minUbr: 3447, cert: "CMVP #5410" },
  20348: { minUbr: 2402, cert: "CMVP #5410 (build 20348.1668)" },
};

/** Whether operations performed by Windows CNG may be reported as FIPS 140 validated (pure; the rule of
 *  ADR-0473). True when (a) the OS FIPS policy is on (FipsAlgorithmPolicy\Enabled = 1: the administrator
 *  put Windows in its FIPS approved mode, which also enables the module self-tests), or (b) the build is
 *  a Microsoft-listed validated release that runs the self-tests without the policy (CNG_AUTO_SELFTEST at
 *  or above its patch level). Anything else (an unlisted build such as Windows 10 22H2 or Windows 11 24H2
 *  with the policy off, or an unknown policy) is NOT claimed. `basis` is the human reason either way. */
export function windowsCngClaim(policy: boolean | null, build: number, ubr: number | null): { fips: boolean; basis: string } {
  const listed = CNG_LISTED_RELEASES[build];
  const listing = listed ? `${listed} is a Microsoft-listed FIPS 140 validated release` : `build ${build} is not a Microsoft-listed FIPS 140 validated release`;
  if (policy === true) return { fips: true, basis: `the Windows FIPS mode policy is on (FipsAlgorithmPolicy\\Enabled=1); ${listing}` };
  const auto = CNG_AUTO_SELFTEST[build];
  if (auto && ubr !== null && ubr >= auto.minUbr) return { fips: true, basis: `${listing} (${auto.cert}) whose module self-tests run without the FIPS policy at build ${build}.${ubr}` };
  const policyText = policy === false ? "the Windows FIPS mode policy is off" : "the Windows FIPS mode policy could not be read";
  return { fips: false, basis: `not claimed as FIPS 140 validated: ${policyText} and ${listing}${auto ? ` but build ${build}.${ubr ?? "?"} predates its automatic self-tests (${build}.${auto.minUbr})` : listed ? " whose self-tests need that policy" : ""}; enable "System cryptography: Use FIPS compliant algorithms" to run CNG in its approved mode` };
}

/** The running Windows build (10.0.<build>) and update build revision (UBR), for windowsCngClaim. */
function windowsBuild(): { build: number; ubr: number | null } {
  const build = Number(release().split(".")[2] ?? 0) || 0;
  const u = regDword("HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion", "UBR");
  return { build, ubr: typeof u === "number" ? u : null };
}

// ── darwin: Apple corecrypto through CommonCrypto ─────────────────────────────────────────────────────

interface CommonCrypto {
  CCRandomGenerateBytes: IntFn;
  CCKeyDerivationPBKDF: IntFn;
  CC_SHA256: PtrFn;
  CCHmac: VoidFn;
  CCCryptorGCMOneshotEncrypt: IntFn;
  CCCryptorGCMOneshotDecrypt: IntFn;
}
const kCCAlgorithmAES = 0;
const kCCPBKDF2 = 2;
const kCCPRFHmacAlgSHA256 = 3;
const kCCHmacAlgSHA256 = 2;

function corecryptoProvider(ffi: BunFfi): Provider {
  const P = "ptr", U32 = "u32", U64 = "u64", I32 = "i32";
  const base = {
    // CCRNGStatus CCRandomGenerateBytes(void *bytes, size_t count)
    CCRandomGenerateBytes: { args: [P, U64], returns: I32 },
    // int CCKeyDerivationPBKDF(CCPBKDFAlgorithm, const char *pw, size_t pwLen, const uint8_t *salt, size_t saltLen,
    //                          CCPseudoRandomAlgorithm prf, unsigned rounds, uint8_t *out, size_t outLen)
    CCKeyDerivationPBKDF: { args: [U32, P, U64, P, U64, U32, U32, P, U64], returns: I32 },
    // unsigned char *CC_SHA256(const void *data, CC_LONG len, unsigned char *md)
    CC_SHA256: { args: [P, U32, P], returns: P },
    // void CCHmac(CCHmacAlgorithm, const void *key, size_t keyLen, const void *data, size_t dataLen, void *macOut)
    CCHmac: { args: [U32, P, U64, P, U64, P], returns: "void" },
  };
  // CommonCryptorSPI.h (macOS 10.13+), SPI rather than public API:
  // CCCryptorStatus CCCryptorGCMOneshotEncrypt(CCAlgorithm, key, keyLen, iv, ivLen, aData, aDataLen, dataIn, dataInLen, cipherOut, tagOut, tagLen)
  // CCCryptorStatus CCCryptorGCMOneshotDecrypt(CCAlgorithm, key, keyLen, iv, ivLen, aData, aDataLen, dataIn, dataInLen, dataOut, tagIn, tagLen)
  const gcmSyms = {
    CCCryptorGCMOneshotEncrypt: { args: [U32, P, U64, P, U64, P, U64, P, U64, P, P, U64], returns: I32 },
    CCCryptorGCMOneshotDecrypt: { args: [U32, P, U64, P, U64, P, U64, P, U64, P, P, U64], returns: I32 },
  };
  let s: CommonCrypto | null = null;
  const problems: string[] = [];
  for (const lib of ["/usr/lib/system/libcommonCrypto.dylib", "/usr/lib/libSystem.B.dylib"]) {
    try { s = ffi.dlopen(lib, { ...base, ...gcmSyms }).symbols as CommonCrypto; break; } catch (e) {
      // Tell "the GCM SPI is missing" apart from "the library is missing".
      let baseOk = false;
      try { ffi.dlopen(lib, base); baseOk = true; } catch { /* library or base symbols absent */ }
      problems.push(baseOk ? `${lib} lacks the CCCryptorGCMOneshot SPI` : `${lib}: ${errText(e)}`);
    }
  }
  if (!s) throw new Error(problems.join("; "));
  const cc = s;
  const big = BigInt;
  const ok = (status: number, what: string): void => { if (status !== 0) throw new Error(`${what} failed (status ${status})`); };

  return {
    module: "macos-corecrypto",
    fips: true,
    detail: `Apple corecrypto through CommonCrypto (Darwin ${release()}): AES-256-GCM, PBKDF2-HMAC-SHA256, SHA-256, HMAC-SHA256 and the system DRBG; claimed because Apple submits corecrypto (which has no separate FIPS mode and self-tests at load) for FIPS 140 validation for each macOS release; see CMVP for the module certificate of your OS build`,
    random(n) {
      const out = new Uint8Array(Math.max(n, 1));
      ok(cc.CCRandomGenerateBytes(ffi.ptr(out), big(n)), "CCRandomGenerateBytes");
      return Buffer.from(out.buffer, 0, n);
    },
    gcmEncrypt(key, iv, pt, aad) {
      const k = own(key), n = own(iv), d = own(pt), a = aad?.length ? own(aad) : null;
      const out = new Uint8Array(Math.max(pt.length, 1));
      const tag = new Uint8Array(TAG_LEN);
      try {
        ok(cc.CCCryptorGCMOneshotEncrypt(kCCAlgorithmAES, ffi.ptr(k), big(KEY_LEN), ffi.ptr(n), big(IV_LEN), a ? ffi.ptr(a) : null, big(aad?.length ?? 0),
          ffi.ptr(d), big(pt.length), ffi.ptr(out), ffi.ptr(tag), big(TAG_LEN)), "CCCryptorGCMOneshotEncrypt");
      } finally { k.fill(0); n.fill(0); d.fill(0); a?.fill(0); }
      return { ct: Buffer.from(out.buffer, 0, pt.length), tag: Buffer.from(tag.buffer) };
    },
    gcmDecrypt(key, iv, ct, tag, aad) {
      const k = own(key), n = own(iv), d = own(ct), t = own(tag), a = aad?.length ? own(aad) : null;
      const out = new Uint8Array(Math.max(ct.length, 1));
      let status: number;
      try {
        status = cc.CCCryptorGCMOneshotDecrypt(kCCAlgorithmAES, ffi.ptr(k), big(KEY_LEN), ffi.ptr(n), big(IV_LEN), a ? ffi.ptr(a) : null, big(aad?.length ?? 0),
          ffi.ptr(d), big(ct.length), ffi.ptr(out), ffi.ptr(t), big(TAG_LEN));
      } finally { k.fill(0); n.fill(0); d.fill(0); t.fill(0); a?.fill(0); }
      // Inputs are validated before this point, so a non-success status is the tag check failing.
      if (status !== 0) { out.fill(0); throw new CryptoAuthError(); }
      return Buffer.from(out.buffer, 0, ct.length);
    },
    pbkdf2(password, salt, iterations, keyLen) {
      const pw = own(password), sa = own(salt);
      const out = new Uint8Array(keyLen);
      try {
        ok(cc.CCKeyDerivationPBKDF(kCCPBKDF2, ffi.ptr(pw), big(password.length), ffi.ptr(sa), big(salt.length), kCCPRFHmacAlgSHA256, iterations, ffi.ptr(out), big(keyLen)), "CCKeyDerivationPBKDF");
      } finally { pw.fill(0); sa.fill(0); }
      return Buffer.from(out.buffer);
    },
    sha256(data) {
      if (data.length > 0xffffffff) throw new RangeError("CC_SHA256 input exceeds 4 GiB");
      const d = own(data);
      const out = new Uint8Array(SHA256_LEN);
      let r: number | null;
      try { r = cc.CC_SHA256(ffi.ptr(d), data.length, ffi.ptr(out)); } finally { d.fill(0); }
      if (!r) throw new Error("CC_SHA256 failed");
      return Buffer.from(out.buffer);
    },
    hmac(key, data) {
      const k = own(key), d = own(data);
      const out = new Uint8Array(SHA256_LEN);
      try { cc.CCHmac(kCCHmacAlgSHA256, ffi.ptr(k), big(key.length), ffi.ptr(d), big(data.length), ffi.ptr(out)); } finally { k.fill(0); d.fill(0); }
      return Buffer.from(out.buffer);
    },
  };
}

// ── linux: OpenSSL 3 with its FIPS provider ───────────────────────────────────────────────────────────

interface LibCrypto {
  OpenSSL_version: (t: number) => unknown;
  EVP_default_properties_is_fips_enabled: IntFn;
  OSSL_PROVIDER_available: IntFn;
  EVP_CIPHER_fetch: PtrFn;
  EVP_MD_fetch: PtrFn;
  EVP_CIPHER_CTX_new: PtrFn;
  EVP_CIPHER_CTX_free: VoidFn;
  EVP_EncryptInit_ex: IntFn;
  EVP_EncryptUpdate: IntFn;
  EVP_EncryptFinal_ex: IntFn;
  EVP_DecryptInit_ex: IntFn;
  EVP_DecryptUpdate: IntFn;
  EVP_DecryptFinal_ex: IntFn;
  EVP_CIPHER_CTX_ctrl: IntFn;
  PKCS5_PBKDF2_HMAC: IntFn;
  EVP_Digest: IntFn;
  HMAC: PtrFn;
  RAND_bytes: IntFn;
}
const EVP_CTRL_AEAD_SET_IVLEN = 0x9;
const EVP_CTRL_AEAD_GET_TAG = 0x10;
const EVP_CTRL_AEAD_SET_TAG = 0x11;

/** Bind libcrypto.so.3. Returns the provider only when the FIPS provider is active (default properties
 *  fips=yes AND the "fips" provider loaded); otherwise null plus the policy reading and the reason. */
function opensslProbe(ffi: BunFfi): { provider: Provider | null; osFipsPolicy: boolean | null; reason: string } {
  const P = "ptr", U64 = "u64", I32 = "i32";
  let s: LibCrypto;
  try {
    s = ffi.dlopen("libcrypto.so.3", {
      OpenSSL_version: { args: [I32], returns: "cstring" },
      EVP_default_properties_is_fips_enabled: { args: [P], returns: I32 },
      OSSL_PROVIDER_available: { args: [P, P], returns: I32 },
      EVP_CIPHER_fetch: { args: [P, P, P], returns: P },
      EVP_MD_fetch: { args: [P, P, P], returns: P },
      EVP_CIPHER_CTX_new: { args: [], returns: P },
      EVP_CIPHER_CTX_free: { args: [P], returns: "void" },
      EVP_EncryptInit_ex: { args: [P, P, P, P, P], returns: I32 },
      EVP_EncryptUpdate: { args: [P, P, P, P, I32], returns: I32 },
      EVP_EncryptFinal_ex: { args: [P, P, P], returns: I32 },
      EVP_DecryptInit_ex: { args: [P, P, P, P, P], returns: I32 },
      EVP_DecryptUpdate: { args: [P, P, P, P, I32], returns: I32 },
      EVP_DecryptFinal_ex: { args: [P, P, P], returns: I32 },
      EVP_CIPHER_CTX_ctrl: { args: [P, I32, I32, P], returns: I32 },
      PKCS5_PBKDF2_HMAC: { args: [P, I32, P, I32, I32, P, I32, P], returns: I32 },
      EVP_Digest: { args: [P, U64, P, P, P, P], returns: I32 },
      HMAC: { args: [P, P, I32, P, U64, P, P], returns: P },
      RAND_bytes: { args: [P, I32], returns: I32 },
    }).symbols as LibCrypto;
  } catch (e) {
    return { provider: null, osFipsPolicy: null, reason: `OpenSSL 3 (libcrypto.so.3) could not be bound (${errText(e)})` };
  }
  const version = String(s.OpenSSL_version(0));
  const fipsName = cstr("fips");
  const policy = s.EVP_default_properties_is_fips_enabled(null) === 1;
  if (!policy) return { provider: null, osFipsPolicy: false, reason: `${version} is present but its default properties do not require fips=yes (not a validated configuration)` };
  if (s.OSSL_PROVIDER_available(null, ffi.ptr(fipsName)) !== 1) return { provider: null, osFipsPolicy: true, reason: `${version} requires fips=yes but its FIPS provider is not loaded` };
  // Fetched once (cached); with default properties fips=yes these come from the FIPS provider only.
  const cipherName = cstr("AES-256-GCM");
  const mdName = cstr("SHA2-256");
  const cipher = s.EVP_CIPHER_fetch(null, ffi.ptr(cipherName), null);
  const md = s.EVP_MD_fetch(null, ffi.ptr(mdName), null);
  if (!cipher || !md) return { provider: null, osFipsPolicy: true, reason: `${version} FIPS provider did not supply AES-256-GCM and SHA2-256` };

  const ok = (r: number, what: string): void => { if (r !== 1) throw new Error(`${what} failed`); };
  const big = BigInt;
  const withCtx = <T>(fn: (ctx: number) => T): T => {
    const ctx = s.EVP_CIPHER_CTX_new();
    if (!ctx) throw new Error("EVP_CIPHER_CTX_new failed");
    try { return fn(ctx); } finally { s.EVP_CIPHER_CTX_free(ctx); }
  };

  const provider: Provider = {
    module: "openssl-fips",
    fips: true,
    detail: `${version} with the FIPS provider active (libcrypto.so.3): AES-256-GCM, PBKDF2-HMAC-SHA256, SHA-256, HMAC-SHA256 and the FIPS DRBG; see CMVP for the module certificate of your OS build`,
    random(n) {
      if (n > INT32_MAX) throw new RangeError("RAND_bytes request too large");
      const out = new Uint8Array(Math.max(n, 1));
      ok(s.RAND_bytes(ffi.ptr(out), n), "RAND_bytes");
      return Buffer.from(out.buffer, 0, n);
    },
    gcmEncrypt(key, iv, pt, aad) {
      return withCtx((ctx) => {
        const k = own(key), n = own(iv), d = own(pt), a = aad?.length ? own(aad) : null;
        const out = new Uint8Array(Math.max(pt.length, 1));
        const tag = new Uint8Array(TAG_LEN);
        const outl = new Int32Array(1);
        try {
          ok(s.EVP_EncryptInit_ex(ctx, cipher, null, null, null), "EVP_EncryptInit_ex");
          ok(s.EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_AEAD_SET_IVLEN, IV_LEN, null), "EVP_CTRL_AEAD_SET_IVLEN");
          ok(s.EVP_EncryptInit_ex(ctx, null, null, ffi.ptr(k), ffi.ptr(n)), "EVP_EncryptInit_ex(key, iv)");
          if (a) ok(s.EVP_EncryptUpdate(ctx, null, ffi.ptr(outl), ffi.ptr(a), aad!.length), "EVP_EncryptUpdate(aad)");
          let total = 0;
          if (pt.length) { ok(s.EVP_EncryptUpdate(ctx, ffi.ptr(out), ffi.ptr(outl), ffi.ptr(d), pt.length), "EVP_EncryptUpdate"); total = outl[0] ?? 0; }
          ok(s.EVP_EncryptFinal_ex(ctx, ffi.ptr(out) + total, ffi.ptr(outl)), "EVP_EncryptFinal_ex");
          total += outl[0] ?? 0;
          if (total !== pt.length) throw new Error(`EVP GCM produced ${total} bytes, expected ${pt.length}`);
          ok(s.EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_AEAD_GET_TAG, TAG_LEN, ffi.ptr(tag)), "EVP_CTRL_AEAD_GET_TAG");
        } finally { k.fill(0); n.fill(0); d.fill(0); a?.fill(0); }
        return { ct: Buffer.from(out.buffer, 0, pt.length), tag: Buffer.from(tag.buffer) };
      });
    },
    gcmDecrypt(key, iv, ct, tag, aad) {
      return withCtx((ctx) => {
        const k = own(key), n = own(iv), d = own(ct), t = own(tag), a = aad?.length ? own(aad) : null;
        const out = new Uint8Array(Math.max(ct.length, 1));
        const outl = new Int32Array(1);
        let total = 0;
        let verified: boolean;
        try {
          ok(s.EVP_DecryptInit_ex(ctx, cipher, null, null, null), "EVP_DecryptInit_ex");
          ok(s.EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_AEAD_SET_IVLEN, IV_LEN, null), "EVP_CTRL_AEAD_SET_IVLEN");
          ok(s.EVP_DecryptInit_ex(ctx, null, null, ffi.ptr(k), ffi.ptr(n)), "EVP_DecryptInit_ex(key, iv)");
          if (a) ok(s.EVP_DecryptUpdate(ctx, null, ffi.ptr(outl), ffi.ptr(a), aad!.length), "EVP_DecryptUpdate(aad)");
          if (ct.length) { ok(s.EVP_DecryptUpdate(ctx, ffi.ptr(out), ffi.ptr(outl), ffi.ptr(d), ct.length), "EVP_DecryptUpdate"); total = outl[0] ?? 0; }
          ok(s.EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_AEAD_SET_TAG, TAG_LEN, ffi.ptr(t)), "EVP_CTRL_AEAD_SET_TAG");
          verified = s.EVP_DecryptFinal_ex(ctx, ffi.ptr(out) + total, ffi.ptr(outl)) > 0;
        } finally { k.fill(0); n.fill(0); d.fill(0); t.fill(0); a?.fill(0); }
        if (!verified) { out.fill(0); throw new CryptoAuthError(); }
        total += outl[0] ?? 0;
        if (total !== ct.length) { out.fill(0); throw new Error(`EVP GCM produced ${total} bytes, expected ${ct.length}`); }
        return Buffer.from(out.buffer, 0, ct.length);
      });
    },
    pbkdf2(password, salt, iterations, keyLen) {
      if (password.length > INT32_MAX || salt.length > INT32_MAX) throw new RangeError("PBKDF2 input too large");
      const pw = own(password), sa = own(salt);
      const out = new Uint8Array(keyLen);
      try {
        ok(s.PKCS5_PBKDF2_HMAC(ffi.ptr(pw), password.length, ffi.ptr(sa), salt.length, iterations, md, keyLen, ffi.ptr(out)), "PKCS5_PBKDF2_HMAC");
      } finally { pw.fill(0); sa.fill(0); }
      return Buffer.from(out.buffer);
    },
    sha256(data) {
      const d = own(data);
      const out = new Uint8Array(SHA256_LEN);
      try { ok(s.EVP_Digest(ffi.ptr(d), big(data.length), ffi.ptr(out), null, md, null), "EVP_Digest"); } finally { d.fill(0); }
      return Buffer.from(out.buffer);
    },
    hmac(key, data) {
      if (key.length > INT32_MAX) throw new RangeError("HMAC key too large");
      const k = own(key), d = own(data);
      const out = new Uint8Array(SHA256_LEN);
      let r: number | null;
      try { r = s.HMAC(md, ffi.ptr(k), key.length, ffi.ptr(d), big(data.length), ffi.ptr(out), null); } finally { k.fill(0); d.fill(0); }
      if (!r) throw new Error("HMAC failed");
      return Buffer.from(out.buffer);
    },
  };
  return { provider, osFipsPolicy: true, reason: "" };
}

// ── power-on self-test (known-answer tests) ───────────────────────────────────────────────────────────

const hex = (h: string): Buffer => Buffer.from(h, "hex");
// AES-256-GCM: GCM specification test case 16 (McGrew and Viega), as used in OpenSSL's evpciph_aes_common.txt.
const GCM_KEY = hex("feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308");
const GCM_IV = hex("cafebabefacedbaddecaf888");
const GCM_AAD = hex("feedfacedeadbeeffeedfacedeadbeefabaddad2");
const GCM_PT = hex("d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39");
const GCM_CT = hex("522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662");
const GCM_TAG = hex("76fc6ece0f4e1768cddf8853bb2d551b");
// PBKDF2-HMAC-SHA256 (OpenSSL evpkdf_pbkdf2.txt; salt and iteration count meet SP 800-132 lower bounds).
const PBKDF2_PW = Buffer.from("passwordPASSWORDpassword", "latin1");
const PBKDF2_SALT = Buffer.from("saltSALTsaltSALTsaltSALTsaltSALTsalt", "latin1");
const PBKDF2_ITERS = 4096;
const PBKDF2_OUT = hex("348c89dbcbd32b2f32d814b8116e84cf2b17347ebc1800181c4e2a1fb8dd53e1c635518c7dac47e9");
// SHA-256("abc") (FIPS 180-4 example) and HMAC-SHA256 RFC 4231 test case 2.
const SHA256_ABC = hex("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
const HMAC_OUT = hex("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");

export interface KatResult { name: string; ok: boolean }

function runKats(p: Provider): KatResult[] {
  const kat = (name: string, fn: () => boolean): KatResult => {
    try { return { name, ok: fn() }; } catch { return { name, ok: false }; }
  };
  return [
    kat("AES-256-GCM encrypt (GCM test case 16)", () => {
      const { ct, tag } = p.gcmEncrypt(GCM_KEY, GCM_IV, GCM_PT, GCM_AAD);
      return ct.equals(GCM_CT) && tag.equals(GCM_TAG);
    }),
    kat("AES-256-GCM decrypt (GCM test case 16)", () => p.gcmDecrypt(GCM_KEY, GCM_IV, GCM_CT, GCM_TAG, GCM_AAD).equals(GCM_PT)),
    kat("AES-256-GCM rejects a flipped tag bit", () => {
      const bad = Buffer.from(GCM_TAG);
      bad[0] = (bad[0] ?? 0) ^ 0x01;
      try { p.gcmDecrypt(GCM_KEY, GCM_IV, GCM_CT, bad, GCM_AAD); return false; } catch (e) { return e instanceof CryptoAuthError; }
    }),
    kat("PBKDF2-HMAC-SHA256 (4096 iterations, 40 bytes)", () => p.pbkdf2(PBKDF2_PW, PBKDF2_SALT, PBKDF2_ITERS, PBKDF2_OUT.length).equals(PBKDF2_OUT)),
    kat("SHA-256(\"abc\")", () => p.sha256(Buffer.from("abc", "latin1")).equals(SHA256_ABC)),
    kat("HMAC-SHA256 (RFC 4231 case 2)", () => p.hmac(Buffer.from("Jefe", "latin1"), Buffer.from("what do ya want for nothing?", "latin1")).equals(HMAC_OUT)),
    kat("DRBG returns distinct 32-byte draws", () => {
      const a = p.random(32), b = p.random(32);
      return a.length === 32 && b.length === 32 && !a.equals(b);
    }),
  ];
}

// ── resolution ────────────────────────────────────────────────────────────────────────────────────────

interface Resolved { provider: Provider; osFipsPolicy: boolean | null }
let resolved: Resolved | undefined;
let forced: "bun-boringssl" | null = null;

function probeNative(): { provider: Provider | null; osFipsPolicy: boolean | null; reason: string } {
  const policy = process.platform === "win32" ? windowsFipsPolicy() : null;
  if (forced) return { provider: null, osFipsPolicy: policy, reason: "the native module was forced unavailable (test seam)" };
  if (typeof Bun === "undefined") return { provider: null, osFipsPolicy: policy, reason: "not running under Bun (Electron main and Node use node:crypto; bun:ffi is never loaded there)" };
  if (process.arch !== "x64" && process.arch !== "arm64") return { provider: null, osFipsPolicy: policy, reason: `no native binding for the ${process.arch} architecture` };
  let ffi: BunFfi;
  try {
    const spec = "bun:ffi";
    ffi = require(spec) as BunFfi;
  } catch (e) {
    return { provider: null, osFipsPolicy: policy, reason: `bun:ffi is unavailable (${errText(e)})` };
  }
  switch (process.platform) {
    case "win32":
      try {
        const { build, ubr } = windowsBuild();
        return { provider: cngProvider(ffi, windowsCngClaim(policy, build, ubr)), osFipsPolicy: policy, reason: "" };
      } catch (e) {
        return { provider: null, osFipsPolicy: policy, reason: `Windows CNG could not be bound (${errText(e)})` };
      }
    case "darwin":
      try { return { provider: corecryptoProvider(ffi), osFipsPolicy: null, reason: "" }; } catch (e) {
        return { provider: null, osFipsPolicy: null, reason: `CommonCrypto could not be bound (${errText(e)})` };
      }
    case "linux":
      try { return opensslProbe(ffi); } catch (e) {
        return { provider: null, osFipsPolicy: null, reason: `OpenSSL 3 could not be probed (${errText(e)})` };
      }
    default:
      return { provider: null, osFipsPolicy: null, reason: `no FIPS 140-validated module binding for ${process.platform}` };
  }
}

function resolveProvider(): Resolved {
  if (resolved) return resolved;
  const probe = probeNative();
  let provider = probe.provider;
  let reason = probe.reason;
  if (provider) {
    const failed = runKats(provider).filter((r) => !r.ok).map((r) => r.name);
    if (failed.length) {
      reason = `${provider.module} failed its power-on self-test (${failed.join("; ")})`;
      provider = null;
    }
  }
  const runtime = typeof Bun !== "undefined" ? `Bun ${process.versions.bun ?? "?"} BoringSSL` : `Node ${process.versions.node} OpenSSL`;
  return (resolved = {
    provider: provider ?? nodeProvider(`node:crypto (${runtime}), not a FIPS 140-validated module: ${reason}`),
    osFipsPolicy: probe.osFipsPolicy,
  });
}

/** The provider for an operation, or FipsRequiredError when policy requires a validated module and the
 *  resolved one is not. Re-evaluated on every call so a policy change applies without a restart. */
function active(): Provider {
  const { provider } = resolveProvider();
  if (!provider.fips && fipsRequired()) {
    const by = process.env.LUCID_FIPS_REQUIRED === "1" ? "LUCID_FIPS_REQUIRED=1" : "managed policy security.crypto.requireFips";
    throw new FipsRequiredError(`FIPS 140-validated cryptography is required (${by}) but no validated module is usable: ${provider.detail}`);
  }
  return provider;
}

// ── public API (Contract A) ───────────────────────────────────────────────────────────────────────────

/** env LUCID_FIPS_REQUIRED=1 OR managed policy security.crypto.requireFips === true (desktop/managed_config.ts). */
export function fipsRequired(): boolean {
  return process.env.LUCID_FIPS_REQUIRED === "1" || managedRequireFips(managedConfig().config);
}

/** Which module performs the operations, whether it is FIPS-validated, and the OS policy. Never throws. */
export function cryptoInfo(): CryptoProviderInfo {
  const { provider, osFipsPolicy } = resolveProvider();
  return { module: provider.module, fips: provider.fips, detail: provider.detail, osFipsPolicy, required: fipsRequired() };
}

/** Re-run the known-answer tests against the active module (the demo and evidence surface). */
export function cryptoSelfTest(): KatResult[] {
  return runKats(active());
}

export function randomBytes(n: number): Buffer {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`randomBytes: bad length ${n}`);
  const p = active();
  return n === 0 ? Buffer.alloc(0) : p.random(n);
}

/** AES-256-GCM: 32-byte key, 12-byte iv, 16-byte tag. Never reuse an iv with the same key. */
export function aesGcmEncrypt(key: Buffer, iv: Buffer, plaintext: Buffer, aad?: Buffer): { ct: Buffer; tag: Buffer } {
  if (key.length !== KEY_LEN) throw new RangeError(`bad key length ${key.length}, want ${KEY_LEN}`);
  if (iv.length !== IV_LEN) throw new RangeError(`bad iv length ${iv.length}, want ${IV_LEN}`);
  return active().gcmEncrypt(key, iv, plaintext, aad);
}

/** AES-256-GCM decrypt. Throws CryptoAuthError on a wrong key, wrong AAD or any tampering. */
export function aesGcmDecrypt(key: Buffer, iv: Buffer, ct: Buffer, tag: Buffer, aad?: Buffer): Buffer {
  if (key.length !== KEY_LEN) throw new RangeError(`bad key length ${key.length}, want ${KEY_LEN}`);
  if (iv.length !== IV_LEN) throw new RangeError(`bad iv length ${iv.length}, want ${IV_LEN}`);
  if (tag.length !== TAG_LEN) throw new RangeError(`bad tag length ${tag.length}, want ${TAG_LEN}`);
  return active().gcmDecrypt(key, iv, ct, tag, aad);
}

export function pbkdf2Sha256(password: Buffer, salt: Buffer, iterations: number, keyLen: number): Buffer {
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > INT32_MAX) throw new RangeError(`pbkdf2Sha256: bad iteration count ${iterations}`);
  if (!Number.isInteger(keyLen) || keyLen < 1 || keyLen > INT32_MAX) throw new RangeError(`pbkdf2Sha256: bad key length ${keyLen}`);
  return active().pbkdf2(password, salt, iterations, keyLen);
}

export function sha256(data: Buffer): Buffer {
  return active().sha256(data);
}

export function hmacSha256(key: Buffer, data: Buffer): Buffer {
  return active().hmac(key, data);
}

/** Test seam: "bun-boringssl" forces the native module unavailable (as on a host without one), null
 *  restores normal probing. Either way the cached resolution is dropped and redone on next use. */
export function _forceModuleForTest(module: "bun-boringssl" | null): void {
  forced = module;
  resolved = undefined;
}
