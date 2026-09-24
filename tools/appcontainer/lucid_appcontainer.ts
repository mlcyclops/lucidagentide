// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// tools/appcontainer/lucid_appcontainer.ts — P-SANDBOX.7 (ADR-0173): the native Windows AppContainer helper.
//
// P-SANDBOX.6 (ADR-0172) built the SEAM: the sandbox picks the AppContainer backend on Windows and shells
// to `lucid-appcontainer <flags> -- <argv>` (Windows has no OS argv-wrapper for a sandbox). THIS is that
// helper. It stays in the Bun/TS language surface (invariant #2 — no C/Rust) yet compiles to a standalone
// `lucid-appcontainer.exe` via `bun build --compile`, using `bun:ffi` to do the real Win32:
//
//   - derive/create an AppContainer SID for a stable LUCID moniker;
//   - build SECURITY_CAPABILITIES with an EMPTY capability set (no `internetClient` ⇒ the AppContainer
//     has NO outbound network — that IS the --deny-network guarantee, enforced by the Windows net stack);
//   - GRANT filesystem DACL ACEs to that container SID (workspace rw; tool dir / --home / --grant-rx
//     rx; --grant-rw rw) — without them an AppContainer child can read/write NOTHING outside the OS
//     dirs, cwd included. Persistent host changes ⇒ logged, scoped, and reversible (`--revoke-acl`);
//   - CreateProcessW the wrapped argv inside that AppContainer via a PROC_THREAD_ATTRIBUTE_SECURITY_
//     CAPABILITIES attribute list; wait; propagate the child's exit code.
//
// FAIL-CLOSED (invariant #3): the seam's `isolates:true` promise MUST hold. If containment cannot be
// established — not Windows, an FFI/Win32 failure, or a mode not yet implemented (`--loopback-only`, the
// mediated case, which needs a WFP/loopback-exemption follow-up) — the helper EXITS NON-ZERO and never
// runs the child. A helper that can't contain must block, never passthrough (that would be false security).

import { dlopen, FFIType, ptr, read as ffiRead, CString, type Pointer } from "bun:ffi";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

// ── the flag contract (mirrors harness/runs/sandbox_exec.ts appContainerArgs) ─────────────────────────
export interface HelperPlan {
  workspace: string;
  home?: string;
  /** "deny" (no network) | "loopback" (mediated, via the proxy) — the two network postures. */
  net: "deny" | "loopback";
  /** extra dirs to ACL-grant READ+EXECUTE to the container SID (`--grant-rx`, repeatable). */
  grantRx: string[];
  /** extra dirs to ACL-grant read/write (GENERIC_ALL) to the container SID (`--grant-rw`, repeatable). */
  grantRw: string[];
  cmd: string;
  cmdArgs: string[];
}

/** PURE: parse `lucid-appcontainer <flags> -- <cmd> <args...>`. Returns a plan or an { error } — never
 *  throws. Unknown flags, a missing `--`, an empty argv, or conflicting/absent net flags are errors
 *  (fail-closed at the boundary, before any spawn). */
export function parseHelperArgs(argv: string[]): HelperPlan | { error: string } {
  let workspace = "", home: string | undefined, deny = false, loopback = false;
  const grantRx: string[] = [], grantRw: string[] = [];
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") { i++; break; }
    else if (a === "--deny-network") deny = true;
    else if (a === "--loopback-only") loopback = true;
    else if (a === "--workspace") { workspace = argv[++i] ?? ""; if (!workspace) return { error: "--workspace needs a path" }; }
    else if (a === "--home") { home = argv[++i] ?? ""; if (!home) return { error: "--home needs a path" }; }
    else if (a === "--grant-rx") { const d = argv[++i] ?? ""; if (!d) return { error: "--grant-rx needs a path" }; grantRx.push(d); }
    else if (a === "--grant-rw") { const d = argv[++i] ?? ""; if (!d) return { error: "--grant-rw needs a path" }; grantRw.push(d); }
    else return { error: `unknown flag: ${a}` };
  }
  const rest = argv.slice(i);
  if (!rest.length) return { error: "no command after --" };
  if (deny === loopback) return { error: "exactly one of --deny-network / --loopback-only is required" };
  if (!workspace) return { error: "--workspace is required" };
  return { workspace, home, net: deny ? "deny" : "loopback", grantRx, grantRw, cmd: rest[0]!, cmdArgs: rest.slice(1) };
}

/** Quote one argv token for a Windows command line (CreateProcessW parses CommandLineToArgvW rules). */
export function quoteArg(a: string): string {
  if (a.length && !/[\s"]/.test(a)) return a;
  // escape backslashes that precede a quote, then the quote itself; wrap in quotes.
  let out = '"';
  let bs = 0;
  for (const ch of a) {
    if (ch === "\\") { bs++; out += ch; }
    else if (ch === '"') { out += "\\".repeat(bs + 1) + '"'; bs = 0; }
    else { bs = 0; out += ch; }
  }
  out += "\\".repeat(bs) + '"';
  return out;
}

/** PURE: build the CreateProcessW command line from cmd + args. */
export function buildCommandLine(cmd: string, args: string[]): string {
  return [cmd, ...args].map(quoteArg).join(" ");
}

// ── filesystem ACL grants (the missing half of containment) ───────────────────────────────────────────
// An AppContainer process is DENIED everything its container SID is not explicitly granted; "ALL
// APPLICATION PACKAGES" only covers OS dirs (C:\Windows, Program Files). Without grants the child cannot
// even read/write the workspace — cwd alone confers nothing. So BEFORE spawning we grant the container
// SID an inheritable ACE on exactly the dirs the plan names. Every grant is a PERSISTENT host DACL
// change, therefore: scoped to the named dirs only, attributed to the stable moniker SID
// (LucidAgentIDE.Sandbox.v1 — auditable & bulk-revocable), logged to stderr, and reversible via the
// `--revoke-acl <path>` admin subcommand.

export interface AclTarget {
  path: string;
  /** "rw" = GENERIC_ALL; "rx" = GENERIC_READ|GENERIC_EXECUTE (never write outside the workspace). */
  mode: "rw" | "rx";
}

/** PURE: the parent directory of a Windows path (both separators; no filesystem access). */
export function parentDir(p: string): string {
  const t = p.replace(/[\\/]+$/, "");
  const i = Math.max(t.lastIndexOf("\\"), t.lastIndexOf("/"));
  return i > 0 ? t.slice(0, i) : t;
}

/** PURE: is this path already readable by "ALL APPLICATION PACKAGES" out of the box? Windows ships
 *  package-readable DACLs on the OS dirs, so granting there would be a pointless persistent mutation. */
export function isPackageReadablePath(p: string): boolean {
  const n = p.replace(/\//g, "\\").toLowerCase();
  return /^[a-z]:\\windows(\\|$)/.test(n) || /^[a-z]:\\program files( \(x86\))?(\\|$)/.test(n);
}

/**
 * PURE: which dirs get which ACL grant for this plan. `resolvedCmd` is the absolute path of plan.cmd as
 * resolved by the (impure) caller via Bun.which — null/undefined when un-resolvable, in which case the
 * rx grant for the tool dir is simply skipped (the caller notes it; CreateProcessW's own search may
 * still find the exe under an already-readable dir). Grants: workspace → rw; the tool's dir → rx unless
 * it is already package-readable (OS dirs); --home → rx ONLY (agents read config from home, never write
 * it); every --grant-rx/--grant-rw dir verbatim. Deduped by path — rw wins over rx.
 */
export function aclTargets(plan: HelperPlan, resolvedCmd?: string | null): AclTarget[] {
  const want: AclTarget[] = [{ path: plan.workspace, mode: "rw" }];
  if (resolvedCmd) {
    const dir = parentDir(resolvedCmd);
    if (!isPackageReadablePath(dir)) want.push({ path: dir, mode: "rx" });
  }
  if (plan.home) want.push({ path: plan.home, mode: "rx" });
  for (const d of plan.grantRx) want.push({ path: d, mode: "rx" });
  for (const d of plan.grantRw) want.push({ path: d, mode: "rw" });
  // dedupe (case-insensitive, separator-normalized); rw beats rx for the same dir.
  const byKey = new Map<string, AclTarget>();
  for (const t of want) {
    const key = t.path.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
    const prev = byKey.get(key);
    if (!prev || (prev.mode === "rx" && t.mode === "rw")) byKey.set(key, prev ? { ...prev, mode: "rw" } : t);
  }
  return [...byKey.values()];
}

// ACL access masks / modes (WinNT.h, AccCtrl.h).
const GENERIC_ALL = 0x10000000; // "rw"
const GENERIC_READ_EXECUTE = 0xa0000000; // GENERIC_READ | GENERIC_EXECUTE — "rx"
const GRANT_ACCESS = 1;
const REVOKE_ACCESS = 4;
const SUB_CONTAINERS_AND_OBJECTS_INHERIT = 3; // CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE
const SE_FILE_OBJECT = 1;
const DACL_SECURITY_INFORMATION = 4;
const TRUSTEE_IS_SID = 0; // TRUSTEE_FORM

/**
 * PURE: one EXPLICIT_ACCESS_W, x64 layout (48 bytes) — the input record for SetEntriesInAclW.
 *   +0  grfAccessPermissions u32      +4  grfAccessMode u32 (GRANT_ACCESS=1 / REVOKE_ACCESS=4)
 *   +8  grfInheritance u32 (=3)       +12 (pad)
 *   +16 TRUSTEE_W (32 bytes): +16 pMultipleTrustee=NULL, +24 MultipleTrusteeOperation=0, +28 (pad),
 *       +32 TrusteeForm=TRUSTEE_IS_SID(0), +36 TrusteeType=0, +40 ptstrName = the AppContainer PSID.
 * Byte-layout-critical ⇒ unit-tested; the PSID is an opaque pointer-sized integer (bigint).
 */
export function buildExplicitAccessW(access: number, accessMode: number, sid: bigint): Uint8Array {
  const ea = new Uint8Array(48);
  const dv = new DataView(ea.buffer);
  dv.setUint32(0, access >>> 0, true); // grfAccessPermissions
  dv.setUint32(4, accessMode >>> 0, true); // grfAccessMode
  dv.setUint32(8, SUB_CONTAINERS_AND_OBJECTS_INHERIT, true); // grfInheritance
  // TRUSTEE_W: everything zero (pMultipleTrustee NULL, NO_MULTIPLE_TRUSTEE, TRUSTEE_IS_SID, type 0) …
  dv.setUint32(32, TRUSTEE_IS_SID, true); // (explicit for readability — already 0)
  dv.setBigUint64(40, sid, true); // … except ptstrName = PSID
  return ea;
}

const APPCONTAINER_NAME = "LucidAgentIDE.Sandbox.v1";

// ── Win32 constants ───────────────────────────────────────────────────────────────────────────────────
const PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x00020009;
const PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002;
const EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
const CREATE_NO_WINDOW = 0x08000000;
const STARTF_USESTDHANDLES = 0x00000100;
const HANDLE_FLAG_INHERIT = 0x00000001;
const STD_INPUT_HANDLE = -10;
const STD_OUTPUT_HANDLE = -11;
const STD_ERROR_HANDLE = -12;
const INVALID_HANDLE = 0xffffffffffffffffn; // INVALID_HANDLE_VALUE as a pointer-sized unsigned

// ── stdio into the container (P-SANDBOX.9, ADR-0386) ───────────────────────────────────────────────────
// The wrapped omp speaks ACP over stdin/stdout, so the child MUST own the helper's std handles. Before
// this, CreateProcessW ran with bInheritHandles=FALSE and no STARTF_USESTDHANDLES: the parent's handles
// are pipes (not console handles), so the child got none. omp saw EOF on stdin, exited 1, and its stderr
// went nowhere, leaving our own last "acl grant" line as the only "last stderr" the engine could show.
// Fix: mark exactly the three std handles inheritable, pass them in STARTUPINFO, and restrict
// inheritance to THEM with PROC_THREAD_ATTRIBUTE_HANDLE_LIST, so no other handle this helper holds
// leaks into the container.

export interface StdHandles { stdin: bigint; stdout: bigint; stderr: bigint }

/** PURE: the distinct, real handles to inherit. NULL / INVALID_HANDLE_VALUE are dropped (an absent
 *  stream stays absent), and duplicates are removed because PROC_THREAD_ATTRIBUTE_HANDLE_LIST rejects a
 *  repeated handle (stdout and stderr are often the same pipe). */
export function inheritableHandleList(h: StdHandles): bigint[] {
  const out: bigint[] = [];
  for (const v of [h.stdin, h.stdout, h.stderr]) {
    if (v === 0n || v === INVALID_HANDLE || out.includes(v)) continue;
    out.push(v);
  }
  return out;
}

/** PURE: a real std handle, or 0 (never INVALID_HANDLE_VALUE) for the STARTUPINFO slot. */
function slot(v: bigint): bigint {
  return v === INVALID_HANDLE ? 0n : v;
}

/**
 * PURE: STARTUPINFOEXW, x64 layout (112 bytes). STARTUPINFOW is 104 bytes:
 *   +0 cb u32 · +8 lpReserved · +16 lpDesktop · +24 lpTitle · +32..+56 dwX..dwFillAttribute (7 × u32)
 *   +60 dwFlags u32 · +64 wShowWindow u16 · +66 cbReserved2 u16 · +72 lpReserved2
 *   +80 hStdInput · +88 hStdOutput · +96 hStdError
 * then +104 lpAttributeList. Byte-layout-critical, so unit-tested.
 */
export function buildStartupInfoExW(attrList: bigint, h: StdHandles): Uint8Array {
  const siex = new Uint8Array(112);
  const dv = new DataView(siex.buffer);
  dv.setUint32(0, 112, true); // cb = sizeof(STARTUPINFOEXW)
  dv.setUint32(60, STARTF_USESTDHANDLES, true);
  dv.setBigUint64(80, slot(h.stdin), true);
  dv.setBigUint64(88, slot(h.stdout), true);
  dv.setBigUint64(96, slot(h.stderr), true);
  dv.setBigUint64(104, attrList, true);
  return siex;
}

/** PURE: CreateProcessW creation flags. Launched from the GUI engine the helper has no console, and a
 *  console child would otherwise get a NEW visible console window; with a console (a terminal run) the
 *  child shares it as before. */
export function creationFlags(hasConsole: boolean): number {
  return (EXTENDED_STARTUPINFO_PRESENT | (hasConsole ? 0 : CREATE_NO_WINDOW)) >>> 0;
}
const INFINITE = 0xffffffff;
const ERROR_ALREADY_EXISTS_HR = 0x800700b7; // HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)

/** UTF-16LE, null-terminated — the LPCWSTR/LPWSTR shape Win32 wants. */
function wide(s: string): Uint8Array {
  const buf = new Uint8Array((s.length + 1) * 2);
  const dv = new DataView(buf.buffer);
  for (let i = 0; i < s.length; i++) dv.setUint16(i * 2, s.charCodeAt(i), true);
  return buf; // last 2 bytes already 0 (the terminator)
}

/** The AppContainer SID (PSID, opaque pointer) for our stable moniker: create the profile, or derive
 *  when it already exists. Windows-only; throws on failure (⇒ fail-closed). Shared by the run path AND
 *  the ACL grant/revoke paths so every persistent DACL change is attributed to the SAME auditable SID. */
function containerSid(): bigint {
  const userenv = dlopen("userenv.dll", {
    CreateAppContainerProfile: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    DeriveAppContainerSidFromAppContainerName: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  });
  const sidOut = new BigUint64Array(1); // PSID*
  const name = wide(APPCONTAINER_NAME);
  const disp = wide("LucidAgentIDE Sandbox");
  const desc = wide("Runtime-isolated agent subprocess (P-SANDBOX)");
  let hr = userenv.symbols.CreateAppContainerProfile(ptr(name), ptr(disp), ptr(desc), null, 0, ptr(sidOut));
  if (hr === ERROR_ALREADY_EXISTS_HR || (hr >>> 0) === ERROR_ALREADY_EXISTS_HR) {
    hr = userenv.symbols.DeriveAppContainerSidFromAppContainerName(ptr(name), ptr(sidOut));
  }
  if (hr !== 0) throw new Error(`AppContainer SID failed (hr=0x${(hr >>> 0).toString(16)})`);
  const sid = sidOut[0]!; // PSID (bigint pointer)
  if (!sid) throw new Error("AppContainer SID is null");
  return sid;
}

/**
 * Mutate `path`'s DACL: read it (GetNamedSecurityInfoW), merge ONE EXPLICIT_ACCESS_W for the container
 * SID (SetEntriesInAclW — whose merge semantics also make re-grants IDEMPOTENT: an identical ACE is
 * coalesced, never stacked), write it back (SetNamedSecurityInfoW). `accessMode` GRANT_ACCESS adds the
 * inheritable ACE; REVOKE_ACCESS strips every ACE for the SID (the `--revoke-acl` path). Windows-only;
 * throws on any Win32 failure so callers fail-closed BEFORE any spawn. NOT pure — the FFI edge.
 */
function modifyDacl(path: string, access: number, accessMode: number, sid: bigint): void {
  const advapi = dlopen("advapi32.dll", {
    GetNamedSecurityInfoW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    // OldAcl / NewAcl / pDacl are pointer-sized values passed BY VALUE ⇒ u64 (same convention as HANDLEs above).
    SetEntriesInAclW: { args: [FFIType.u32, FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.u32 },
    SetNamedSecurityInfoW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u64], returns: FFIType.u32 },
  });
  const kfree = dlopen("kernel32.dll", { LocalFree: { args: [FFIType.u64], returns: FFIType.u64 } });

  const wpath = wide(path);
  const daclOut = new BigUint64Array(1); // PACL (points INTO the SD — freed with it, never separately)
  const sdOut = new BigUint64Array(1); // PSECURITY_DESCRIPTOR (LocalFree'd)
  let rc = advapi.symbols.GetNamedSecurityInfoW(ptr(wpath), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, null, null, ptr(daclOut), null, ptr(sdOut));
  if (rc !== 0) throw new Error(`GetNamedSecurityInfoW(${path}) failed (err=${rc})`);

  const ea = buildExplicitAccessW(access, accessMode, sid);
  const newAclOut = new BigUint64Array(1);
  rc = advapi.symbols.SetEntriesInAclW(1, ptr(ea), daclOut[0]!, ptr(newAclOut));
  if (rc !== 0) {
    kfree.symbols.LocalFree(sdOut[0]!);
    throw new Error(`SetEntriesInAclW(${path}) failed (err=${rc})`);
  }
  rc = advapi.symbols.SetNamedSecurityInfoW(ptr(wpath), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, null, null, newAclOut[0]!, 0n);
  kfree.symbols.LocalFree(newAclOut[0]!);
  kfree.symbols.LocalFree(sdOut[0]!);
  if (rc !== 0) throw new Error(`SetNamedSecurityInfoW(${path}) failed (err=${rc})`);
}

/**
 * Run `plan.cmd plan.cmdArgs` inside an AppContainer, returning the child's exit code. BOTH network
 * postures use the SAME container: an EMPTY capability set ⇒ no `internetClient` ⇒ NO direct outbound
 * internet (P-SANDBOX.7). The postures differ only in the AMBIENT system state, not in this spawn:
 *   - `deny`     — nothing else; the child has no network at all.
 *   - `loopback` — the child ADDITIONALLY inherits HTTP(S)_PROXY (set by the seam) and relies on a
 *     one-time, admin-registered LOOPBACK EXEMPTION for our AppContainer SID (`--register-loopback`,
 *     P-SANDBOX.7b) so it can reach ONLY the loopback proxy. Without the exemption it simply has no
 *     network (fail-closed) — never direct internet. The no-internet guarantee holds either way.
 * Windows-only; throws on any Win32 failure (⇒ the caller fail-closes). NOT pure — the FFI edge.
 */
export function runInAppContainer(plan: HelperPlan): number {
  if (process.platform !== "win32") throw new Error("lucid-appcontainer runs on Windows only");

  const k32 = dlopen("kernel32.dll", {
    InitializeProcThreadAttributeList: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    UpdateProcThreadAttribute: { args: [FFIType.ptr, FFIType.u32, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    DeleteProcThreadAttributeList: { args: [FFIType.ptr], returns: FFIType.void },
    CreateProcessW: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    // HANDLEs are opaque pointer-sized integers passed BY VALUE — u64 (bun:ffi rejects a raw int as a `ptr` arg).
    WaitForSingleObject: { args: [FFIType.u64, FFIType.u32], returns: FFIType.u32 },
    GetExitCodeProcess: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
    GetStdHandle: { args: [FFIType.i32], returns: FFIType.u64 },
    SetHandleInformation: { args: [FFIType.u64, FFIType.u32, FFIType.u32], returns: FFIType.i32 },
    GetConsoleWindow: { args: [], returns: FFIType.u64 },
  });

  // 1) AppContainer SID for our moniker (create the profile, or derive if it already exists).
  const sid = containerSid();

  // 1b) resolve the tool's absolute path (Bun.which for bare names; the filesystem for anything with a
  // separator) and GRANT the filesystem ACLs the plan names — BEFORE any spawn, so a failed grant
  // throws and fail-closes without ever running the child. Un-resolvable cmd ⇒ pass it through
  // unchanged (CreateProcessW's own search may still find it) but skip its rx grant, with a note.
  const resolvedCmd = /[\\/]/.test(plan.cmd)
    ? (existsSync(plan.cmd) ? resolvePath(plan.cmd) : null)
    : (Bun.which(plan.cmd) ?? null);
  if (!resolvedCmd) {
    process.stderr.write(`[lucid-appcontainer] note: cannot resolve '${plan.cmd}' to an absolute path - skipping its rx grant\n`);
  } else if (isPackageReadablePath(parentDir(resolvedCmd))) {
    process.stderr.write(`[lucid-appcontainer] note: ${parentDir(resolvedCmd)} is already package-readable - skipping rx grant\n`);
  }
  for (const t of aclTargets(plan, resolvedCmd)) {
    modifyDacl(t.path, t.mode === "rw" ? GENERIC_ALL : GENERIC_READ_EXECUTE, GRANT_ACCESS, sid);
    process.stderr.write(`[lucid-appcontainer] acl grant ${t.path} ${t.mode}\n`);
  }

  // 2) SECURITY_CAPABILITIES { PSID AppContainerSid; PSID_AND_ATTRIBUTES Capabilities=NULL; DWORD Count=0; DWORD Reserved; }
  const secCaps = new Uint8Array(24);
  new DataView(secCaps.buffer).setBigUint64(0, sid, true); // AppContainerSid; Capabilities/Count/Reserved stay 0 ⇒ NO network capability

  // 2b) the std handles the child must own (P-SANDBOX.9): inheritable, and the ONLY inheritable ones.
  const std: StdHandles = {
    stdin: k32.symbols.GetStdHandle(STD_INPUT_HANDLE),
    stdout: k32.symbols.GetStdHandle(STD_OUTPUT_HANDLE),
    stderr: k32.symbols.GetStdHandle(STD_ERROR_HANDLE),
  };
  const inherit = inheritableHandleList(std);
  for (const h of inherit) {
    if (!k32.symbols.SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT))
      throw new Error(`SetHandleInformation(std handle) failed (err=${k32.symbols.GetLastError()})`);
  }
  const handleList = new BigUint64Array(inherit); // must outlive CreateProcessW

  // 3) attribute list: size probe → alloc → init → update(SECURITY_CAPABILITIES [, HANDLE_LIST])
  const attrCount = inherit.length ? 2 : 1;
  const sizeOut = new BigUint64Array(1);
  k32.symbols.InitializeProcThreadAttributeList(null, attrCount, 0, ptr(sizeOut));
  const listLen = Number(sizeOut[0]!);
  if (!listLen) throw new Error("InitializeProcThreadAttributeList size probe returned 0");
  const attrList = new Uint8Array(listLen);
  if (!k32.symbols.InitializeProcThreadAttributeList(ptr(attrList), attrCount, 0, ptr(sizeOut)))
    throw new Error(`InitializeProcThreadAttributeList failed (err=${k32.symbols.GetLastError()})`);
  if (!k32.symbols.UpdateProcThreadAttribute(ptr(attrList), 0, BigInt(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES), ptr(secCaps), 24n, null, null))
    throw new Error(`UpdateProcThreadAttribute failed (err=${k32.symbols.GetLastError()})`);
  if (inherit.length && !k32.symbols.UpdateProcThreadAttribute(ptr(attrList), 0, BigInt(PROC_THREAD_ATTRIBUTE_HANDLE_LIST), ptr(handleList), BigInt(inherit.length * 8), null, null))
    throw new Error(`UpdateProcThreadAttribute(HANDLE_LIST) failed (err=${k32.symbols.GetLastError()})`);

  // 4) STARTUPINFOEXW carrying the std handles + the attribute list.
  const siex = buildStartupInfoExW(BigInt(ptr(attrList)), std);

  // 5) CreateProcessW: mutable command line buffer; inherit ONLY the listed handles; child cwd = workspace.
  const cmdline = wide(buildCommandLine(resolvedCmd ?? plan.cmd, plan.cmdArgs));
  const cwd = wide(plan.workspace);
  const pi = new Uint8Array(24); // PROCESS_INFORMATION { hProcess, hThread, dwProcessId, dwThreadId }
  const flags = creationFlags(k32.symbols.GetConsoleWindow() !== 0n);
  const okCreate = k32.symbols.CreateProcessW(null, ptr(cmdline), null, null, inherit.length ? 1 : 0, flags, null, ptr(cwd), ptr(siex), ptr(pi));
  k32.symbols.DeleteProcThreadAttributeList(ptr(attrList));
  // (SID freed by process teardown; FreeSid omitted deliberately — short-lived helper)
  if (!okCreate) throw new Error(`CreateProcessW failed (err=${k32.symbols.GetLastError()})`);

  const pdv = new DataView(pi.buffer);
  const hProcess = pdv.getBigUint64(0, true);
  const hThread = pdv.getBigUint64(8, true);

  // 6) wait + propagate exit code (HANDLEs passed by value as u64).
  k32.symbols.WaitForSingleObject(hProcess, INFINITE);
  const codeOut = new Uint32Array(1);
  k32.symbols.GetExitCodeProcess(hProcess, ptr(codeOut));
  k32.symbols.CloseHandle(hProcess);
  k32.symbols.CloseHandle(hThread);
  void CString;
  return codeOut[0]! >>> 0;
}

// ── loopback exemption (P-SANDBOX.7b): a one-time ADMIN op so the AppContainer can reach ONLY the ─────
// loopback proxy. AppContainers block loopback by default; `CheckNetIsolation LoopbackExempt` (which ships
// with Windows) toggles it per AppContainer name. This needs elevation, so it is an INSTALL-time step, not
// something the per-spawn run path does. `--loopback-only` at runtime relies on this having been registered.
export function checkNetIsolationArgs(op: "add" | "delete"): string[] {
  return ["LoopbackExempt", op === "add" ? "-a" : "-d", `-n=${APPCONTAINER_NAME}`];
}

function loopbackExemption(op: "add" | "delete"): number {
  if (process.platform !== "win32") {
    process.stderr.write("[lucid-appcontainer] loopback exemption is Windows-only\n");
    return 3;
  }
  if (op === "add") {
    // P-SANDBOX.9 (ADR-0386): the PROFILE must exist before the exemption. Registered against a name
    // with no profile yet, Windows stores a bare SID that lists as "AppContainer NOT FOUND", so the
    // engine's by-name match never saw it and the session stayed the disclosed passthrough although
    // register exited 0 (observed live). containerSid() creates the profile (or derives the existing one).
    try {
      containerSid();
    } catch (e) {
      process.stderr.write(`[lucid-appcontainer] loopback exemption add failed: cannot create the AppContainer profile: ${String((e as Error).message ?? e)}\n`);
      return 3;
    }
  }
  const args = checkNetIsolationArgs(op);
  const r = Bun.spawnSync(["CheckNetIsolation.exe", ...args], { stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) {
    process.stderr.write(`[lucid-appcontainer] loopback exemption ${op} failed (exit ${r.exitCode}) - run elevated (admin).\n`);
  }
  return r.exitCode ?? 3;
}

// ── standalone ACL subcommands (P-SANDBOX.8): user-approved standing directory grants ─────────────────
// The desktop's grant flow (desktop/sandbox_grants.ts) shells here so EVERY persistent DACL change —
// grant, probe, undo — goes through the one binary that owns the container SID, and is logged the same way.

/** PURE: the `--apply-acl` mode vocabulary ("rx"/"rw", the aclTargets words); anything else is refused. */
export function parseAclMode(m: string | undefined): "rx" | "rw" | null {
  return m === "rx" || m === "rw" ? m : null;
}

/** Subcommand: grant the container SID one inheritable ACE on `path` — the standalone form of the
 *  per-spawn grants in runInAppContainer (same modifyDacl, same idempotent merge, same log line). */
function applyAcl(mode: "rx" | "rw", path: string): number {
  if (process.platform !== "win32") {
    process.stderr.write("[lucid-appcontainer] --apply-acl is Windows-only\n");
    return 3;
  }
  try {
    modifyDacl(path, mode === "rw" ? GENERIC_ALL : GENERIC_READ_EXECUTE, GRANT_ACCESS, containerSid());
    process.stderr.write(`[lucid-appcontainer] acl grant ${path} ${mode}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`[lucid-appcontainer] acl grant failed: ${String((e as Error).message ?? e)}\n`);
    return 3;
  }
}

/** The container SID as its S-1-15-2-… string (ConvertSidToStringSidW), for matching icacls output. */
function containerSidString(): string {
  const advapi = dlopen("advapi32.dll", {
    // PSID passed BY VALUE (pointer-sized int, same convention as modifyDacl's pDacl args) ⇒ u64.
    ConvertSidToStringSidW: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  });
  const kfree = dlopen("kernel32.dll", { LocalFree: { args: [FFIType.u64], returns: FFIType.u64 } });
  const out = new BigUint64Array(1); // LPWSTR* (LocalFree'd)
  if (!advapi.symbols.ConvertSidToStringSidW(containerSid(), ptr(out))) throw new Error("ConvertSidToStringSidW failed");
  const base = Number(out[0]!); // user-mode pointer < 2^48 — exact as a JS number
  let s = "";
  for (let i = 0; ; i++) {
    const c = ffiRead.u16(base as Pointer, i * 2);
    if (!c) break;
    s += String.fromCharCode(c);
  }
  kfree.symbols.LocalFree(out[0]!);
  return s;
}

/** PURE: does an `icacls <path>` listing hold an EXPLICIT ACE for this SID? icacls prints AppContainer
 *  trustees as the raw S-1-15-2-… string (they resolve to no account name). Two traps this parser
 *  survives (both observed live): (1) console-width wrapping can split an ACE mid-SID, so ALL whitespace
 *  is collapsed before matching; (2) an ACE inherited from a parent grant carries the (I) flag and MUST
 *  NOT count — it is the parent's row, and REVOKE_ACCESS on this path cannot remove it. */
export function icaclsListsSid(output: string, sidStr: string): boolean {
  if (!sidStr) return false; // an empty needle must never read as "granted everywhere"
  const flat = output.replace(/\s+/g, "").toLowerCase();
  const needle = `${sidStr.toLowerCase()}:`;
  for (let i = flat.indexOf(needle); i !== -1; i = flat.indexOf(needle, i + needle.length)) {
    // Collect this ACE's parenthesized flag groups: (I)(OI)(CI)(RX)…
    let j = i + needle.length;
    let flags = "";
    while (flat[j] === "(") {
      const close = flat.indexOf(")", j);
      if (close === -1) break;
      flags += flat.slice(j, close + 1);
      j = close + 1;
    }
    if (!/\(i\)/.test(flags)) return true; // explicit ((IO) does not match — the group must be exactly (i))
  }
  return false;
}

/** Subcommand: exit 0 when the container SID holds an EXPLICIT ACE on `path` itself, 1 when not, 3 on
 *  error. Inherited ACEs deliberately do NOT count: they flow from (and are revoked at) a parent grant.
 *  IMPLEMENTATION CHOICE: parse `icacls <path>` (ships with Windows) for the SID string instead of
 *  GetNamedSecurityInfoW + GetExplicitEntriesFromAclW — the FFI route means walking a variable-length
 *  EXPLICIT_ACCESS_W array of nested TRUSTEE_W structs byte-by-byte for a boolean this command answers
 *  reliably in one line; the grant/revoke WRITES stay real Win32 (modifyDacl). */
function checkAcl(path: string): number {
  if (process.platform !== "win32") {
    process.stderr.write("[lucid-appcontainer] --check-acl is Windows-only\n");
    return 3;
  }
  try {
    const sidStr = containerSidString();
    const r = Bun.spawnSync(["icacls.exe", path], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) {
      process.stderr.write(`[lucid-appcontainer] acl check failed: icacls exit ${r.exitCode}: ${new TextDecoder().decode(r.stderr).trim()}\n`);
      return 3;
    }
    const granted = icaclsListsSid(new TextDecoder().decode(r.stdout), sidStr);
    process.stderr.write(`[lucid-appcontainer] acl check ${path}: ${granted ? "granted" : "absent"} (${sidStr})\n`);
    return granted ? 0 : 1;
  } catch (e) {
    process.stderr.write(`[lucid-appcontainer] acl check failed: ${String((e as Error).message ?? e)}\n`);
    return 3;
  }
}

/** Admin subcommand: strip every ACE our container SID holds on `path` (REVOKE_ACCESS removes grant AND
 *  deny entries for the trustee, whatever their mask) — the UNDO for the persistent grants above. */
function revokeAcl(path: string): number {
  if (process.platform !== "win32") {
    process.stderr.write("[lucid-appcontainer] --revoke-acl is Windows-only\n");
    return 3;
  }
  try {
    modifyDacl(path, GENERIC_ALL, REVOKE_ACCESS, containerSid());
    process.stderr.write(`[lucid-appcontainer] acl revoke ${path}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`[lucid-appcontainer] acl revoke failed: ${String((e as Error).message ?? e)}\n`);
    return 3;
  }
}

// ── folder picker (P-SANDBOX.13b, ADR-0393): the Security panel's "Add folder" dialog, without PowerShell ──
// The engine's native picker (desktop/native_dialog.ts) compiles a C# shim with PowerShell Add-Type. On a
// host where Smart App Control / WDAC enforces PowerShell's Constrained Language Mode, Add-Type is refused
// and the picker reported "no native folder dialog". This helper already runs on such hosts, so it opens
// the shell's Browse For Folder dialog directly (SHBrowseForFolderW, a plain shell32 call; no COM vtables,
// no script host). Output uses the same markers the engine already parses (parseWinPick).
export const PICK_PICKED_MARK = "LUCID_PICKED::";
export const PICK_CANCEL_MARK = "LUCID_CANCELLED::";
const BIF_RETURNONLYFSDIRS = 0x0001;
const BIF_NEWDIALOGSTYLE = 0x0040; // resizable, with "Make New Folder"; needs an STA (CoInitializeEx)
const MAX_PATH_W = 1024; // wide chars; generous for long paths

/**
 * PURE: BROWSEINFOW, x64 layout (64 bytes):
 *   +0 hwndOwner · +8 pidlRoot · +16 pszDisplayName · +24 lpszTitle · +32 ulFlags u32 (+4 pad)
 *   +40 lpfn · +48 lParam · +56 iImage i32 (+4 pad)
 * Byte-layout-critical, so unit-tested; pointers are opaque bigints.
 */
export function buildBrowseInfoW(owner: bigint, displayBuf: bigint, title: bigint, flags: number): Uint8Array {
  const b = new Uint8Array(64);
  const dv = new DataView(b.buffer);
  dv.setBigUint64(0, owner, true);
  dv.setBigUint64(16, displayBuf, true);
  dv.setBigUint64(24, title, true);
  dv.setUint32(32, flags >>> 0, true);
  return b;
}

/** Subcommand: show the folder dialog; print PICKED::<path> or CANCELLED::. Exit 0 either way, 3 on error. */
function pickFolder(title: string): number {
  if (process.platform !== "win32") {
    process.stderr.write("[lucid-appcontainer] --pick-folder is Windows-only\n");
    return 3;
  }
  try {
    const ole = dlopen("ole32.dll", {
      CoInitializeEx: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      CoTaskMemFree: { args: [FFIType.u64], returns: FFIType.void },
    });
    const shell = dlopen("shell32.dll", {
      SHBrowseForFolderW: { args: [FFIType.ptr], returns: FFIType.u64 },
      SHGetPathFromIDListW: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    });
    const user = dlopen("user32.dll", {
      GetForegroundWindow: { args: [], returns: FFIType.u64 },
      ShowWindow: { args: [FFIType.u64, FFIType.i32], returns: FFIType.i32 },
    });
    const k32 = dlopen("kernel32.dll", { GetConsoleWindow: { args: [], returns: FFIType.u64 } });
    // The engine spawns us with windowsHide (STARTF_USESHOWWINDOW + SW_HIDE), and Windows applies that to
    // the process's FIRST ShowWindow call, which would otherwise be the dialog: it would open invisible.
    // Spend that first call on our own (hidden) console window.
    const con = k32.symbols.GetConsoleWindow();
    if (con) user.symbols.ShowWindow(con, 0); // SW_HIDE
    ole.symbols.CoInitializeEx(null, 0x2); // COINIT_APARTMENTTHREADED
    const display = new Uint8Array(MAX_PATH_W * 2);
    const wTitle = wide(title || "Choose a folder");
    const bi = buildBrowseInfoW(user.symbols.GetForegroundWindow(), BigInt(ptr(display)), BigInt(ptr(wTitle)), BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE);
    const pidl = shell.symbols.SHBrowseForFolderW(ptr(bi));
    if (!pidl) {
      process.stdout.write(PICK_CANCEL_MARK);
      return 0;
    }
    const out = new Uint8Array(MAX_PATH_W * 2);
    const ok = shell.symbols.SHGetPathFromIDListW(pidl, ptr(out));
    ole.symbols.CoTaskMemFree(pidl);
    if (!ok) {
      process.stderr.write("[lucid-appcontainer] the picked item is not a file-system folder\n");
      process.stdout.write(PICK_CANCEL_MARK);
      return 0;
    }
    let path = "";
    const dv = new DataView(out.buffer);
    for (let i = 0; i < MAX_PATH_W; i++) {
      const c = dv.getUint16(i * 2, true);
      if (!c) break;
      path += String.fromCharCode(c);
    }
    process.stdout.write(PICK_PICKED_MARK + path);
    return 0;
  } catch (e) {
    process.stderr.write(`[lucid-appcontainer] pick-folder failed: ${String((e as Error).message ?? e)}\n`);
    return 3;
  }
}

// ── entrypoint (only when run/compiled as the binary, not when imported by tests) ──────────────────────
export function main(argv: string[]): number {
  // Admin subcommands (install-time): register/unregister the loopback exemption for our AppContainer SID.
  if (argv[0] === "--register-loopback") return loopbackExemption("add");
  if (argv[0] === "--unregister-loopback") return loopbackExemption("delete");
  // Admin subcommand: reverse a persistent filesystem grant made for the container SID.
  if (argv[0] === "--revoke-acl") {
    const p = argv[1];
    if (!p) { process.stderr.write("[lucid-appcontainer] FAIL-CLOSED: --revoke-acl needs a path\n"); return 2; }
    return revokeAcl(p);
  }
  // P-SANDBOX.8: standalone grant + probe, driven by the desktop's user-approved directory-grant flow.
  if (argv[0] === "--apply-acl") {
    const mode = parseAclMode(argv[1]);
    const p = argv[2];
    if (!mode || !p) { process.stderr.write("[lucid-appcontainer] FAIL-CLOSED: --apply-acl needs <rx|rw> <path>\n"); return 2; }
    return applyAcl(mode, p);
  }
  if (argv[0] === "--pick-folder") return pickFolder(argv[1] ?? "");
  if (argv[0] === "--check-acl") {
    const p = argv[1];
    if (!p) { process.stderr.write("[lucid-appcontainer] FAIL-CLOSED: --check-acl needs a path\n"); return 2; }
    return checkAcl(p);
  }

  const plan = parseHelperArgs(argv);
  if ("error" in plan) {
    process.stderr.write(`[lucid-appcontainer] FAIL-CLOSED: ${plan.error}\n`);
    return 2;
  }
  try {
    return runInAppContainer(plan);
  } catch (e) {
    process.stderr.write(`[lucid-appcontainer] FAIL-CLOSED: could not establish AppContainer isolation - refusing to run the child. ${String((e as Error).message ?? e)}\n`);
    return 3; // fail-closed: never run the child un-isolated
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
