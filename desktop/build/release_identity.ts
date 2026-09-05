// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/build/release_identity.ts - P-RELEASE.4 (ADR-0307): the release identity gate, pure core.
//
// THE INCIDENT this exists to prevent, 2026-08-30: a user reported that "v1.14.1 installed the
// Tactical GenAI Trainer instead of LUCID". The release turned out to be genuine - but PROVING that
// cost a full forensic session of hand-parsing the shipped bytes: peeling the 28-byte xar header off
// the .pkg to reach its Distribution XML, walking the .deb's `ar` members to read `control`, reading
// the .rpm lead byte by byte. That session produced an answer nobody could reproduce and a guarantee
// nobody had. This module is that session frozen into code, moved from "after a user complains" to
// "before the upload": flavor identity becomes a machine-checked PRECONDITION of shipping, so an
// artifact whose EMBEDDED identity (bundle id, payload .app path, package name, version) disagrees
// with the flavor being built never reaches a user, and never needs exonerating.
//
// The failure is not hypothetical for this repo: ONE branch builds TWO products from ONE config tree
// (desktop/build_flavor.ts, build/electron-builder.creator.cjs), which is exactly how an Agent-
// identified artifact ends up in a Creator upload set, or the reverse. Filenames are the weakest
// possible evidence there - they are a template string an override can change without touching a
// single byte of embedded identity - so this gate reads what is INSIDE the artifact.
//
// PURE by design: no fs, no zlib, no network, no electron, no dependencies. Callers hand over bytes
// and strings; desktop/build/release-identity-gate.ts owns the IO (ranged reads, decompression, tar
// walking) and the exit code the workflows gate on. Every parse, every decision and the report text
// are unit-tested here rather than improvised inside a CI script that only ever executes on a
// release tag (house pattern: desktop/port_guard.ts, desktop/gpu_watchdog.ts - pure decision core,
// wiring at the callsite).
//
// FAIL-CLOSED throughout (AGENTS.md invariant 3): an unreadable identity, an unrecognized file and
// an empty artifact set are all failures. "I could not check it" is never "it is fine".

/**
 * The artifact shapes a release upload set may contain. Closed set: a new target is a deliberate
 * contract change, not a new string, because `unknown` is a HARD FAILURE - an unexpected file in an
 * upload set is precisely the condition being guarded (the incident was a wrong PRODUCT shipping
 * under a right-looking name).
 */
export type ArtifactKind =
  | "mac-pkg"
  | "mac-zip"
  | "deb"
  | "rpm"
  | "win-nsis"
  | "win-portable"
  | "appimage"
  | "updater-feed"
  | "unknown";

/**
 * What the caller managed to read OUT of one artifact. Every identity field is nullable because it
 * is an observation, not a promise: a truncated download, a target that embeds no identity at all,
 * or a parse that did not recognize the shape all produce null. Whether null is acceptable depends
 * on the kind and is decided by checkArtifact, never by the reader.
 *
 * - `appId`      .pkg bundle/product id, i.e. electron-builder's `appId`.
 * - `productPath` the payload's `.app` path ("LucidAgentIDE.app"), or - for an updater feed - the
 *   artifact path the feed DECLARES. Normalized (no leading "./").
 * - `packageName` .deb `Package:` field, or the .rpm lead's RAW name-version-release string.
 * - `version`    the artifact's own embedded version, not the tag it was uploaded under.
 * - `title`      the installer's display title. INFORMATIONAL: reported, never compared, because a
 *   display name is marketing copy and FlavorExpectation deliberately carries no displayName.
 */
export interface ArtifactIdentity {
  kind: ArtifactKind;
  file: string;
  appId: string | null;
  productPath: string | null;
  packageName: string | null;
  version: string | null;
  title: string | null;
}

/**
 * What the flavor being built MUST look like from the outside. Built from desktop/build_flavor.ts's
 * AGENT_FLAVOR / CREATOR_FLAVOR plus desktop/package.json's `name` and `version`, so the gate can
 * never disagree with the shipping identity without one of those files changing.
 *
 * `artifactStem` is the installer filename stem (LucidAgent / LucidCreator); `debRpmName` is the
 * Linux PACKAGE name (lucidagentide-desktop / lucidcreator-desktop). They are different strings on
 * purpose: electron-builder interpolates `${name}` into the deb/rpm artifactName patterns and the
 * flavor stem into everything else (desktop/package.json build.deb.artifactName).
 */
export interface FlavorExpectation {
  appId: string;
  productName: string;
  artifactStem: string;
  debRpmName: string;
  version: string;
}

/** One artifact's verdict. `problem` is a single human line naming BOTH sides of the mismatch, so a
 *  failing CI log is self-explanatory without re-running the forensics that motivated ADR-0307. */
export interface IdentityFinding {
  file: string;
  kind: ArtifactKind;
  ok: boolean;
  problem: string | null;
}

// --- filename classification -------------------------------------------------------------------

/**
 * Classify an artifact by NAME alone. This decides only which checks apply, never whether the
 * artifact is legitimate: that is checkArtifact's job, using the embedded identity.
 *
 * Tolerates a path (only the basename matters) and case (Windows and the GitHub upload globs are
 * both case-insensitive; ".AppImage" is capitalized in the real artifact name).
 *
 * Anything unrecognized is "unknown", which checkArtifact treats as a failure. That includes
 * electron-builder byproducts (`builder-debug.yml`) and `.blockmap` companions: the CALLER owns the
 * decision of which files form the upload set, and a file that reached this function without being
 * filtered is, by definition, an artifact-shaped thing nobody accounted for.
 */
export function classifyArtifact(fileName: string): ArtifactKind {
  const base = basename(fileName);
  const lower = base.toLowerCase();
  if (!lower) return "unknown";
  // The auto-update feed: electron-builder emits latest.yml (win) / latest-mac.yml / latest-linux.yml.
  // Matched by SHAPE rather than an exhaustive list so a new platform channel is covered on arrival.
  if (/^latest(-[a-z0-9]+)?\.ya?ml$/.test(lower)) return "updater-feed";
  if (lower.endsWith(".pkg")) return "mac-pkg";
  // zip is a mac-only target here (desktop/package.json build.mac.target); win ships nsis + portable.
  if (lower.endsWith(".zip")) return "mac-zip";
  if (lower.endsWith(".deb")) return "deb";
  if (lower.endsWith(".rpm")) return "rpm";
  if (lower.endsWith(".appimage")) return "appimage";
  if (lower.endsWith(".exe")) {
    // Two win targets, separated by their artifactName patterns: "LucidAgent-Setup.exe" (nsis) and
    // "LucidAgent-portable.exe" (portable). An .exe that is neither is not something this repo
    // builds, so it stays unknown rather than being guessed into a kind.
    if (lower.includes("portable")) return "win-portable";
    if (lower.includes("setup")) return "win-nsis";
    return "unknown";
  }
  return "unknown";
}

// --- the verdict -------------------------------------------------------------------------------

/**
 * Compare one artifact's observed identity against the flavor being built. FAIL-CLOSED: every path
 * out of this function that is not a positive match is `ok: false`.
 *
 * Two layers, in order:
 *  1. FILENAME - applies to every kind. deb/rpm must start with the package name, an updater feed
 *     must be named latest*.yml, everything else must start with the flavor's artifact stem.
 *  2. EMBEDDED IDENTITY - only mac-pkg, deb and rpm carry one. For those, a null field is a FAILURE
 *     (unreadable identity proves nothing). For the kinds that embed nothing reachable without
 *     unpacking (mac-zip, win-nsis, win-portable, appimage, updater-feed) all-null is the normal
 *     case and passes - but any field the caller DID manage to read is still verified, because
 *     evidence is never discarded.
 *
 * The filename layer runs first because it is universal, and the embedded layer second because it is
 * the one that catches the actual incident class: a Creator payload inside a correctly named Agent
 * installer passes layer 1 and fails layer 2.
 */
export function checkArtifact(expected: FlavorExpectation, got: ArtifactIdentity): IdentityFinding {
  const finding = (problem: string | null): IdentityFinding => ({
    file: got.file,
    kind: got.kind,
    ok: problem === null,
    problem,
  });
  const base = basename(got.file) || got.file;

  // An unaccounted-for file in an upload set is the failure, not a curiosity to be skipped.
  if (got.kind === "unknown") {
    return finding(
      `unrecognized artifact in the release dir: "${base}" is not a known ${expected.artifactStem} target,` +
        " and an upload set must contain nothing this gate cannot identify",
    );
  }

  // --- layer 1: filename ---
  if (got.kind === "updater-feed") {
    if (classifyArtifact(base) !== "updater-feed") {
      return finding(`updater feed must be named latest*.yml, got "${base}"`);
    }
  } else {
    // deb/rpm are named after the PACKAGE (electron-builder interpolates `${name}` into their
    // artifactName patterns), every other target after the flavor stem.
    const linuxPkg = got.kind === "deb" || got.kind === "rpm";
    const stem = linuxPkg ? expected.debRpmName : expected.artifactStem;
    if (!base.startsWith(stem)) {
      return finding(
        `filename mismatch: the ${got.kind} ${linuxPkg ? "package" : "artifact"} must start with "${stem}", got "${base}"`,
      );
    }
  }

  // --- layer 2: embedded identity ---
  switch (got.kind) {
    case "mac-pkg":
      return finding(checkPkg(expected, got));
    case "deb":
      return finding(checkDeb(expected, got));
    case "rpm":
      return finding(checkRpm(expected, got));
    default:
      return finding(checkFilenameOnlyKind(expected, got));
  }
}

/** The .pkg is the artifact the original forensic session had to hand-parse, so it is the one with
 *  the most identity to check: product id, payload .app, version. All three must agree. */
function checkPkg(expected: FlavorExpectation, got: ArtifactIdentity): string | null {
  if (got.appId === null) {
    return "could not read the embedded bundle id from the pkg (Distribution/PackageInfo unreadable) - an unverifiable installer does not ship";
  }
  if (got.appId !== expected.appId) {
    // THE SWAP: correct filename, foreign payload. Exactly what a user cannot see and what cost a
    // full session to establish by hand.
    return `bundle id mismatch: this flavor is "${expected.appId}", the pkg embeds "${got.appId}"`;
  }
  const wantPath = `${expected.productName}.app`;
  if (got.productPath === null) {
    return "could not read the payload .app path from the pkg - an unverifiable installer does not ship";
  }
  if (normalizePayloadPath(got.productPath) !== wantPath) {
    return `pkg payload mismatch: expected to install "${wantPath}", the pkg installs "${got.productPath}"`;
  }
  if (got.version === null) {
    return "could not read the embedded version from the pkg - an unverifiable installer does not ship";
  }
  if (got.version !== expected.version) {
    return `version mismatch: building ${expected.version}, the pkg embeds ${got.version}`;
  }
  return null;
}

/**
 * The semver being built, expressed the way DEBIAN and RPM are allowed to express it.
 *
 * Neither format may contain `-` in the version field: Debian reads `-` as the separator before the
 * Debian revision, and RPM reads it as the separator before the release. So fpm (via electron-builder)
 * correctly rewrites a semver PRERELEASE separator to `~`, which is also the character both ecosystems
 * sort BEFORE the plain release, exactly matching prerelease semantics. `2.1.1-test.101` therefore ships
 * as `2.1.1~test.101`, and it is the artifact that is right, not the expectation.
 *
 * This gate compared the embedded string literally, so EVERY prerelease build failed its deb and rpm
 * checks. Tag builds carry a clean version with no `-` and passed, which hid it: the only path that
 * stamps a prerelease is the manual `workflow_dispatch` that refreshes the rolling `latest` release, so
 * that job could never once have run to completion. That is why the rolling downloads (and the website
 * links pointing at them) went stale.
 *
 * Deliberately narrow: ONLY the prerelease separator is translated. A genuine version mismatch, a stale
 * payload republished under a new tag, or a mis-stamped build all still fail, which is the whole point
 * of ADR-0307.
 */
export function debRpmVersion(semver: string): string {
  return (semver ?? "").replace(/-/g, "~");
}

function checkDeb(expected: FlavorExpectation, got: ArtifactIdentity): string | null {
  if (got.packageName === null) {
    return "could not read Package: from the deb's control file - an unverifiable package does not ship";
  }
  if (got.packageName !== expected.debRpmName) {
    return `deb package name mismatch: this flavor is "${expected.debRpmName}", control says "${got.packageName}"`;
  }
  if (got.version === null) {
    return "could not read Version: from the deb's control file - an unverifiable package does not ship";
  }
  const wantDeb = debRpmVersion(expected.version);
  if (got.version !== wantDeb) {
    return `version mismatch: building ${expected.version} (deb form ${wantDeb}), control says ${got.version}`;
  }
  return null;
}

/**
 * The rpm lead's name field is the RAW name-version-release ("lucidagentide-desktop-1.14.1-1"), not
 * a bare package name: rpmNameFromLead returns it verbatim rather than guessing where the name ends,
 * because the package name itself contains hyphens and only the EXPECTED name tells us where to cut.
 * So the split happens here, where the expectation is in hand: prefix-match the name, then read the
 * version out of the tail.
 */
function checkRpm(expected: FlavorExpectation, got: ArtifactIdentity): string | null {
  if (got.packageName === null) {
    return "could not read the name from the rpm lead - an unverifiable package does not ship";
  }
  const nvr = got.packageName;
  const prefix = `${expected.debRpmName}-`;
  if (!nvr.startsWith(prefix)) {
    return `rpm package name mismatch: this flavor is "${expected.debRpmName}", the rpm lead says "${nvr}"`;
  }
  // Tail is "<version>-<release>"; the version runs to the next "-".
  const leadVersion = nvr.slice(prefix.length).split("-")[0] ?? "";
  // A version the caller read from the header tags is more authoritative than the legacy lead, so it
  // wins when present; the lead-derived value is the fallback.
  const observed = got.version ?? (leadVersion.length > 0 ? leadVersion : null);
  if (observed === null) {
    return `could not determine the rpm version (lead: "${nvr}") - an unverifiable package does not ship`;
  }
  const wantRpm = debRpmVersion(expected.version);
  if (observed !== wantRpm) {
    return `version mismatch: building ${expected.version} (rpm form ${wantRpm}), the rpm says ${observed}`;
  }
  return null;
}

/**
 * mac-zip / win-nsis / win-portable / appimage / updater-feed embed nothing this gate can reach
 * without unpacking the artifact, so their filename check (already done) is the contract. All-null
 * is therefore NOT a mismatch. Anything the caller did read is still checked, and for the updater
 * feed that is the only real check available: both flavors emit a file named EXACTLY `latest.yml`
 * (see build/electron-builder.creator.cjs - a Creator resolving Agent's feed would replace itself
 * with Agent bytes on the next quit), so the feed's DECLARED artifact path is what separates them.
 */
function checkFilenameOnlyKind(expected: FlavorExpectation, got: ArtifactIdentity): string | null {
  if (got.appId !== null && got.appId !== expected.appId) {
    return `bundle id mismatch: this flavor is "${expected.appId}", the ${got.kind} declares "${got.appId}"`;
  }
  if (got.version !== null && got.version !== expected.version) {
    return `version mismatch: building ${expected.version}, the ${got.kind} declares ${got.version}`;
  }
  if (got.productPath !== null) {
    if (got.kind === "updater-feed") {
      const declared = basename(got.productPath);
      if (!declared.startsWith(expected.artifactStem)) {
        return `updater feed points at a foreign artifact: expected a path starting with "${expected.artifactStem}", the feed declares "${got.productPath}"`;
      }
    } else {
      const wantPath = `${expected.productName}.app`;
      if (normalizePayloadPath(got.productPath) !== wantPath) {
        return `payload mismatch: expected "${wantPath}", the ${got.kind} contains "${got.productPath}"`;
      }
    }
  }
  return null;
}

// --- the report --------------------------------------------------------------------------------

/**
 * Render the whole upload set's verdict as one block for the CI log, and decide the gate's exit.
 *
 * `ok` requires at least one finding. "every finding is ok" over an EMPTY set is vacuously true,
 * which is how a green check comes to mean nothing at all - the same trap desktop/build/airgap-smoke
 * guards against when it is aimed at a stale output tree. A gate that inspected nothing proved
 * nothing, so it fails and says why.
 *
 * Failing files are named twice - once in their own row with the mismatch, once in the summary line -
 * so both a truncated log tail and a skimmed log body identify the artifact that must not ship.
 */
export function summarize(findings: readonly IdentityFinding[]): { ok: boolean; report: string } {
  const failed = findings.filter((f) => !f.ok);
  const ok = findings.length > 0 && failed.length === 0;

  const kindWidth = Math.max(4, ...findings.map((f) => f.kind.length));
  const fileWidth = Math.max(8, ...findings.map((f) => f.file.length));
  const lines = [
    "release identity gate (ADR-0307): embedded identity of every artifact about to be uploaded",
    "",
  ];
  if (findings.length === 0) {
    lines.push("  NO ARTIFACTS INSPECTED - the gate was handed an empty set, so it proved nothing.");
  }
  for (const f of findings) {
    const row = `  ${f.ok ? "PASS" : "FAIL"}  ${f.kind.padEnd(kindWidth)}  ${f.file.padEnd(fileWidth)}`;
    lines.push(f.problem === null ? row.trimEnd() : `${row}  ${f.problem}`);
  }
  lines.push("");
  lines.push(
    ok
      ? `  OK - ${findings.length} artifact(s) checked, every embedded identity matches the flavor being built.`
      : `  FAILED - ${failed.length} of ${findings.length} artifact(s) do not match the flavor being built: ` +
        `${failed.length === 0 ? "(nothing was inspected)" : failed.map((f) => f.file).join(", ")}`,
  );
  return { ok, report: `${lines.join("\n")}\n` };
}

// --- xar / .pkg --------------------------------------------------------------------------------

const XAR_MAGIC = 0x78617221; // "xar!"
const XAR_HEADER_BYTES = 28;

/**
 * Parse the 28-byte xar header that opens every .pkg. Everything is BIG-endian:
 *   0..3   magic 0x78617221 ("xar!")
 *   4..5   uint16 header size (28 for every xar in the wild, but read, never assumed)
 *   6..7   uint16 format version
 *   8..15  uint64 compressed TOC length
 *   16..23 uint64 uncompressed TOC length
 *   24..27 uint32 checksum algorithm
 *
 * The two fields returned are exactly what a caller needs to read the next slice: the TOC is the
 * `headerSize` bytes in, `tocCompressedLength` bytes long, zlib-deflated, and contains the XML that
 * names Distribution and PackageInfo. Doing that read is the caller's job (this module is pure).
 *
 * Returns null - never a guess - for anything that is not a xar we can navigate: a short buffer,
 * wrong magic (the exact case where the "pkg" is actually some other file), a header that claims to
 * be smaller than the fields it must contain, or a TOC length of zero or beyond safe-integer range.
 */
/** One heap-backed `<file>` entry as recorded in a xar TOC. */
export interface XarHeapMember {
  readonly name: string;
  readonly offset: number;
  readonly length: number;
}

/** Locate every heap-backed member in a xar TOC.
 *
 *  ELEMENT-SCOPED on purpose. A xar TOC is nested XML: a directory is a `<file>` holding child `<file>`
 *  elements, and a heap-backed entry is a `<file>` that owns a `<data>` block. Two real-world details
 *  make global proximity matching wrong, both verified against a shipped installer's TOC
 *  (fixtures/real-mac-pkg-toc.xml, captured from the v1.14.1 mac pkg):
 *    1. `<data>` comes BEFORE `<name>` inside a `<file>`. Pairing each `<data>` with the nearest
 *       PRECEDING `<name>` therefore labels every member with the PREVIOUS file's name and drops the
 *       first member entirely, since nothing precedes it. That is not hypothetical: it shipped, and the
 *       mac job of the first v1.14.2 tag build refused a perfectly good installer, reporting
 *       `saw: com.lucidagentide.desktop.pkg, Bom, Payload` for an archive whose real members are
 *       Distribution, Bom, Payload and PackageInfo.
 *    2. `<name>` is commonly repeated twice for the same file, so take the first and stop.
 *  So each `<file>` is read within its OWN header region - everything up to its first nested `<file>`,
 *  which is where xar puts a file's `<data>` and a directory's `<name>`. A directory owns no `<data>` in
 *  that region and is correctly not a member.
 *
 *  `<length>` is the ARCHIVED (compressed) byte count in the heap, which is what a range read needs;
 *  `<size>` is the extracted size and is deliberately ignored. Regex over machine-generated,
 *  never-user-authored markup is the right tool here; pulling an XML parser into a build gate is not. */
export function xarHeapMembers(toc: string): XarHeapMember[] {
  const starts: number[] = [];
  for (const m of toc.matchAll(/<file\b/g)) starts.push(m.index ?? 0);
  const out: XarHeapMember[] = [];
  for (let i = 0; i < starts.length; i++) {
    const region = toc.slice(starts[i]!, starts[i + 1] ?? toc.length);
    const data = /<data>([\s\S]*?)<\/data>/.exec(region);
    if (!data) continue; // a directory owns no heap bytes
    const name = /<name>([^<]*)<\/name>/.exec(region);
    const offset = /<offset>(\d+)<\/offset>/.exec(data[1] ?? "");
    const length = /<length>(\d+)<\/length>/.exec(data[1] ?? "");
    if (!name?.[1] || !offset || !length) continue;
    out.push({ name: name[1], offset: Number(offset[1]), length: Number(length[1]) });
  }
  return out;
}

export function parseXarHeader(head: Uint8Array): { headerSize: number; tocCompressedLength: number } | null {
  if (head.byteLength < XAR_HEADER_BYTES) return null;
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (dv.getUint32(0, false) !== XAR_MAGIC) return null;
  const headerSize = dv.getUint16(4, false);
  if (headerSize < XAR_HEADER_BYTES) return null;
  const tocCompressedLength = dv.getBigUint64(8, false);
  if (tocCompressedLength <= 0n || tocCompressedLength > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { headerSize, tocCompressedLength: Number(tocCompressedLength) };
}

/**
 * Pull the flavor identity out of a .pkg's two XML files.
 *
 * Distribution (productbuild) carries:
 *   <product id="com.lucidagentide.desktop" version="1.14.1"/>
 *   <title>Lucid Agent</title>
 *   <bundle ... id="..." path="LucidAgentIDE.app"/>
 * PackageInfo (pkgbuild) carries:
 *   <pkg-info ... identifier="com.lucidagentide.desktop" install-location="/Applications">
 *   <bundle path="./LucidAgentIDE.app" id="..." CFBundleShortVersionString="1.14.1">
 *
 * Distribution is preferred because it is the installer's own declaration of what it installs, with
 * PackageInfo as a PER-FIELD fallback: a pkg built by pkgbuild alone has no Distribution at all, and
 * a Distribution without a <bundle-version> block still yields the payload path from PackageInfo.
 * Pass "" for a file that is absent - null out, never a throw.
 *
 * REGEX, NOT AN XML PARSER, DELIBERATELY: both files are generated by Apple's own pkgbuild /
 * productbuild ("InstallCmds" in the generator-version attribute), so their shape is stable and we
 * need exactly four attributes and one element's text out of them. A real parser means another
 * dependency inside the release-critical build path and more failure modes for zero gain, while a
 * tolerant attribute match that returns null on anything it does not recognize composes correctly
 * with a gate whose whole posture is fail-closed. The matchers assume neither quote style,
 * attribute order, nor self-closing form.
 */
export function pkgIdentityFromXml(
  distributionXml: string,
  packageInfoXml: string,
): { appId: string | null; productPath: string | null; version: string | null; title: string | null } {
  const appId = attr(distributionXml, "product", "id") ?? attr(packageInfoXml, "pkg-info", "identifier");
  const version =
    attr(distributionXml, "product", "version") ?? attr(packageInfoXml, "bundle", "CFBundleShortVersionString");
  const rawPath = attr(distributionXml, "bundle", "path") ?? attr(packageInfoXml, "bundle", "path");
  // Only Distribution has a human title; PackageInfo has no equivalent, so no fallback exists.
  const title = tagText(distributionXml, "title");
  return {
    appId,
    productPath: rawPath === null ? null : normalizePayloadPath(rawPath),
    version,
    title,
  };
}

/** One attribute off one tag. The `(?=[\s/>])` lookahead keeps `<bundle` from matching
 *  `<bundle-version`, and `[^>]*?` keeps the attribute search inside the opening tag it started in. */
function attr(xml: string, tag: string, name: string): string | null {
  if (!xml) return null;
  const re = new RegExp(`<${tag}(?=[\\s/>])[^>]*?\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i");
  const m = re.exec(xml);
  if (!m) return null;
  const value = (m[2] ?? m[3] ?? "").trim();
  return value.length > 0 ? value : null;
}

/** The text of the first `<tag>...</tag>`. Used only for the informational installer title. */
function tagText(xml: string, tag: string): string | null {
  if (!xml) return null;
  const m = new RegExp(`<${tag}(?=[\\s>])[^>]*>([\\s\\S]*?)</${tag}\\s*>`, "i").exec(xml);
  const value = m?.[1]?.trim() ?? "";
  return value.length > 0 ? value : null;
}

/**
 * PackageInfo writes the payload as "./LucidAgentIDE.app" while Distribution writes
 * "LucidAgentIDE.app". Same bundle, two spellings, so both normalize to the bare relative path
 * before comparison. A LEADING "/" is left intact on purpose: an absolute payload path is a genuine
 * difference and should fail rather than be normalized away.
 */
function normalizePayloadPath(raw: string): string {
  let p = raw.trim().replace(/\\/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  return p.replace(/\/+$/, "");
}

// --- ar / .deb ---------------------------------------------------------------------------------

const AR_MAGIC = "!<arch>\n";
const AR_HEADER_BYTES = 60;

/**
 * Walk a .deb's `ar` table of contents. A .deb is a plain `ar` archive of exactly three members -
 * `debian-binary`, `control.tar.*`, `data.tar.*` - and the one we want is the control tarball.
 *
 * Layout: the 8-byte magic "!<arch>\n", then per member a 60-byte ASCII header followed by its data
 * padded to an EVEN length. Within a header only two fields matter here:
 *   0..15  name, terminated by "/" and space padded (GNU ar), e.g. "control.tar.gz/ "
 *   48..57 size in decimal ASCII
 *
 * The even padding is not cosmetic: skip it and the SECOND member's header lands one byte off and
 * the walk desynchronizes into garbage, which is exactly the kind of hand-parsing error the original
 * forensic session had to debug by eye.
 *
 * `head` may be a PREFIX of the file: the returned offsets are absolute file offsets for the caller
 * to seek to, so a member whose data lies beyond the buffer is still reported. The walk simply stops
 * once a full 60-byte header is no longer available, or at the first header it cannot parse.
 *
 * Not an `ar` archive (wrong or missing magic) returns [] - the caller then has no control member to
 * read and fails closed on a null packageName. GNU long-name members ("/123" pointing into a "//"
 * string table) are returned verbatim rather than resolved: no .deb produced by electron-builder
 * uses them, and inventing support for an untestable path would be worse than not having it.
 */
export function arMembers(head: Uint8Array): { name: string; offset: number; size: number }[] {
  const out: { name: string; offset: number; size: number }[] = [];
  if (head.byteLength < AR_MAGIC.length) return out;
  for (let i = 0; i < AR_MAGIC.length; i++) {
    if (head[i] !== AR_MAGIC.charCodeAt(i)) return out;
  }

  let cursor = AR_MAGIC.length;
  while (cursor + AR_HEADER_BYTES <= head.byteLength) {
    const name = ascii(head, cursor, 16).trim().replace(/\/+$/, "");
    const size = Number.parseInt(ascii(head, cursor + 48, 10).trim(), 10);
    // A size we cannot read means we no longer know where the next header is: stop rather than
    // resynchronize on a guess.
    if (!Number.isSafeInteger(size) || size < 0) break;
    const offset = cursor + AR_HEADER_BYTES;
    if (name.length > 0) out.push({ name, offset, size });
    cursor = offset + size + (size % 2);
  }
  return out;
}

/** Fixed-width ASCII field. `ar` headers and the rpm lead are both plain ASCII by specification. */
function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let s = "";
  for (let i = offset; i < offset + length && i < bytes.byteLength; i++) {
    s += String.fromCharCode(bytes[i] ?? 0);
  }
  return s;
}

/**
 * Read the identity out of a .deb's `control` text:
 *   Package: lucidagentide-desktop
 *   Version: 1.14.1
 *
 * Fields are line-anchored so a folded field's continuation line (Description:, indented by a
 * space) can never be mistaken for a field of its own, and field names are matched
 * case-insensitively as Debian policy specifies. A missing or empty field is null, which
 * checkArtifact turns into a failure - control is generated by electron-builder, so a missing
 * Package/Version means we are not looking at the file we think we are.
 */
export function debIdentityFromControl(control: string): { packageName: string | null; version: string | null } {
  return {
    packageName: controlField(control, "Package"),
    version: controlField(control, "Version"),
  };
}

function controlField(control: string, field: string): string | null {
  if (!control) return null;
  // `.` excludes newlines, so a value stops at the end of its line; trim() drops a CRLF's "\r".
  const m = new RegExp(`^${field}[ \\t]*:[ \\t]*(.*)$`, "im").exec(control);
  const value = m?.[1]?.trim() ?? "";
  return value.length > 0 ? value : null;
}

// --- rpm ---------------------------------------------------------------------------------------

const RPM_LEAD_MAGIC = [0xed, 0xab, 0xee, 0xdb] as const;
const RPM_LEAD_BYTES = 96;
const RPM_LEAD_NAME_OFFSET = 10;
const RPM_LEAD_NAME_MAX = 66;

/**
 * Read the package name out of an .rpm's 96-byte lead:
 *   0..3   magic ED AB EE DB
 *   4      major version, 5 minor
 *   6..7   type, 8..9 archnum
 *   10..75 name, NUL-terminated char[66]
 *   76..77 osnum, 78..79 signature type, 80..95 reserved
 *
 * The lead is legacy - rpm itself only trusts the signature and header sections - but it is the one
 * identity field readable from the first 96 bytes with no decompression at all, which makes it the
 * cheapest possible flavor check and exactly the field the original forensic session read by hand.
 *
 * Returns the string VERBATIM, i.e. "lucidagentide-desktop-1.14.1-1" (name-version-release), NOT a
 * bare package name. Splitting it here would mean guessing where the name ends, and the package name
 * itself contains hyphens; only the expectation knows where to cut, so checkArtifact does the
 * prefix match and reads the version out of the tail.
 *
 * Fail-closed on anything that is not a lead we understand: a buffer shorter than the full lead,
 * wrong magic, an empty name, or any non-printable byte inside the name field (mojibake reported as
 * an identity would be worse than no answer).
 */
export function rpmNameFromLead(lead: Uint8Array): string | null {
  if (lead.byteLength < RPM_LEAD_BYTES) return null;
  for (let i = 0; i < RPM_LEAD_MAGIC.length; i++) {
    if (lead[i] !== RPM_LEAD_MAGIC[i]) return null;
  }
  let name = "";
  for (let i = 0; i < RPM_LEAD_NAME_MAX; i++) {
    const b = lead[RPM_LEAD_NAME_OFFSET + i] ?? 0;
    if (b === 0) break;
    if (b < 0x20 || b > 0x7e) return null;
    name += String.fromCharCode(b);
  }
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// --- shared ------------------------------------------------------------------------------------

/** Basename on either separator: CI hands us posix paths, a Windows runner hands us backslashes. */
function basename(p: string): string {
  return (p.split(/[\\/]/).pop() ?? "").trim();
}
