// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIncident, issueUrl, redact, type IncidentInput } from "./incident_report.ts";
import { INCIDENT_KEEP, incidentDir, incidentReport, listIncidents, markIncidentSeen, readIncident, recordIncident, updateIncident } from "./incident_store.ts";

const HOME = "C:\\Users\\alice";
const base = (over: Partial<IncidentInput> = {}): IncidentInput => ({
  kind: "unclean-shutdown",
  outcome: "pending",
  product: "LucidAgent",
  version: "2.3.0-beta.8",
  platform: "win32",
  arch: "x64",
  summary: `The previous run exited without a clean shutdown. Workspace ${HOME}\\repo.`,
  events: [{ at: 1_790_000_000_000, what: "Found engine 4242 from the previous run" }],
  home: HOME,
  ...over,
});

const dirs: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "lucid-incident-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

test("redact burns credentials, e-mail, long hex and the home folder, in every path spelling", () => {
  const raw = [
    "Authorization: Bearer abcdefghijklmnop",
    "key sk-ant-api03-SECRETSECRET",
    "ghp_ABCDEFGHIJKLMNOPQRSTUV",
    '{"refresh_token":"r1r2r3r4r5r6r7r8"}',
    "author enrique@example.com",
    `nonce ${"a".repeat(64)}`,
    `${HOME}\\.omp\\logs`,
    "C:/Users/alice/.omp",
    "C:\\\\Users\\\\alice\\\\.omp",
  ].join("\n");
  const out = redact(raw, HOME);
  for (const leak of ["abcdefghijklmnop", "SECRETSECRET", "ABCDEFGHIJKLMNOPQRSTUV", "r1r2r3r4r5r6r7r8", "enrique@example.com", "a".repeat(64), "alice"]) {
    expect(out).not.toContain(leak);
  }
  expect(out).toContain("Bearer <redacted>");
  expect(out).toContain("~\\.omp\\logs");
  expect(redact(out, HOME)).toBe(out); // idempotent: rebuilding a stored report changes nothing
  // A profile path outside the given home (another account, or no home passed) still loses the name.
  const other = redact("C:\\Users\\bob\\.omp\\logs and C:/Users/bob/x and /home/carol/.omp and /Users/dave/a");
  for (const name of ["bob", "carol", "dave"]) expect(other).not.toContain(name);
  expect(other).toContain("C:\\Users\\<user>\\.omp\\logs");
});

test("the public issue body carries the summary but never log text; the local report carries both", () => {
  const inc = buildIncident(base({ logs: [{ name: "engine.log", text: "LOGLINE-ONLY-IN-REPORT token=zzzzzzzzzz" }] }), 1_790_000_000_000, () => 0.5);
  expect(inc.issueBody).toContain("Found engine 4242");
  expect(inc.issueBody).not.toContain("LOGLINE-ONLY-IN-REPORT");
  expect(inc.markdown).toContain("LOGLINE-ONLY-IN-REPORT");
  expect(inc.markdown).not.toContain("zzzzzzzzzz");
  expect(inc.markdown).not.toContain("alice");
  const url = new URL(issueUrl(inc));
  expect(url.protocol).toBe("https:");
  expect(url.host).toBe("github.com");
  expect(url.searchParams.get("body")).toBe(inc.issueBody);
});

test("log tails are clipped to the newest text", () => {
  const inc = buildIncident(base({ logs: [{ name: "engine.log", text: `OLDEST${"x".repeat(20_000)}NEWEST` }] }));
  expect(inc.markdown).toContain("NEWEST");
  expect(inc.markdown).not.toContain("OLDEST");
});

test("an incident is written redacted, listed unseen, then settled under the same id", () => {
  const dir = scratch();
  const meta = recordIncident(base({ logs: [{ name: "omp.log", text: "Bearer qqqqqqqqqqqq" }] }), dir, 1_790_000_000_000)!;
  expect(meta.seen).toBe(false);
  expect(readFileSync(join(dir, `${meta.id}.json`), "utf8")).not.toContain("qqqqqqqqqqqq"); // raw tail never hits disk
  expect(listIncidents(dir).map((m) => m.id)).toEqual([meta.id]);

  expect(markIncidentSeen(meta.id, dir)).toBe(true);
  const settled = updateIncident(meta.id, { outcome: "recovered", events: [{ at: 1_790_000_060_000, what: "Session resumed" }] }, dir)!;
  expect(settled.id).toBe(meta.id);
  expect(settled.seen).toBe(true);
  expect(settled.outcome).toBe("recovered");
  const report = readFileSync(settled.reportPath, "utf8");
  expect(report).toContain(`Incident: ${meta.id}`);
  expect(report).toContain("Session resumed");
  expect(report).toContain("Recovered automatically");
});

test("the home folder is used for redaction and never written to disk", () => {
  const dir = scratch();
  const meta = recordIncident(base({ logs: [{ name: "engine.log", text: `opened ${HOME}\\.omp\\agent.db` }] }), dir)!;
  for (const file of readdirSync(dir)) {
    const text = readFileSync(join(dir, file), "utf8");
    expect(text).not.toContain("alice");
    expect(text).not.toContain(HOME);
  }
  expect(JSON.parse(readFileSync(join(dir, `${meta.id}.json`), "utf8")).input.home).toBeUndefined();
});

test("AskSage developer diagnostics never reach a report or the disk, whole or split", () => {
  const log = [
    "engine up",
    `[ASKSAGE_DIAG] {"route":"anthropic","ok":true,"anomaly":"empty-response","raw":"{\\"content\\":\\"MODEL-SAID-THIS\\"}"}`,
    // the tail of a record whose line another child's stderr interleaved into
    `x","anomaly":"truncated","raw":"{\\"text\\":\\"SPLIT-MODEL-TEXT\\"}"}`,
    "agent process exited (code 1)",
  ].join("\n");
  const inc = buildIncident(base({ logs: [{ name: "lucid-acp.log", text: log }] }));
  expect(inc.markdown).toContain("engine up");
  expect(inc.markdown).toContain("agent process exited (code 1)");
  for (const leak of ["MODEL-SAID-THIS", "SPLIT-MODEL-TEXT", "ASKSAGE_DIAG"]) expect(inc.markdown).not.toContain(leak);
  const dir = scratch();
  recordIncident(base({ logs: [{ name: "lucid-acp.log", text: log }] }), dir);
  for (const file of readdirSync(dir)) expect(readFileSync(join(dir, file), "utf8")).not.toContain("MODEL-SAID-THIS");
});

test("a record edited on disk cannot change the public issue, the report, or the report path", () => {
  const dir = scratch();
  const meta = recordIncident(base(), dir)!;
  const file = join(dir, `${meta.id}.json`);
  const rec = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({
    ...rec,
    issueTitle: "INJECTED-TITLE",
    issueBody: "INJECTED-BODY",
    reportPath: "C:/Windows/System32/config/SAM",
    input: { ...rec.input, summary: "Bearer abcdefghijklmnopqrstuvwx and sk-ant-SECRETSECRETSECRET" },
  }));
  const [shown] = listIncidents(dir);
  expect(shown!.id).toBe(meta.id);
  expect(shown!.reportPath).toBe(join(dir, `${meta.id}.md`));
  for (const text of [shown!.issueTitle, shown!.issueBody, issueUrl(shown!), incidentReport(meta.id, dir)!]) {
    for (const leak of ["INJECTED", "abcdefghijklmnopqrstuvwx", "SECRETSECRETSECRET"]) expect(text).not.toContain(leak);
  }
  // A record that does not validate is not an incident at all.
  for (const bad of [{ ...rec, input: { ...rec.input, kind: "made-up" } }, { ...rec, input: { ...rec.input, summary: "x".repeat(10_000) } }, { ...rec, v: 2 }, { ...rec, id: "20260101T000000Z-zzzz" }]) {
    writeFileSync(file, JSON.stringify(bad));
    expect(listIncidents(dir)).toEqual([]);
    expect(readIncident(meta.id, dir)).toBeNull();
    expect(incidentReport(meta.id, dir)).toBeNull();
  }
});

test("incidents are kept only under a data root outside the agent-writable ~/.omp", () => {
  const home = join(tmpdir(), "lucid-home");
  const data = join(home, "AppData", "Roaming", "lucidagentide-desktop");
  expect(incidentDir(data, home)).toBe(join(data, "incidents"));
  expect(incidentDir(join(home, ".omp-other"), home)).toBe(join(home, ".omp-other", "incidents"));
  for (const refused of [undefined, "", "relative/data", join(home, ".omp"), join(home, ".omp", "userdata")]) {
    expect(incidentDir(refused, home)).toBeNull();
  }
  expect(recordIncident(base(), null)).toBeNull();
  expect(listIncidents(null)).toEqual([]);
});

test("ids from the window cannot address files outside the incident folder", () => {
  const dir = scratch();
  expect(readIncident("../../agent/agent", dir)).toBeNull();
  expect(markIncidentSeen("..\\x", dir)).toBe(false);
});

test("only the newest incidents are kept", () => {
  const dir = scratch();
  for (let n = 0; n < INCIDENT_KEEP + 3; n++) recordIncident(base(), dir, 1_790_000_000_000 + n * 1000);
  expect(listIncidents(dir)).toHaveLength(INCIDENT_KEEP);
  expect(readdirSync(dir).filter((f) => f.endsWith(".md"))).toHaveLength(INCIDENT_KEEP);
});
