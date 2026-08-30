// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-MAINT.1: the OS-native scheduling plan. Over-tests the two things that actually break in the
// field: QUOTING (this repo's own path contains spaces, so every platform is exercised with one) and
// FAIL-CLOSED REFUSAL (a cadence the core would reject, or one the platform genuinely cannot express,
// must raise a named error rather than silently schedule something different).

import { expect, test } from "bun:test";
import type { Cadence } from "./contracts.ts";
import { ScheduleRefusedError, scheduleInstallPlan, type Platform, type RefusalReason } from "./os_schedule.ts";

// A real path with spaces, of exactly the shape this repository lives at.
const WIN_EXE = "C:\\Users\\neorc\\OneDrive\\Desktop\\Apps AI Vibe\\10-COVERT AGENT IDE\\LucidAgentIDE\\bin\\lucid-maintainer.exe";
const NIX_EXE = "/opt/Lucid Agent IDE/bin/lucid-maintainer";
const ARGS = ["maintainer", "sweep", "--target", "core"];
const DAILY: Cadence = { kind: "daily", hhmm: "02:30" };

/** A persisted platform value the compiler never validated: exactly what fail-closed exists for. */
const OFF_DISK_PLATFORM = "aix" as Platform;

/**
 * Run something expected to refuse, and hand back the NARROWED error. Keeps every assertion below
 * free of inline casts: the instanceof check is what proves the shape, not an assertion.
 */
function refusal(run: () => unknown): ScheduleRefusedError {
  try {
    run();
  } catch (e) {
    if (e instanceof ScheduleRefusedError) return e;
    throw e;
  }
  throw new Error("expected a ScheduleRefusedError, but the call returned a plan");
}

test("win32 daily: schtasks command quotes a space-bearing path the way the CRT argv parser needs", () => {
  const plan = scheduleInstallPlan({ platform: "win32", cadence: DAILY, id: "core", exe: WIN_EXE, args: ARGS });
  expect(plan.register).toBe(
    'schtasks /Create /F /RL LIMITED /TN "LUCID Maintainer core" ' +
      '/TR "\\"C:\\Users\\neorc\\OneDrive\\Desktop\\Apps AI Vibe\\10-COVERT AGENT IDE\\LucidAgentIDE\\bin\\lucid-maintainer.exe\\" maintainer sweep --target core" ' +
      "/SC DAILY /ST 02:30",
  );
  expect(plan.remove).toBe('schtasks /Delete /TN "LUCID Maintainer core" /F');
  // The exe is wrapped in \" \" so the space inside "Apps AI Vibe" cannot split the argv.
  expect(plan.register).toContain('\\"C:\\Users');
  expect(plan.register).toContain('lucid-maintainer.exe\\"');
  expect(plan.unitPath).toBeUndefined();
});

test("win32 interval: /SC MINUTE /MO n under the 1439 cap, /SC DAILY /MO days for whole-day periods", () => {
  const minute = scheduleInstallPlan({ platform: "win32", cadence: { kind: "interval", everyMin: 45 }, id: "core", exe: WIN_EXE, args: ARGS });
  expect(minute.register).toContain("/SC MINUTE /MO 45");
  expect(minute.register).not.toContain("/ST");

  const edge = scheduleInstallPlan({ platform: "win32", cadence: { kind: "interval", everyMin: 1439 }, id: "core", exe: WIN_EXE, args: [] });
  expect(edge.register).toContain("/SC MINUTE /MO 1439");

  const threeDays = scheduleInstallPlan({ platform: "win32", cadence: { kind: "interval", everyMin: 4320 }, id: "core", exe: WIN_EXE, args: [] });
  expect(threeDays.register).toContain("/SC DAILY /MO 3 /ST 00:00");
  expect(threeDays.note).toContain("caps /SC MINUTE /MO at 1439");
});

test("win32 refuses an interval no schtasks flag combination can express, instead of rounding it", () => {
  // 2000 minutes is in range for the core (1..10080) but is neither <= 1439 nor a whole day.
  const err = refusal(() => scheduleInstallPlan({ platform: "win32", cadence: { kind: "interval", everyMin: 2000 }, id: "core", exe: WIN_EXE, args: [] }));
  expect(err.reason).toBe("cadence-inexpressible");
  expect(err.message).toContain("caps at 1439");
  // Linux CAN express it, so the refusal is a real platform limit and not a blanket rejection.
  const linux = scheduleInstallPlan({ platform: "linux", cadence: { kind: "interval", everyMin: 2000 }, id: "core", exe: NIX_EXE, args: [] });
  expect(linux.unitText).toContain("OnUnitActiveSec=2000min");
});

test("darwin daily: a valid plist with StartCalendarInterval, and a path with spaces stays one argv element", () => {
  const plan = scheduleInstallPlan({ platform: "darwin", cadence: DAILY, id: "core", exe: NIX_EXE, args: ARGS });
  expect(plan.unitPath).toBe("~/Library/LaunchAgents/com.techlead187.lucid.maintainer.core.plist");
  expect(plan.register).toBe('launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/com.techlead187.lucid.maintainer.core.plist"');
  expect(plan.remove).toBe('launchctl bootout gui/$(id -u) "$HOME/Library/LaunchAgents/com.techlead187.lucid.maintainer.core.plist"');
  // A single-quoted "~" would never expand; the command must use $HOME.
  expect(plan.register).not.toContain("'~/");
  const text = plan.unitText ?? "";
  expect(text).toStartWith('<?xml version="1.0" encoding="UTF-8"?>');
  expect(text).toContain("<key>Label</key>\n  <string>com.techlead187.lucid.maintainer.core</string>");
  // The space-bearing path is ONE <string>, so launchd does not word-split it.
  expect(text).toContain("<string>/opt/Lucid Agent IDE/bin/lucid-maintainer</string>");
  expect(text).toContain("<key>StartCalendarInterval</key>");
  expect(text).toContain("<key>Hour</key>\n    <integer>2</integer>");
  expect(text).toContain("<key>Minute</key>\n    <integer>30</integer>");
  expect(text).not.toContain("StartInterval");
  expect(text.trimEnd()).toEndWith("</plist>");
});

test("darwin interval: StartInterval is the cadence in SECONDS", () => {
  const plan = scheduleInstallPlan({ platform: "darwin", cadence: { kind: "interval", everyMin: 90 }, id: "nightly-audit", exe: NIX_EXE, args: [] });
  expect(plan.unitText).toContain("<key>StartInterval</key>\n  <integer>5400</integer>");
  expect(plan.unitText).not.toContain("StartCalendarInterval");
  expect(plan.unitPath).toBe("~/Library/LaunchAgents/com.techlead187.lucid.maintainer.nightly-audit.plist");
});

test("darwin plist XML-escapes a hostile argument instead of breaking the document", () => {
  const plan = scheduleInstallPlan({ platform: "darwin", cadence: DAILY, id: "core", exe: NIX_EXE, args: ["--note", '</string><key>RunAtLoad</key><true/>'] });
  const text = plan.unitText ?? "";
  expect(text).toContain("&lt;/string&gt;&lt;key&gt;RunAtLoad&lt;/key&gt;&lt;true/&gt;");
  expect(text).not.toContain("<true/>");
});

test("linux daily: systemd user timer unit text plus the enable command, and a crontab alternative", () => {
  const plan = scheduleInstallPlan({ platform: "linux", cadence: DAILY, id: "core", exe: NIX_EXE, args: ARGS });
  expect(plan.register).toBe("systemctl --user enable --now lucid-maintainer-core.timer");
  expect(plan.remove).toBe("systemctl --user disable --now lucid-maintainer-core.timer");
  expect(plan.unitPath).toBe("~/.config/systemd/user/lucid-maintainer-core.timer");
  const text = plan.unitText ?? "";
  // BOTH files are carried, behind explicit banners, because systemd needs a .service and a .timer.
  expect(text).toContain("# ---- ~/.config/systemd/user/lucid-maintainer-core.service ----");
  expect(text).toContain("# ---- ~/.config/systemd/user/lucid-maintainer-core.timer ----");
  expect(text).toContain("Type=oneshot");
  // systemd quotes with double quotes, so the space in the path is inert.
  expect(text).toContain('ExecStart="/opt/Lucid Agent IDE/bin/lucid-maintainer" maintainer sweep --target core');
  expect(text).toContain("OnCalendar=*-*-* 02:30:00");
  expect(text).toContain("Persistent=true");
  expect(text).toContain("Unit=lucid-maintainer-core.service");
  expect(text).toContain("WantedBy=timers.target");
  // The crontab line single-quotes the space-bearing path and leaves inert tokens bare.
  expect(plan.note).toContain("30 2 * * * '/opt/Lucid Agent IDE/bin/lucid-maintainer' maintainer sweep --target core");
});

test("linux interval: OnUnitActiveSec plus a step crontab line, with the hour-boundary skew stated", () => {
  const clean = scheduleInstallPlan({ platform: "linux", cadence: { kind: "interval", everyMin: 15 }, id: "core", exe: NIX_EXE, args: [] });
  expect(clean.unitText).toContain("OnBootSec=15min");
  expect(clean.unitText).toContain("OnUnitActiveSec=15min");
  expect(clean.note).toContain("*/15 * * * *");
  expect(clean.note).not.toContain("skews at the hour boundary");

  const skewed = scheduleInstallPlan({ platform: "linux", cadence: { kind: "interval", everyMin: 45 }, id: "core", exe: NIX_EXE, args: [] });
  expect(skewed.note).toContain("*/45 * * * *");
  expect(skewed.note).toContain("skews at the hour boundary");

  const hourly = scheduleInstallPlan({ platform: "linux", cadence: { kind: "interval", everyMin: 360 }, id: "core", exe: NIX_EXE, args: [] });
  expect(hourly.note).toContain("0 */6 * * *");

  const weekly = scheduleInstallPlan({ platform: "linux", cadence: { kind: "interval", everyMin: 10080 }, id: "core", exe: NIX_EXE, args: [] });
  expect(weekly.note).toContain("0 0 */7 * *");
  expect(weekly.note).toContain("skews at month end");

  // 2000 minutes: no cron step fits, and the note says so rather than offering a wrong line.
  const odd = scheduleInstallPlan({ platform: "linux", cadence: { kind: "interval", everyMin: 2000 }, id: "core", exe: NIX_EXE, args: [] });
  expect(odd.note).toContain("Cron cannot express this cadence exactly");
});

test("every platform's plan carries the fail-closed preflight rationale", () => {
  for (const platform of ["win32", "darwin", "linux"] as const) {
    const plan = scheduleInstallPlan({ platform, cadence: DAILY, id: "core", exe: platform === "win32" ? WIN_EXE : NIX_EXE, args: ARGS });
    expect(plan.platform).toBe(platform);
    expect(plan.note).toContain("lucid check");
    expect(plan.note).toContain("not omp and not a bare agent runner");
    expect(plan.note).toContain("never start an ungated agent");
  }
});

test("out-of-range and malformed cadences are refused with a named error on every platform", () => {
  const bad: readonly { cadence: Cadence; reason: RefusalReason }[] = [
    { cadence: { kind: "interval", everyMin: 0 }, reason: "cadence-out-of-range" },
    { cadence: { kind: "interval", everyMin: 10081 }, reason: "cadence-out-of-range" },
    { cadence: { kind: "interval", everyMin: 12.5 }, reason: "cadence-malformed" },
    { cadence: { kind: "daily", hhmm: "24:00" }, reason: "cadence-malformed" },
    { cadence: { kind: "daily", hhmm: "2:30" }, reason: "cadence-malformed" },
    { cadence: { kind: "daily", hhmm: "" }, reason: "cadence-malformed" },
  ];
  for (const platform of ["win32", "darwin", "linux"] as const) {
    for (const c of bad) {
      const err = refusal(() => scheduleInstallPlan({ platform, cadence: c.cadence, id: "core", exe: NIX_EXE, args: [] }));
      expect(err.reason).toBe(c.reason);
      expect(err.name).toBe("ScheduleRefusedError");
    }
  }
  // The core's boundary values themselves are ACCEPTED (1 and 10080 minutes).
  expect(scheduleInstallPlan({ platform: "linux", cadence: { kind: "interval", everyMin: 1 }, id: "core", exe: NIX_EXE, args: [] }).unitText).toContain("OnUnitActiveSec=1min");
  expect(scheduleInstallPlan({ platform: "linux", cadence: { kind: "interval", everyMin: 10080 }, id: "core", exe: NIX_EXE, args: [] }).unitText).toContain("OnUnitActiveSec=10080min");
});

test("an unusable id, a missing exe, an unquotable arg, and an unknown platform all refuse by name", () => {
  const reasons: readonly [() => unknown, RefusalReason][] = [
    [() => scheduleInstallPlan({ platform: "linux", cadence: DAILY, id: "core repo/../../etc", exe: NIX_EXE, args: [] }), "id-invalid"],
    [() => scheduleInstallPlan({ platform: "linux", cadence: DAILY, id: "", exe: NIX_EXE, args: [] }), "id-invalid"],
    [() => scheduleInstallPlan({ platform: "linux", cadence: DAILY, id: "core", exe: "   ", args: [] }), "exe-missing"],
    [() => scheduleInstallPlan({ platform: "win32", cadence: DAILY, id: "core", exe: WIN_EXE, args: ['--note="x"'] }), "arg-unquotable"],
    // A platform string that arrived off disk rather than from the union type. The cast is the
    // point of the case: it models a persisted target record the compiler never validated.
    [() => scheduleInstallPlan({ platform: OFF_DISK_PLATFORM, cadence: DAILY, id: "core", exe: NIX_EXE, args: [] }), "platform-unsupported"],
  ];
  for (const [run, reason] of reasons) {
    expect(refusal(run).reason).toBe(reason);
  }
});

test("no emitted string contains an em dash", () => {
  for (const platform of ["win32", "darwin", "linux"] as const) {
    for (const cadence of [DAILY, { kind: "interval", everyMin: 45 } as Cadence]) {
      const plan = scheduleInstallPlan({ platform, cadence, id: "core", exe: platform === "win32" ? WIN_EXE : NIX_EXE, args: ARGS });
      const all = [plan.register, plan.remove, plan.unitPath ?? "", plan.unitText ?? "", plan.note].join("\n");
      expect(all).not.toContain("\u2014");
    }
  }
});
