cask "lucidagentide" do
  arch arm: "arm64", intel: "x64"

  version :latest
  sha256 :no_check

  url "https://github.com/mlcyclops/lucidagentide/releases/download/latest/LucidAgentIDE-mac-#{arch}.pkg"
  name "LucidAgentIDE"
  desc "Fail-closed security, provenance, and memory layer around oh-my-pi (omp)"
  homepage "https://github.com/mlcyclops/lucidagentide"

  # The project ships a single rolling "latest" GitHub release and the app
  # updates itself in place via electron-updater, so there is no per-version
  # tag for Homebrew to track.
  livecheck do
    skip "Rolling 'latest' release; the app self-updates via electron-updater"
  end

  depends_on macos: :big_sur

  # The build is NOT notarized (that needs a paid Apple Developer account). The
  # app IS ad-hoc-signed by electron-builder, so it runs on Apple Silicon, and
  # `installer(8)` (which Homebrew uses for a pkg cask) places it in /Applications
  # WITHOUT the quarantine flag — so it launches with no Gatekeeper prompt.
  # `allow_untrusted` lets installer accept the unsigned package; it's permitted
  # in third-party taps like this one (just not in homebrew/cask).
  pkg "LucidAgentIDE-mac-#{arch}.pkg", allow_untrusted: true

  # Belt-and-suspenders: strip quarantine if anything set it, so the very first
  # launch never trips Gatekeeper.
  postflight do
    system_command "/usr/bin/xattr",
                   args: ["-dr", "com.apple.quarantine", "/Applications/LucidAgentIDE.app"],
                   sudo: true
  end

  # `overwriteAction=upgrade` + `isRelocatable=false` (see desktop/package.json)
  # mean `brew upgrade` replaces the app atomically in /Applications. User data
  # under ~/Library is never touched on upgrade — only `zap` (i.e.
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
