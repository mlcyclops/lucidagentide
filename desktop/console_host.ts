// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/console_host.ts
//
// P-BROWSER.4 (ADR-0415): the engine owns a HIDDEN Windows console so the omp children it spawns can
// share it, because omp decides how it spawns its own children from whether it has a console window.
//
// The chain that produced an all-white, unclosable Chrome window: Electron spawns the engine with
// windowsHide (CREATE_NO_WINDOW + STARTF_USESHOWWINDOW/SW_HIDE), the engine spawned omp with
// windowsHide (Bun: CREATE_NO_WINDOW, so omp has no console window at all), omp's
// `hostHasInheritableConsole()` (kernel32!GetConsoleWindow) then answered false, and omp's daemon broker
// spawned the shared headed Chromium with windowsHide too. Windows applies that SW_HIDE to the process's
// first ShowWindow, so Chrome's browser window was created but never shown: the user saw a white
// rectangle with no frame, no close button, and no way to log in. The same rule hides every window a
// console-less omp child opens (the Python kernel, hub daemons, the folder pop-up from a lane).
//
// Fix, in this order: at boot the engine gives itself a console window when it has none (FreeConsole
// drops the windowless conhost CREATE_NO_WINDOW attached; AllocConsole creates one whose window honours
// the SW_HIDE the engine was started with, and is hidden again if it somehow shows), and the omp spawn
// (acp.ts) passes `windowsHide: false` whenever the engine has a console window, so omp attaches to the
// hidden console instead of getting none. omp then sees a console, spawns its broker and Chrome without
// SW_HIDE, and the window appears. Nothing is ever shown on screen: the console window stays hidden and
// console children of a hidden console open no window of their own.
//
// Only Windows does anything here. A dev run from a terminal already has a console window (or a ConPTY
// one, which GetConsoleWindow also reports) and is left alone; a run whose stdio IS a terminal is never
// detached from it.

import { dlopen, FFIType, type Pointer } from "bun:ffi";

const SW_HIDE = 0;

/** The engine's console after `ensureHiddenConsole`. `window` true means children can inherit one. */
export interface ConsoleHostState {
  /** A console window exists for this process (inherited or allocated). */
  window: boolean;
  /** This call allocated it (false when one was already there, or when none could be made). */
  allocated: boolean;
  /** The window is hidden (always the goal; false only if hiding failed). */
  hidden: boolean;
  /** Why no window exists, when `window` is false. */
  reason?: string;
}

/** What the decision needs: the platform and whether a console window exists. */
export interface ConsoleEvidence {
  platform: NodeJS.Platform;
  consoleWindow: boolean;
}

/**
 * PURE: `windowsHide` for an omp child. On Windows, hide (CREATE_NO_WINDOW) only when this process has
 * no console window to share, exactly omp's own rule for its children; with a window the child attaches
 * to it (hidden, so nothing appears) and omp's console probe answers true. Elsewhere the flag is a no-op
 * and stays true, the value every spawn used before.
 */
export function agentSpawnWindowsHide(e: ConsoleEvidence): boolean {
  if (e.platform !== "win32") return true;
  return !e.consoleWindow;
}

/**
 * PURE: whether the engine should allocate a console. Only on Windows, only when it has none, and never
 * when its stdio is a terminal (FreeConsole would cut the engine off from the terminal it is printing to;
 * a ConPTY terminal reports a window anyway).
 */
export function shouldAllocateConsole(e: ConsoleEvidence & { stdioIsTTY: boolean }): boolean {
  return e.platform === "win32" && !e.consoleWindow && !e.stdioIsTTY;
}

interface Kernel32 {
  GetConsoleWindow(): Pointer | null;
  AllocConsole(): number;
  FreeConsole(): number;
  GetLastError(): number;
}
interface User32 {
  IsWindowVisible(h: Pointer): boolean;
  ShowWindow(h: Pointer, cmd: number): boolean;
}

let k32: Kernel32 | null | undefined;
let u32: User32 | null | undefined;
function kernel32(): Kernel32 | null {
  if (k32 !== undefined) return k32;
  try {
    k32 = dlopen("kernel32.dll", {
      GetConsoleWindow: { args: [], returns: FFIType.ptr },
      AllocConsole: { args: [], returns: FFIType.i32 },
      FreeConsole: { args: [], returns: FFIType.i32 },
      GetLastError: { args: [], returns: FFIType.u32 },
    }).symbols as unknown as Kernel32; // bun:ffi types every symbol loosely; the table above is the contract
  } catch { k32 = null; }
  return k32;
}
function user32(): User32 | null {
  if (u32 !== undefined) return u32;
  try {
    u32 = dlopen("user32.dll", {
      IsWindowVisible: { args: [FFIType.ptr], returns: FFIType.bool },
      ShowWindow: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.bool },
    }).symbols as unknown as User32;
  } catch { u32 = null; }
  return u32;
}

/** True when this process has a console window (Windows only; false elsewhere or when the probe fails). */
export function hasConsoleWindow(): boolean {
  if (process.platform !== "win32") return false;
  const k = kernel32();
  if (!k) return false;
  try { return k.GetConsoleWindow() !== null; } catch { return false; }
}

/** The `windowsHide` every omp child spawn uses: computed from this process's live console state. */
export function ompWindowsHide(): boolean {
  return agentSpawnWindowsHide({ platform: process.platform, consoleWindow: hasConsoleWindow() });
}

/**
 * Give this process a hidden console window when it has none. Idempotent; never throws; every failure
 * is reported in the returned state so the boot log can say what happened.
 */
export function ensureHiddenConsole(): ConsoleHostState {
  const stdioIsTTY = !!process.stdin.isTTY || !!process.stdout.isTTY || !!process.stderr.isTTY;
  if (process.platform !== "win32") return { window: false, allocated: false, hidden: true, reason: "not windows" };
  const k = kernel32();
  const u = user32();
  if (!k || !u) return { window: false, allocated: false, hidden: true, reason: "kernel32/user32 FFI unavailable" };
  try {
    const existing = k.GetConsoleWindow();
    if (existing !== null) return { window: true, allocated: false, hidden: hideIfShown(u, existing) };
    if (!shouldAllocateConsole({ platform: process.platform, consoleWindow: false, stdioIsTTY })) {
      return { window: false, allocated: false, hidden: true, reason: "stdio is a terminal" };
    }
    // CREATE_NO_WINDOW leaves a windowless console attached, and AllocConsole refuses (ERROR_ACCESS_DENIED)
    // while any console is attached: detach it first. Our stdio are pipes to the Electron main, untouched.
    k.FreeConsole();
    if (!k.AllocConsole()) return { window: false, allocated: false, hidden: true, reason: `AllocConsole failed (err=${k.GetLastError()})` };
    const hwnd = k.GetConsoleWindow();
    if (hwnd === null) return { window: false, allocated: true, hidden: true, reason: "AllocConsole made no window" };
    return { window: true, allocated: true, hidden: hideIfShown(u, hwnd) };
  } catch (e) {
    return { window: false, allocated: false, hidden: true, reason: `console probe threw: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Hide `hwnd` if it is showing. True when hidden afterwards. */
function hideIfShown(u: User32, hwnd: Pointer): boolean {
  if (!u.IsWindowVisible(hwnd)) return true;
  u.ShowWindow(hwnd, SW_HIDE);
  return !u.IsWindowVisible(hwnd);
}
