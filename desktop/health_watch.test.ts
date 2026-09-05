// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/health_watch.test.ts - P-HEALTH.1: the self-healing ladder ok -> quiet -> probe -> recover.
//
// This suite exists for the REFUSALS, not the happy path. The load-bearing ones: an open tool call caps
// the verdict at `quiet` at any silence (the ADR-0263 guarantee, tested by name below), an idle session is
// never stalled, the probe and recover budgets are spendable exactly once each, and an unreadable clock
// never authorizes a cancel-and-respawn.

import { describe, expect, test } from "bun:test";
import {
  HEALTH_ACTION_GAP_MS,
  HEALTH_DEFAULTS,
  HEALTH_PROBE_NOTE,
  type HealthEpisode,
  type HealthInput,
  type HealthVerdict,
  healthLabel,
  healthVerdict,
  newEpisode,
  onActivity,
  onProbe,
  onRecover,
} from "./health_watch.ts";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const { quietMs, probeMs, recoverMs } = HEALTH_DEFAULTS;

/** An episode whose last action is long past, so HEALTH_ACTION_GAP_MS is out of the way unless a test
 *  deliberately puts it back. */
function ep(over: Partial<HealthEpisode> = {}): HealthEpisode {
  return { probes: 0, recovers: 0, startedAt: NOW - HOUR, lastActionAt: NOW - HOUR, ...over };
}

/** A busy session that has been silent for `ms`. */
function silent(ms: number, over: Partial<HealthInput> = {}): HealthInput {
  return { busy: true, dead: false, lastActivityAt: NOW - ms, now: NOW, openCalls: 0, episode: ep(), ...over };
}

describe("an idle session is not a stalled session", () => {
  test("not busy is `ok` whatever the silence", () => {
    expect(healthVerdict(silent(1, { busy: false })).action).toBe("ok");
    expect(healthVerdict(silent(10 * HOUR, { busy: false })).action).toBe("ok");
    // Even with a spent budget and an open call in the record, idle is idle.
    expect(healthVerdict(silent(10 * HOUR, { busy: false, openCalls: 3, episode: ep({ probes: 2, recovers: 2 }) })).action).toBe("ok");
  });
});

describe("a dead child is evidence, not a clock", () => {
  test("dead while NOT busy is still `recover`: a dead child cannot take the next prompt either", () => {
    const v = healthVerdict(silent(0, { busy: false, dead: true }));
    expect(v.action).toBe("recover");
    expect(v.reason).toMatch(/gone/);
  });
  test("dead OUTRANKS openCalls, which nothing else does", () => {
    expect(healthVerdict(silent(0, { dead: true, openCalls: 4 })).action).toBe("recover");
    expect(healthVerdict(silent(10 * HOUR, { dead: true, openCalls: 4 })).action).toBe("recover");
  });
  test("dead still respects the recover budget, so a wedged child is not a respawn loop", () => {
    const v = healthVerdict(silent(0, { dead: true, episode: ep({ recovers: HEALTH_DEFAULTS.maxRecovers }) }));
    expect(v.action).toBe("quiet");
    expect(v.reason).toMatch(/stopped retrying/);
  });
});

describe("the ladder", () => {
  test("busy and silent 10s is `ok`", () => {
    expect(healthVerdict(silent(10_000)).action).toBe("ok");
  });
  test("silent 91s is `quiet`, no action", () => {
    expect(healthVerdict(silent(91_000)).action).toBe("quiet");
  });
  test("silent 181s with no open call is `probe`", () => {
    const v = healthVerdict(silent(181_000));
    expect(v.action).toBe("probe");
    expect(v.silentMs).toBe(181_000);
    expect(v.reason).toMatch(/status/);
  });
  test("silent 181s with one open call is `quiet`, and the reason names the open call", () => {
    const v = healthVerdict(silent(181_000, { openCalls: 1 }));
    expect(v.action).toBe("quiet");
    expect(v.reason).toMatch(/1 tool call is still running/);
  });
  test("silent 421s with no open call is `recover`", () => {
    const v = healthVerdict(silent(421_000));
    expect(v.action).toBe("recover");
    expect(v.reason).toMatch(/respawning/);
  });
  test("every reason is a non-empty sentence", () => {
    for (const ms of [0, 91_000, 181_000, 421_000]) {
      for (const openCalls of [0, 1]) {
        expect(healthVerdict(silent(ms, { openCalls })).reason.trim().length).toBeGreaterThan(0);
      }
    }
  });
});

describe("ADR-0263: an open tool call is never killed on a clock", () => {
  test("busy, silent 500s, openCalls 1 is `quiet` and NOT `recover`", () => {
    const v = healthVerdict(silent(500_000, { openCalls: 1 }));
    expect(v.action).toBe("quiet");
    expect(v.action).not.toBe("recover");
    expect(v.reason).toMatch(/tool call/);
  });
  test("no silence at all escalates past `quiet` while a call is open: 3 minutes or 10 hours", () => {
    for (const ms of [probeMs, recoverMs, 30 * 60_000, 10 * HOUR]) {
      const v = healthVerdict(silent(ms, { openCalls: 1 }));
      expect(v.action).toBe("quiet");
    }
    // And an already-spent probe budget does not unlock it either.
    expect(healthVerdict(silent(10 * HOUR, { openCalls: 2, episode: ep({ probes: 2 }) })).action).toBe("quiet");
  });
  test("an UNREADABLE open-call count is treated as an open call, not as zero", () => {
    expect(healthVerdict(silent(recoverMs, { openCalls: Number.NaN })).action).toBe("quiet");
    expect(healthVerdict(silent(recoverMs, { openCalls: Number.POSITIVE_INFINITY })).action).toBe("quiet");
  });
});

describe("thresholds are inclusive", () => {
  test("exactly quietMs is `quiet`, one ms under is `ok`", () => {
    expect(healthVerdict(silent(quietMs)).action).toBe("quiet");
    expect(healthVerdict(silent(quietMs - 1)).action).toBe("ok");
  });
  test("exactly probeMs is `probe`, one ms under is `quiet`", () => {
    expect(healthVerdict(silent(probeMs)).action).toBe("probe");
    expect(healthVerdict(silent(probeMs - 1)).action).toBe("quiet");
  });
  test("exactly recoverMs is `recover`, one ms under is `probe`", () => {
    expect(healthVerdict(silent(recoverMs)).action).toBe("recover");
    expect(healthVerdict(silent(recoverMs - 1)).action).toBe("probe");
  });
});

describe("budgets: the harness asks twice and respawns twice, then stops", () => {
  test("probes at maxProbes never probes again, and escalation still happens at recoverMs", () => {
    const spent = ep({ probes: HEALTH_DEFAULTS.maxProbes });
    const v = healthVerdict(silent(probeMs, { episode: spent }));
    expect(v.action).toBe("quiet");
    expect(v.reason).toMatch(/already asked for status/);
    // Nagging loop check: no silence in the probe band ever yields `probe` again.
    for (let ms = probeMs; ms < recoverMs; ms += 10_000) {
      expect(healthVerdict(silent(ms, { episode: spent })).action).not.toBe("probe");
    }
    // The recover rung is still reachable: exhausting probes does not freeze the ladder.
    expect(healthVerdict(silent(recoverMs, { episode: spent })).action).toBe("recover");
  });
  test("recovers at maxRecovers pins at `quiet` and says the harness stopped retrying", () => {
    const spent = ep({ recovers: HEALTH_DEFAULTS.maxRecovers });
    const v = healthVerdict(silent(recoverMs, { episode: spent }));
    expect(v.action).toBe("quiet");
    expect(v.reason).toMatch(/stopped retrying/);
    expect(v.reason).toMatch(/manual restart/);
    // Respawn loop check: no silence, and no dead child, ever yields `recover` again.
    for (const ms of [recoverMs, 10 * 60_000, HOUR, 10 * HOUR]) {
      expect(healthVerdict(silent(ms, { episode: spent })).action).not.toBe("recover");
      expect(healthVerdict(silent(ms, { dead: true, episode: spent })).action).not.toBe("recover");
    }
  });
  test("a budget the caller left unusable is spent, not infinite", () => {
    const cfg = { ...HEALTH_DEFAULTS, maxProbes: Number.NaN, maxRecovers: Number.NaN };
    expect(healthVerdict(silent(probeMs), cfg).action).toBe("quiet");
    expect(healthVerdict(silent(recoverMs), cfg).action).toBe("quiet");
  });
});

describe("HEALTH_ACTION_GAP_MS: a fast poll cannot fire twice on one session", () => {
  test("a would-be probe inside the gap is `quiet`", () => {
    const e = ep({ probes: 1, lastActionAt: NOW - (HEALTH_ACTION_GAP_MS - 1) });
    const v = healthVerdict(silent(probeMs, { episode: e }));
    expect(v.action).toBe("quiet");
    expect(v.reason).toMatch(/waiting before acting again/);
  });
  test("a would-be recover inside the gap is `quiet`, even for a dead child", () => {
    const e = ep({ recovers: 1, lastActionAt: NOW - 1 });
    expect(healthVerdict(silent(recoverMs, { episode: e })).action).toBe("quiet");
    expect(healthVerdict(silent(0, { dead: true, episode: e })).action).toBe("quiet");
  });
  test("past the gap the action fires again", () => {
    const e = ep({ probes: 1, lastActionAt: NOW - HEALTH_ACTION_GAP_MS });
    expect(healthVerdict(silent(probeMs, { episode: e })).action).toBe("probe");
  });
  test("an action we cannot time holds, and a fresh episode is not muzzled", () => {
    // Counters say we acted but the stamp is garbage: fail closed and wait.
    const blind = ep({ probes: 1, lastActionAt: Number.NaN });
    expect(healthVerdict(silent(probeMs, { episode: blind })).action).toBe("quiet");
    // newEpisode has no action stamp at all, so the first probe is allowed immediately.
    expect(healthVerdict(silent(probeMs, { episode: newEpisode(NOW) })).action).toBe("probe");
  });
  test("the gap never suppresses `ok`", () => {
    const e = ep({ probes: 1, lastActionAt: NOW });
    expect(healthVerdict(silent(1_000, { episode: e })).action).toBe("ok");
    expect(healthVerdict(silent(1_000, { busy: false, episode: e })).action).toBe("ok");
  });
});

describe("an unusable clock never authorizes a destructive action", () => {
  const broken = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, -HOUR];
  test("a broken lastActivityAt or now yields `ok` and never throws", () => {
    for (const bad of broken) {
      for (const frame of [silent(0, { lastActivityAt: bad }), silent(0, { now: bad }), silent(0, { lastActivityAt: bad, now: bad })]) {
        const v = healthVerdict(frame);
        expect(v.action).toBe("ok");
        expect(v.silentMs).toBe(0);
        expect(v.reason).toMatch(/unreadable/);
      }
    }
  });
  test("a broken clock outranks even a dead child: unreadable input is reported, not acted on", () => {
    // Defined here: `dead` arrives from the same poll as the clock, so it does not escalate past one we
    // cannot read. Fail-closed beats evidence we cannot date.
    expect(healthVerdict(silent(0, { dead: true, lastActivityAt: Number.NaN })).action).toBe("ok");
    expect(healthVerdict(silent(0, { dead: true, now: Number.NaN })).action).toBe("ok");
  });
  test("a clock that runs backwards reads as zero silence, not as a stall", () => {
    expect(healthVerdict(silent(-HOUR)).action).toBe("ok"); // lastActivityAt in the future
    expect(healthVerdict({ ...silent(0), lastActivityAt: NOW + HOUR }).silentMs).toBe(0);
  });
  test("an unusable threshold is unreachable, so an escalation nobody configured cannot fire", () => {
    const cfg = { ...HEALTH_DEFAULTS, quietMs: Number.NaN, probeMs: -1, recoverMs: Number.NaN };
    expect(healthVerdict(silent(10 * HOUR), cfg).action).toBe("ok");
  });
});

describe("episode bookkeeping", () => {
  test("newEpisode starts empty at `now` with no action stamp", () => {
    expect(newEpisode(NOW)).toEqual({ probes: 0, recovers: 0, startedAt: NOW, lastActionAt: 0 });
  });
  test("onActivity zeroes both counters and moves startedAt", () => {
    const worn: HealthEpisode = { probes: 2, recovers: 2, startedAt: NOW - HOUR, lastActionAt: NOW - 1000 };
    const fresh = onActivity(worn, NOW);
    expect(fresh).toEqual({ probes: 0, recovers: 0, startedAt: NOW, lastActionAt: 0 });
    expect(worn.probes).toBe(2); // pure: the input is untouched
  });
  test("onProbe and onRecover each increment exactly one counter and stamp the action", () => {
    const base = newEpisode(NOW - HOUR);
    const probed = onProbe(base, NOW);
    expect(probed).toEqual({ probes: 1, recovers: 0, startedAt: NOW - HOUR, lastActionAt: NOW });
    const recovered = onRecover(probed, NOW + 1);
    expect(recovered).toEqual({ probes: 1, recovers: 1, startedAt: NOW - HOUR, lastActionAt: NOW + 1 });
    expect(base.probes).toBe(0);
  });
  test("a garbage counter cannot mint budget", () => {
    const junk: HealthEpisode = { probes: Number.NaN, recovers: -5, startedAt: NOW, lastActionAt: NOW - HOUR };
    expect(onProbe(junk, NOW).probes).toBe(1);
    expect(onRecover(junk, NOW).recovers).toBe(1);
    expect(healthVerdict(silent(probeMs, { episode: junk })).action).toBe("probe");
  });
  test("a full round trip: quiet, probe, wait out the gap, probe, then recover, then stop", () => {
    let e = newEpisode(NOW - HOUR);
    const at = (ms: number, t: number): HealthVerdict => healthVerdict({ busy: true, dead: false, lastActivityAt: t - ms, now: t, openCalls: 0, episode: e });

    expect(at(quietMs, NOW).action).toBe("quiet");
    expect(at(probeMs, NOW).action).toBe("probe");
    e = onProbe(e, NOW);
    expect(at(probeMs + 1_000, NOW + 1_000).action).toBe("quiet"); // inside the gap
    e = onProbe(e, NOW + HEALTH_ACTION_GAP_MS);
    expect(at(recoverMs, NOW + 2 * HEALTH_ACTION_GAP_MS).action).toBe("recover");
    e = onRecover(e, NOW + 2 * HEALTH_ACTION_GAP_MS);
    e = onRecover(e, NOW + 3 * HEALTH_ACTION_GAP_MS);
    const stopped = at(recoverMs, NOW + 10 * HEALTH_ACTION_GAP_MS);
    expect(stopped.action).toBe("quiet");
    expect(stopped.reason).toMatch(/stopped retrying/);
    // Activity ends the episode and hands back a full budget.
    e = onActivity(e, NOW + 11 * HEALTH_ACTION_GAP_MS);
    expect(at(recoverMs, NOW + 12 * HEALTH_ACTION_GAP_MS).action).toBe("recover");
  });
});

describe("operator-facing strings", () => {
  test("HEALTH_PROBE_NOTE asks for status, orders the model to continue, and stays short", () => {
    expect(HEALTH_PROBE_NOTE.length).toBeLessThan(400);
    expect(HEALTH_PROBE_NOTE).toMatch(/status/i);
    expect(HEALTH_PROBE_NOTE).toMatch(/continue/i);
    expect(HEALTH_PROBE_NOTE).toMatch(/not a stop order/i);
    expect(HEALTH_PROBE_NOTE).toMatch(/operator note/i);
  });
  test("healthLabel is non-empty for all four actions", () => {
    const labels = (["ok", "quiet", "probe", "recover"] as const).map((action) => healthLabel({ action, silentMs: 181_000, reason: "x" }));
    for (const l of labels) expect(l.trim().length).toBeGreaterThan(0);
    expect(new Set(labels).size).toBe(4);
  });
  test("healthLabel never invents a duration it was not given", () => {
    expect(healthLabel({ action: "quiet", silentMs: Number.NaN, reason: "x" })).toMatch(/unknown time/);
    expect(healthLabel({ action: "quiet", silentMs: 45_000, reason: "x" })).toContain("45s");
    expect(healthLabel({ action: "recover", silentMs: 421_000, reason: "x" })).toContain("7m 1s");
  });
  test("no operator-facing string contains an em dash", () => {
    const strings = [HEALTH_PROBE_NOTE];
    const frames: HealthInput[] = [
      silent(0),
      silent(0, { busy: false }),
      silent(0, { dead: true }),
      silent(0, { dead: true, episode: ep({ recovers: 2 }) }),
      silent(quietMs),
      silent(probeMs),
      silent(probeMs, { openCalls: 1 }),
      silent(probeMs, { openCalls: 3 }),
      silent(probeMs, { episode: ep({ probes: 1 }) }),
      silent(probeMs, { episode: ep({ probes: 2 }) }),
      silent(probeMs, { episode: ep({ probes: 1, lastActionAt: NOW }) }),
      silent(recoverMs),
      silent(recoverMs, { episode: ep({ recovers: 1 }) }),
      silent(recoverMs, { episode: ep({ recovers: 2 }) }),
      silent(0, { lastActivityAt: Number.NaN }),
    ];
    for (const f of frames) {
      const v = healthVerdict(f);
      strings.push(v.reason, healthLabel(v));
    }
    for (const s of strings) expect(s).not.toContain("\u2014");
  });
});
