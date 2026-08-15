cask "lucidagentide" do
  arch arm: "arm64", intel: "x64"

  version "1.12.1"
  sha256 arm:   "a9185c7a91af73e6b40ebddfe10632b4b81d1a2c9d2835dc42b71d4930a62b17",
         intel: "21f057b411c8a2c5e14cba66fc2ba1c6fe2c2e0c627e39ac8fa5888dce41b0cc"

  url "https://github.com/mlcyclops/lucidagentide/releases/download/v#{version}/LucidAgent-mac-#{arch}.pkg"
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

  depends_on macos: :big_sur

  # The build is NOT notarized (that needs a paid Apple Developer account). The
  # app IS ad-hoc-signed by electron-builder, so it runs on Apple Silicon, and
  # `installer(8)` (which Homebrew uses for a pkg cask) places it in /Applications
  # WITHOUT the quarantine flag, so it launches with no Gatekeeper prompt.
  # `allow_untrusted` lets installer accept the unsigned package; it's permitted
  # in third-party taps like this one (just not in homebrew/cask).
  pkg "LucidAgent-mac-#{arch}.pkg", allow_untrusted: true

  # Belt-and-suspenders: strip quarantine if anything set it, so the very first
  # launch never trips Gatekeeper.
  postflight do
    system_command "/usr/bin/xattr",
                   args: ["-dr", "com.apple.quarantine", "/Applications/LucidAgentIDE.app"],
                   sudo: true
  end

  # `overwriteAction=upgrade` + `isRelocatable=false` (see desktop/package.json)
  # mean `brew upgrade` replaces the app atomically in /Applications. User data
  # under ~/Library is never touched on upgrade; only `zap` (i.e.
  # `brew uninstall --zap`) removes it.
  uninstall quit:    "com.lucidagentide.desktop",
            pkgutil: "com.lucidagentide.desktop"

  zap trash: [
    "~/Library/Application Support/LucidAgentIDE",
    "~/Library/Caches/com.lucidagentide.desktop",
    "~/Library/Caches/com.lucidagentide.desktop.ShipIt",
    "~/Library/Logs/LucidAgentIDE",
    "~/Library/Preferences/com.lucidagentide.desktop.plist",
    "~/Library/Saved Application State/com.lucidagentide.desktop.savedState",
  ]
end
