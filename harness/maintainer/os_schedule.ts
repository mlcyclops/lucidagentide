// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/maintainer/os_schedule.ts
//
// P-MAINT.1: the OS-NATIVE scheduling plan for a Maintainer Agent. PURE - it emits the exact
// registration / removal commands and unit text for a platform and never runs them, so the whole
// thing is unit-testable on any host.
//
// WHY THIS EXISTS AT ALL, given desktop/acp_backend.ts:13-15 explicitly decided AGAINST OS
// scheduling. That decision was correct for the automation ticker: registering `omp` with the OS
// scheduler would run omp in a process where the security gate is not guaranteed armed, which is a
// FAIL-OPEN risk. A maintainer agent must outlive the desktop app (it exists to run while nobody is
// looking), so the constraint has to be engineered around rather than ignored:
//
//   The command registered with the OS is NEVER `omp` and NEVER an ungated runner. It is a WRAPPER
//   entry point whose FIRST action is the fail-closed preflight - `lucid check`, which exits 0 only
//   when the gate and the scanner sidecar are both ready and 1 when either is unavailable. A failed
//   preflight ABORTS the run with a non-zero exit and writes an audit line; it never proceeds
//   ungated. So the OS scheduler can only ever start a process that gates itself before it acts.
//
// Every plan carries that requirement in its `note`, so a plan pasted into a terminal, an installer,
// or a runbook cannot lose the rationale. Callers pass the wrapper as `exe`; passing a bare `omp`
// would defeat the invariant, which is why the note names it explicitly.
//
// EDGE-FIRST: this is the PRIMARY path. The machine the agent lives on schedules it. No cloud
// scheduler, no vendor service, nothing to reach out to. Interval cadences that a given OS genuinely
// cannot express are REFUSED (named error) rather than silently rounded into a different schedule.

import type { Cadence } from "./contracts.ts";

export type Platform = "win32" | "darwin" | "linux";

export interface SchedulePlan {
  platform: Platform;
  /** The exact command that registers the schedule with the OS. */
  register: string;
  /** The exact command that removes it again. */
  remove: string;
  /** Where the unit / plist must be written before `register` runs (launchd, systemd). */
  unitPath?: string;
  /** The literal file content for `unitPath`. systemd needs two files; see the banner convention. */
  unitText?: string;
  note: string;
}

export type RefusalReason =
  | "cadence-malformed"
  | "cadence-out-of-range"
  | "cadence-inexpressible"
  | "id-invalid"
  | "exe-missing"
  | "arg-unquotable"
  | "platform-unsupported";

/**
 * Fail-closed refusal. A schedule that cannot be expressed EXACTLY is never approximated, because a
 * maintainer agent that runs on a different cadence than the operator asked for is a silent lie.
 */
export class ScheduleRefusedError extends Error {
  readonly reason: RefusalReason;
  constructor(reason: RefusalReason, message: string) {
    super(message);
    this.name = "ScheduleRefusedError";
    this.reason = reason;
  }
}

// Same bounds as the core's normalizeCadence (desktop/automations.ts): interval 1..10080 minutes,
// daily HH:MM 24h. Kept in sync deliberately - a cadence the core refuses must never reach the OS.
const MIN_INTERVAL = 1;
const MAX_INTERVAL = 1440 * 7;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ID_OK = /^[A-Za-z0-9._-]{1,48}$/;

/** Windows Task Scheduler's simple CLI caps `/SC MINUTE /MO n` at 1439. */
const WIN_MAX_MINUTE_MO = 1439;

const PREFLIGHT_NOTE =
  "The registered command MUST be the maintainer wrapper entry point, not omp and not a bare agent " +
  "runner: its first action is the fail-closed `lucid check` preflight, and a preflight failure " +
  "aborts the run non-zero with an audit line so the OS scheduler can never start an ungated agent.";

/** Validate a cadence exactly the way the core does. Returns it narrowed, or refuses. */
function checkCadence(cadence: Cadence): Cadence {
  if (cadence.kind === "interval") {
    const n = cadence.everyMin;
    if (!Number.isInteger(n)) throw new ScheduleRefusedError("cadence-malformed", `interval everyMin must be a whole number of minutes, got ${String(n)}`);
    if (n < MIN_INTERVAL || n > MAX_INTERVAL) {
      throw new ScheduleRefusedError("cadence-out-of-range", `interval everyMin must be ${MIN_INTERVAL}..${MAX_INTERVAL}, got ${n}`);
    }
    return cadence;
  }
  if (cadence.kind === "daily") {
    if (!HHMM.test(cadence.hhmm)) throw new ScheduleRefusedError("cadence-malformed", `daily hhmm must be HH:MM 24h, got ${JSON.stringify(cadence.hhmm)}`);
    return cadence;
  }
  // Unreachable for a well-typed caller; still fail closed for JSON that arrived off disk.
  throw new ScheduleRefusedError("cadence-malformed", "cadence kind must be interval or daily");
}

function checkId(id: string): string {
  if (!ID_OK.test(id)) {
    throw new ScheduleRefusedError("id-invalid", `target id must match ${String(ID_OK)} so it is safe in a task name, unit name, and plist label, got ${JSON.stringify(id)}`);
  }
  return id;
}

// --- Windows -----------------------------------------------------------------------------------

/**
 * Build the `/TR` value. schtasks receives its argv through the CRT parser, so an embedded quote is
 * written `\"` and the whole command is then wrapped in one outer pair. A path with spaces therefore
 * survives cmd.exe unchanged.
 */
function winTaskRun(exe: string, args: string[]): string {
  const quote = (s: string): string => {
    if (s.includes('"')) throw new ScheduleRefusedError("arg-unquotable", `a schtasks /TR token cannot contain a double quote: ${JSON.stringify(s)}`);
    return /\s/.test(s) || s.length === 0 ? `\\"${s}\\"` : s;
  };
  if (exe.includes('"')) throw new ScheduleRefusedError("arg-unquotable", `the executable path cannot contain a double quote: ${JSON.stringify(exe)}`);
  const parts = [`\\"${exe}\\"`, ...args.map(quote)];
  return `"${parts.join(" ")}"`;
}

function winPlan(id: string, cadence: Cadence, exe: string, args: string[]): SchedulePlan {
  const tn = `"LUCID Maintainer ${id}"`;
  const tr = winTaskRun(exe, args);
  // /F makes re-registration idempotent; /RL LIMITED pins the task to least privilege explicitly.
  const head = `schtasks /Create /F /RL LIMITED /TN ${tn} /TR ${tr}`;
  const remove = `schtasks /Delete /TN ${tn} /F`;
  if (cadence.kind === "daily") {
    return {
      platform: "win32",
      register: `${head} /SC DAILY /ST ${cadence.hhmm}`,
      remove,
      note: `Runs once a day at ${cadence.hhmm} local time. ${PREFLIGHT_NOTE}`,
    };
  }
  const n = cadence.everyMin;
  if (n <= WIN_MAX_MINUTE_MO) {
    return {
      platform: "win32",
      register: `${head} /SC MINUTE /MO ${n}`,
      remove,
      note: `Runs every ${n} minute(s). ${PREFLIGHT_NOTE}`,
    };
  }
  if (n % 1440 === 0) {
    const days = n / 1440;
    return {
      platform: "win32",
      register: `${head} /SC DAILY /MO ${days} /ST 00:00`,
      remove,
      note:
        `Windows caps /SC MINUTE /MO at ${WIN_MAX_MINUTE_MO}, so a whole-day interval is registered as ` +
        `/SC DAILY /MO ${days} at 00:00 local time (same period, anchored to midnight instead of to the ` +
        `install moment). ${PREFLIGHT_NOTE}`,
    };
  }
  throw new ScheduleRefusedError(
    "cadence-inexpressible",
    `Windows Task Scheduler cannot express an interval of ${n} minutes: /SC MINUTE /MO caps at ` +
      `${WIN_MAX_MINUTE_MO} and /SC DAILY /MO needs whole days. Use an interval <= ${WIN_MAX_MINUTE_MO} ` +
      `minutes or a whole multiple of 1440.`,
  );
}

// --- macOS -------------------------------------------------------------------------------------

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** POSIX single-quote a path so spaces and shell metacharacters are inert. */
function sh(s: string): string {
  // A token of only shell-inert characters is left bare; anything else (a space, a metacharacter)
  // is single-quoted, with any embedded single quote closed-escaped-reopened the POSIX way.
  return /^[A-Za-z0-9._\-/=:+@,]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function darwinPlan(id: string, cadence: Cadence, exe: string, args: string[]): SchedulePlan {
  const label = `com.techlead187.lucid.maintainer.${id}`;
  const unitPath = `~/Library/LaunchAgents/${label}.plist`;
  const argv = [exe, ...args].map((a) => `    <string>${xml(a)}</string>`).join("\n");
  let schedule: string;
  let human: string;
  if (cadence.kind === "daily") {
    const [hh, mm] = cadence.hhmm.split(":");
    schedule =
      `  <key>StartCalendarInterval</key>\n` +
      `  <dict>\n` +
      `    <key>Hour</key>\n    <integer>${Number(hh)}</integer>\n` +
      `    <key>Minute</key>\n    <integer>${Number(mm)}</integer>\n` +
      `  </dict>`;
    human = `Runs once a day at ${cadence.hhmm} local time (StartCalendarInterval).`;
  } else {
    schedule = `  <key>StartInterval</key>\n  <integer>${cadence.everyMin * 60}</integer>`;
    human = `Runs every ${cadence.everyMin} minute(s) (StartInterval ${cadence.everyMin * 60} seconds).`;
  }
  const unitText =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
    `<plist version="1.0">\n` +
    `<dict>\n` +
    `  <key>Label</key>\n  <string>${xml(label)}</string>\n` +
    `  <key>ProgramArguments</key>\n  <array>\n${argv}\n  </array>\n` +
    `${schedule}\n` +
    `  <key>RunAtLoad</key>\n  <false/>\n` +
    `  <key>ProcessType</key>\n  <string>Background</string>\n` +
    `</dict>\n` +
    `</plist>\n`;
  // NOTE the double quotes: the plist path must be quoted (LaunchAgents can sit under a home
  // directory with a space) but a single-quoted "~" would NOT be expanded by the shell, so the
  // command uses "$HOME" instead. The `id` regex guarantees the label itself is metacharacter-free.
  const shellPath = `"$HOME/Library/LaunchAgents/${label}.plist"`;
  return {
    platform: "darwin",
    register: `launchctl bootstrap gui/$(id -u) ${shellPath}`,
    remove: `launchctl bootout gui/$(id -u) ${shellPath}`,
    unitPath,
    unitText,
    note: `${human} Write unitText to unitPath first, then run register (a per-user LaunchAgent, no root). ${PREFLIGHT_NOTE}`,
  };
}

// --- Linux -------------------------------------------------------------------------------------

/** systemd unit values are quoted with double quotes; an embedded quote is escaped. */
function sd(s: string): string {
  const esc = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return /[\s"'\\]/.test(s) ? `"${esc}"` : s;
}

/** The crontab schedule field, or null when cron genuinely cannot express the cadence. */
function cronSpec(cadence: Cadence): { spec: string; caveat: string } | null {
  if (cadence.kind === "daily") {
    const [hh, mm] = cadence.hhmm.split(":");
    return { spec: `${Number(mm)} ${Number(hh)} * * *`, caveat: "" };
  }
  const n = cadence.everyMin;
  if (n < 60) {
    return {
      spec: `*/${n} * * * *`,
      caveat: 60 % n === 0 ? "" : ` Cron restarts the step every hour, so a ${n}-minute step skews at the hour boundary; the systemd timer above does not.`,
    };
  }
  if (n % 60 === 0 && n / 60 <= 23) return { spec: `0 */${n / 60} * * *`, caveat: "" };
  if (n % 1440 === 0 && n / 1440 <= 31) {
    return { spec: `0 0 */${n / 1440} * *`, caveat: ` Cron's day-of-month step restarts each month, so a ${n / 1440}-day step skews at month end; the systemd timer above does not.` };
  }
  return null;
}

function linuxPlan(id: string, cadence: Cadence, exe: string, args: string[]): SchedulePlan {
  const unit = `lucid-maintainer-${id}`;
  const dir = "~/.config/systemd/user";
  const unitPath = `${dir}/${unit}.timer`;
  const execStart = [exe, ...args].map(sd).join(" ");
  let timerBody: string;
  let human: string;
  if (cadence.kind === "daily") {
    timerBody = `OnCalendar=*-*-* ${cadence.hhmm}:00\nPersistent=true\n`;
    human = `Runs once a day at ${cadence.hhmm} local time; Persistent=true catches up a run missed while the machine was off.`;
  } else {
    timerBody = `OnBootSec=${cadence.everyMin}min\nOnUnitActiveSec=${cadence.everyMin}min\nAccuracySec=1min\n`;
    human = `Runs every ${cadence.everyMin} minute(s) measured from the end of the previous run.`;
  }
  // systemd needs TWO files. Both are carried in unitText behind an explicit per-file banner so the
  // caller (or a human with a terminal) can split them deterministically.
  const unitText =
    `# ---- ${dir}/${unit}.service ----\n` +
    `[Unit]\n` +
    `Description=LUCID Maintainer Agent sweep (${id})\n` +
    `\n` +
    `[Service]\n` +
    `Type=oneshot\n` +
    `ExecStart=${execStart}\n` +
    `\n` +
    `# ---- ${dir}/${unit}.timer ----\n` +
    `[Unit]\n` +
    `Description=LUCID Maintainer Agent sweep timer (${id})\n` +
    `\n` +
    `[Timer]\n` +
    timerBody +
    `Unit=${unit}.service\n` +
    `\n` +
    `[Install]\n` +
    `WantedBy=timers.target\n`;
  const cron = cronSpec(cadence);
  const cronLine = cron
    ? `crontab alternative (one line, for a host without systemd --user): ${cron.spec} ${[exe, ...args].map(sh).join(" ")}.${cron.caveat}`
    : `Cron cannot express this cadence exactly (no step form fits ${cadence.kind === "interval" ? `${cadence.everyMin} minutes` : cadence.hhmm}), so the systemd timer is the only correct registration on this host.`;
  return {
    platform: "linux",
    register: `systemctl --user enable --now ${unit}.timer`,
    remove: `systemctl --user disable --now ${unit}.timer`,
    unitPath,
    unitText,
    note: `${human} Write both files from unitText (split on the "# ---- <path> ----" banners) into ${dir}, run \`systemctl --user daemon-reload\`, then register. ${cronLine} ${PREFLIGHT_NOTE}`,
  };
}

/**
 * The one entry point: an OS-native registration plan for one maintainer target. Pure. Throws
 * ScheduleRefusedError (never returns an approximation) when the cadence, id, or argv cannot be
 * expressed exactly on the requested platform.
 */
export function scheduleInstallPlan(opts: {
  platform: Platform;
  cadence: Cadence;
  id: string;
  exe: string;
  args: string[];
}): SchedulePlan {
  const id = checkId(opts.id);
  const cadence = checkCadence(opts.cadence);
  const exe = opts.exe.trim();
  if (!exe) throw new ScheduleRefusedError("exe-missing", "exe must be the absolute path to the maintainer wrapper entry point");
  const args = opts.args;
  if (opts.platform === "win32") return winPlan(id, cadence, exe, args);
  if (opts.platform === "darwin") return darwinPlan(id, cadence, exe, args);
  if (opts.platform === "linux") return linuxPlan(id, cadence, exe, args);
  throw new ScheduleRefusedError("platform-unsupported", `no OS-native scheduler mapping for platform ${JSON.stringify(opts.platform)}`);
}
