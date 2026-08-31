// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-RELEASE.4 - the release-identity gate (ADR-0307).
//
// THE INCIDENT: on 2026-08-30 a user reported that "v1.14.1 installed the Tactical GenAI Trainer
// instead of LUCID". The release was genuine, but proving it took a full session of hand-parsing xar
// headers, ar members and rpm leads, because CI had only ever checked artifact FILENAMES - and a
// filename is exactly what a mixed-up build gets right while the bytes underneath belong to another
// product. desktop/build/release-identity-gate.ts now reads the EMBEDDED identity of every artifact
// before any upload step can run.
//
// This demo proves the gate for real. It stages SYNTHETIC release dirs whose .pkg carries genuine xar
// framing (28-byte big-endian header, zlib-deflated TOC, zlib-deflated Distribution and PackageInfo
// members in the heap, PackageInfo nested inside a component-package directory the way productbuild
// writes it), whose .deb is a genuine `ar` archive with an even-padded, gzipped control.tar.gz holding
// a real 512-byte-header tar member, and whose .rpm opens with a genuine 96-byte lead. Nothing is
// stubbed: the gate's real range-read / inflate / tar-walk path is what runs.
//
// Then it proves the three things that matter: a correct set PASSES, THE SWAP (identical Agent
// filenames wrapped around a Creator payload - the incident class itself) FAILS, and an EMPTY dir
// FAILS rather than reporting a vacuous green (the ADR-0303 lesson). Plus the remaining fail-closed
// rules: a stray unrecognized file fails, an orphan .blockmap companion fails, the wrong --flavor
// fails, and a misspelled --flavor fails instead of silently folding to `agent`.
//
// The scratch dirs are bare directory NAMES under desktop/ rather than an OS temp path, because the
// gate deliberately refuses a path-shaped LUCID_RELEASE_DIR (a stray value must not be able to aim it
// at an unrelated tree and pass). They are removed in `finally`.
//
// Run with: bun run desktop/scripts/demo_release_identity.ts

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync, gzipSync } from "node:zlib";

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error("  \u2717 " + msg); process.exit(1); }
  console.log("  \u2713 " + msg);
}

const DESKTOP = join(import.meta.dir, "..");
// The gate reads desktop/package.json for the version it demands, so the fixtures stamp the same one.
// Hardcoding a version here would make this demo start failing the day CI stamps a new release.
const VERSION: string = JSON.parse(readFileSync(join(DESKTOP, "package.json"), "utf8")).version;

const AGENT = { appId: "com.lucidagentide.desktop", app: "LucidAgentIDE.app", title: "Lucid Agent", stem: "LucidAgent", pkg: "lucidagentide-desktop" };
const CREATOR = { appId: "com.lucidcreator.desktop", app: "LucidCreator.app", title: "Lucid Creator", stem: "LucidCreator", pkg: "lucidcreator-desktop" };

// --- fixture builders: real container framing, not stubs ---------------------------------------------

/** A xar flat package carrying one Distribution and one nested PackageInfo.
 *
 *  Header is 28 bytes, big-endian: "xar!" magic, uint16 header size, uint16 format version, uint64
 *  compressed TOC length, uint64 uncompressed TOC length, uint32 checksum algorithm. The TOC is
 *  zlib-deflated XML; heap offsets are relative to the end of that compressed TOC. Members are
 *  deflated too, which is what xar's `application/x-gzip` encoding actually means (raw zlib, not a
 *  gzip container). PackageInfo sits inside a `<file type="directory">` on purpose: that is how
 *  productbuild nests a component package, and it is the case the gate's TOC walk has to get right.
 *  The 20-byte heap prefix stands in for the TOC checksum a real xar puts at heap offset 0, so the
 *  member offsets are non-trivial.
 *
 *  ELEMENT ORDER HERE IS COPIED FROM A REAL INSTALLER, and that is load-bearing. This fixture used to
 *  emit `<name>` before `<data>`, which is backwards: xar writes `<data>` FIRST and repeats `<name>`
 *  twice. Because the fixture was written in the shape the parser expected, it passed while the parser
 *  was wrong, and the first v1.14.2 tag build refused a genuine installer. A fixture that only proves
 *  the parser agrees with itself proves nothing. The authoritative pin is the captured TOC in
 *  build/fixtures/real-mac-pkg-toc.xml; this one now at least fails honestly. */
function fakePkg(id: typeof AGENT, version: string): Buffer {
  const distribution = [
    '<?xml version="1.0" encoding="utf-8" standalone="no"?>',
    '<installer-gui-script minSpecVersion="1">',
    `    <title>${id.title}</title>`,
    `    <product id="${id.appId}" version="${version}"/>`,
    '    <options customize="never" require-scripts="false" hostArchitectures="arm64"/>',
    '    <choices-outline><line choice="default"><line choice="app"/></line></choices-outline>',
    `    <pkg-ref id="${id.appId}"/>`,
    `    <bundle-version><bundle id="${id.appId}" CFBundleShortVersionString="${version}" path="${id.app}"/></bundle-version>`,
    "</installer-gui-script>",
  ].join("\n");
  const packageInfo = [
    '<?xml version="1.0" encoding="utf-8" standalone="no"?>',
    `<pkg-info overwrite-permissions="true" relocatable="false" identifier="${id.appId}" version="${version}" install-location="/Applications" auth="root">`,
    '    <payload numberOfFiles="4211" installKBytes="512000"/>',
    `    <bundle path="./${id.app}" id="${id.appId}" CFBundleShortVersionString="${version}" CFBundleVersion="${version}"/>`,
    "</pkg-info>",
  ].join("\n");

  const distZ = deflateSync(Buffer.from(distribution, "utf8"));
  const infoZ = deflateSync(Buffer.from(packageInfo, "utf8"));
  const checksumFiller = Buffer.alloc(20, 0);
  const distAt = checksumFiller.byteLength;
  const infoAt = distAt + distZ.byteLength;

  const data = (lengthBytes: number, offset: number, sizeBytes: number): string =>
    `<data><length>${lengthBytes}</length><offset>${offset}</offset><size>${sizeBytes}</size>` +
    '<encoding style="application/x-gzip"/><extracted-checksum style="sha1">0</extracted-checksum></data>';
  const toc = Buffer.from([
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<xar>",
    " <toc>",
    '  <checksum style="sha1"><offset>0</offset><size>20</size></checksum>',
    // Real ordering: <data> first, then <type>, then <name> (twice). Distribution is a TOP-LEVEL
    // member listed BEFORE the component directory, so it is the first <data> in the document and has
    // no <name> of any kind before it - the exact shape that broke the shipped walk.
    '  <file id="1">',
    `   ${data(distZ.byteLength, distAt, Buffer.byteLength(distribution))}`,
    "   <type>file</type><name>Distribution</name>",
    "  </file>",
    '  <file id="2"><type>directory</type><name>payload.pkg</name>',
    '   <file id="3">',
    `    ${data(infoZ.byteLength, infoAt, Buffer.byteLength(packageInfo))}`,
    "    <type>file</type><name>PackageInfo</name><name>PackageInfo</name>",
    "   </file>",
    "  </file>",
    " </toc>",
    "</xar>",
  ].join("\n"), "utf8");
  const tocZ = deflateSync(toc);

  const header = Buffer.alloc(28, 0);
  header.write("xar!", 0, 4, "latin1");
  header.writeUInt16BE(28, 4);
  header.writeUInt16BE(1, 6);
  header.writeBigUInt64BE(BigInt(tocZ.byteLength), 8);
  header.writeBigUInt64BE(BigInt(toc.byteLength), 16);
  header.writeUInt32BE(1, 24);

  return Buffer.concat([header, tocZ, checksumFiller, distZ, infoZ]);
}

/** One 512-byte tar header plus its 512-padded data. Name at 0..100, octal size at 124..136, and a
 *  real checksum at 148..156 computed over the block with that field blanked to spaces - the gate does
 *  not verify it, but a fixture that `tar tf` would reject is not proof of anything. */
function tarFile(name: string, body: string): Buffer {
  const data = Buffer.from(body, "utf8");
  const head = Buffer.alloc(512, 0);
  head.write(name, 0, 100, "latin1");
  head.write("0000644\0", 100, 8, "latin1");
  head.write("0000000\0", 108, 8, "latin1");
  head.write("0000000\0", 116, 8, "latin1");
  head.write(`${data.byteLength.toString(8).padStart(11, "0")}\0`, 124, 12, "latin1");
  head.write("00000000000\0", 136, 12, "latin1");
  head.write("        ", 148, 8, "latin1"); // blanked while summing, per the tar checksum definition
  head.write("0", 156, 1, "latin1"); // typeflag: regular file
  head.write("ustar\0", 257, 6, "latin1");
  head.write("00", 263, 2, "latin1");
  let sum = 0;
  for (const b of head) sum += b;
  head.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
  const pad = Buffer.alloc((512 - (data.byteLength % 512)) % 512, 0);
  return Buffer.concat([head, data, pad]);
}

/** A 60-byte GNU `ar` member header. The name field carries the trailing slash real .deb members
 *  have ("control.tar.gz/"), and every field is space-padded ASCII: size lives at 48..58. */
function arHeader(name: string, size: number): Buffer {
  const h = Buffer.alloc(60, 0x20);
  h.write(`${name}/`.padEnd(16, " ").slice(0, 16), 0, 16, "latin1");
  h.write("0".padEnd(12, " "), 16, 12, "latin1"); // mtime
  h.write("0".padEnd(6, " "), 28, 6, "latin1"); // uid
  h.write("0".padEnd(6, " "), 34, 6, "latin1"); // gid
  h.write("100644".padEnd(8, " "), 40, 8, "latin1"); // mode
  h.write(String(size).padEnd(10, " "), 48, 10, "latin1");
  h.write("`\n", 58, 2, "latin1");
  return h;
}

/** A .deb: the 8-byte `!<arch>\n` magic then debian-binary, control.tar.gz and data.tar.gz, each
 *  member's data padded to an EVEN length. The padding matters - skip it and the next header lands one
 *  byte off and the whole walk desynchronizes. debian-binary is 4 bytes (even) and the two tarballs
 *  are arbitrary lengths, so this fixture exercises both the padded and unpadded case. */
function fakeDeb(id: typeof AGENT, version: string): Buffer {
  const control = [
    `Package: ${id.pkg}`,
    `Version: ${version}`,
    "License: BUSL-1.1",
    "Vendor: TechLead 187 LLC",
    "Architecture: amd64",
    "Maintainer: TechLead 187 LLC",
    "Installed-Size: 512000",
    "Depends: libgtk-3-0, libnotify4",
    "Section: default",
    "Priority: optional",
    "Homepage: https://github.com/mlcyclops/lucidagentide",
    "Description: Sovereignty-aware, fail-closed AI agent IDE",
    " A folded continuation line, which must never be read as a field of its own.",
    "",
  ].join("\n");
  const members: { name: string; body: Buffer }[] = [
    { name: "debian-binary", body: Buffer.from("2.0\n", "utf8") },
    { name: "control.tar.gz", body: gzipSync(Buffer.concat([tarFile("./control", control), Buffer.alloc(1024, 0)])) },
    { name: "data.tar.gz", body: gzipSync(Buffer.concat([tarFile(`./opt/${id.app}/resources/app.txt`, "payload"), Buffer.alloc(1024, 0)])) },
  ];
  const parts: Buffer[] = [Buffer.from("!<arch>\n", "latin1")];
  for (const m of members) {
    parts.push(arHeader(m.name, m.body.byteLength), m.body);
    if (m.body.byteLength % 2 === 1) parts.push(Buffer.from("\n", "latin1"));
  }
  return Buffer.concat(parts);
}

/** An .rpm lead: magic ED AB EE DB, major/minor, type, archnum, then the NUL-terminated
 *  name-version-release string in char[66] at offset 10. The lead is 96 bytes; real rpms continue
 *  with signature and header sections, which this gate never reads. */
function fakeRpm(id: typeof AGENT, version: string): Buffer {
  const lead = Buffer.alloc(256, 0);
  lead[0] = 0xed; lead[1] = 0xab; lead[2] = 0xee; lead[3] = 0xdb;
  lead[4] = 3; // major
  lead[5] = 0; // minor
  lead.writeUInt16BE(0, 6); // type: binary
  lead.writeUInt16BE(1, 8); // archnum
  lead.write(`${id.pkg}-${version}-1`, 10, 66, "latin1");
  lead.writeUInt16BE(1, 76); // osnum
  lead.writeUInt16BE(5, 78); // signature type
  return lead;
}

/** electron-updater's feed. Both flavors emit a file named EXACTLY latest.yml, so the declared `path:`
 *  is the only field that can tell them apart - which is precisely why the gate reads it. */
function fakeFeed(id: typeof AGENT, version: string): string {
  return [
    `version: ${version}`,
    "files:",
    `  - url: ${id.stem}-Setup.exe`,
    "    sha512: PLACEHOLDER",
    "    size: 118000000",
    `path: ${id.stem}-Setup.exe`,
    "sha512: PLACEHOLDER",
    "releaseDate: '2026-08-30T00:00:00.000Z'",
  ].join("\n");
}

// --- staging + running -------------------------------------------------------------------------------

const scratch: string[] = [];

/** A bare directory NAME under desktop/, as the gate requires. */
function stage(suffix: string, id: typeof AGENT | null, extras: Record<string, Buffer | string> = {}): string {
  const name = `release-demo-${process.pid}-${suffix}`;
  const dir = join(DESKTOP, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  scratch.push(dir);
  if (id) {
    // Filenames are ALWAYS the Agent set. The `id` argument only decides what the bytes inside say,
    // which is what makes the swapped-flavor dir a faithful reproduction of the incident.
    writeFileSync(join(dir, `${AGENT.stem}-mac-arm64.pkg`), fakePkg(id, VERSION));
    writeFileSync(join(dir, `${AGENT.pkg}_${VERSION}_amd64.deb`), fakeDeb(id, VERSION));
    writeFileSync(join(dir, `${AGENT.pkg}-${VERSION}.x86_64.rpm`), fakeRpm(id, VERSION));
    writeFileSync(join(dir, `${AGENT.stem}-mac-arm64.zip`), Buffer.from("PK\u0003\u0004 not a real zip, and nothing reads it", "latin1"));
    writeFileSync(join(dir, `${AGENT.stem}-Setup.exe`), Buffer.from("MZ nsis installer bytes", "latin1"));
    writeFileSync(join(dir, `${AGENT.stem}-Setup.exe.blockmap`), Buffer.from("blockmap chunk index", "latin1"));
    writeFileSync(join(dir, `${AGENT.stem}-portable.exe`), Buffer.from("MZ portable bytes", "latin1"));
    writeFileSync(join(dir, `${AGENT.stem}-x86_64.AppImage`), Buffer.from("\u007fELF appimage bytes", "latin1"));
    writeFileSync(join(dir, "latest.yml"), fakeFeed(id, VERSION), "utf8");
    // electron-builder always drops these next to the artifacts and no upload glob includes them, so
    // the gate must skip them rather than reject them as unrecognized files.
    writeFileSync(join(dir, "builder-debug.yml"), "# electron-builder diagnostics\n", "utf8");
    writeFileSync(join(dir, "builder-effective-config.yaml"), "appId: com.example.whatever\n", "utf8");
  }
  for (const [file, body] of Object.entries(extras)) writeFileSync(join(dir, file), body);
  return name;
}

function runGate(releaseDir: string, flavor: string): { code: number; text: string } {
  const r = Bun.spawnSync(["bun", "run", "build/release-identity-gate.ts", "--flavor", flavor], {
    cwd: DESKTOP,
    env: { ...process.env, LUCID_RELEASE_DIR: releaseDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode ?? -1, text: `${r.stdout.toString()}${r.stderr.toString()}` };
}

console.log("== #ADR-0307 P-RELEASE.4: the release-identity gate ==\n");
console.log(`  fixtures stamped at version ${VERSION} (read from desktop/package.json, the same source the gate uses)`);

try {
  console.log("\n[1] a correct Agent upload set PASSES, and every artifact is inspected by name AND by bytes");
  const good = stage("good", AGENT);
  const pass = runGate(good, "agent");
  assert(pass.code === 0, `the gate exits 0 on a correct Agent release dir (exit ${pass.code})`);
  assert(pass.text.includes("PASS  mac-pkg"), "the .pkg passed through the REAL parse path: 28-byte xar header, inflated TOC, nested PackageInfo, Distribution identity");
  assert(pass.text.includes("PASS  deb"), "the .deb passed through the REAL parse path: ar member walk, gunzipped control.tar.gz, 512-byte-header tar member, control fields");
  assert(pass.text.includes("PASS  rpm"), "the .rpm passed through the REAL parse path: 96-byte lead, NUL-terminated name-version-release at offset 10");
  assert(pass.text.includes("PASS  updater-feed"), "latest.yml is READ, not stem-checked: both flavors emit that exact filename, so its declared path is the only real evidence");
  assert(pass.text.includes(`${AGENT.stem}-Setup.exe.blockmap`), "the .blockmap companion is accounted for rather than ignored");
  assert(!pass.text.includes("builder-debug.yml") && !pass.text.includes("builder-effective-config.yaml"), "electron-builder's own byproducts are skipped, not rejected as unrecognized files");
  assert(pass.text.includes("every embedded identity matches"), "the full report prints on SUCCESS too, so a green CI log still carries the evidence");

  console.log("\n[2] THE SWAP: correct Agent filenames, Creator payload inside -> FAILS (the incident class)");
  const swapped = stage("swapped", CREATOR);
  const swap = runGate(swapped, "agent");
  assert(swap.code !== 0, `the gate exits non-zero when the bytes belong to the other flavor (exit ${swap.code})`);
  assert(swap.text.includes("bundle id mismatch") && swap.text.includes(CREATOR.appId), `the report names BOTH sides: the pkg embeds ${CREATOR.appId} while this flavor is ${AGENT.appId}`);
  assert(swap.text.includes("deb package name mismatch"), "the .deb's control file is caught too, independently of its filename");
  assert(swap.text.includes("rpm package name mismatch"), "the .rpm lead is caught too");
  assert(swap.text.includes("updater feed points at a foreign artifact"), "the updater feed pointing at the other product's installer is caught - the auto-update self-replacement path");
  assert(swap.text.includes("do not match the agent flavor - nothing here may be uploaded"), "the failure is loud and says what it blocks");
  // Layer 1 could not have caught any of this: the filenames in the swapped dir are byte-identical to
  // the passing dir's, which is exactly why filename checks alone let v1.14.1 need a forensic session.
  assert(!swap.text.includes("filename mismatch"), "not one filename check fired: the swap is invisible to names and only the embedded identity catches it");

  console.log("\n[3] fail-closed: nothing to inspect is a FAILURE, not a vacuous green (ADR-0303)");
  const empty = stage("empty", null);
  const none = runGate(empty, "agent");
  assert(none.code !== 0, `an EMPTY release dir fails (exit ${none.code})`);
  assert(none.text.includes("proves nothing"), "and it says why, naming the directory it found nothing in");
  const missing = runGate(`release-demo-${process.pid}-absent`, "agent");
  assert(missing.code !== 0 && missing.text.includes("no release dir at"), "a MISSING release dir fails the same way");

  console.log("\n[4] fail-closed: the remaining rules");
  const stray = stage("stray", AGENT, { "TacticalGenAITrainer-Setup.msi": Buffer.from("MZ someone else's installer", "latin1") });
  const strayRun = runGate(stray, "agent");
  assert(strayRun.code !== 0 && strayRun.text.includes("unrecognized artifact in the release dir"), "an unaccounted-for file in the upload set fails, because that is the shape of the bug being guarded");

  const orphan = stage("orphan", AGENT, { [`${AGENT.stem}-mac-x64.zip.blockmap`]: Buffer.from("blockmap with no artifact", "latin1") });
  const orphanRun = runGate(orphan, "agent");
  assert(orphanRun.code !== 0 && orphanRun.text.includes("orphan differential-update companion"), "a .blockmap with no artifact to belong to fails: a companion without its installer is a broken upload set");

  // The feed's version is compared for EQUALITY, so a formatting difference must not red-light a real
  // release - while a genuinely wrong version still has to fail. Both halves are asserted, because a
  // normalization that swallowed the second case would have quietly disabled the check.
  const tagged = stage("tagged", AGENT, { "latest.yml": fakeFeed(AGENT, `v${VERSION}`) });
  const taggedRun = runGate(tagged, "agent");
  assert(taggedRun.code === 0, `a tag-shaped "v${VERSION}" in the updater feed still PASSES: a leading "v" is a formatting difference, not a flavor difference (exit ${taggedRun.code})`);

  const staleFeed = stage("stalefeed", AGENT, { "latest.yml": fakeFeed(AGENT, "v0.0.1") });
  const staleRun = runGate(staleFeed, "agent");
  assert(staleRun.code !== 0 && staleRun.text.includes("declares 0.0.1"), "but a feed advertising a DIFFERENT version still fails: normalizing the prefix did not disable the version check");

  const wrongFlavor = runGate(good, "creator");
  assert(wrongFlavor.code !== 0 && wrongFlavor.text.includes(CREATOR.appId), "gating the SAME dir as --flavor creator fails, so the expectation really is derived per flavor (appId, product name, and the deb/rpm name off the Creator packaging overlay)");
  assert(wrongFlavor.text.includes(CREATOR.pkg), `the Creator expectation resolved its deb/rpm name to ${CREATOR.pkg} from the electron-builder overlay, not from a second hardcoded copy`);

  const typo = runGate(good, "creatr");
  assert(typo.code !== 0 && typo.text.includes('unknown --flavor "creatr"'), "a misspelled --flavor is a hard failure, never a silent fold to `agent` that would gate the wrong expectation");
} finally {
  for (const dir of scratch) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

console.log("\n\u2713 P-RELEASE.4 demo passed - flavor identity is now read out of the shipped bytes before upload, so a mis-flavored artifact fails the build instead of needing a forensic session after a user reports it.\n");
