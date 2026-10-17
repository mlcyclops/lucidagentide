# frozen_string_literal: true

cask "lucidagentide" do
  arch arm: "arm64", intel: "x64"

  version "2.4.0"
  sha256 arm:   "016838e3727edcd50d078fd0a823b7cc011cbe3ceb2d948678958adfb04c44a1",
         intel: "3076977a6c9c3cbb7af5ba407d8d157eccea362e5b85dce1b6071b5121ca4a67"

  url "https://github.com/mlcyclops/lucidagentide/releases/download/v#{version}/LucidAgent-mac-#{arch}.zip"
  name "LucidAgentIDE"
  desc "Fail-closed security, provenance, and memory layer around oh-my-pi (omp)"
  homepage "https://github.com/mlcyclops/lucidagentide"

  # The cask is PINNED to a tagged release with real checksums, and CI re-pins it on
  # every stable tag build (the update-cask job in .github/workflows/build-desktop.yml
  # opens a PR with the new version + sha256 pair beside the release). It used to track
  # the rolling "latest" release with sha256 :no_check; that release is only refreshed
  # by a manual dispatch, so `brew install` silently served a weeks-old build with no
  # checksum verification (and in-app auto-update cannot rescue macOS: Squirrel.Mac
  # refuses updates on the unsigned build, ADR-0246). `brew upgrade` is therefore the
  # working macOS update channel, and it must be versioned and verified.
  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on :macos

  # The build is NOT notarized (that needs a paid Apple Developer account); the app
  # IS ad-hoc-signed by electron-builder, so it runs on Apple Silicon. The cask
  # consumes the .zip app bundle with an `app` stanza: Homebrew copies the bundle
  # into /Applications itself, so `installer(8)` and package trust never enter the
  # picture (the old pkg stanza needed `allow_untrusted`, deprecated in Homebrew 6).
  # The .pkg release assets still exist for MDM fleets (Jamf/Munki/Intune), see
  # docs/MACOS-ENTERPRISE-DEPLOYMENT.md; the cask just no longer uses them.
  app "LucidAgentIDE.app"
  # The compiled fail-closed launcher ships INSIDE the app bundle: desktop/package.json
  # compile-lucid writes ../bin/lucid and the extraResources "repo" copy packs bin/**/* into
  # Contents/Resources/repo. Put it on PATH for Homebrew installs, plus a lucid-hub command
  # wrapper that execs `lucid hub "$@"`, so the terminal hub runs from any terminal
  # (including inside herdr) without typing the bundle path.
  binary "#{appdir}/LucidAgentIDE.app/Contents/Resources/repo/bin/lucid"
  command_wrapper "lucid-hub",
                  executable: "#{appdir}/LucidAgentIDE.app/Contents/Resources/repo/bin/lucid",
                  args:       ["hub"]

  # Homebrew quarantines the downloaded zip and the copied app inherits the flag,
  # which would make Gatekeeper refuse the unsigned build on first launch. Strip it
  # here (no sudo: the app-stanza copy is user-owned, unlike the old root-owned
  # pkg payload).
  postflight_steps do
    run "/usr/bin/xattr", args: ["-dr", "com.apple.quarantine", "/Applications/LucidAgentIDE.app"]
  end

  # `brew upgrade` trashes the old bundle and copies the new one; user data under
  # ~/Library is never touched on upgrade, only `zap` (`brew uninstall --zap`)
  # removes it. `pkgutil` stays so upgrades from a pkg-era install (<= 2.3.1)
  # also forget the old installer receipt.
  uninstall quit:    "com.lucidagentide.desktop",
            pkgutil: "com.lucidagentide.desktop"

  # userData is named after desktop/package.json "name", not the product name; a
  # non-default LUCID_PORT instance adds a -<port> suffix.
  zap trash: [
    "~/Library/Application Support/lucidagentide-desktop",
    "~/Library/Application Support/lucidagentide-desktop-*",
    "~/Library/Caches/com.lucidagentide.desktop",
    "~/Library/Caches/com.lucidagentide.desktop.ShipIt",
    "~/Library/Logs/LucidAgentIDE",
    "~/Library/Preferences/com.lucidagentide.desktop.plist",
    "~/Library/Saved Application State/com.lucidagentide.desktop.savedState",
  ]
end
