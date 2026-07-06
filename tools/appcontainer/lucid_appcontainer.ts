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
//   - CreateProcessW the wrapped argv inside that AppContainer via a PROC_THREAD_ATTRIBUTE_SECURITY_
//     CAPABILITIES attribute list; wait; propagate the child's exit code.
//
// FAIL-CLOSED (invariant #3): the seam's `isolates:true` promise MUST hold. If containment cannot be
// established — not Windows, an FFI/Win32 failure, or a mode not yet implemented (`--loopback-only`, the
// mediated case, which needs a WFP/loopback-exemption follow-up) — the helper EXITS NON-ZERO and never
// runs the child. A helper that can't contain must block, never passthrough (that would be false security).

import { dlopen, FFIType, ptr, CString } from "bun:ffi";

// ── the flag contract (mirrors harness/runs/sandbox_exec.ts appContainerArgs) ─────────────────────────
export interface HelperPlan {
  workspace: string;
  home?: string;
  /** "deny" (no network) | "loopback" (mediated, via the proxy) — the two network postures. */
  net: "deny" | "loopback";
  cmd: string;
  cmdArgs: string[];
}

/** PURE: parse `lucid-appcontainer <flags> -- <cmd> <args...>`. Returns a plan or an { error } — never
 *  throws. Unknown flags, a missing `--`, an empty argv, or conflicting/absent net flags are errors
 *  (fail-closed at the boundary, before any spawn). */
export function parseHelperArgs(argv: string[]): HelperPlan | { error: string } {
  let workspace = "", home: string | undefined, deny = false, loopback = false;
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") { i++; break; }
    else if (a === "--deny-network") deny = true;
    else if (a === "--loopback-only") loopback = true;
    else if (a === "--workspace") { workspace = argv[++i] ?? ""; if (!workspace) return { error: "--workspace needs a path" }; }
    else if (a === "--home") { home = argv[++i] ?? ""; if (!home) return { error: "--home needs a path" }; }
    else return { error: `unknown flag: ${a}` };
  }
  const rest = argv.slice(i);
  if (!rest.length) return { error: "no command after --" };
  if (deny === loopback) return { error: "exactly one of --deny-network / --loopback-only is required" };
  if (!workspace) return { error: "--workspace is required" };
  return { workspace, home, net: deny ? "deny" : "loopback", cmd: rest[0]!, cmdArgs: rest.slice(1) };
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

const APPCONTAINER_NAME = "LucidAgentIDE.Sandbox.v1";

// ── Win32 constants ───────────────────────────────────────────────────────────────────────────────────
const PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x00020009;
const EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
const INFINITE = 0xffffffff;
const ERROR_ALREADY_EXISTS_HR = 0x800700b7; // HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)

/** UTF-16LE, null-terminated — the LPCWSTR/LPWSTR shape Win32 wants. */
function wide(s: string): Uint8Array {
  const buf = new Uint8Array((s.length + 1) * 2);
  const dv = new DataView(buf.buffer);
  for (let i = 0; i < s.length; i++) dv.setUint16(i * 2, s.charCodeAt(i), true);
  return buf; // last 2 bytes already 0 (the terminator)
}

/**
 * Run `plan.cmd plan.cmdArgs` inside an AppContainer, returning the child's exit code. Only `net:"deny"`
 * is implemented here (empty capabilities ⇒ no network); `net:"loopback"` throws (its WFP/loopback-
 * exemption is the P-SANDBOX.7b follow-up). Windows-only; throws on any Win32 failure (⇒ the caller
 * fail-closes). NOT pure — this is the FFI edge; the parser above is what the unit tests cover.
 */
export function runInAppContainer(plan: HelperPlan): number {
  if (process.platform !== "win32") throw new Error("lucid-appcontainer runs on Windows only");
  if (plan.net !== "deny") throw new Error("--loopback-only (mediated egress) is not implemented yet (P-SANDBOX.7b)");

  const userenv = dlopen("userenv.dll", {
    CreateAppContainerProfile: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    DeriveAppContainerSidFromAppContainerName: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  });
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
  });

  // 1) AppContainer SID for our moniker (create the profile, or derive if it already exists).
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

  // 2) SECURITY_CAPABILITIES { PSID AppContainerSid; PSID_AND_ATTRIBUTES Capabilities=NULL; DWORD Count=0; DWORD Reserved; }
  const secCaps = new Uint8Array(24);
  new DataView(secCaps.buffer).setBigUint64(0, sid, true); // AppContainerSid; Capabilities/Count/Reserved stay 0 ⇒ NO network capability

  // 3) attribute list: size probe → alloc → init → update(SECURITY_CAPABILITIES)
  const sizeOut = new BigUint64Array(1);
  k32.symbols.InitializeProcThreadAttributeList(null, 1, 0, ptr(sizeOut));
  const listLen = Number(sizeOut[0]!);
  if (!listLen) throw new Error("InitializeProcThreadAttributeList size probe returned 0");
  const attrList = new Uint8Array(listLen);
  if (!k32.symbols.InitializeProcThreadAttributeList(ptr(attrList), 1, 0, ptr(sizeOut)))
    throw new Error(`InitializeProcThreadAttributeList failed (err=${k32.symbols.GetLastError()})`);
  if (!k32.symbols.UpdateProcThreadAttribute(ptr(attrList), 0, BigInt(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES), ptr(secCaps), 24n, null, null))
    throw new Error(`UpdateProcThreadAttribute failed (err=${k32.symbols.GetLastError()})`);

  // 4) STARTUPINFOEXW (x64: STARTUPINFOW is 104 bytes; lpAttributeList at +104 ⇒ total 112).
  const siex = new Uint8Array(112);
  const sdv = new DataView(siex.buffer);
  sdv.setUint32(0, 112, true); // StartupInfo.cb = sizeof(STARTUPINFOEXW)
  sdv.setBigUint64(104, BigInt(ptr(attrList)), true); // lpAttributeList

  // 5) CreateProcessW — mutable command line buffer; EXTENDED_STARTUPINFO_PRESENT; child cwd = workspace.
  const cmdline = wide(buildCommandLine(plan.cmd, plan.cmdArgs));
  const cwd = wide(plan.workspace);
  const pi = new Uint8Array(24); // PROCESS_INFORMATION { hProcess, hThread, dwProcessId, dwThreadId }
  const okCreate = k32.symbols.CreateProcessW(null, ptr(cmdline), null, null, 0, EXTENDED_STARTUPINFO_PRESENT, null, ptr(cwd), ptr(siex), ptr(pi));
  k32.symbols.DeleteProcThreadAttributeList(ptr(attrList));
  if (sid) userenv; // (SID freed by process teardown; LocalFree omitted deliberately — short-lived helper)
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

// ── entrypoint (only when run/compiled as the binary, not when imported by tests) ──────────────────────
export function main(argv: string[]): number {
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
