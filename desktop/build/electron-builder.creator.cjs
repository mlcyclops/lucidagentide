// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/build/electron-builder.creator.cjs - CREATOR-0 (ADR-0279): the Creator packaging overlay.
//
// The standard build config in desktop/package.json stays THE base and is never edited for Creator. This
// file deep-clones it and overrides exactly the identity fields, so a Creator installer can sit beside the
// Agent installer on one machine: its own appId (which is also the NSIS install GUID), its own product
// name (which is the userData directory and therefore the Windows safeStorage key), its own artifact
// names, its own output directory, its own auto-update feed, and `extraMetadata.lucidBuildFlavor` so the
// packaged app can resolve its flavor with no launch environment variable at all.

const base = require("../package.json").build;
// Deep clone: mutating the shared object would leak Creator identity into the standard build.
const cfg = JSON.parse(JSON.stringify(base));

cfg.appId = "com.lucidcreator.desktop";
cfg.productName = "LucidCreator";
cfg.directories = { ...cfg.directories, output: "release-creator" };
// Packaged identity + the flavor marker desktop/main.ts reads from the app's own package.json.
cfg.extraMetadata = {
  name: "lucidcreator-desktop",
  productName: "LucidCreator",
  lucidBuildFlavor: "creator",
};
// Creator claims its OWN scheme. It must never register lucid:// - that belongs to the Agent build.
cfg.protocols = [{ name: "Lucid Creator", schemes: ["lucid-creator"] }];

// The rolling release tag Creator installs update themselves from. The build-creator.yml workflow
// publishes to this exact tag; electron-builder.creator.test.ts asserts the two still agree, because a
// silent disagreement here does not fail a build, it just stops every installed Creator from updating.
const CREATOR_ROLLING_TAG = "creator-latest";

// Auto-update isolation. The deep clone above also copied Agent's `publish` block, which pointed a
// packaged Creator at electron-updater's GitHub provider for owner/repo mlcyclops/lucidagentide. Read
// what that provider actually does (desktop/node_modules/electron-updater/out/providers/GitHubProvider.js):
// with allowPrerelease unset, which is our case, getLatestVersion takes its tag from getLatestTagName,
// which GETs `/<owner>/<repo>/releases/latest`. That is GitHub's single latest-release POINTER for the
// whole repo, the one `make_latest` moves. It then fetches `releases/download/<that tag>/latest.yml`.
// Both products emit a file named exactly `latest.yml`, and desktop/updater.ts sets autoDownload +
// autoInstallOnAppQuit, so a shipped Creator would have resolved AGENT's rolling release, downloaded
// Agent's installer, and installed it on the next quit. (The atom feed that same function reads is only
// used to attach release notes to the entry matching that tag.)
//
// Renaming the channel does NOT fix it: release SELECTION is still that one repo-wide pointer, so Creator
// would still pick Agent's release and merely 404 looking for its own channel file inside it, i.e. an app
// that never updates again. The selection step has to be skipped entirely, which is what the GENERIC
// provider does: GenericProvider.getLatestVersion fetches `<url>/<channel>.yml` at a fixed URL, with no
// release lookup at all. Pinning that URL to Creator's own rolling tag gives Creator a private feed
// inside the shared repo. Same mechanism managed_config.ts already uses for the enterprise "feed"
// channel, and an enterprise updateFeedUrl still overrides this at runtime through updater.ts.
//
// The hazard runs BOTH ways, which is why build-creator.yml never marks a Creator release `make_latest`:
// if a Creator release ever became the repo's latest pointer, every installed AGENT would resolve
// Creator's tag and pull LucidCreator bytes. Creator publishes, Agent's pointer must not move.
const agentPublish = Array.isArray(base.publish) ? base.publish[0] : base.publish;
cfg.publish = [
  {
    provider: "generic",
    // Derived from Agent's publish target rather than hardcoded, so moving the repo moves both products.
    url: `https://github.com/${agentPublish.owner}/${agentPublish.repo}/releases/download/${CREATOR_ROLLING_TAG}`,
    channel: "latest",
  },
];

cfg.mac = {
  ...cfg.mac,
  artifactName: "LucidCreator-mac-${arch}.${ext}",
  extendInfo: { ...(cfg.mac && cfg.mac.extendInfo), CFBundleDisplayName: "Lucid Creator" },
};
cfg.pkg = { ...cfg.pkg, mustClose: ["com.lucidcreator.desktop"] };
cfg.nsis = { ...cfg.nsis, shortcutName: "Lucid Creator", artifactName: "LucidCreator-Setup.${ext}" };
cfg.portable = { ...cfg.portable, artifactName: "LucidCreator-portable.${ext}" };
cfg.linux = {
  ...cfg.linux,
  desktop: { ...(cfg.linux && cfg.linux.desktop), Name: "Lucid Creator" },
  synopsis: "Sovereignty-aware, fail-closed AI creator studio",
  artifactName: "LucidCreator-x86_64.${ext}",
};
cfg.deb = { ...cfg.deb, artifactName: "lucidcreator-desktop_${version}_${arch}.${ext}" };
cfg.rpm = { ...cfg.rpm, artifactName: "lucidcreator-desktop-${version}.${arch}.${ext}" };

module.exports = cfg;
