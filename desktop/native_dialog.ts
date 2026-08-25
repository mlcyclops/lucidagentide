// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/native_dialog.ts - P-FS.2 (ADR-0253): the REAL OS folder dialog for the browser build.
//
// The packaged Electron shell already opens Explorer/Finder via `lucid:pickFolder` (preload). But the
// default launch path (LucidAgentIDE.bat / lucid.exe) serves the GUI to a PLAIN BROWSER, where no
// `window.lucid` bridge exists, so every folder pick fell back to the in-app dark browser (ADR-0103):
// the cramped "Up / Home" dialog users report. The GUI server, however, RUNS ON THE SAME MACHINE as
// that browser (loopback-only bind, ADR-0022 H1), so it can open the native dialog itself and hand the
// chosen path back over the authenticated bridge:
//   win32  - powershell + the modern IFileOpenDialog (FOS_PICKFOLDERS): the SAME Explorer picker
//            Electron shows. NOT System.Windows.Forms.FolderBrowserDialog (the legacy folder tree).
//   darwin - osascript `choose folder`.
//   linux  - zenity, then kdialog, whichever exists (needs a display server).
//
// Result contract (NativePickResult):
//   { supported: false }              -> no native dialog here (headless, no binary, dialog busy);
//                                        the renderer falls back to the in-app browser.
//   { supported: true, path: null }   -> the user CANCELLED. The renderer must NOT re-prompt; a
//                                        second dialog after a deliberate cancel is hostile.
//   { supported: true, path: "..." }  -> the picked absolute path.
//
// Title/label text rides ENV VARS (win32) or a single argv element (darwin/linux): caller text is
// never spliced into a shell-parsed string, so a hostile title cannot break out of the script.

export interface NativePickOpts {
  title?: string;
  buttonLabel?: string;
}

export interface NativePickResult {
  supported: boolean;
  path: string | null;
}

/** Parsed outcome of the win32 powershell run (exported for tests). */
export type PickParse =
  | { status: "picked"; path: string }
  | { status: "cancelled" }
  | { status: "error" };

/** Stdout markers so compiler noise / warnings can never be mistaken for a path. */
export const PICKED_MARK = "LUCID_PICKED::";
export const CANCEL_MARK = "LUCID_CANCELLED::";

/** A user can legitimately leave a dialog open for a long time; this only reaps a truly abandoned one. */
const DIALOG_TIMEOUT_MS = 10 * 60 * 1000;

/** The powershell program (read from stdin, title/label from env). Uses the modern shell item dialog
 *  (IFileOpenDialog + FOS_PICKFOLDERS): full Explorer navigation, Quick access, search, new folder.
 *  Pure string so the test can pin the contract (no legacy FolderBrowserDialog, env-var text passing). */
export function winPickScript(): string {
  return `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IFileDialog
{
    [PreserveSig] uint Show(IntPtr hwndParent);
    void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
    void SetFileTypeIndex(uint iFileType);
    void GetFileTypeIndex(out uint piFileType);
    void Advise(IntPtr pfde, out uint pdwCookie);
    void Unadvise(uint dwCookie);
    void SetOptions(uint fos);
    void GetOptions(out uint pfos);
    void SetDefaultFolder(IntPtr psi);
    void SetFolder(IntPtr psi);
    void GetFolder(out IntPtr ppsi);
    void GetCurrentSelection(out IntPtr ppsi);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetFileName(out IntPtr pszName);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
    void GetResult(out IShellItem ppsi);
    void AddPlace(IntPtr psi, uint fdap);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
    void Close(uint hr);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr pFilter);
}

[ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IShellItem
{
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, out IntPtr ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IShellItem psi, uint hint, out int piOrder);
}

[ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
public class FileOpenDialogRCW { }

public static class LucidFolderPicker
{
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    public static string Pick(string title, string okLabel)
    {
        IFileDialog dlg = (IFileDialog)(object)new FileOpenDialogRCW();
        uint opts;
        dlg.GetOptions(out opts);
        // FOS_PICKFOLDERS (0x20) | FOS_FORCEFILESYSTEM (0x40) | FOS_NOCHANGEDIR (0x8)
        dlg.SetOptions(opts | 0x20u | 0x40u | 0x8u);
        if (!String.IsNullOrEmpty(title)) dlg.SetTitle(title);
        if (!String.IsNullOrEmpty(okLabel)) dlg.SetOkButtonLabel(okLabel);
        // Owner = whatever is foreground (the user's browser), so the dialog lands on top of it.
        if (dlg.Show(GetForegroundWindow()) != 0) return null; // cancelled (or failed): both read as cancel
        IShellItem item;
        dlg.GetResult(out item);
        IntPtr ptr;
        item.GetDisplayName(0x80058000u, out ptr); // SIGDN_FILESYSPATH
        try { return Marshal.PtrToStringUni(ptr); }
        finally { Marshal.FreeCoTaskMem(ptr); }
    }
}
'@
$picked = [LucidFolderPicker]::Pick([string]$env:LUCID_PICK_TITLE, [string]$env:LUCID_PICK_OK)
if ($picked) { [Console]::Out.Write('${PICKED_MARK}' + $picked) } else { [Console]::Out.Write('${CANCEL_MARK}') }
`;
}

/** Parse the win32 run's stdout into picked/cancelled/error (exported for tests). Marker-anchored so
 *  any stray compiler/host noise on stdout can never be read as a path. */
export function parseWinPick(stdout: string): PickParse {
  const at = stdout.lastIndexOf(PICKED_MARK);
  if (at >= 0) {
    const path = (stdout.slice(at + PICKED_MARK.length).split(/\r?\n/, 1)[0] ?? "").trim();
    return path ? { status: "picked", path } : { status: "error" };
  }
  if (stdout.includes(CANCEL_MARK)) return { status: "cancelled" };
  return { status: "error" };
}

/** Escape text for inclusion inside a double-quoted AppleScript string literal. */
export function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** The single-expression AppleScript source for `osascript -e` (exported for tests). */
export function macPickSource(title: string): string {
  return `POSIX path of (choose folder with prompt "${escapeAppleScript(title)}")`;
}

/** Candidate linux commands, tried in order; the title is its OWN argv element (no shell parsing). */
export function linuxPickCommands(title: string): string[][] {
  return [
    ["zenity", "--file-selection", "--directory", "--title", title],
    ["kdialog", "--getexistingdirectory", process.env.HOME || "~", "--title", title],
  ];
}

// One dialog at a time. A second concurrent ask reads as a cancel (never a second stacked dialog,
// and never a fall-through to the in-app browser BEHIND the open native one).
let inFlight = false;

async function runToText(argv: string[], opts: { stdinText?: string; env?: Record<string, string | undefined> } = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(argv, {
    stdin: opts.stdinText === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
  });
  if (opts.stdinText !== undefined && proc.stdin) {
    proc.stdin.write(opts.stdinText);
    void proc.stdin.end();
  }
  const reaper = setTimeout(() => { try { proc.kill(); } catch { /* already gone */ } }, DIALOG_TIMEOUT_MS);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;
  clearTimeout(reaper);
  return { exitCode, stdout, stderr };
}

async function winPick(opts: NativePickOpts): Promise<NativePickResult> {
  // -Sta: IFileOpenDialog needs a single-threaded apartment (5.1's console default, pinned anyway).
  const r = await runToText(
    ["powershell.exe", "-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-Command", "-"],
    { stdinText: winPickScript(), env: { LUCID_PICK_TITLE: opts.title ?? "Choose a folder", LUCID_PICK_OK: opts.buttonLabel ?? "" } },
  );
  const parsed = parseWinPick(r.stdout);
  if (parsed.status === "picked") return { supported: true, path: parsed.path };
  if (parsed.status === "cancelled") return { supported: true, path: null };
  return { supported: false, path: null };
}

async function macPick(opts: NativePickOpts): Promise<NativePickResult> {
  const r = await runToText(["osascript", "-e", macPickSource(opts.title ?? "Choose a folder")]);
  const path = r.stdout.trim();
  if (r.exitCode === 0 && path) return { supported: true, path };
  if (r.stderr.includes("-128")) return { supported: true, path: null }; // user canceled
  return { supported: false, path: null };
}

async function linuxPick(opts: NativePickOpts): Promise<NativePickResult> {
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return { supported: false, path: null }; // headless
  for (const argv of linuxPickCommands(opts.title ?? "Choose a folder")) {
    try {
      const r = await runToText(argv);
      const path = r.stdout.trim();
      if (r.exitCode === 0 && path) return { supported: true, path };
      if (r.exitCode === 1) return { supported: true, path: null }; // zenity/kdialog cancel
    } catch { /* binary missing: try the next candidate */ }
  }
  return { supported: false, path: null };
}

/** Open the native OS folder dialog on THIS machine and resolve with the user's choice. */
export async function pickFolderNative(opts: NativePickOpts = {}): Promise<NativePickResult> {
  if (inFlight) return { supported: true, path: null }; // one dialog at a time; a second ask reads as cancel
  inFlight = true;
  try {
    if (process.platform === "win32") return await winPick(opts);
    if (process.platform === "darwin") return await macPick(opts);
    return await linuxPick(opts);
  } catch {
    return { supported: false, path: null }; // fail toward the in-app fallback, never a hang
  } finally {
    inFlight = false;
  }
}
