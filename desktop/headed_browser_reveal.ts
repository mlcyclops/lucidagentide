// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/headed_browser_reveal.ts - P-BROWSER.5 (ADR-0456): the agent's visible browser is shown again.
//
// ADR-0415 (P-BROWSER.4) fixed the white, frameless, unclosable Chrome window at the seam LUCID owned: give
// omp a hidden console so omp's daemon broker spawned the shared headed Chromium without SW_HIDE. omp 18.8
// moved the broker out of reach: it is now spawned `{ detached: true, windowsHide: true }`
// (pi-coding-agent/src/launch/client.ts, so it outlives the omp process that started it), which leaves the
// broker with no console, so its `windowsHide: !hostHasInheritableConsole()` is always true on Windows and
// Chrome is spawned with STARTF_USESHOWWINDOW/SW_HIDE again. Windows applies that to Chrome's first
// ShowWindow: the browser frame is created without WS_VISIBLE, yet its client area is composed on screen
// as a white rectangle with no frame, no tabs and no close button. Measured: `ShowWindow(SW_SHOW)` on that
// frame turns it into a normal Chrome window with its tab strip and the page.
//
// No seam LUCID owns reaches the broker's spawn any more, and invariant 1 rules out patching omp. So the
// engine does what ADR-0415 avoided: it finds that frame and shows it. The match is narrow on purpose:
// a top-level `Chrome_WidgetWin_1` that has a title, is not visible, and belongs to the ROOT process of a
// Chromium whose command line names omp's headed profile (`omp.browser.headed.profile`). A headed browser
// exists to be seen, so showing it is the intended state, never a new one; the user's own Chrome, omp's
// headless browsers and Chrome's helper processes never match. Each window is shown at most once, so a
// window Chrome hides on purpose later is left alone. Shown without activation: it never steals focus.

import { dlopen, FFIType, ptr, toArrayBuffer, type Pointer } from "bun:ffi";

/** The profile directory omp gives its shared headed Chromium (`${daemonName}.profile`, shared-daemon.ts). */
export const HEADED_PROFILE_MARK = "omp.browser.headed.profile";
export const REVEAL_INTERVAL_MS = 1500;
const SW_SHOWNOACTIVATE = 4;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const PROCESS_COMMAND_LINE_INFORMATION = 60;

/** PURE: the root process of omp's headed Chromium (helpers carry `--type=`; the headless one another profile). */
export function isHeadedOmpBrowser(commandLine: string): boolean {
  return commandLine.includes(HEADED_PROFILE_MARK) && !/(^|\s)--type=/.test(commandLine);
}

export interface TopWindow { hwnd: number; pid: number; visible: boolean; titled: boolean }

/** PURE: the hidden, titled browser frames of headed omp Chromiums that have not been shown before. */
export function windowsToReveal(windows: readonly TopWindow[], isHeaded: (pid: number) => boolean, shown: ReadonlySet<number>): number[] {
  return windows.filter((w) => !w.visible && w.titled && !shown.has(w.hwnd) && isHeaded(w.pid)).map((w) => w.hwnd);
}

interface User32 {
  FindWindowExW(parent: Pointer | null, after: Pointer | null, cls: Pointer, title: Pointer | null): Pointer | null;
  IsWindowVisible(h: Pointer): boolean;
  GetWindowTextLengthW(h: Pointer): number;
  GetWindowThreadProcessId(h: Pointer, pid: Pointer): number;
  ShowWindow(h: Pointer, cmd: number): boolean;
}
interface Kernel32 { OpenProcess(access: number, inherit: boolean, pid: number): Pointer | null; CloseHandle(h: Pointer): boolean }
interface Ntdll { NtQueryInformationProcess(h: Pointer, cls: number, buf: Pointer, len: number, ret: Pointer): number }
interface Win32 { user: User32; kernel: Kernel32; nt: Ntdll }

let win32: Win32 | null | undefined;
function api(): Win32 | null {
  if (win32 !== undefined) return win32;
  try {
    // bun:ffi types every symbol loosely; the tables below are the contract.
    const user = dlopen("user32.dll", {
      FindWindowExW: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
      IsWindowVisible: { args: [FFIType.ptr], returns: FFIType.bool },
      GetWindowTextLengthW: { args: [FFIType.ptr], returns: FFIType.i32 },
      GetWindowThreadProcessId: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
      ShowWindow: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.bool },
    }).symbols as unknown as User32;
    const kernel = dlopen("kernel32.dll", {
      OpenProcess: { args: [FFIType.u32, FFIType.bool, FFIType.u32], returns: FFIType.ptr },
      CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
    }).symbols as unknown as Kernel32;
    const nt = dlopen("ntdll.dll", {
      NtQueryInformationProcess: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    }).symbols as unknown as Ntdll;
    win32 = { user, kernel, nt };
  } catch { win32 = null; }
  return win32;
}

const utf16z = (s: string): Buffer => Buffer.from(`${s}\0`, "utf16le");
const FRAME_CLASS = utf16z("Chrome_WidgetWin_1");

/** Every top-level Chrome frame window (class Chrome_WidgetWin_1), visible or not. */
function chromeFrames(w: Win32): (TopWindow & { handle: Pointer })[] {
  const out: (TopWindow & { handle: Pointer })[] = [];
  const pid = new Uint32Array(1);
  let after: Pointer | null = null;
  for (let i = 0; i < 512; i++) {
    const h = w.user.FindWindowExW(null, after, ptr(FRAME_CLASS), null);
    if (!h) break;
    w.user.GetWindowThreadProcessId(h, ptr(pid));
    out.push({ handle: h, hwnd: Number(h), pid: pid[0]!, visible: w.user.IsWindowVisible(h), titled: w.user.GetWindowTextLengthW(h) > 0 });
    after = h;
  }
  return out;
}

/** The command line of `pid` (NtQueryInformationProcess class 60, Windows 8.1+), or "" when unreadable. */
function commandLineOf(w: Win32, pid: number): string {
  const h = w.kernel.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (!h) return "";
  try {
    const buf = Buffer.alloc(64 * 1024);
    const ret = new Uint32Array(1);
    if (w.nt.NtQueryInformationProcess(h, PROCESS_COMMAND_LINE_INFORMATION, ptr(buf), buf.length, ptr(ret)) !== 0) return "";
    // UNICODE_STRING { USHORT Length; USHORT MaximumLength; PWSTR Buffer } (x64: Buffer at offset 8), and the
    // string itself is written into the same buffer after it.
    const len = buf.readUInt16LE(0);
    const at = Number(buf.readBigUInt64LE(8));
    if (!len || !at) return "";
    return Buffer.from(toArrayBuffer(at as Pointer, 0, len)).toString("utf16le");
  } catch {
    return "";
  } finally {
    w.kernel.CloseHandle(h);
  }
}

/** Shows the hidden frames of omp's headed Chromium. Windows only; a no-op everywhere else. */
export class HeadedBrowserRevealer {
  readonly #shown = new Set<number>();
  readonly #headed = new Map<number, boolean>();
  #timer: Timer | null = null;

  /** One sweep. Returns the window handles shown. Never throws. */
  sweep(): number[] {
    if (process.platform !== "win32") return [];
    const w = api();
    if (!w) return [];
    try {
      const frames = chromeFrames(w);
      // Command lines are read only for hidden titled frames, once per pid (pids are not reused while alive).
      if (this.#headed.size > 256) this.#headed.clear();
      const isHeaded = (pid: number): boolean => {
        let v = this.#headed.get(pid);
        if (v === undefined) { v = isHeadedOmpBrowser(commandLineOf(w, pid)); this.#headed.set(pid, v); }
        return v;
      };
      const reveal = new Set(windowsToReveal(frames, isHeaded, this.#shown));
      for (const f of frames) {
        if (!reveal.has(f.hwnd)) continue;
        w.user.ShowWindow(f.handle, SW_SHOWNOACTIVATE);
        this.#shown.add(f.hwnd);
      }
      if (this.#shown.size > 1024) this.#shown.clear();
      return [...reveal];
    } catch {
      return [];
    }
  }

  start(intervalMs = REVEAL_INTERVAL_MS): void {
    if (process.platform !== "win32" || this.#timer) return;
    this.#timer = setInterval(() => {
      const shown = this.sweep();
      if (shown.length) console.error(`[browser] showed ${shown.length} hidden window(s) of the agent's headed browser (omp's broker spawns it with SW_HIDE; ADR-0456)`);
    }, intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    clearInterval(this.#timer ?? undefined);
    this.#timer = null;
  }
}
