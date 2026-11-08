// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// tools/metrics/repo_metrics.test.ts - P-METRICS.1 (ADR-0525): the pure core and the collect path.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assetKind, assetPlatform, baselineDate, buildSummary, collect, mergeDays, parseSeries, productOf, rollupRelease,
  type ReleaseSnap, type Snapshot,
} from "./repo_metrics.ts";

// The real v2.5.1 asset list as GitHub reported it on 2026-11-08.
const V251: ReleaseSnap = {
  tag: "v2.5.1", name: "v2.5.1", publishedAt: "2026-11-06T02:57:57Z", prerelease: false,
  assets: {
    "latest-linux-arm64.yml": 1, "latest-linux.yml": 14, "latest-mac.yml": 2, "latest.yml": 16,
    "LucidAgent-2.5.1-x64.appx": 1, "LucidAgent-2.5.1-x64.msi": 1, "LucidAgent-arm64.AppImage": 1,
    "LucidAgent-mac-arm64.pkg": 1, "LucidAgent-mac-arm64.zip": 1, "LucidAgent-mac-arm64.zip.blockmap": 1,
    "LucidAgent-mac-x64.pkg": 1, "LucidAgent-mac-x64.zip": 1, "LucidAgent-mac-x64.zip.blockmap": 1,
    "LucidAgent-portable.exe": 1, "LucidAgent-Setup.exe": 14, "LucidAgent-Setup.exe.blockmap": 8,
    "LucidAgent-x86_64.AppImage": 2, "lucidagentide-desktop-2.5.1.x86_64.rpm": 1, "lucidagentide-desktop_2.5.1_amd64.deb": 2,
  },
};

describe("classification", () => {
  test("update files never count as installs, and the mac/linux yml are not read as windows", () => {
    expect(assetKind("latest.yml")).toBe("update-check");
    expect(assetKind("latest-mac.yml")).toBe("update-check");
    expect(assetKind("LucidAgent-Setup.exe.blockmap")).toBe("update-delta");
    expect(assetKind("LucidAgent-Setup.exe")).toBe("installer");
    expect(assetPlatform("latest.yml")).toBe("windows");
    expect(assetPlatform("latest-mac.yml")).toBe("mac");
    expect(assetPlatform("latest-linux-arm64.yml")).toBe("linux");
    expect(assetPlatform("LucidAgent-Setup.exe.blockmap")).toBe("windows");
  });
  test("every installer format the release pipeline ships lands on a platform", () => {
    for (const n of Object.keys(V251.assets).filter((a) => assetKind(a) === "installer")) expect(assetPlatform(n)).not.toBe("other");
    expect(assetPlatform("LucidCreator-mac-x64.zip")).toBe("mac");
    expect(assetPlatform("lucidcreator-desktop_0.1.2_amd64.deb")).toBe("linux");
  });
  test("product follows the tag prefix", () => {
    expect(productOf("creator-v0.1.2")).toBe("Creator");
    expect(productOf("v2.5.1")).toBe("Agent");
  });
  test("v2.5.1 rolls up to the numbers reported by hand on 2026-11-08", () => {
    const r = rollupRelease(V251);
    expect(r.installers).toBe(27);
    expect(r.updateChecks).toBe(33);
    expect(r.updateDeltas).toBe(10);
    // windows appx 1 + msi 1 + portable 1 + Setup 14; mac two pkg + two zip; linux AppImage 1 + 2, rpm 1, deb 2
    expect(r.byPlatform).toEqual({ windows: 17, mac: 4, linux: 6, other: 0 });
  });
  test("a hostile count never goes negative or fractional", () => {
    expect(rollupRelease({ ...V251, assets: { "a.exe": -5, "b.exe": Number.NaN, "c.exe": 2.9 } }).installers).toBe(2);
  });
});

describe("daily series", () => {
  test("a newer fetch wins for days GitHub still reports; days outside its window are kept", () => {
    const prev = { "2026-10-20": { count: 4, uniques: 2 }, "2026-11-01": { count: 1, uniques: 1 } };
    const merged = mergeDays(prev, [
      { timestamp: "2026-11-01T00:00:00Z", count: 6, uniques: 3 },
      { timestamp: "2026-11-02T00:00:00Z", count: 2, uniques: 2 },
      { timestamp: "garbage", count: 9, uniques: 9 },
    ]);
    expect(merged).toEqual({ "2026-10-20": { count: 4, uniques: 2 }, "2026-11-01": { count: 6, uniques: 3 }, "2026-11-02": { count: 2, uniques: 2 } });
    expect(Object.keys(merged)).toEqual(["2026-10-20", "2026-11-01", "2026-11-02"]);
  });
  test("a corrupt series file is reported, not silently replaced", () => {
    expect(parseSeries("{not json").ok).toBe(false);
    expect(parseSeries(JSON.stringify({ v: 2 })).ok).toBe(false);
    expect(parseSeries(null)).toEqual({ series: { v: 1, clones: {}, views: {} }, ok: true });
  });
  test("baseline picks the newest snapshot at least 7 days back", () => {
    expect(baselineDate(["2026-10-30", "2026-11-01", "2026-11-02", "2026-11-05"], "2026-11-08")).toBe("2026-11-01");
    expect(baselineDate(["2026-11-05"], "2026-11-08")).toBeNull();
  });
});

describe("summary", () => {
  const snap = (date: string, releases: ReleaseSnap[], traffic: Snapshot["traffic"]): Snapshot => ({ v: 1, date, collectedAt: `${date}T04:23:00Z`, repo: "o/r", releases, traffic });
  test("says counts are downloads, shows change against the baseline, and never invents traffic", () => {
    const old = snap("2026-11-01", [{ ...V251, assets: { "LucidAgent-Setup.exe": 4 } }], { status: "not-collected", reason: "METRICS_TRAFFIC_TOKEN is not set" });
    const now = snap("2026-11-08", [V251, { tag: "v2.5.2", name: "", publishedAt: "2026-11-07T21:35:01Z", prerelease: false, assets: { "LucidAgent-Setup.exe": 2 } }],
      { status: "not-collected", reason: "METRICS_TRAFFIC_TOKEN is not set" });
    const md = buildSummary(now, old, { v: 1, clones: {}, views: {} });
    expect(md).toContain("downloads, not people");
    expect(md).toContain("| v2.5.1 | Agent | 2026-11-06 | 27 | +23 |");
    expect(md).toContain("| v2.5.2 | Agent | 2026-11-07 | 2 | new |");
    expect(md).toContain("Traffic was not collected on 2026-11-08: METRICS_TRAFFIC_TOKEN is not set");
    expect(md).not.toMatch(/Last 14 days \(GitHub\) \| 0/);
    expect(md.indexOf("v2.5.2")).toBeLessThan(md.indexOf("v2.5.1 |")); // newest first
  });
  test("a pipe or newline in GitHub-supplied text cannot break the table", () => {
    const now = snap("2026-11-08", [], { status: "ok", clones: { count: 3, uniques: 2 }, views: { count: 9, uniques: 4 }, referrers: [{ referrer: "evil|site\n| injected", count: 1, uniques: 1 }], paths: [] });
    const md = buildSummary(now, null, { v: 1, clones: {}, views: {} });
    const row = md.split("\n").find((l) => l.includes("evil"))!;
    expect(row.split("|").length).toBe(5);
  });
  test("no em dashes in anything the summary writes", () => {
    const md = buildSummary(snap("2026-11-08", [V251], { status: "not-collected", reason: "x" }), null, { v: 1, clones: { "2026-11-01": { count: 1, uniques: 1 } }, views: {} });
    expect(md.includes("\u2014")).toBe(false);
  });
});

// ---- collect against a fake GitHub ------------------------------------------------------------

function fakeGitHub(opts: { traffic: "ok" | 403 | 500; releases?: "ok" | 500; clones?: { timestamp: string; count: number; uniques: number }[] }) {
  const seen: { url: string; auth: string | null }[] = [];
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    seen.push({ url, auth: h.get("authorization") });
    const path = new URL(url).pathname;
    if (path.endsWith("/releases")) return opts.releases === 500 ? json({ message: "boom" }, 500)
      : json([{ tag_name: "v2.5.1", name: "v2.5.1", published_at: V251.publishedAt, prerelease: false, assets: Object.entries(V251.assets).map(([name, download_count]) => ({ name, download_count })) },
               { tag_name: "v9-draft", draft: true, assets: [{ name: "x.exe", download_count: 99 }] }]);
    if (path.includes("/traffic/")) {
      if (opts.traffic !== "ok") return json({ message: "Must have push access to repository" }, opts.traffic);
      if (path.endsWith("/clones")) return json({ count: 5, uniques: 3, clones: opts.clones ?? [{ timestamp: "2026-11-07T00:00:00Z", count: 5, uniques: 3 }] });
      if (path.endsWith("/views")) return json({ count: 40, uniques: 12, views: [{ timestamp: "2026-11-07T00:00:00Z", count: 40, uniques: 12 }] });
      if (path.endsWith("/referrers")) return json([{ referrer: "github.com", count: 30, uniques: 9 }]);
      if (path.endsWith("/paths")) return json([{ path: "/o/r", title: "o/r", count: 20, uniques: 8 }]);
    }
    return json({ message: "Not Found" }, 404);
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, seen };
}

describe("collect", () => {
  const SECRET = "github_pat_TESTSECRET_never_written";
  const withDir = (f: (dir: string) => Promise<void>) => async () => {
    const dir = mkdtempSync(join(tmpdir(), "repo-metrics-"));
    try { await f(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  const quiet = () => {};

  test("writes a snapshot, the series and the summary; drafts are skipped; the token goes only to traffic", withDir(async (dir) => {
    const gh = fakeGitHub({ traffic: "ok" });
    const code = await collect({ repo: "o/r", dir, today: "2026-11-08", trafficToken: SECRET, fetchImpl: gh.fetchImpl, log: quiet });
    expect(code).toBe(0);
    const snap = JSON.parse(readFileSync(join(dir, "snapshots", "2026-11-08.json"), "utf8")) as Snapshot;
    expect(snap.releases.map((r) => r.tag)).toEqual(["v2.5.1"]);
    expect(snap.traffic.status).toBe("ok");
    expect(JSON.parse(readFileSync(join(dir, "traffic-daily.json"), "utf8")).clones).toEqual({ "2026-11-07": { count: 5, uniques: 3 } });
    expect(readFileSync(join(dir, "SUMMARY.md"), "utf8")).toContain("| Last 14 days (GitHub) | 5 | 3 | 40 | 12 |");
    for (const s of gh.seen) expect(s.auth === `Bearer ${SECRET}`).toBe(s.url.includes("/traffic/"));
    for (const f of ["snapshots/2026-11-08.json", "traffic-daily.json", "SUMMARY.md"]) expect(readFileSync(join(dir, f), "utf8")).not.toContain("TESTSECRET");
  }));

  test("no traffic token: releases still recorded, traffic marked not collected, exit 0, no series file", withDir(async (dir) => {
    const code = await collect({ repo: "o/r", dir, today: "2026-11-08", fetchImpl: fakeGitHub({ traffic: "ok" }).fetchImpl, log: quiet });
    expect(code).toBe(0);
    const snap = JSON.parse(readFileSync(join(dir, "snapshots", "2026-11-08.json"), "utf8")) as Snapshot;
    expect(snap.traffic).toEqual({ status: "not-collected", reason: "METRICS_TRAFFIC_TOKEN is not set" });
    expect(existsSync(join(dir, "traffic-daily.json"))).toBe(false);
  }));

  test("a rejected traffic token exits 1, names the permission, and keeps the release snapshot", withDir(async (dir) => {
    const lines: string[] = [];
    const code = await collect({ repo: "o/r", dir, today: "2026-11-08", trafficToken: SECRET, fetchImpl: fakeGitHub({ traffic: 403 }).fetchImpl, log: (l) => lines.push(l) });
    expect(code).toBe(1);
    const snap = JSON.parse(readFileSync(join(dir, "snapshots", "2026-11-08.json"), "utf8")) as Snapshot;
    expect(snap.releases.length).toBe(1);
    expect(snap.traffic.status).toBe("not-collected");
    expect(lines.join("\n")).toContain("Administration: read");
    expect(lines.join("\n")).not.toContain("TESTSECRET");
  }));

  test("a failed release fetch writes nothing at all", withDir(async (dir) => {
    const code = await collect({ repo: "o/r", dir, today: "2026-11-08", trafficToken: SECRET, fetchImpl: fakeGitHub({ traffic: "ok", releases: 500 }).fetchImpl, log: quiet });
    expect(code).toBe(1);
    expect(existsSync(join(dir, "snapshots"))).toBe(false);
  }));

  test("history survives GitHub's 14-day window across runs", withDir(async (dir) => {
    await collect({ repo: "o/r", dir, today: "2026-11-01", trafficToken: SECRET, log: quiet,
      fetchImpl: fakeGitHub({ traffic: "ok", clones: [{ timestamp: "2026-10-20T00:00:00Z", count: 7, uniques: 4 }, { timestamp: "2026-11-01T00:00:00Z", count: 1, uniques: 1 }] }).fetchImpl });
    await collect({ repo: "o/r", dir, today: "2026-11-08", trafficToken: SECRET, log: quiet,
      fetchImpl: fakeGitHub({ traffic: "ok", clones: [{ timestamp: "2026-11-01T00:00:00Z", count: 3, uniques: 2 }, { timestamp: "2026-11-08T00:00:00Z", count: 2, uniques: 2 }] }).fetchImpl });
    const clones = JSON.parse(readFileSync(join(dir, "traffic-daily.json"), "utf8")).clones;
    expect(clones).toEqual({ "2026-10-20": { count: 7, uniques: 4 }, "2026-11-01": { count: 3, uniques: 2 }, "2026-11-08": { count: 2, uniques: 2 } });
    expect(readFileSync(join(dir, "SUMMARY.md"), "utf8")).toContain("Recorded since 2026-10-20: 12 clones");
  }));

  test("an unreadable series file is left untouched and the run exits 1", withDir(async (dir) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "traffic-daily.json"), "{corrupt");
    const code = await collect({ repo: "o/r", dir, today: "2026-11-08", trafficToken: SECRET, fetchImpl: fakeGitHub({ traffic: "ok" }).fetchImpl, log: quiet });
    expect(code).toBe(1);
    expect(readFileSync(join(dir, "traffic-daily.json"), "utf8")).toBe("{corrupt");
  }));

  test("a malformed --repo is refused before any request", withDir(async (dir) => {
    const gh = fakeGitHub({ traffic: "ok" });
    expect(await collect({ repo: "o/r/../../x", dir, fetchImpl: gh.fetchImpl, log: quiet })).toBe(1);
    expect(gh.seen.length).toBe(0);
  }));
});
