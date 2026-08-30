// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/build/release-identity-gate.ts - P-RELEASE.4 (ADR-0307): the release-identity gate.
//
// On 2026-08-30 a user reported that "v1.14.1 installed the Tactical GenAI Trainer instead of LUCID".
// The release turned out to be genuine, but PROVING that took a full session of hand-parsing xar
// headers, ar members and rpm leads, because nothing in CI had ever looked INSIDE an artifact. Every
// check we owned was a filename check, and a filename is exactly the thing a mixed-up build renames
// correctly while the bytes underneath belong to something else.
//
// This gate makes flavor identity a machine-checked PRECONDITION of every upload. For each file in the
// electron-builder output dir it reads the EMBEDDED identity - the .pkg's bundle id, payload .app path
// and version out of Distribution+PackageInfo, the .deb package name and version out of the ar
// archive's control member, the .rpm name out of the lead, the updater feed's declared version and
// artifact path - and compares it against the flavor being built. Only the formats that genuinely carry
// nothing readable (.zip, NSIS/portable .exe, .AppImage) fall back to a filename-stem check.
//
// FAIL-CLOSED, three ways, because every failure mode here is a silent-pass shape:
//   1. A missing or EMPTY release dir is a FAILURE. A gate that reports green over zero inputs is the
//      ADR-0303 lesson: it proves nothing while looking exactly like proof.
//   2. An artifact whose kind says we CAN read its identity, but which we cannot parse, is a FAILURE.
//      Never a skip - from out here, "unparseable" and "wrong" are indistinguishable.
//   3. An unrecognized file in the dir is a FAILURE (release_identity's `unknown` kind), because a
//      stray artifact inside an upload set is the exact shape of the bug being guarded.
// The full report prints on success as well as failure, so a CI log always carries the evidence the
// v1.14.1 forensics had to reconstruct by hand.
//
// Splits the way its neighbours do: the byte and text decisions below (xar TOC walk, tar member pull,
// member inflate, feed field pull) are pure functions over buffers and strings; all IO is the range
// reads and the one readdir. The comparison itself lives in release_identity.ts and is not re-litigated
// here - this file's job is to hand that pure core an honest ArtifactIdentity per file.
//
// Run with: bun run build/release-identity-gate.ts --flavor agent|creator   (cwd = desktop/)
// Env: LUCID_RELEASE_DIR=<name>  bare output-dir NAME under desktop/ (default release / release-creator)

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, inflateSync } from "node:zlib";
import { type BuildFlavor, flavorInfo } from "../build_flavor.ts";
import {
  type ArtifactIdentity,
  type ArtifactKind,
  type FlavorExpectation,
  type IdentityFinding,
  arMembers,
  checkArtifact,
  classifyArtifact,
  debIdentityFromControl,
  parseXarHeader,
  pkgIdentityFromXml,
  rpmNameFromLead,
  summarize,
} from "./release_identity.ts";

const HERE = dirname(fileURLToPath(import.meta.url)); // desktop/build
const DESKTOP = join(HERE, "..");
const requireCjs = createRequire(import.meta.url);

function fail(msg: string): never {
  console.error(`\n\u2717 release-identity gate: ${msg}\n`);
  process.exit(1);
}

/** Every failure path in this file reports WHY, and a thrown value is `unknown`. One checked narrowing,
 *  used by all of them, so no call site has to assert a shape onto whatever got thrown. */
function why(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// --- reading values the compiler never saw ------------------------------------------------------------
// package.json and the electron-builder overlay are JSON/CJS: every field is `unknown` until checked.
// These two keep that honest - a runtime check first, then one cast to a plain string-keyed bag, so no
// read ever fabricates a field shape it did not verify.

function objectOf(value: unknown): Readonly<Record<string, unknown>> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  // Checked directly above: a non-null, non-array object IS a string-keyed bag. Every read off it still
  // comes back `unknown` and has to be narrowed, so this asserts nothing about any particular field.
  const bag: Readonly<Record<string, unknown>> = value as Readonly<Record<string, unknown>>;
  return bag;
}

function strAt(bag: Readonly<Record<string, unknown>> | null, key: string): string | null {
  const v = bag?.[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

// --- CLI + release dir -------------------------------------------------------------------------------

/** `--flavor agent|creator`, required, and deliberately NOT resolved through normalizeBuildFlavor():
 *  that helper folds anything unrecognized to `agent` so a typo can never unlock Creator surfaces at
 *  runtime. Here the same fold would be a disaster - a `--flavor creatr` in a workflow would gate the
 *  Creator output dir against AGENT identity and pass every artifact it should have stopped. A gate
 *  reads its own arguments strictly. */
function parseFlavorArg(argv: readonly string[]): BuildFlavor {
  let raw: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--flavor") raw = (argv[i + 1] ?? "").trim();
    else if (a.startsWith("--flavor=")) raw = a.slice("--flavor=".length).trim();
  }
  if (raw === null) fail("missing --flavor: run with `--flavor agent` or `--flavor creator`");
  if (raw === "agent" || raw === "creator") return raw;
  fail(`unknown --flavor "${raw}": expected exactly "agent" or "creator"`);
}

/** Which electron-builder output dir under desktop/ to gate, as a bare directory NAME. Creator packages
 *  into `release-creator` (build/electron-builder.creator.cjs), so the default follows the flavor rather
 *  than making every Creator caller remember an env var. A NAME, not a path (same rule as
 *  airgap-smoke.ts / pf-boot-smoke.ts): anchoring resolution inside desktop/ means a stray value cannot
 *  aim the gate at an unrelated tree and pass. */
function releaseDirName(flavor: BuildFlavor): string {
  const raw = (process.env.LUCID_RELEASE_DIR ?? "").trim();
  if (!raw) return flavor === "creator" ? "release-creator" : "release";
  if (raw.includes("/") || raw.includes("\\") || raw.startsWith(".")) {
    fail(`LUCID_RELEASE_DIR must be a bare directory name under desktop/, got "${raw}"`);
  }
  return raw;
}

// --- what this flavor is supposed to be --------------------------------------------------------------

let pkgJsonCache: Readonly<Record<string, unknown>> | null = null;
function desktopPackageJson(): Readonly<Record<string, unknown>> {
  if (pkgJsonCache) return pkgJsonCache;
  const path = join(DESKTOP, "package.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    fail(`cannot read ${path}: ${why(e)}`);
  }
  const bag = objectOf(parsed);
  if (!bag) fail(`${path} did not parse as an object`);
  pkgJsonCache = bag;
  return bag;
}

/** The EFFECTIVE electron-builder config for this flavor: package.json's `build` block for Agent, the
 *  Creator overlay for Creator (it deep-clones that block and overrides the identity fields). The
 *  overlay is a side-effect-free CJS module - it requires ../package.json and mutates its own clone -
 *  so loading it here is a read of the packaging truth, not a build step. */
function effectiveBuildConfig(flavor: BuildFlavor): Readonly<Record<string, unknown>> {
  let raw: unknown;
  if (flavor === "creator") {
    try {
      raw = requireCjs("./electron-builder.creator.cjs");
    } catch (e) {
      fail(`cannot load build/electron-builder.creator.cjs: ${why(e)}`);
    }
  } else {
    raw = desktopPackageJson()["build"];
  }
  const cfg = objectOf(raw);
  if (!cfg) fail(`the effective electron-builder config for the ${flavor} flavor did not read as an object`);
  return cfg;
}

/** The deb/rpm package name, DERIVED from the very `deb.artifactName` pattern electron-builder will use
 *  (`${name}_${version}_${arch}.${ext}` for Agent, a literal `lucidcreator-desktop_...` for Creator),
 *  with `${name}` resolved against the effective package name (`extraMetadata.name` when the overlay
 *  sets one, else package.json's own `name`). Restating "lucidagentide-desktop" here would put that
 *  string in a SECOND place, and a gate whose expectation can drift from the packaging config is a gate
 *  that eventually green-lights the very drift it exists to catch. */
function debRpmNameFor(flavor: BuildFlavor): string {
  const cfg = effectiveBuildConfig(flavor);
  const pattern = strAt(objectOf(cfg["deb"]), "artifactName");
  if (!pattern) fail(`the ${flavor} electron-builder config has no deb.artifactName to derive the package name from`);
  const packageName = strAt(objectOf(cfg["extraMetadata"]), "name") ?? strAt(desktopPackageJson(), "name");
  if (!packageName) fail(`neither extraMetadata.name nor package.json name resolved for the ${flavor} flavor`);
  const stem = (pattern.split("_${version}")[0] ?? "").replace("${name}", packageName);
  if (!stem || stem.includes("${")) {
    fail(`could not derive the deb/rpm package name from deb.artifactName "${pattern}" (resolved to "${stem}")`);
  }
  return stem;
}

/** Version comes from desktop/package.json, not from a tag or an env var: the CI version-stamp step
 *  rewrites that file BEFORE electron-builder runs, so it holds the same number the artifacts were
 *  stamped with. Reading it anywhere else would compare artifacts against a version nothing built. */
function expectationFor(flavor: BuildFlavor): FlavorExpectation {
  const info = flavorInfo(flavor);
  const version = strAt(desktopPackageJson(), "version");
  if (!version) fail("desktop/package.json has no `version` - the CI version-stamp step is the source of truth here");
  return {
    appId: info.appId,
    productName: info.productName,
    artifactStem: info.artifactStem,
    debRpmName: debRpmNameFor(flavor),
    version,
  };
}

// --- pure byte/text decisions ------------------------------------------------------------------------

/** One heap-backed `<file>` entry as recorded in a xar TOC. */
interface XarHeapMember {
  readonly name: string;
  readonly offset: number;
  readonly length: number;
}

/** Locate every heap-backed member in a xar TOC.
 *
 *  The TOC is nested XML: a directory is a `<file>` holding child `<file>` elements, and a heap-backed
 *  entry is exactly a `<file>` that owns a `<data>` block. So the walk pairs each `<data>` with the
 *  nearest PRECEDING `<name>` - a directory's own name is always displaced by its children's names
 *  before any of their `<data>` appears, which makes that pairing correct without tracking depth.
 *  Regex over a machine-generated, never-user-authored TOC is the right tool; pulling an XML parser
 *  into a build gate is not. `<length>` is the archived (compressed) byte count in the heap, which is
 *  what a range read needs; `<size>` is the extracted size and is deliberately ignored. */
function xarHeapMembers(toc: string): XarHeapMember[] {
  const names: { at: number; name: string }[] = [];
  for (const m of toc.matchAll(/<name>([^<]*)<\/name>/g)) names.push({ at: m.index ?? 0, name: m[1] ?? "" });
  const out: XarHeapMember[] = [];
  for (const d of toc.matchAll(/<data>([\s\S]*?)<\/data>/g)) {
    const at = d.index ?? 0;
    let owner = "";
    for (const n of names) {
      if (n.at >= at) break;
      owner = n.name;
    }
    const body = d[1] ?? "";
    const offset = /<offset>(\d+)<\/offset>/.exec(body);
    const length = /<length>(\d+)<\/length>/.exec(body);
    if (!owner || !offset || !length) continue;
    out.push({ name: owner, offset: Number(offset[1]), length: Number(length[1]) });
  }
  return out;
}

/** xar records deflated members as `application/x-gzip` - a historical misnomer, the bytes are a raw
 *  zlib stream and not a gzip container - and productbuild also stores some small members uncompressed.
 *  Try zlib, then gzip, then plain text, and return null if none of the three yields markup. Guessing
 *  wrong must not read as "this artifact has no identity"; it has to read as a parse failure. */
function inflateMemberText(bytes: Uint8Array): string | null {
  for (const decode of [inflateSync, gunzipSync]) {
    try {
      const text = Buffer.from(decode(bytes)).toString("utf8");
      if (text.includes("<")) return text;
    } catch {
      // wrong container for this member, try the next shape
    }
  }
  const raw = Buffer.from(bytes).toString("utf8");
  return raw.includes("<") ? raw : null;
}

function cString(buf: Uint8Array, at: number, max: number): string {
  const stop = Math.min(at + max, buf.length);
  let end = at;
  while (end < stop && buf[end] !== 0) end++;
  return Buffer.from(buf.subarray(at, end)).toString("latin1");
}

/** Minimal tar reader: enough to pull ONE known small text member out of a deb control archive. 512-byte
 *  headers, NUL-terminated name at 0..100, octal size at 124..136, data padded up to a 512 multiple, and
 *  a zeroed name block marks end-of-archive. No long-name or sparse support on purpose - a control
 *  archive holds a handful of short paths, and one that needs GNU extensions is not something this gate
 *  should be quietly tolerating. */
function tarMemberText(tar: Uint8Array, wanted: readonly string[]): string | null {
  for (let p = 0; p + 512 <= tar.length; ) {
    const name = cString(tar, p, 100);
    if (!name) break; // end-of-archive marker
    const size = Number.parseInt(cString(tar, p + 124, 12).trim() || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0) return null;
    const body = p + 512;
    if (wanted.includes(name)) {
      if (body + size > tar.length) return null;
      return Buffer.from(tar.subarray(body, body + size)).toString("utf8");
    }
    p = body + Math.ceil(size / 512) * 512;
  }
  return null;
}

/** One top-level scalar out of an electron-updater feed. The feed is small, flat, machine-generated
 *  YAML (`version:`, `path:`, `sha512:`, a `files:` list), so an anchored per-line match is exact
 *  without a YAML dependency; the leading-space anchor keeps it off the indented `files:` entries,
 *  where `url:`/`sha512:` repeat per artifact. */
function feedScalar(yml: string, key: string): string | null {
  const m = new RegExp(`^${key}:[ \\t]*(?:"([^"]*)"|'([^']*)'|(.*?))[ \\t]*$`, "m").exec(yml);
  if (!m) return null;
  const v = (m[1] ?? m[2] ?? m[3] ?? "").trim();
  return v.length > 0 ? v : null;
}

// --- IO: range reads + per-kind identity extraction --------------------------------------------------

/** Either an identity we read, or the reason we could not. A failure is never a skip (fail-closed rule
 *  2), so it travels as a message the caller turns into a FAILING finding. */
type Extracted = { readonly identity: ArtifactIdentity } | { readonly failure: string };

/** Range read. A mac .pkg is ~120 MB and its identity lives in the first few KB of the heap, so the
 *  gate reads slices rather than hauling whole installers through a CI runner's memory. */
async function readRange(file: string, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(file).slice(start, end).arrayBuffer());
}

const XAR_HEADER_BYTES = 28;
/** debian-binary plus control.tar.gz's own 60-byte ar header always land far inside this, so one head
 *  read locates the control member without touching the multi-hundred-MB data member behind it. */
const DEB_HEAD_BYTES = 64 * 1024;
const RPM_LEAD_BYTES = 200;

async function macPkgIdentity(file: string, name: string): Promise<Extracted> {
  const header = parseXarHeader(await readRange(file, 0, XAR_HEADER_BYTES));
  if (!header) return { failure: "not a xar flat package (no `xar!` magic in the first 28 bytes)" };

  const tocStart = header.headerSize;
  const heapStart = header.headerSize + header.tocCompressedLength;
  const toc = inflateMemberText(await readRange(file, tocStart, heapStart));
  if (!toc) {
    return { failure: `the xar TOC (${header.tocCompressedLength} bytes at offset ${tocStart}) did not inflate to XML` };
  }
  const members = xarHeapMembers(toc);
  const pick = async (member: string): Promise<string> => {
    const m = members.find((x) => x.name === member);
    if (!m) return "";
    return inflateMemberText(await readRange(file, heapStart + m.offset, heapStart + m.offset + m.length)) ?? "";
  };
  // Distribution is the flat package's own manifest and PackageInfo belongs to the component package
  // inside it. pkgIdentityFromXml prefers Distribution and falls back to PackageInfo, so both are read
  // and an empty string means "absent" rather than "unreadable" to it.
  const distribution = await pick("Distribution");
  const packageInfo = await pick("PackageInfo");
  if (!distribution && !packageInfo) {
    const saw = members.map((m) => m.name).join(", ") || "no heap members at all";
    return { failure: `the xar TOC carries neither a readable Distribution nor a readable PackageInfo (saw: ${saw})` };
  }
  const id = pkgIdentityFromXml(distribution, packageInfo);
  return {
    identity: { kind: "mac-pkg", file: name, appId: id.appId, productPath: id.productPath, packageName: null, version: id.version, title: id.title },
  };
}

async function debIdentity(file: string, name: string): Promise<Extracted> {
  const bytes = statSync(file).size;
  const members = arMembers(await readRange(file, 0, Math.min(bytes, DEB_HEAD_BYTES)));
  if (!members.length) {
    return { failure: "not an ar archive (no readable members) - a .deb is an ar archive by definition" };
  }
  // Real ar member names carry a trailing slash (`control.tar.gz/`), so every comparison trims it.
  const control = members.find((m) => m.name.replace(/\/+$/, "").startsWith("control.tar"));
  if (!control) {
    const saw = members.map((m) => m.name.replace(/\/+$/, "")).join(", ");
    return { failure: `no control.tar.* member in the ar archive (saw: ${saw})` };
  }
  const controlName = control.name.replace(/\/+$/, "");
  if (!controlName.endsWith(".gz")) {
    return { failure: `the control member is ${controlName}; this gate reads gzip control archives only, which is what electron-builder emits` };
  }
  let tar: Uint8Array;
  try {
    tar = gunzipSync(await readRange(file, control.offset, control.offset + control.size));
  } catch (e) {
    return { failure: `${controlName} did not gunzip: ${why(e)}` };
  }
  const text = tarMemberText(tar, ["./control", "control"]);
  if (!text) return { failure: `${controlName} carries no ./control member` };

  const id = debIdentityFromControl(text);
  return {
    identity: { kind: "deb", file: name, appId: null, productPath: null, packageName: id.packageName, version: id.version, title: null },
  };
}

/** The rpm lead's name field is `<name>-<version>-<release>`. Whatever rpmNameFromLead() makes of that
 *  goes into `packageName` VERBATIM - release_identity owns whether it is matched by prefix or by
 *  equality against debRpmName, and second-guessing that here would put one decision in two places.
 *  `version` stays null for the same reason: the lead is not a version record, so checkArtifact derives
 *  the version from the lead's own tail rather than being handed a number this gate invented. */
async function rpmIdentity(file: string, name: string): Promise<Extracted> {
  const packageName = rpmNameFromLead(await readRange(file, 0, RPM_LEAD_BYTES));
  if (!packageName) {
    return { failure: "the rpm lead carries no readable package name (bad magic, or a non-rpm file wearing the extension)" };
  }
  return {
    identity: { kind: "rpm", file: name, appId: null, productPath: null, packageName, version: null, title: null },
  };
}

/** The updater feed is the ONE artifact whose filename can never separate the flavors: both products
 *  emit a file named exactly `latest.yml` (electron-builder.creator.cjs documents what that cost - a
 *  shipped Creator resolving Agent's rolling release and installing Agent on next quit). So the feed is
 *  read, not stem-checked: `version:` and the declared `path:` are the only evidence available, and a
 *  feed we cannot read is a parse failure like any other. */
async function updaterFeedIdentity(file: string, name: string): Promise<Extracted> {
  const yml = await Bun.file(file).text();
  const declared = feedScalar(yml, "version");
  // electron-builder writes a bare semver here, and checkArtifact compares a NON-NULL feed version for
  // equality against the build version - so a tag-shaped "v1.14.1" would fail the gate for a formatting
  // reason that has nothing to do with flavor identity. One leading "v" is dropped to keep that false red
  // out of a release build. This weakens nothing: a genuinely wrong version still mismatches, and the
  // feed's real flavor evidence (the declared artifact path) is untouched.
  const version = declared === null ? null : declared.replace(/^v(?=\d)/, "");
  const path = feedScalar(yml, "path");
  if (!version && !path) {
    return { failure: "the updater feed declares neither a top-level `version:` nor a `path:` - nothing in it identifies a product" };
  }
  return {
    identity: { kind: "updater-feed", file: name, appId: null, productPath: path, packageName: null, version, title: null },
  };
}

// --- enumeration -------------------------------------------------------------------------------------

/** electron-builder writes its own diagnostics into the output dir. They are in no upload glob (see
 *  build-desktop.yml) and carry no product identity, so they are skipped by EXACT name - which keeps
 *  fail-closed rule 3 sharp: every other artifact-shaped file still has to classify. */
const BUILD_BYPRODUCTS: readonly string[] = ["builder-debug.yml", "builder-effective-config.yaml"];

const BLOCKMAP_SUFFIX = ".blockmap";

/** Which kinds we open rather than judge by name. */
const DEEP_KINDS: readonly ArtifactKind[] = ["mac-pkg", "deb", "rpm", "updater-feed"];

// --- the gate ----------------------------------------------------------------------------------------

const flavor = parseFlavorArg(process.argv.slice(2));
const RELEASE = join(DESKTOP, releaseDirName(flavor));
const expected = expectationFor(flavor);
const where = relative(DESKTOP, RELEASE);

console.log("== P-RELEASE.4 (ADR-0307): release-identity gate ==\n");
console.log(`  flavor        ${flavor}`);
console.log(`  release dir   desktop/${where}`);
console.log(`  expected id   appId=${expected.appId}  payload=${expected.productName}.app  version=${expected.version}`);
console.log(`  expected name stem=${expected.artifactStem}  deb/rpm=${expected.debRpmName}\n`);

if (!existsSync(RELEASE)) {
  fail(`no release dir at ${RELEASE}: did electron-builder run? (LUCID_RELEASE_DIR selects a non-default output dir)`);
}
if (!statSync(RELEASE).isDirectory()) fail(`${RELEASE} exists but is not a directory`);

// Files only. The `*-unpacked` trees and `*.app` bundles are directories, are in no upload glob, and are
// already gated by airgap-smoke.ts and pf-boot-smoke.ts; this gate is about the bytes that ship.
const present = readdirSync(RELEASE, { withFileTypes: true })
  .filter((e) => e.isFile() && !e.name.startsWith(".") && !BUILD_BYPRODUCTS.includes(e.name))
  .map((e) => e.name)
  .sort();

// Rule 1. An empty dir means the packaging step produced nothing, or wrote somewhere else - either way
// the artifacts this gate is supposed to vouch for do not exist, and reporting green over them is the
// ADR-0303 silent-pass shape verbatim. (summarize() also fail-closes on an empty finding set; failing
// here first buys the operator a message that names the directory.)
if (!present.length) {
  fail(`desktop/${where} contains no artifacts to check - a gate that passes over an empty input set proves nothing (ADR-0303)`);
}

// `.blockmap` files are differential-update companions: electron-builder emits one beside an NSIS/zip
// artifact and the workflow uploads them with everything else. They hold a chunk index, not an identity,
// so they cannot be judged on their own - and handing one to an identity-bearing kind would fail a
// perfectly good file. Instead each companion INHERITS its parent's verdict, which is strictly stronger
// than the stem check a name-only pass would give it, and an orphan companion (no parent artifact in the
// dir) is a failure, because a blockmap without its installer is a broken upload set.
const companions = present.filter((n) => n.endsWith(BLOCKMAP_SUFFIX));
const artifacts = present.filter((n) => !n.endsWith(BLOCKMAP_SUFFIX));

const findings: IdentityFinding[] = [];
const verdicts = new Map<string, IdentityFinding>();

for (const name of artifacts) {
  const kind = classifyArtifact(name);
  const path = join(RELEASE, name);
  let finding: IdentityFinding;
  if (!DEEP_KINDS.includes(kind)) {
    // Kinds with no embeddable identity travel as an all-null identity: checkArtifact owns the filename
    // comparison (and the `unknown` rejection), so no verdict is invented locally.
    finding = checkArtifact(expected, { kind, file: name, appId: null, productPath: null, packageName: null, version: null, title: null });
  } else {
    let got: Extracted;
    try {
      got = kind === "mac-pkg" ? await macPkgIdentity(path, name)
        : kind === "deb" ? await debIdentity(path, name)
        : kind === "rpm" ? await rpmIdentity(path, name)
        : await updaterFeedIdentity(path, name);
    } catch (e) {
      got = { failure: `read failed: ${why(e)}` };
    }
    // Rule 2: a kind we should be able to read but could not is a FAILING finding, never a skipped one.
    finding = "identity" in got
      ? checkArtifact(expected, got.identity)
      : { file: name, kind, ok: false, problem: `could not read embedded identity - ${got.failure}` };
  }
  findings.push(finding);
  verdicts.set(name, finding);
}

for (const name of companions) {
  const parentName = name.slice(0, -BLOCKMAP_SUFFIX.length);
  const parent = verdicts.get(parentName);
  findings.push(parent
    ? { file: name, kind: parent.kind, ok: parent.ok, problem: parent.ok ? null : `differential-update companion of ${parentName}, which failed: ${parent.problem}` }
    : { file: name, kind: classifyArtifact(parentName), ok: false, problem: `orphan differential-update companion - no ${parentName} in the release dir for it to belong to` });
}

const { ok, report } = summarize(findings);
console.log(report);

if (!ok) {
  const bad = findings.filter((f) => !f.ok).length;
  fail(`${bad} of ${findings.length} file${findings.length === 1 ? "" : "s"} in desktop/${where} do not match the ${flavor} flavor - nothing here may be uploaded`);
}

console.log(`\n\u2713 release-identity gate passed: all ${findings.length} file${findings.length === 1 ? "" : "s"} in desktop/${where} carry ${flavor} identity (appId ${expected.appId}, version ${expected.version}).\n`);
