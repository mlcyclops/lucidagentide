// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// tools/metrics/repo_metrics.ts - P-METRICS.1 (ADR-0525): long-term download and clone tracking.
//
// GitHub keeps release asset download counts forever but only as one running total per file, and it
// keeps clone and view traffic for 14 days only. Anything older is gone. This collector runs once a
// day from .github/workflows/repo-metrics.yml and writes what GitHub knows today into a data
// directory (the `metrics` branch in CI):
//
//   snapshots/<YYYY-MM-DD>.json   every release's per-asset counts + the 14-day traffic window,
//                                 top referrers and top paths, exactly as GitHub reported them
//   traffic-daily.json            the per-day clone and view series, merged across runs so it keeps
//                                 growing past GitHub's 14-day horizon
//   SUMMARY.md                    the human view: per release, installers vs update checks, the
//                                 7-day change, and clones / views to date
//
//   bun run tools/metrics/repo_metrics.ts collect --repo owner/name --dir <data dir>
//   bun run tools/metrics/repo_metrics.ts summary --dir <data dir>
//
// Tokens come from the environment only: GITHUB_TOKEN reads releases (public data, optional),
// METRICS_TRAFFIC_TOKEN reads traffic (GitHub requires repository Administration: read for it, which
// the workflow's own GITHUB_TOKEN cannot be granted). A token is never written to a file or printed.
//
// Honesty rules, because these numbers drive decisions:
//   - missing data is recorded as missing, never as zero (no token, a 403, a failed call);
//   - a failed release fetch writes nothing at all, so an empty list can never read as "no downloads";
//   - counts are downloads, not people: the summary says so, and keeps update checks (the small
//     latest*.yml files installed apps poll) apart from installer downloads.

import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---- types --------------------------------------------------------------------------------------

export type AssetKind = "installer" | "update-check" | "update-delta";
export type Platform = "windows" | "mac" | "linux" | "other";

export interface CountPair { count: number; uniques: number }

export interface ReleaseSnap {
  tag: string;
  name: string;
  publishedAt: string | null;
  prerelease: boolean;
  /** asset file name -> GitHub's running download_count for it */
  assets: Record<string, number>;
}

export interface TrafficOk {
  status: "ok";
  clones: CountPair;
  views: CountPair;
  referrers: { referrer: string; count: number; uniques: number }[];
  paths: { path: string; title: string; count: number; uniques: number }[];
}
export interface TrafficMissing { status: "not-collected"; reason: string }
export type TrafficSnap = TrafficOk | TrafficMissing;

export interface Snapshot {
  v: 1;
  date: string;
  collectedAt: string;
  repo: string;
  releases: ReleaseSnap[];
  traffic: TrafficSnap;
}

export interface DailySeries {
  v: 1;
  clones: Record<string, CountPair>;
  views: Record<string, CountPair>;
}

export interface ReleaseRollup {
  tag: string;
  product: "Agent" | "Creator";
  publishedAt: string | null;
  prerelease: boolean;
  installers: number;
  byPlatform: Record<Platform, number>;
  updateChecks: number;
  updateDeltas: number;
}

// ---- pure: classification -----------------------------------------------------------------------

/** Which platform a release file is for. Mac and Linux are checked first because their update files
 *  (latest-mac.yml, latest-linux.yml) would otherwise match the plain Windows `latest.yml` rule. */
export function assetPlatform(name: string): Platform {
  const n = name.toLowerCase().replace(/\.blockmap$/, "");
  if (n.includes("mac") || n.endsWith(".pkg") || n.endsWith(".dmg")) return "mac";
  if (n.includes("linux") || n.endsWith(".appimage") || n.endsWith(".deb") || n.endsWith(".rpm") || n.endsWith(".snap")) return "linux";
  if (n.endsWith(".exe") || n.endsWith(".msi") || n.endsWith(".appx") || n.endsWith(".msix") || n === "latest.yml") return "windows";
  return "other";
}

/** An update check is a read of the small file electron-updater polls; an update delta is a
 *  differential-update block map; everything else is a file a person (or an updater) installs from. */
export function assetKind(name: string): AssetKind {
  const n = name.toLowerCase();
  if (n.endsWith(".yml") || n.endsWith(".yaml")) return "update-check";
  if (n.endsWith(".blockmap")) return "update-delta";
  return "installer";
}

export function productOf(tag: string): "Agent" | "Creator" {
  return tag.toLowerCase().startsWith("creator-") ? "Creator" : "Agent";
}

export function rollupRelease(r: ReleaseSnap): ReleaseRollup {
  const out: ReleaseRollup = {
    tag: r.tag,
    product: productOf(r.tag),
    publishedAt: r.publishedAt,
    prerelease: r.prerelease,
    installers: 0,
    byPlatform: { windows: 0, mac: 0, linux: 0, other: 0 },
    updateChecks: 0,
    updateDeltas: 0,
  };
  for (const [name, raw] of Object.entries(r.assets)) {
    const n = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
    const kind = assetKind(name);
    if (kind === "update-check") out.updateChecks += n;
    else if (kind === "update-delta") out.updateDeltas += n;
    else { out.installers += n; out.byPlatform[assetPlatform(name)] += n; }
  }
  return out;
}

// ---- pure: the daily series ---------------------------------------------------------------------

export const EMPTY_SERIES: DailySeries = { v: 1, clones: {}, views: {} };

/** Parse a persisted series; anything off-shape starts over EMPTY rather than throwing, but the
 *  caller is told (`ok: false`) so CI can refuse to overwrite a file it could not read. */
export function parseSeries(raw: string | null): { series: DailySeries; ok: boolean } {
  if (raw === null) return { series: structuredClone(EMPTY_SERIES), ok: true };
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object" || (v as { v?: unknown }).v !== 1) return { series: structuredClone(EMPTY_SERIES), ok: false };
    const src = v as Record<string, unknown>;
    const out = structuredClone(EMPTY_SERIES);
    for (const key of ["clones", "views"] as const) {
      const m = src[key];
      if (!m || typeof m !== "object") continue;
      for (const [day, p] of Object.entries(m as Record<string, unknown>)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !p || typeof p !== "object") continue;
        const { count, uniques } = p as Record<string, unknown>;
        if (typeof count === "number" && typeof uniques === "number") out[key][day] = { count, uniques };
      }
    }
    return { series: out, ok: true };
  } catch { return { series: structuredClone(EMPTY_SERIES), ok: false }; }
}

/** Merge one fetch of GitHub's per-day window into the series. A day GitHub still reports is taken
 *  from the newer fetch (today's partial count grows; GitHub may revise recent days); a day that has
 *  left GitHub's window keeps the last value we saw. Days come back sorted. */
export function mergeDays(prev: Record<string, CountPair>, fetched: { timestamp: string; count: number; uniques: number }[]): Record<string, CountPair> {
  const next: Record<string, CountPair> = { ...prev };
  for (const d of fetched) {
    const day = typeof d.timestamp === "string" ? d.timestamp.slice(0, 10) : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    if (!Number.isFinite(d.count) || !Number.isFinite(d.uniques)) continue;
    next[day] = { count: d.count, uniques: d.uniques };
  }
  return Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
}

// ---- pure: the summary --------------------------------------------------------------------------

/** The newest snapshot date at least `days` before `today`, for the "change since" column. */
export function baselineDate(dates: string[], today: string, days = 7): string | null {
  const cutoff = new Date(`${today}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  const limit = cutoff.toISOString().slice(0, 10);
  const older = dates.filter((d) => d <= limit).sort();
  return older.length ? older[older.length - 1]! : null;
}

const fmt = (n: number): string => n.toLocaleString("en-US");
const delta = (now: number, then: number | undefined): string => (then === undefined ? "new" : now - then >= 0 ? `+${fmt(now - then)}` : fmt(now - then));
// Table cells come from GitHub (tags, referrer hosts, page titles). Strip what would break a row.
const cell = (s: string): string => s.replace(/[|\r\n`]/g, " ").slice(0, 80);

export function buildSummary(latest: Snapshot, baseline: Snapshot | null, series: DailySeries, maxReleases = 15): string {
  const lines: string[] = [];
  lines.push(`# ${cell(latest.repo)} usage metrics`, "");
  lines.push(`Last collected ${latest.collectedAt} by the repo-metrics workflow (P-METRICS.1, ADR-0525).`, "");
  lines.push("All counts are downloads, not people. GitHub does not record who downloaded a file, so one person can count many times.", "");

  // Releases
  const base = new Map<string, ReleaseRollup>((baseline?.releases ?? []).map((r) => [r.tag, rollupRelease(r)]));
  const rows = latest.releases
    .slice()
    .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))
    .slice(0, maxReleases)
    .map(rollupRelease);
  lines.push("## Release downloads", "");
  lines.push(baseline
    ? `Change is measured against the ${baseline.date} snapshot.`
    : "Change appears once a snapshot at least 7 days old exists.");
  lines.push("");
  lines.push("| Release | Product | Published | Installers | Change | Windows | Mac | Linux | Update checks |");
  lines.push("| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const r of rows) {
    const pre = r.prerelease ? " (pre)" : "";
    const then = base.get(r.tag);
    lines.push(`| ${cell(r.tag)}${pre} | ${r.product} | ${(r.publishedAt ?? "?").slice(0, 10)} | ${fmt(r.installers)} | ${baseline ? delta(r.installers, then?.installers) : "-"} | ${fmt(r.byPlatform.windows)} | ${fmt(r.byPlatform.mac)} | ${fmt(r.byPlatform.linux)} | ${fmt(r.updateChecks)} |`);
  }
  if (latest.releases.length > rows.length) lines.push("", `${latest.releases.length - rows.length} older releases are in the snapshot files.`);
  lines.push("");
  lines.push("Installers include every file someone can install from, so a Windows app that updates itself adds to Setup.exe. Update checks count reads of the latest*.yml files that installed apps poll.", "");

  // Traffic
  lines.push("## Clones and views", "");
  if (latest.traffic.status === "ok") {
    const t = latest.traffic;
    lines.push("| Window | Clones | Unique cloners | Views | Unique visitors |");
    lines.push("| --- | ---: | ---: | ---: | ---: |");
    lines.push(`| Last 14 days (GitHub) | ${fmt(t.clones.count)} | ${fmt(t.clones.uniques)} | ${fmt(t.views.count)} | ${fmt(t.views.uniques)} |`);
  } else {
    lines.push(`Traffic was not collected on ${latest.date}: ${cell(latest.traffic.reason)}`);
  }
  lines.push("");
  const cloneDays = Object.keys(series.clones);
  if (cloneDays.length) {
    const total = Object.values(series.clones).reduce((s, p) => s + p.count, 0);
    const views = Object.values(series.views).reduce((s, p) => s + p.count, 0);
    lines.push(`Recorded since ${cloneDays[0]}: ${fmt(total)} clones and ${fmt(views)} views across ${cloneDays.length} days with clone activity.`);
    lines.push("Unique cloners are only meaningful per day or per 14-day window. GitHub counts them per window, so they cannot be added up across days.", "");
  } else {
    lines.push("No daily clone history yet.", "");
  }

  if (latest.traffic.status === "ok" && latest.traffic.referrers.length) {
    lines.push("## Top referrers, last 14 days", "");
    lines.push("| Referrer | Views | Unique visitors |", "| --- | ---: | ---: |");
    for (const r of latest.traffic.referrers.slice(0, 10)) lines.push(`| ${cell(r.referrer)} | ${fmt(r.count)} | ${fmt(r.uniques)} |`);
    lines.push("");
  }
  return lines.join("\n");
}

// ---- I/O: GitHub -------------------------------------------------------------------------------

export class GitHubError extends Error {
  constructor(readonly status: number, readonly path: string) {
    // Status and path only: a response body or a header could echo the token back.
    super(`GitHub ${path} answered ${status}`);
  }
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

async function ghGet(apiBase: string, path: string, token: string | undefined, fetchImpl: Fetch): Promise<unknown> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "lucid-repo-metrics",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  let res: Response;
  try { res = await fetchImpl(`${apiBase}${path}`, { headers, signal: AbortSignal.timeout(20_000) }); }
  catch { throw new GitHubError(0, path); }
  if (!res.ok) throw new GitHubError(res.status, path);
  return res.json();
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export async function fetchReleases(apiBase: string, repo: string, token: string | undefined, fetchImpl: Fetch = fetch): Promise<ReleaseSnap[]> {
  const out: ReleaseSnap[] = [];
  for (let page = 1; page <= 20; page++) {
    const batch = arr(await ghGet(apiBase, `/repos/${repo}/releases?per_page=100&page=${page}`, token, fetchImpl));
    for (const raw of batch) {
      const r = rec(raw);
      if (r.draft === true) continue;
      const assets: Record<string, number> = {};
      for (const a of arr(r.assets)) { const x = rec(a); if (str(x.name)) assets[str(x.name)] = num(x.download_count); }
      out.push({ tag: str(r.tag_name), name: str(r.name), publishedAt: str(r.published_at) || null, prerelease: r.prerelease === true, assets });
    }
    if (batch.length < 100) break;
  }
  return out;
}

export interface TrafficFetch { snap: TrafficSnap; clonesDaily: { timestamp: string; count: number; uniques: number }[]; viewsDaily: { timestamp: string; count: number; uniques: number }[] }

export async function fetchTraffic(apiBase: string, repo: string, token: string | undefined, fetchImpl: Fetch = fetch): Promise<TrafficFetch> {
  if (!token) return { snap: { status: "not-collected", reason: "METRICS_TRAFFIC_TOKEN is not set" }, clonesDaily: [], viewsDaily: [] };
  const daily = (v: unknown, key: string) => arr(rec(v)[key]).map(rec).map((d) => ({ timestamp: str(d.timestamp), count: num(d.count), uniques: num(d.uniques) }));
  const [clones, views, referrers, paths] = await Promise.all([
    ghGet(apiBase, `/repos/${repo}/traffic/clones?per=day`, token, fetchImpl),
    ghGet(apiBase, `/repos/${repo}/traffic/views?per=day`, token, fetchImpl),
    ghGet(apiBase, `/repos/${repo}/traffic/popular/referrers`, token, fetchImpl),
    ghGet(apiBase, `/repos/${repo}/traffic/popular/paths`, token, fetchImpl),
  ]);
  return {
    snap: {
      status: "ok",
      clones: { count: num(rec(clones).count), uniques: num(rec(clones).uniques) },
      views: { count: num(rec(views).count), uniques: num(rec(views).uniques) },
      referrers: arr(referrers).map(rec).map((r) => ({ referrer: str(r.referrer), count: num(r.count), uniques: num(r.uniques) })),
      paths: arr(paths).map(rec).map((p) => ({ path: str(p.path), title: str(p.title), count: num(p.count), uniques: num(p.uniques) })),
    },
    clonesDaily: daily(clones, "clones"),
    viewsDaily: daily(views, "views"),
  };
}

// ---- I/O: the data directory -------------------------------------------------------------------

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

function readOrNull(path: string): string | null {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

export function snapshotDates(dir: string): string[] {
  try { return readdirSync(join(dir, "snapshots")).map((f) => /^(\d{4}-\d{2}-\d{2})\.json$/.exec(f)?.[1]).filter((d): d is string => !!d).sort(); }
  catch { return []; }
}

function readSnapshot(dir: string, date: string): Snapshot | null {
  const raw = readOrNull(join(dir, "snapshots", `${date}.json`));
  if (!raw) return null;
  try { const s = JSON.parse(raw) as Snapshot; return s && s.v === 1 && Array.isArray(s.releases) ? s : null; } catch { return null; }
}

export function writeSummary(dir: string, today?: string): string | null {
  const dates = snapshotDates(dir);
  const latestDate = today && dates.includes(today) ? today : dates[dates.length - 1];
  if (!latestDate) return null;
  const latest = readSnapshot(dir, latestDate);
  if (!latest) return null;
  const bd = baselineDate(dates, latestDate);
  const baseline = bd ? readSnapshot(dir, bd) : null;
  const { series } = parseSeries(readOrNull(join(dir, "traffic-daily.json")));
  const md = buildSummary(latest, baseline, series);
  writeAtomic(join(dir, "SUMMARY.md"), md + "\n");
  return md;
}

export interface CollectOptions {
  repo: string;
  dir: string;
  apiBase?: string;
  today?: string;
  releasesToken?: string;
  trafficToken?: string;
  fetchImpl?: Fetch;
  log?: (line: string) => void;
}

/** Returns the process exit code: 0 everything collected, 1 something failed (what could be saved
 *  was saved, and the failure is recorded in the snapshot, never papered over with zeros). */
export async function collect(o: CollectOptions): Promise<number> {
  const log = o.log ?? ((l: string) => console.log(l));
  const apiBase = (o.apiBase ?? "https://api.github.com").replace(/\/$/, "");
  const fetchImpl = o.fetchImpl ?? fetch;
  const now = new Date();
  const date = o.today ?? now.toISOString().slice(0, 10);
  if (!/^[\w.-]+\/[\w.-]+$/.test(o.repo)) { log(`::error::--repo must be owner/name, got ${JSON.stringify(o.repo)}`); return 1; }

  let releases: ReleaseSnap[];
  try { releases = await fetchReleases(apiBase, o.repo, o.releasesToken, fetchImpl); }
  catch (e) {
    // Nothing is written: an empty release list in a snapshot would read as "nobody downloaded anything".
    log(`::error::release counts not collected: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  let failed = false;
  let traffic: TrafficFetch;
  try { traffic = await fetchTraffic(apiBase, o.repo, o.trafficToken, fetchImpl); }
  catch (e) {
    const why = e instanceof GitHubError && (e.status === 401 || e.status === 403)
      ? `${e.message}; METRICS_TRAFFIC_TOKEN needs repository Administration: read on ${o.repo}`
      : e instanceof Error ? e.message : String(e);
    traffic = { snap: { status: "not-collected", reason: why }, clonesDaily: [], viewsDaily: [] };
    log(`::error::traffic not collected: ${why}`);
    failed = true;
  }
  if (traffic.snap.status === "not-collected" && !failed) log(`::warning::traffic not collected: ${traffic.snap.reason}`);

  mkdirSync(join(o.dir, "snapshots"), { recursive: true });
  const snap: Snapshot = { v: 1, date, collectedAt: now.toISOString(), repo: o.repo, releases, traffic: traffic.snap };
  writeAtomic(join(o.dir, "snapshots", `${date}.json`), JSON.stringify(snap, null, 2) + "\n");

  const seriesPath = join(o.dir, "traffic-daily.json");
  const parsed = parseSeries(readOrNull(seriesPath));
  if (!parsed.ok) {
    // Refuse to replace history we could not read: a corrupt file is a human's call, not ours.
    log(`::error::${seriesPath} is unreadable; left untouched (fix or remove it by hand)`);
    failed = true;
  } else if (traffic.snap.status === "ok") {
    const series: DailySeries = { v: 1, clones: mergeDays(parsed.series.clones, traffic.clonesDaily), views: mergeDays(parsed.series.views, traffic.viewsDaily) };
    writeAtomic(seriesPath, JSON.stringify(series, null, 2) + "\n");
  }

  writeSummary(o.dir, date);
  const r = releases.map(rollupRelease);
  log(`collected ${date}: ${r.length} releases, ${r.reduce((s, x) => s + x.installers, 0)} installer downloads in total, traffic ${traffic.snap.status}`);
  return failed ? 1 : 0;
}

// ---- CLI ---------------------------------------------------------------------------------------

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function main(argv: string[], env: Record<string, string | undefined>): Promise<number> {
  const [cmd] = argv;
  const dir = flag(argv, "--dir");
  if (!dir || (cmd !== "collect" && cmd !== "summary")) {
    console.error("usage: repo_metrics.ts collect --repo owner/name --dir <data dir> [--api-base URL] [--today YYYY-MM-DD]\n       repo_metrics.ts summary --dir <data dir>");
    return 2;
  }
  if (cmd === "summary") { const md = writeSummary(dir); if (md === null) { console.error("no snapshots in " + dir); return 1; } console.log(md); return 0; }
  const repo = flag(argv, "--repo");
  if (!repo) { console.error("collect needs --repo owner/name"); return 2; }
  return collect({
    repo,
    dir,
    apiBase: flag(argv, "--api-base"),
    today: flag(argv, "--today"),
    releasesToken: env.GITHUB_TOKEN || undefined,
    trafficToken: env.METRICS_TRAFFIC_TOKEN || undefined,
  });
}

if (import.meta.main) process.exit(await main(process.argv.slice(2), process.env));
