cask "lucidagentide" do
  version :latest
  sha256 :no_check

  on_arm do
    url "https://github.com/mlcyclops/lucidagentide/releases/download/latest/LucidAgentIDE-mac-arm64.zip"
  end
  on_intel do
    url "https://github.com/mlcyclops/lucidagentide/releases/download/latest/LucidAgentIDE-mac-x64.zip"
  end

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

  app "LucidAgentIDE.app"

  zap trash: [
    "~/Library/Application Support/LucidAgentIDE",
    "~/Library/Caches/com.lucidagentide.desktop",
    "~/Library/Caches/com.lucidagentide.desktop.ShipIt",
    "~/Library/Logs/LucidAgentIDE",
    "~/Library/Preferences/com.lucidagentide.desktop.plist",
    "~/Library/Saved Application State/com.lucidagentide.desktop.savedState",
  ]

  caveats <<~EOS
    LucidAgentIDE is currently distributed UNSIGNED and is NOT notarized, so
    macOS Gatekeeper will block it after install. (Homebrew 6 removed the
    `--no-quarantine` install flag, so clear the quarantine attribute yourself
    once, after installing:)

      xattr -dr com.apple.quarantine "/Applications/LucidAgentIDE.app"

    Then open it normally. The app keeps itself current afterwards
    (electron-updater pulls from the GitHub "latest" release), so `brew upgrade`
    is rarely needed.
  EOS
end
