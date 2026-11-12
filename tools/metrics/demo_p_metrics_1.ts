// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// tools/metrics/demo_p_metrics_1.ts - `make demo-P-METRICS.1` (ADR-0561).
//
// Runs the REAL collector CLI as a subprocess, with tokens in its environment exactly as the
// workflow passes them, against a local HTTP server that answers like api.github.com. Proves:
//   1. two runs a week apart keep clone history GitHub has already dropped, and the summary shows
//      the 7-day change per release;
//   2. without METRICS_TRAFFIC_TOKEN, releases are still recorded and traffic says "not collected";
//   3. a rejected traffic token exits 1, names the missing permission, keeps the release snapshot;
//   4. a failed release fetch writes nothing;
//   5. no token value appears in any written file or in the CLI output.

import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "repo_metrics.ts");
const RELEASES_TOKEN = "ghs_DEMO_RELEASES_TOKEN_x1";
const TRAFFIC_TOKEN = "github_pat_DEMO_TRAFFIC_TOKEN_x2";

let week = 1;
let trafficMode: "ok" | 403 = "ok";
let releasesMode: "ok" | 500 = "ok";
const authSeen: { path: string; auth: string | null }[] = [];

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    authSeen.push({ path: url.pathname, auth: req.headers.get("authorization") });
    const j = (b: unknown, status = 200) => Response.json(b, { status });
    if (url.pathname === "/repos/demo/lucid/releases") {
      if (releasesMode === 500) return j({ message: "Server Error" }, 500);
      const setup = week === 1 ? 4 : 14;
      return j([
        ...(week === 2 ? [{ tag_name: "v2.5.2", name: "v2.5.2", published_at: "2026-11-07T21:35:01Z", prerelease: false, assets: [{ name: "LucidAgent-Setup.exe", download_count: 2 }, { name: "latest.yml", download_count: 7 }] }] : []),
        { tag_name: "v2.5.1", name: "v2.5.1", published_at: "2026-11-06T02:57:57Z", prerelease: false,
          assets: [{ name: "LucidAgent-Setup.exe", download_count: setup }, { name: "lucidagentide-desktop_2.5.1_amd64.deb", download_count: 2 }, { name: "LucidAgent-mac-arm64.pkg", download_count: 1 }, { name: "latest.yml", download_count: 16 }, { name: "LucidAgent-Setup.exe.blockmap", download_count: 8 }] },
      ]);
    }
    if (url.pathname.startsWith("/repos/demo/lucid/traffic/")) {
      if (trafficMode !== "ok") return j({ message: "Must have push access to repository" }, trafficMode);
      const days = week === 1
        ? [{ timestamp: "2026-10-20T00:00:00Z", count: 7, uniques: 4 }, { timestamp: "2026-11-01T00:00:00Z", count: 1, uniques: 1 }]
        : [{ timestamp: "2026-11-01T00:00:00Z", count: 3, uniques: 2 }, { timestamp: "2026-11-08T00:00:00Z", count: 2, uniques: 2 }];
      if (url.pathname.endsWith("/clones")) return j({ count: days.reduce((s, d) => s + d.count, 0), uniques: 5, clones: days });
      if (url.pathname.endsWith("/views")) return j({ count: 40, uniques: 12, views: [{ timestamp: "2026-11-01T00:00:00Z", count: 40, uniques: 12 }] });
      if (url.pathname.endsWith("/referrers")) return j([{ referrer: "github.com", count: 30, uniques: 9 }]);
      if (url.pathname.endsWith("/paths")) return j([]);
    }
    return j({ message: "Not Found" }, 404);
  },
});
const apiBase = `http://127.0.0.1:${server.port}`;

let failures = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failures++; };

async function run(dir: string, today: string, env: Record<string, string>) {
  const p = Bun.spawn(["bun", "run", SCRIPT, "collect", "--repo", "demo/lucid", "--dir", dir, "--api-base", apiBase, "--today", today], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env }, stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, text: out + err };
}

function allFiles(dir: string): string {
  if (!existsSync(dir)) return "";
  return readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith(".json") || f.endsWith(".md"))
    .map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
}
const leaks = (s: string) => s.includes("DEMO_RELEASES_TOKEN") || s.includes("DEMO_TRAFFIC_TOKEN");

const tmp = mkdtempSync(join(tmpdir(), "demo-p-metrics-"));
try {
  // 1. two runs a week apart
  const dir = join(tmp, "data");
  const both = { GITHUB_TOKEN: RELEASES_TOKEN, METRICS_TRAFFIC_TOKEN: TRAFFIC_TOKEN };
  const r1 = await run(dir, "2026-11-01", both);
  week = 2;
  const r2 = await run(dir, "2026-11-08", both);
  check(r1.code === 0 && r2.code === 0, "two scheduled runs a week apart both exit 0");
  const series = JSON.parse(readFileSync(join(dir, "traffic-daily.json"), "utf8"));
  check(JSON.stringify(Object.keys(series.clones)) === JSON.stringify(["2026-10-20", "2026-11-01", "2026-11-08"]), "clone history keeps 2026-10-20 after GitHub's window dropped it");
  check(series.clones["2026-11-01"].count === 3, "a day GitHub still reports takes the newer count (1 -> 3)");
  const md = readFileSync(join(dir, "SUMMARY.md"), "utf8");
  check(md.includes("| v2.5.1 | Agent | 2026-11-06 | 17 | +10 |"), "summary shows v2.5.1 at 17 installer downloads, +10 since the 2026-11-01 snapshot");
  check(md.includes("| v2.5.2 | Agent | 2026-11-07 | 2 | new |"), "a release published after the baseline reads as new");
  check(md.includes("Recorded since 2026-10-20: 12 clones"), "summary totals the recorded clone history");
  check(/\| v2\.5\.1 [^\n]*\| 16 \|$/m.test(md), "update checks (latest.yml) are reported apart from installers");
  const relCalls = authSeen.filter((a) => a.path.endsWith("/releases"));
  const trafCalls = authSeen.filter((a) => a.path.includes("/traffic/"));
  check(relCalls.every((a) => a.auth === `Bearer ${RELEASES_TOKEN}`) && trafCalls.every((a) => a.auth === `Bearer ${TRAFFIC_TOKEN}`), "each token is sent only to the endpoints it is for");

  // 2. no traffic token
  const dir2 = join(tmp, "no-traffic");
  const r3 = await run(dir2, "2026-11-08", { GITHUB_TOKEN: RELEASES_TOKEN });
  const s3 = JSON.parse(readFileSync(join(dir2, "snapshots", "2026-11-08.json"), "utf8"));
  check(r3.code === 0 && s3.releases.length === 2 && s3.traffic.status === "not-collected", "without METRICS_TRAFFIC_TOKEN releases are recorded and traffic says not collected");
  check(!existsSync(join(dir2, "traffic-daily.json")) && readFileSync(join(dir2, "SUMMARY.md"), "utf8").includes("Traffic was not collected"), "no zeros are invented for traffic that was never read");

  // 3. rejected traffic token
  trafficMode = 403;
  const dir3 = join(tmp, "rejected");
  const r4 = await run(dir3, "2026-11-08", both);
  const s4 = JSON.parse(readFileSync(join(dir3, "snapshots", "2026-11-08.json"), "utf8"));
  check(r4.code === 1 && r4.text.includes("Administration: read") && s4.releases.length === 2, "a 403 on traffic exits 1, names the permission, keeps the release snapshot");
  trafficMode = "ok";

  // 4. release fetch fails
  releasesMode = 500;
  const dir4 = join(tmp, "release-fail");
  const r5 = await run(dir4, "2026-11-08", both);
  check(r5.code === 1 && !existsSync(join(dir4, "snapshots")), "a failed release fetch exits 1 and writes nothing");
  releasesMode = "ok";

  // 5. no leaks anywhere
  const outputs = [r1, r2, r3, r4, r5].map((r) => r.text).join("\n");
  check(!leaks(outputs) && !leaks(allFiles(dir)) && !leaks(allFiles(dir2)) && !leaks(allFiles(dir3)), "no token value in CLI output or any written file");
} finally {
  server.stop(true);
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failures ? `\ndemo-P-METRICS.1: ${failures} check(s) FAILED` : "\ndemo-P-METRICS.1: all checks passed");
process.exit(failures ? 1 : 0);
