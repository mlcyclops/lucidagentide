cask "lucidagentide" do
  arch arm: "arm64", intel: "x64"

  version "2.3.1"
  sha256 arm:   "b4d1d99e6ae6ff738c107aa0e2bef81fd4b41516ed5f2db3d7867b0105939326",
         intel: "756e520daf6e80a03e69b48cac7a309610c5be594d6955075847fec57801b7f3"

  url "https://github.com/mlcyclops/lucidagentide/releases/download/v#{version}/LucidAgent-mac-#{arch}.zip"
  name "LucidAgentIDE"
  desc "Fail-closed security, provenance, and memory layer around oh-my-pi (omp)"
  homepage "https://github.com/mlcyclops/lucidagentide"

  # The cask is PINNED to a tagged release with real checksums, and CI re-pins it on
  # every tag build (the update-cask job in .github/workflows/build-desktop.yml pushes
  # the new version + sha256 pair to master alongside the release). It used to track
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
