// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/build/release_identity.test.ts - P-RELEASE.4 (ADR-0307): the release identity gate, pure core.
//
// THE INCIDENT: a user reported that "v1.14.1 installed the Tactical GenAI Trainer instead of LUCID".
// The release was genuine, but proving it cost a full session of hand-parsing a .pkg's xar header, a
// .deb's ar members and a .rpm's lead. These tests are that hand-parsing, automated: the byte layouts
// are asserted against fixtures built HERE, in code, so no binary is ever committed and every fixture
// is readable next to the assertion that depends on it.
//
// The headline case is the last one in this file: a Creator payload inside a correctly named Agent
// installer. Its filename is right, its bytes are wrong, and only the embedded identity can tell.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_FLAVOR, CREATOR_FLAVOR } from "../build_flavor.ts";
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
  xarHeapMembers,
} from "./release_identity.ts";

// --- fixtures ----------------------------------------------------------------------------------

/** The flavor being built. Mirrors desktop/build_flavor.ts + desktop/package.json (name, version);
 *  the "fixtures mirror the shipping identities" test below fails if that ever drifts. */
const AGENT: FlavorExpectation = {
  appId: "com.lucidagentide.desktop",
  productName: "LucidAgentIDE",
  artifactStem: "LucidAgent",
  debRpmName: "lucidagentide-desktop",
  version: "1.14.1",
};

/** Real productbuild output shape, trimmed to the elements the gate reads. Note `<bundle-version>`:
 *  it exists to prove the attribute matcher does not confuse that tag with `<bundle>`. */
const DISTRIBUTION_XML = `<?xml version="1.0" encoding="utf-8" standalone="no"?>
<installer-gui-script minSpecVersion="1">
    <pkg-ref id="com.lucidagentide.desktop"/>
    <options customize="never" require-scripts="false" hostArchitectures="arm64,x86_64"/>
    <product id="com.lucidagentide.desktop" version="1.14.1"/>
    <title>Lucid Agent</title>
    <choices-outline>
        <line choice="default">
            <line choice="com.lucidagentide.desktop"/>
        </line>
    </choices-outline>
    <choice id="default"/>
    <choice id="com.lucidagentide.desktop" visible="false">
        <pkg-ref id="com.lucidagentide.desktop"/>
    </choice>
    <pkg-ref id="com.lucidagentide.desktop" version="1.14.1" onConclusion="none" installKBytes="612345">#LucidAgent-mac.pkg</pkg-ref>
    <bundle-version>
        <bundle CFBundleShortVersionString="1.14.1" CFBundleVersion="1.14.1" id="com.lucidagentide.desktop" path="LucidAgentIDE.app"/>
    </bundle-version>
</installer-gui-script>
`;

/** Real pkgbuild output shape. The payload path here is "./LucidAgentIDE.app" - the normalization case. */
const PACKAGE_INFO_XML = `<?xml version="1.0" encoding="utf-8"?>
<pkg-info overwrite-permissions="true" relocatable="false" identifier="com.lucidagentide.desktop" postinstall-action="none" version="1.14.1" format-version="2" generator-version="InstallCmds-830 (22G120)" install-location="/Applications" auth="root">
    <payload numberOfFiles="12874" installKBytes="612345"/>
    <bundle path="./LucidAgentIDE.app" id="com.lucidagentide.desktop" CFBundleIdentifier="com.lucidagentide.desktop" CFBundleShortVersionString="1.14.1" CFBundleVersion="1.14.1"/>
    <bundle-version>
        <bundle id="com.lucidagentide.desktop" CFBundleShortVersionString="1.14.1" CFBundleVersion="1.14.1"/>
    </bundle-version>
</pkg-info>
`;

const CONTROL_TEXT = `Package: lucidagentide-desktop
Version: 1.14.1
License: BUSL-1.1
Architecture: amd64
Maintainer: TechLead 187 LLC <support@lucidagentide.com>
Installed-Size: 612345
Depends: libgtk-3-0, libnotify4, libnss3, libxss1, libxtst6, xdg-utils
Section: devel
Priority: optional
Homepage: https://github.com/mlcyclops/lucidagentide
Description: Sovereignty-aware, fail-closed AI coding IDE
 Version: not-a-field - a folded continuation line that must never be read as one.
`;

/** A 28-byte big-endian xar header. Every field is written explicitly so the offsets under test are
 *  visible in the fixture rather than implied by a blob. */
function xarHeader(opts: { magic?: number; headerSize?: number; tocCompressed?: number } = {}): Uint8Array {
  const buf = new Uint8Array(28);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, opts.magic ?? 0x78617221, false); // "xar!"
  dv.setUint16(4, opts.headerSize ?? 28, false);
  dv.setUint16(6, 1, false); // format version
  const toc = BigInt(opts.tocCompressed ?? 6231);
  dv.setBigUint64(8, toc, false); // compressed TOC length
  dv.setBigUint64(16, toc * 5n, false); // uncompressed TOC length
  dv.setUint32(24, 1, false); // checksum alg = sha1
  return buf;
}

/** A real `ar` archive: 8-byte magic, then per member a 60-byte ASCII header (GNU form: name
 *  terminated by "/", size in decimal at 48..57, "`\n" terminator) and its data padded to even. */
function arArchive(members: readonly { name: string; data: string }[]): Uint8Array {
  const bytes: number[] = [];
  const push = (s: string) => {
    for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i));
  };
  push("!<arch>\n");
  for (const m of members) {
    push(`${m.name}/`.padEnd(16, " ")); // 0..15  name
    push("1756512000".padEnd(12, " ")); // 16..27 mtime
    push("0".padEnd(6, " ")); // 28..33 uid
    push("0".padEnd(6, " ")); // 34..39 gid
    push("100644".padEnd(8, " ")); // 40..47 mode
    push(String(m.data.length).padEnd(10, " ")); // 48..57 size
    push("`\n"); // 58..59 header terminator
    push(m.data);
    if (m.data.length % 2 === 1) bytes.push(0x0a); // even-boundary padding
  }
  return new Uint8Array(bytes);
}

/** A 96-byte rpm lead: magic ED AB EE DB, then the NUL-terminated name at offset 10. */
function rpmLead(name: string, magic: readonly number[] = [0xed, 0xab, 0xee, 0xdb]): Uint8Array {
  const lead = new Uint8Array(96);
  lead.set(magic, 0);
  lead[4] = 0x03; // major
  lead[5] = 0x00; // minor
  lead[7] = 0x00; // type 0 = binary package (uint16 at 6..7)
  lead[9] = 0x01; // archnum
  for (let i = 0; i < name.length; i++) lead[10 + i] = name.charCodeAt(i);
  lead[77] = 0x01; // osnum = linux
  lead[79] = 0x05; // signature type = header-style
  return lead;
}

const BLANK = {
  appId: null,
  productPath: null,
  packageName: null,
  version: null,
  title: null,
} as const;

/** A correct Agent .pkg: the exact bytes the gate must let through. */
const AGENT_PKG: ArtifactIdentity = {
  kind: "mac-pkg",
  file: "LucidAgent-mac-arm64.pkg",
  appId: "com.lucidagentide.desktop",
  productPath: "LucidAgentIDE.app",
  packageName: null,
  version: "1.14.1",
  title: "Lucid Agent",
};

// --- the fixtures cannot drift from the product -----------------------------------------------

test("the expectation fixture mirrors the shipping flavor identities", () => {
  // If build_flavor.ts changes an appId or a stem, this test - not a shipped installer - is what
  // notices. Creator is asserted too because it is the wrong-flavor half of every FAIL case below.
  expect(AGENT.appId).toBe(AGENT_FLAVOR.appId);
  expect(AGENT.productName).toBe(AGENT_FLAVOR.productName);
  expect(AGENT.artifactStem).toBe(AGENT_FLAVOR.artifactStem);
  expect(CREATOR_FLAVOR.appId).toBe("com.lucidcreator.desktop");
  expect(CREATOR_FLAVOR.productName).toBe("LucidCreator");
  expect(CREATOR_FLAVOR.artifactStem).toBe("LucidCreator");
  // The two flavors must be distinguishable on every field the gate compares, or the gate is theatre.
  expect(AGENT_FLAVOR.appId).not.toBe(CREATOR_FLAVOR.appId);
  expect(AGENT_FLAVOR.productName).not.toBe(CREATOR_FLAVOR.productName);
  expect(AGENT_FLAVOR.artifactStem).not.toBe(CREATOR_FLAVOR.artifactStem);
});

// --- xarHeapMembers ----------------------------------------------------------------------------

// THE REGRESSION THAT SHIPPED. The first v1.14.2 tag build refused a perfectly good mac installer:
// the walk paired each `<data>` with the nearest PRECEDING `<name>`, and a real xar TOC breaks that
// two ways at once - `<data>` comes BEFORE `<name>` inside a `<file>`, and `<name>` is repeated. The
// result was `saw: com.lucidagentide.desktop.pkg, Bom, Payload` for an archive whose members are
// Distribution, Bom, Payload and PackageInfo: every label shifted by one and the first member lost.
// Synthetic fixtures could not catch it (they were written in the shape the parser expected), so this
// suite reads the TOC of an ACTUAL shipped installer, captured from the v1.14.1 mac pkg.
const REAL_TOC = readFileSync(join(import.meta.dir, "fixtures", "real-mac-pkg-toc.xml"), "utf8");

describe("xarHeapMembers (against a REAL shipped pkg TOC)", () => {
  const members = xarHeapMembers(REAL_TOC);
  const byName = (n: string) => members.find((m) => m.name === n);

  test("finds Distribution, which the shipped bug lost entirely (nothing precedes the first member)", () => {
    expect(byName("Distribution")).toEqual({ name: "Distribution", offset: 540063975, length: 522 });
  });
  test("finds PackageInfo with its own offset, not the previous file's", () => {
    expect(byName("PackageInfo")).toEqual({ name: "PackageInfo", offset: 540063601, length: 374 });
  });
  test("labels Bom and Payload correctly (the shifted labels the bug produced)", () => {
    expect(byName("Bom")?.offset).toBe(20);
    expect(byName("Payload")?.offset).toBe(1612348);
    // `length` is the ARCHIVED byte count a range read needs, never the extracted `size`.
    expect(byName("Bom")?.length).toBe(1612328);
  });
  test("the component DIRECTORY is not a member - it owns no heap bytes", () => {
    expect(byName("com.lucidagentide.desktop.pkg")).toBeUndefined();
    expect(members.map((m) => m.name).sort()).toEqual(["Bom", "Distribution", "PackageInfo", "Payload"]);
  });
  test("a repeated <name> does not create a duplicate member", () => {
    // Bom, Payload and PackageInfo each carry <name> TWICE in the real TOC.
    expect(members.filter((m) => m.name === "Bom")).toHaveLength(1);
    expect(members).toHaveLength(4);
  });
  test("empty / non-TOC input yields nothing rather than throwing", () => {
    expect(xarHeapMembers("")).toEqual([]);
    expect(xarHeapMembers("<xar><toc/></xar>")).toEqual([]);
    expect(xarHeapMembers("not xml at all")).toEqual([]);
  });
});

describe("parseXarHeader", () => {
  test("reads headerSize and the compressed TOC length as big-endian", () => {
    expect(parseXarHeader(xarHeader({ tocCompressed: 6231 }))).toEqual({
      headerSize: 28,
      tocCompressedLength: 6231,
    });
  });
  test("a non-default headerSize is READ, not assumed", () => {
    expect(parseXarHeader(xarHeader({ headerSize: 32, tocCompressed: 42 }))?.headerSize).toBe(32);
  });
  test("wrong magic is null - the 'pkg' is some other file entirely", () => {
    expect(parseXarHeader(xarHeader({ magic: 0x504b0304 }))).toBeNull(); // a zip
    expect(parseXarHeader(xarHeader({ magic: 0x78617220 }))).toBeNull(); // one byte off "xar!"
  });
  test("a truncated header is null, never a partial guess", () => {
    const full = xarHeader();
    expect(parseXarHeader(full.subarray(0, 27))).toBeNull();
    expect(parseXarHeader(full.subarray(0, 8))).toBeNull();
    expect(parseXarHeader(new Uint8Array(0))).toBeNull();
  });
  test("FAIL-CLOSED: a header claiming to be smaller than its own fields, or an empty TOC, is null", () => {
    expect(parseXarHeader(xarHeader({ headerSize: 16 }))).toBeNull();
    expect(parseXarHeader(xarHeader({ tocCompressed: 0 }))).toBeNull();
  });
  test("reads through a byteOffset (a slice of a larger read buffer)", () => {
    // The caller reads a chunk and hands us a view into it; a DataView built off .buffer alone
    // without .byteOffset would silently parse the wrong bytes here.
    const backing = new Uint8Array(64);
    backing.set(xarHeader({ tocCompressed: 99 }), 12);
    expect(parseXarHeader(backing.subarray(12, 40))).toEqual({ headerSize: 28, tocCompressedLength: 99 });
  });
});

// --- pkgIdentityFromXml ------------------------------------------------------------------------

describe("pkgIdentityFromXml", () => {
  test("prefers Distribution for a real Agent pkg", () => {
    expect(pkgIdentityFromXml(DISTRIBUTION_XML, PACKAGE_INFO_XML)).toEqual({
      appId: "com.lucidagentide.desktop",
      productPath: "LucidAgentIDE.app",
      version: "1.14.1",
      title: "Lucid Agent",
    });
  });
  test("normalizes PackageInfo's './LucidAgentIDE.app' to the bare payload path", () => {
    // Distribution here has no <bundle-version> block, so the payload path falls back to PackageInfo,
    // where pkgbuild writes it with a "./" prefix. Both spellings must compare equal to the same app.
    const distNoBundle = DISTRIBUTION_XML.replace(/<bundle-version>[\s\S]*?<\/bundle-version>/, "");
    expect(distNoBundle).not.toContain("path=");
    const got = pkgIdentityFromXml(distNoBundle, PACKAGE_INFO_XML);
    expect(got.productPath).toBe("LucidAgentIDE.app");
    expect(got.appId).toBe("com.lucidagentide.desktop"); // still Distribution's <product id>
  });
  test("Distribution missing entirely falls back to PackageInfo, field by field", () => {
    expect(pkgIdentityFromXml("", PACKAGE_INFO_XML)).toEqual({
      appId: "com.lucidagentide.desktop", // <pkg-info identifier=...>
      productPath: "LucidAgentIDE.app", // <bundle path="./..."> normalized
      version: "1.14.1", // CFBundleShortVersionString
      title: null, // PackageInfo has no title, and none is invented
    });
  });
  test("a Creator pkg reports Creator identity - the two are never confusable", () => {
    const creatorDist = DISTRIBUTION_XML.replaceAll("com.lucidagentide.desktop", "com.lucidcreator.desktop")
      .replace("LucidAgentIDE.app", "LucidCreator.app")
      .replace("<title>Lucid Agent</title>", "<title>Lucid Creator</title>");
    expect(pkgIdentityFromXml(creatorDist, "")).toEqual({
      appId: "com.lucidcreator.desktop",
      productPath: "LucidCreator.app",
      version: "1.14.1",
      title: "Lucid Creator",
    });
  });
  test("both files missing is all-null, never a throw", () => {
    expect(pkgIdentityFromXml("", "")).toEqual({ appId: null, productPath: null, version: null, title: null });
  });
  test("tolerates single quotes and reordered attributes (no XML shape is assumed)", () => {
    const odd = `<installer-gui-script><product version='2.0.0' id='com.example.app'/><title>Example</title></installer-gui-script>`;
    expect(pkgIdentityFromXml(odd, "")).toEqual({
      appId: "com.example.app",
      productPath: null,
      version: "2.0.0",
      title: "Example",
    });
  });
  test("garbage in is null out, not a partial identity from an unrelated tag", () => {
    expect(pkgIdentityFromXml("not xml at all", "<html><body>404</body></html>")).toEqual({
      appId: null,
      productPath: null,
      version: null,
      title: null,
    });
  });
});

// --- arMembers ---------------------------------------------------------------------------------

describe("arMembers", () => {
  // Stand-in for the gzip bytes: ASCII so the offset asserts below can decode it as text. The walk
  // never looks at member CONTENT, only at the header fields, so the payload's realism is irrelevant
  // while its LENGTH (odd, here and in debian-binary) is exactly what the padding math turns on.
  const CONTROL_TGZ = "gzipped-control-bytes";
  const deb = arArchive([
    { name: "debian-binary", data: "2.0" }, // ODD length: forces the even-padding path
    { name: "control.tar.gz", data: CONTROL_TGZ },
  ]);

  test("walks both members and pads odd data to an even boundary", () => {
    // 8 magic + 60 header = 68 for the first data; 3 bytes + 1 pad puts the second header at 72,
    // so its data starts at 132. Skip the pad byte and the second header lands one byte off.
    expect(arMembers(deb)).toEqual([
      { name: "debian-binary", offset: 68, size: 3 },
      { name: "control.tar.gz", offset: 132, size: CONTROL_TGZ.length },
    ]);
  });
  test("the reported offsets actually address the member data", () => {
    const [first, second] = arMembers(deb);
    expect(new TextDecoder().decode(deb.subarray(first!.offset, first!.offset + first!.size))).toBe("2.0");
    expect(new TextDecoder().decode(deb.subarray(second!.offset, second!.offset + second!.size))).toBe(CONTROL_TGZ);
  });
  test("strips GNU ar's trailing slash and space padding from member names", () => {
    // Raw bytes really are "control.tar.gz/ " - a name compared without stripping never matches.
    expect(new TextDecoder().decode(deb.subarray(72, 88))).toBe("control.tar.gz/ ");
    expect(arMembers(deb).map((m) => m.name)).toEqual(["debian-binary", "control.tar.gz"]);
  });
  test("a non-ar buffer is empty - no resynchronizing on a guess", () => {
    expect(arMembers(xarHeader())).toEqual([]);
    expect(arMembers(new TextEncoder().encode("!<arch>x"))).toEqual([]);
    expect(arMembers(new Uint8Array(0))).toEqual([]);
  });
  test("stops when a full 60-byte header is no longer in the buffer", () => {
    // A prefix read: the first member is reported (its offsets are absolute and still usable), the
    // partial second header is not.
    expect(arMembers(deb.subarray(0, 100))).toEqual([{ name: "debian-binary", offset: 68, size: 3 }]);
    expect(arMembers(deb.subarray(0, 40))).toEqual([]);
  });
  test("an unreadable size field stops the walk instead of desynchronizing", () => {
    const broken = new Uint8Array(deb);
    broken.set(new TextEncoder().encode("NOTANUMBER"), 8 + 48);
    expect(arMembers(broken)).toEqual([]);
  });
});

// --- debIdentityFromControl --------------------------------------------------------------------

describe("debIdentityFromControl", () => {
  test("reads Package and Version from a real control block", () => {
    expect(debIdentityFromControl(CONTROL_TEXT)).toEqual({
      packageName: "lucidagentide-desktop",
      version: "1.14.1",
    });
  });
  test("a folded Description continuation line is never read as a field", () => {
    // CONTROL_TEXT's Description carries an indented " Version: not-a-field" line on purpose.
    expect(CONTROL_TEXT).toContain(" Version: not-a-field");
    expect(debIdentityFromControl(CONTROL_TEXT).version).toBe("1.14.1");
  });
  test("a missing Version is null, so checkArtifact can fail closed", () => {
    const noVersion = CONTROL_TEXT.replace("Version: 1.14.1\n", "");
    expect(debIdentityFromControl(noVersion)).toEqual({ packageName: "lucidagentide-desktop", version: null });
  });
  test("CRLF line endings and empty values do not leak into the identity", () => {
    expect(debIdentityFromControl("Package: lucidcreator-desktop\r\nVersion: 1.14.1\r\n")).toEqual({
      packageName: "lucidcreator-desktop",
      version: "1.14.1",
    });
    expect(debIdentityFromControl("Package:\nVersion:   \n")).toEqual({ packageName: null, version: null });
  });
  test("empty or unrelated text is all-null", () => {
    expect(debIdentityFromControl("")).toEqual({ packageName: null, version: null });
    expect(debIdentityFromControl("this is a tarball, not control")).toEqual({ packageName: null, version: null });
  });
});

// --- rpmNameFromLead ---------------------------------------------------------------------------

describe("rpmNameFromLead", () => {
  test("returns the lead's raw name-version-release string", () => {
    expect(rpmNameFromLead(rpmLead("lucidagentide-desktop-1.14.1-1"))).toBe("lucidagentide-desktop-1.14.1-1");
    expect(rpmNameFromLead(rpmLead("lucidcreator-desktop-1.14.1-1"))).toBe("lucidcreator-desktop-1.14.1-1");
  });
  test("a garbage lead is null", () => {
    expect(rpmNameFromLead(rpmLead("lucidagentide-desktop-1.14.1-1", [0x50, 0x4b, 0x03, 0x04]))).toBeNull(); // zip
    expect(rpmNameFromLead(new Uint8Array(96))).toBeNull(); // all zeros: right size, no magic
    expect(rpmNameFromLead(xarHeader())).toBeNull();
  });
  test("a truncated lead is null - the full 96 bytes or nothing", () => {
    expect(rpmNameFromLead(rpmLead("lucidagentide-desktop-1.14.1-1").subarray(0, 95))).toBeNull();
    expect(rpmNameFromLead(new Uint8Array(0))).toBeNull();
  });
  test("an empty name field is null, not an empty-string identity", () => {
    expect(rpmNameFromLead(rpmLead(""))).toBeNull();
  });
  test("FAIL-CLOSED: a non-printable byte in the name field is null, never mojibake as an identity", () => {
    const lead = rpmLead("lucidagentide-desktop-1.14.1-1");
    lead[15] = 0xff;
    expect(rpmNameFromLead(lead)).toBeNull();
  });
  test("a name filling the full 66-byte field does not read past it", () => {
    const long = "a".repeat(66);
    const lead = rpmLead(long);
    lead[76] = 0x41; // a stray 'A' immediately after the name field must not be absorbed
    expect(rpmNameFromLead(lead)).toBe(long);
  });
});

// --- classifyArtifact --------------------------------------------------------------------------

describe("classifyArtifact", () => {
  const cases: readonly [string, ArtifactKind][] = [
    ["LucidAgent-mac-arm64.pkg", "mac-pkg"],
    ["LucidAgent-mac-x64.zip", "mac-zip"],
    ["lucidagentide-desktop_1.14.1_amd64.deb", "deb"],
    ["lucidagentide-desktop-1.14.1.x86_64.rpm", "rpm"],
    ["LucidAgent-Setup.exe", "win-nsis"],
    ["LucidAgent-portable.exe", "win-portable"],
    ["LucidAgent-x86_64.AppImage", "appimage"],
    ["latest.yml", "updater-feed"],
    ["latest-mac.yml", "updater-feed"],
    ["latest-linux.yml", "updater-feed"],
    // The alien file, named after the actual incident report.
    ["TacticalGenAITrainer-Setup.msi", "unknown"],
  ];
  for (const [file, kind] of cases) {
    test(`${file} -> ${kind}`, () => {
      expect(classifyArtifact(file)).toBe(kind);
    });
  }
  test("tolerates a path and mixed case (the upload globs and Windows both are)", () => {
    expect(classifyArtifact("desktop/release/LucidAgent-mac-arm64.pkg")).toBe("mac-pkg");
    expect(classifyArtifact("desktop\\release\\LucidAgent-x86_64.appimage")).toBe("appimage");
    expect(classifyArtifact("release/LATEST-MAC.YML")).toBe("updater-feed");
  });
  test("byproducts and sidecars are unknown, so nothing unaccounted-for slips through", () => {
    expect(classifyArtifact("LucidAgent-Setup.exe.blockmap")).toBe("unknown");
    expect(classifyArtifact("builder-debug.yml")).toBe("unknown");
    expect(classifyArtifact("builder-effective-config.yaml")).toBe("unknown");
    expect(classifyArtifact("")).toBe("unknown");
    // An .exe that is neither the nsis nor the portable target is not something this repo builds.
    expect(classifyArtifact("LucidAgent.exe")).toBe("unknown");
  });
});

// --- checkArtifact -----------------------------------------------------------------------------

describe("checkArtifact", () => {
  test("PASS: a correct Agent pkg", () => {
    expect(checkArtifact(AGENT, AGENT_PKG)).toEqual({
      file: "LucidAgent-mac-arm64.pkg",
      kind: "mac-pkg",
      ok: true,
      problem: null,
    });
  });

  test("THE INCIDENT: a Creator payload inside a correctly named Agent pkg FAILS", () => {
    // Filename says LucidAgent, every embedded byte says Creator. This is the artifact a user cannot
    // inspect, the one that cost a forensic session, and the reason ADR-0307 exists.
    const swapped: ArtifactIdentity = {
      ...AGENT_PKG,
      appId: CREATOR_FLAVOR.appId,
      productPath: "./LucidCreator.app",
      title: "Lucid Creator",
    };
    const finding = checkArtifact(AGENT, swapped);
    expect(finding.ok).toBe(false);
    expect(finding.file).toBe("LucidAgent-mac-arm64.pkg");
    // The problem must name BOTH sides, or a CI log sends the reader back to hand-parsing.
    expect(finding.problem).toContain("com.lucidagentide.desktop");
    expect(finding.problem).toContain("com.lucidcreator.desktop");
  });

  test("FAIL: right bundle id, wrong payload .app inside", () => {
    const finding = checkArtifact(AGENT, { ...AGENT_PKG, productPath: "./LucidCreator.app" });
    expect(finding.ok).toBe(false);
    expect(finding.problem).toContain("LucidAgentIDE.app");
    expect(finding.problem).toContain("LucidCreator.app");
  });

  test("FAIL: version mismatch (a stale payload republished under a new tag)", () => {
    const finding = checkArtifact(AGENT, { ...AGENT_PKG, version: "1.14.0" });
    expect(finding.ok).toBe(false);
    expect(finding.problem).toContain("1.14.1");
    expect(finding.problem).toContain("1.14.0");
  });

  test("FAIL: filename stem mismatch (a Creator-named artifact in an Agent upload set)", () => {
    const finding = checkArtifact(AGENT, { ...AGENT_PKG, file: "LucidCreator-mac-arm64.pkg" });
    expect(finding.ok).toBe(false);
    expect(finding.problem).toContain("LucidAgent");
    expect(finding.problem).toContain("LucidCreator-mac-arm64.pkg");
  });

  test("FAIL: kind unknown - an unaccounted-for file in the upload set", () => {
    const finding = checkArtifact(AGENT, {
      ...BLANK,
      kind: "unknown",
      file: "TacticalGenAITrainer-Setup.msi",
    });
    expect(finding.ok).toBe(false);
    expect(finding.problem).toContain("unrecognized artifact");
    expect(finding.problem).toContain("TacticalGenAITrainer-Setup.msi");
  });

  test("FAIL-CLOSED: a pkg whose identity could not be read does not ship", () => {
    const unreadable: ArtifactIdentity[] = [
      { ...AGENT_PKG, appId: null },
      { ...AGENT_PKG, productPath: null },
      { ...AGENT_PKG, version: null },
    ];
    for (const got of unreadable) {
      const finding = checkArtifact(AGENT, got);
      expect(finding.ok).toBe(false);
      expect(finding.problem).toContain("could not read");
    }
  });

  test("the pkg title is informational: a different display name is not a failure", () => {
    // FlavorExpectation deliberately carries no displayName - marketing copy must not gate a release.
    expect(checkArtifact(AGENT, { ...AGENT_PKG, title: "LUCID" }).ok).toBe(true);
    expect(checkArtifact(AGENT, { ...AGENT_PKG, title: null }).ok).toBe(true);
  });

  const AGENT_DEB: ArtifactIdentity = {
    ...BLANK,
    kind: "deb",
    file: "lucidagentide-desktop_1.14.1_amd64.deb",
    packageName: "lucidagentide-desktop",
    version: "1.14.1",
  };
  test("deb: PASS on the package name, FAIL on a Creator control block or a bad version", () => {
    expect(checkArtifact(AGENT, AGENT_DEB).ok).toBe(true);
    // THE SWAP, deb edition: an Agent-named file whose control block says Creator. Filename passes,
    // control does not, and the problem names both packages.
    const swapped = checkArtifact(AGENT, { ...AGENT_DEB, packageName: "lucidcreator-desktop" });
    expect(swapped.ok).toBe(false);
    expect(swapped.problem).toContain("lucidagentide-desktop");
    expect(swapped.problem).toContain("lucidcreator-desktop");
    // The deb/rpm FILENAME carries the PACKAGE name, not the installer stem, so a wholly Creator deb
    // is caught one layer earlier, by the name.
    const creatorDeb = checkArtifact(AGENT, {
      ...AGENT_DEB,
      file: "lucidcreator-desktop_1.14.1_amd64.deb",
      packageName: "lucidcreator-desktop",
    });
    expect(creatorDeb.ok).toBe(false);
    expect(creatorDeb.problem).toContain("lucidcreator-desktop_1.14.1_amd64.deb");
    expect(checkArtifact(AGENT, { ...AGENT_DEB, version: "1.13.9" }).ok).toBe(false);
    expect(checkArtifact(AGENT, { ...AGENT_DEB, packageName: null }).problem).toContain("could not read");
  });

  const AGENT_RPM: ArtifactIdentity = {
    ...BLANK,
    kind: "rpm",
    file: "lucidagentide-desktop-1.14.1.x86_64.rpm",
    // Raw lead string, exactly what rpmNameFromLead returns.
    packageName: "lucidagentide-desktop-1.14.1-1",
  };
  test("rpm: the raw lead NVR is prefix-matched and its version read from the tail", () => {
    expect(checkArtifact(AGENT, AGENT_RPM).ok).toBe(true);
    // Same lead, wrong version encoded in it.
    expect(checkArtifact(AGENT, { ...AGENT_RPM, packageName: "lucidagentide-desktop-1.13.9-1" }).ok).toBe(false);
    // A version the caller read from the header tags wins over the legacy lead.
    expect(checkArtifact(AGENT, { ...AGENT_RPM, version: "1.14.1" }).ok).toBe(true);
    expect(checkArtifact(AGENT, { ...AGENT_RPM, version: "9.9.9" }).ok).toBe(false);
    // THE SWAP, rpm edition: Agent filename, Creator lead. The problem quotes the raw NVR, since that
    // is the string a human would go read out of the file's first 96 bytes to confirm it.
    const swapped = checkArtifact(AGENT, { ...AGENT_RPM, packageName: "lucidcreator-desktop-1.14.1-1" });
    expect(swapped.ok).toBe(false);
    expect(swapped.problem).toContain("lucidagentide-desktop");
    expect(swapped.problem).toContain("lucidcreator-desktop-1.14.1-1");
    // A wholly Creator rpm is caught one layer earlier, by its filename.
    const creatorRpm = checkArtifact(AGENT, {
      ...AGENT_RPM,
      file: "lucidcreator-desktop-1.14.1.x86_64.rpm",
      packageName: "lucidcreator-desktop-1.14.1-1",
    });
    expect(creatorRpm.ok).toBe(false);
    expect(creatorRpm.problem).toContain("lucidcreator-desktop-1.14.1.x86_64.rpm");
    expect(checkArtifact(AGENT, { ...AGENT_RPM, packageName: null }).problem).toContain("could not read");
  });

  test("filename-only kinds: all-null is normal and passes, a wrong stem does not", () => {
    for (const [file, kind] of [
      ["LucidAgent-mac-arm64.zip", "mac-zip"],
      ["LucidAgent-Setup.exe", "win-nsis"],
      ["LucidAgent-portable.exe", "win-portable"],
      ["LucidAgent-x86_64.AppImage", "appimage"],
    ] as const) {
      expect(checkArtifact(AGENT, { ...BLANK, kind, file }).ok).toBe(true);
      expect(checkArtifact(AGENT, { ...BLANK, kind, file: file.replace("LucidAgent", "LucidCreator") }).ok).toBe(false);
    }
  });

  test("filename-only kinds: a value the caller DID read is still verified", () => {
    const zip = { ...BLANK, kind: "mac-zip" as const, file: "LucidAgent-mac-arm64.zip" };
    expect(checkArtifact(AGENT, { ...zip, appId: CREATOR_FLAVOR.appId }).ok).toBe(false);
    expect(checkArtifact(AGENT, { ...zip, version: "0.0.1" }).ok).toBe(false);
    expect(checkArtifact(AGENT, { ...zip, productPath: "LucidCreator.app" }).ok).toBe(false);
    expect(checkArtifact(AGENT, { ...zip, productPath: "./LucidAgentIDE.app", version: "1.14.1" }).ok).toBe(true);
  });

  test("updater feed: the filename cannot separate the flavors, the declared path can", () => {
    const feed = { ...BLANK, kind: "updater-feed" as const, file: "latest.yml" };
    expect(checkArtifact(AGENT, feed).ok).toBe(true);
    expect(checkArtifact(AGENT, { ...feed, file: "latest-mac.yml" }).ok).toBe(true);
    expect(checkArtifact(AGENT, { ...feed, file: "notlatest.yml" }).ok).toBe(false);
    // Both flavors emit a file named EXACTLY latest.yml; only the `path:` it declares differs.
    expect(checkArtifact(AGENT, { ...feed, productPath: "LucidAgent-Setup.exe" }).ok).toBe(true);
    const foreign = checkArtifact(AGENT, { ...feed, productPath: "LucidCreator-Setup.exe" });
    expect(foreign.ok).toBe(false);
    expect(foreign.problem).toContain("LucidCreator-Setup.exe");
  });

  test("a full pkg round trip: bytes to XML to verdict, Agent passes and Creator does not", () => {
    // The whole read path the CI gate performs, minus the IO: header, XML, identity, verdict.
    expect(parseXarHeader(xarHeader())).not.toBeNull();
    const agentId = pkgIdentityFromXml(DISTRIBUTION_XML, PACKAGE_INFO_XML);
    expect(
      checkArtifact(AGENT, { kind: "mac-pkg", file: "LucidAgent-mac-arm64.pkg", packageName: null, ...agentId }).ok,
    ).toBe(true);
    const creatorId = pkgIdentityFromXml(
      DISTRIBUTION_XML.replaceAll("com.lucidagentide.desktop", "com.lucidcreator.desktop").replace(
        "LucidAgentIDE.app",
        "LucidCreator.app",
      ),
      "",
    );
    expect(
      checkArtifact(AGENT, { kind: "mac-pkg", file: "LucidAgent-mac-arm64.pkg", packageName: null, ...creatorId }).ok,
    ).toBe(false);
  });
});

// --- summarize ---------------------------------------------------------------------------------

describe("summarize", () => {
  const pass = (file: string, kind: ArtifactKind): IdentityFinding => ({ file, kind, ok: true, problem: null });
  const fail = (file: string, kind: ArtifactKind, problem: string): IdentityFinding => ({
    file,
    kind,
    ok: false,
    problem,
  });

  test("all clean: ok and a per-file PASS row", () => {
    const { ok, report } = summarize([
      pass("LucidAgent-mac-arm64.pkg", "mac-pkg"),
      pass("lucidagentide-desktop_1.14.1_amd64.deb", "deb"),
    ]);
    expect(ok).toBe(true);
    expect(report).toContain("ADR-0307");
    expect(report).toContain("PASS  mac-pkg");
    expect(report).toContain("LucidAgent-mac-arm64.pkg");
    expect(report).toContain("2 artifact(s) checked");
    expect(report).not.toContain("FAIL");
  });

  test("one bad artifact fails the whole set and is NAMED, with its mismatch", () => {
    const { ok, report } = summarize([
      pass("LucidAgent-Setup.exe", "win-nsis"),
      fail("LucidAgent-mac-arm64.pkg", "mac-pkg", 'bundle id mismatch: this flavor is "a", the pkg embeds "b"'),
      pass("latest.yml", "updater-feed"),
    ]);
    expect(ok).toBe(false);
    // Named twice on purpose: in its own row and in the summary line, so a truncated log still says
    // which artifact must not ship.
    expect(report).toContain("FAIL  mac-pkg");
    expect(report).toContain("bundle id mismatch");
    expect(report).toContain("FAILED - 1 of 3 artifact(s)");
    expect(report.split("\n").at(-2)).toContain("LucidAgent-mac-arm64.pkg");
  });

  test("every failing file is listed in the summary line", () => {
    const { report } = summarize([
      fail("LucidCreator-Setup.exe", "win-nsis", "filename mismatch"),
      fail("TacticalGenAITrainer-Setup.msi", "unknown", "unrecognized artifact"),
    ]);
    expect(report).toContain("FAILED - 2 of 2 artifact(s)");
    expect(report).toContain("LucidCreator-Setup.exe, TacticalGenAITrainer-Setup.msi");
  });

  test("FAIL-CLOSED: an empty set is NOT ok - a gate that inspected nothing proved nothing", () => {
    const { ok, report } = summarize([]);
    expect(ok).toBe(false);
    expect(report).toContain("NO ARTIFACTS INSPECTED");
    expect(report).toContain("FAILED");
  });

  test("the report is a single trailing-newline block, one row per artifact", () => {
    const { report } = summarize([pass("LucidAgent-Setup.exe", "win-nsis")]);
    expect(report.endsWith("\n")).toBe(true);
    expect(report).not.toContain("  \n"); // no dangling column padding on a PASS row
  });
});
