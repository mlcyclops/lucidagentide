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

  # The .pkg installs LucidAgentIDE.app into /Applications (isRelocatable=false,
  # overwriteAction=upgrade), so `brew upgrade` replaces the app atomically in
  # place. User data under ~/Library is never touched on upgrade — only `zap`
  # (i.e. `brew uninstall --zap`) removes it.
  pkg "LucidAgentIDE-mac-#{arch}.pkg"

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

  caveats <<~EOS
    LucidAgentIDE ships as a signed + notarized .pkg once the project's Apple
    signing secrets are configured. If you install an interim UNSIGNED build,
    macOS Gatekeeper blocks it — install once from Terminal:

      sudo installer -pkg "$(brew --cache --cask lucidagentide)" -target /

    The app keeps itself current afterwards via electron-updater. For managed
    fleet deployment (Jamf / Munki / Intune), do NOT use this cask — see
    docs/MACOS-ENTERPRISE-DEPLOYMENT.md and push the .pkg through your MDM.
  EOS
end
