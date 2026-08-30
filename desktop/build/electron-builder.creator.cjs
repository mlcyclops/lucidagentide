// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/build/electron-builder.creator.cjs - CREATOR-0 (ADR-0279): the Creator packaging overlay.
//
// The standard build config in desktop/package.json stays THE base and is never edited for Creator. This
// file deep-clones it and overrides exactly the identity fields, so a Creator installer can sit beside the
// Agent installer on one machine: its own appId (which is also the NSIS install GUID), its own product
// name (which is the userData directory and therefore the Windows safeStorage key), its own artifact
// names, its own output directory, and `extraMetadata.lucidBuildFlavor` so the packaged app can resolve
// its flavor with no launch environment variable at all.

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
