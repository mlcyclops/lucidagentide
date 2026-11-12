// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer_watchdog.test.ts - ADR-0481 (P-RECOVER.4): the main-window renderer watchdog.
// The strand: the window's renderer process dies, the frameless window paints only its background and
// nothing in main reloads it. The watchdog must reload the app on every death that is not a clean exit,
// back the reloads off, give up past the per-window cap (no reload loop on a renderer that dies at boot),
// allow reloads again once the window has slid past, and log the reason and exit code every time.

import { describe, expect, test } from "bun:test";
import {
  RENDERER_MAX_RELOADS,
  RENDERER_RELOAD_DELAYS_MS,
  RENDERER_RELOAD_WINDOW_MS,
  decideReloadRetry,
  decideRendererAction,
  engineAppUrl,
  freshRendererWatch,
  isRendererDeath,
  reloadFailedLogLine,
  rendererGoneLogLine,
  rendererResponsivenessLogLine,
  type RendererWatchState,
} from "./renderer_watchdog.ts";

const T0 = 1_700_000_000_000;
const crashed = { reason: "crashed", exitCode: 5 };

/** Feed `n` deaths `gapMs` apart starting at T0; return the last decision and the state after it. */
function deaths(n: number, gapMs: number, from: RendererWatchState = freshRendererWatch(), details = crashed) {
  let s = from;
  let last = decideRendererAction(details, s, T0);
  for (let i = 0; i < n; i++) {
    last = decideRendererAction(details, s, T0 + i * gapMs);
    s = last.state;
  }
  return { last, state: s };
}

describe("isRendererDeath", () => {
  test("every reason but clean-exit is a death, including an unknown one", () => {
    for (const reason of ["crashed", "abnormal-exit", "killed", "oom", "launch-failed", "integrity-failure", "something-new"]) {
      expect(isRendererDeath({ reason })).toBe(true);
    }
    expect(isRendererDeath({})).toBe(true);
  });
  test("clean-exit is not a death", () => {
    expect(isRendererDeath({ reason: "clean-exit", exitCode: 0 })).toBe(false);
  });
});

describe("decideRendererAction", () => {
  test("a clean exit is ignored and leaves the state alone", () => {
    const s = freshRendererWatch();
    const r = decideRendererAction({ reason: "clean-exit" }, s, T0);
    expect(r.action).toBe("ignore");
    expect(r.state).toBe(s);
  });

  test("the first death reloads after the shortest delay", () => {
    const r = decideRendererAction(crashed, freshRendererWatch(), T0);
    expect(r.action).toBe("reload");
    expect(r.attempt).toBe(1);
    expect(r.delayMs).toBe(RENDERER_RELOAD_DELAYS_MS[0]);
    expect(r.state.reloadsAt).toEqual([T0]);
  });

  test("repeated deaths back off through the delay table", () => {
    const seen: number[] = [];
    let s = freshRendererWatch();
    for (let i = 0; i < RENDERER_MAX_RELOADS; i++) {
      const r = decideRendererAction(crashed, s, T0 + i * 1000);
      expect(r.action).toBe("reload");
      expect(r.attempt).toBe(i + 1);
      seen.push(r.delayMs);
      s = r.state;
    }
    expect(seen).toEqual([...RENDERER_RELOAD_DELAYS_MS]);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]);
  });

  test("the death after the cap gives up and keeps the window as it is", () => {
    const { last } = deaths(RENDERER_MAX_RELOADS + 1, 1000);
    expect(last.action).toBe("give-up");
    expect(last.attempt).toBe(RENDERER_MAX_RELOADS);
    expect(last.delayMs).toBe(0);
    // Giving up records no new reload, so the window keeps its size.
    expect(last.state.reloadsAt.length).toBe(RENDERER_MAX_RELOADS);
  });

  test("a death that keeps coming past the cap keeps giving up (no reload loop)", () => {
    const { state } = deaths(RENDERER_MAX_RELOADS + 1, 1000);
    for (let i = 0; i < 20; i++) {
      const r = decideRendererAction(crashed, state, T0 + 10_000 + i * 100);
      expect(r.action).toBe("give-up");
    }
  });

  test("once the window slides past the old reloads, a reload is allowed again with the short delay", () => {
    const { state } = deaths(RENDERER_MAX_RELOADS, 1000);
    const later = T0 + RENDERER_RELOAD_WINDOW_MS + 5000;
    const r = decideRendererAction(crashed, state, later);
    expect(r.action).toBe("reload");
    expect(r.attempt).toBe(1);
    expect(r.delayMs).toBe(RENDERER_RELOAD_DELAYS_MS[0]);
    expect(r.state.reloadsAt).toEqual([later]);
  });

  test("reloads spread wider than the window never hit the cap", () => {
    let s = freshRendererWatch();
    for (let i = 0; i < 3 * RENDERER_MAX_RELOADS; i++) {
      const r = decideRendererAction(crashed, s, T0 + i * (RENDERER_RELOAD_WINDOW_MS + 1));
      expect(r.action).toBe("reload");
      expect(r.attempt).toBe(1);
      s = r.state;
    }
  });

  test("the delay table has one entry per allowed reload", () => {
    expect(RENDERER_RELOAD_DELAYS_MS.length).toBe(RENDERER_MAX_RELOADS);
  });
});

// P-RECOVER.4 (ADR-0481) upgrade review RELOAD-RETRY: a failed reload retries with backoff under the SAME cap.
describe("decideReloadRetry", () => {
  test("a failed reload after one death retries with the next backoff step", () => {
    const first = decideRendererAction(crashed, freshRendererWatch(), T0);
    const r = decideReloadRetry(first.state, T0 + first.delayMs + 10);
    expect(r.action).toBe("reload");
    expect(r.attempt).toBe(2);
    expect(r.delayMs).toBe(RENDERER_RELOAD_DELAYS_MS[1]);
  });

  test("deaths and failed-reload retries share one cap; past it the retry gives up", () => {
    let s = decideRendererAction(crashed, freshRendererWatch(), T0).state;
    const actions: string[] = [];
    for (let i = 1; i <= RENDERER_MAX_RELOADS + 3; i++) {
      const r = decideReloadRetry(s, T0 + i * 100);
      actions.push(r.action);
      s = r.state;
    }
    expect(actions.filter((a) => a === "reload").length).toBe(RENDERER_MAX_RELOADS - 1);
    expect(actions.slice(RENDERER_MAX_RELOADS - 1).every((a) => a === "give-up")).toBe(true);
    expect(decideRendererAction(crashed, s, T0 + 5000).action).toBe("give-up");
  });

  test("retry log lines say retrying or NOT retried", () => {
    const r = decideReloadRetry(freshRendererWatch(), T0);
    expect(reloadFailedLogLine("ERR_CONNECTION_REFUSED", r, "t")).toContain(`retrying in ${r.delayMs}ms`);
    const { state } = deaths(RENDERER_MAX_RELOADS, 10);
    const g = decideReloadRetry(state, T0 + 100);
    expect(reloadFailedLogLine("x", g, "t")).toContain("NOT retried");
  });
});

// P-RECOVER.4 (ADR-0481) upgrade review RELOAD-ORIGIN: the reload goes to the IPv4 loopback the engine binds.
describe("engineAppUrl", () => {
  test("is the 127.0.0.1 origin, never localhost", () => {
    expect(engineAppUrl(8787)).toBe("http://127.0.0.1:8787");
    expect(new URL(engineAppUrl(8787)).hostname).toBe("127.0.0.1");
  });
});

describe("log lines", () => {
  test("a reload line carries the reason, the exit code and the attempt", () => {
    const r = decideRendererAction({ reason: "oom", exitCode: -1073741819 }, freshRendererWatch(), T0);
    const line = rendererGoneLogLine({ reason: "oom", exitCode: -1073741819 }, r, "2026-11-03T20:00:00.000Z");
    expect(line).toContain("[renderer-watchdog]");
    expect(line).toContain("reason=oom");
    expect(line).toContain("exitCode=0xC0000005");
    expect(line).toContain(`reload #1 of ${RENDERER_MAX_RELOADS}`);
    expect(line.endsWith("\n")).toBe(true);
    expect(line).not.toContain(String.fromCharCode(0x2014)); // no em dash anywhere (CLAUDE.md writing style)
  });

  test("a give-up line says the window is left alone and names the cap", () => {
    const { last } = deaths(RENDERER_MAX_RELOADS + 1, 1000);
    const line = rendererGoneLogLine(crashed, last, "2026-11-03T20:00:00.000Z");
    expect(line).toContain("NOT reloaded");
    expect(line).toContain(`cap ${RENDERER_MAX_RELOADS}`);
    expect(line).toContain("relaunch LUCID");
  });

  test("a clean exit line is marked ignored and an unknown reason prints ?", () => {
    const r = decideRendererAction({ reason: "clean-exit" }, freshRendererWatch(), T0);
    expect(rendererGoneLogLine({ reason: "clean-exit" }, r, "t")).toContain("ignored");
    const r2 = decideRendererAction({}, freshRendererWatch(), T0);
    expect(rendererGoneLogLine({}, r2, "t")).toContain("reason=?");
  });

  test("responsiveness lines are log-only statements", () => {
    expect(rendererResponsivenessLogLine("unresponsive", "t")).toContain("logged only");
    expect(rendererResponsivenessLogLine("responsive", "t")).toContain("responsive again");
  });
});
