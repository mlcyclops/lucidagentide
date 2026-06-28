# macOS deployment runbook (Homebrew + Jamf / Munki / Intune)

How to install **LucidAgentIDE** on macOS from the `.pkg`: the Homebrew cask for
single users, and Jamf / Munki / Intune for a managed fleet.

> **Part of PI-4 / ADR-A009.** The `.pkg` is built by
> [`build-desktop.yml`](../.github/workflows/build-desktop.yml). Managed-config
> enforcement is the #74 channel; air-gap distribution is #73.

## Signing reality (no Apple Developer account)

This project does **not** notarize — notarization requires a paid Apple Developer
account. It doesn't need one for these install paths:

- The app is **ad-hoc-signed** by electron-builder (free), which is all Apple
  Silicon requires to *execute* native arm64 code.
- A `.pkg` installed by **`installer(8)`** — what Homebrew's pkg cask and every
  MDM use — lands the app in `/Applications` **without the quarantine flag**, so
  there is **no Gatekeeper prompt**. (Double-clicking the `.pkg` in Finder *would*
  prompt; install via brew or your MDM instead.)

If you ever do enroll, add the Apple signing secrets in
[`desktop/SIGNING.md`](../desktop/SIGNING.md) and the same build notarizes
automatically — nothing else changes.

## Package facts

| Property | Value |
| --- | --- |
| Artifact | `LucidAgentIDE-mac-arm64.pkg`, `LucidAgentIDE-mac-x64.pkg` |
| Install location | `/Applications/LucidAgentIDE.app` (fixed; `isRelocatable=false`) |
| Bundle / package id | `com.lucidagentide.desktop` |
| Signature | ad-hoc (unsigned for Gatekeeper) |
| Upgrade behavior | `overwriteAction=upgrade` — atomic in-place replace; `mustClose` quits a running copy first |
| User data | `~/Library/Application Support/LucidAgentIDE` — **never touched** on install/upgrade |
| Min OS | macOS 11 (Big Sur) |

Apple Silicon and Intel are **separate** packages — scope each to the matching
architecture.

## 1. Homebrew (single user)

```bash
brew tap mlcyclops/lucid https://github.com/mlcyclops/lucidagentide
brew install --cask lucidagentide   # installs the .pkg, no Gatekeeper prompt
brew upgrade --cask lucidagentide   # in-place upgrade, keeps user data
brew uninstall --cask lucidagentide          # remove app, keep user data
brew uninstall --zap --cask lucidagentide    # remove app AND user data
```

The cask uses `allow_untrusted` (legal in a third-party tap) so `installer`
accepts the unsigned pkg, and strips any quarantine flag in a `postflight`.

## 2. Verify the package before fleet deployment

```bash
PKG=LucidAgentIDE-mac-arm64.pkg
pkgutil --check-signature "$PKG"      # expect: no signing certificate (ad-hoc) — that's intended
pkgutil --payload-files "$PKG" | head # sanity: the .app payload is present
sudo installer -pkg "$PKG" -target /  # installs (installer(8) bypasses Gatekeeper)
spctl --assess -vv /Applications/LucidAgentIDE.app 2>&1 || true   # "rejected" is expected for unsigned; it still launches because it's not quarantined
codesign -dv /Applications/LucidAgentIDE.app 2>&1 | grep -i 'Signature=adhoc'  # confirms it'll run on Apple Silicon
```

MDM-deployed and `installer(8)`-deployed packages are not quarantined, so the
unsigned app launches without a prompt — the same reason the Homebrew path works.

## 3. Disable the in-app updater (let MDM own the version)

In managed fleets IT owns the version, so turn off electron-updater and push new
`.pkg`s through the MDM. Drop this admin-only file at the canonical path (see
[`desktop/managed_config.ts`](../desktop/managed_config.ts)):

`/Library/Application Support/LucidAgentIDE/managed-config.json`

```json
{
  "orgName": "Acme Corp",
  "updateChannel": "managed"
}
```

`updateChannel: "managed"` disables the in-app update check. (Use `"feed"` +
`updateFeedUrl` to point at a customer-hosted mirror instead.) The file MUST be
root-owned and **not** group/world-writable or the app ignores it (tamper guard):

```bash
sudo install -d -m 755 "/Library/Application Support/LucidAgentIDE"
sudo install -m 644 managed-config.json "/Library/Application Support/LucidAgentIDE/managed-config.json"
```

It only ever *adds* constraints — it can never relax the security gate.

## 4. Jamf Pro

1. **Upload** both `.pkg`s to your distribution point (Jamf Cloud or on-prem).
2. **Policy → Packages:** add the pkg, action **Install**. Jamf installs via
   `installer`, so the unsigned pkg deploys with no Gatekeeper prompt.
3. **Scope:** a smart group on `Architecture Type` so each Mac gets the right pkg.
4. **Trigger:** Recurring Check-in (silent) and/or Self Service.
5. **Managed config:** deploy `managed-config.json` as a second pkg, or via
   **Files and Processes → Execute Command** (root, mode 644).
6. **Upgrades:** upload the new pkg (same id), flush the policy log, re-run.
   `overwriteAction=upgrade` replaces the app in place; user data survives. For
   staged rollouts, scope on an *Application Version is less than* smart group.

## 5. Munki

```bash
munkiimport LucidAgentIDE-mac-arm64.pkg \
  --name LucidAgentIDE --displayname "LucidAgentIDE" --catalog testing
```

In the pkginfo:

- `unattended_install: true` / `unattended_uninstall: true` for silent runs.
- Keep the auto-detected `receipts` (id `com.lucidagentide.desktop`) so
  `uninstall_method: removepackages` works.
- `minimum_os_version: "11.0"`; optionally `force_install_after_date`.

Ship `managed-config.json` as a tiny companion payload-pkg in the same manifest.

## 6. Microsoft Intune (macOS)

1. **Apps → macOS → Add → macOS app (PKG)** and upload the `.pkg`. Intune
   normally wants a signed pkg; for an unsigned build, wrap the `.pkg` with the
   **Intune App Wrapping Tool** (`IntuneAppUtil`) into a `.intunemac` and upload
   that, or deploy it via a **shell script** running `installer -pkg`.
2. Set **minimum OS = 11.0**.
3. **Managed config:** a **shell script** (root, once) that writes
   `/Library/Application Support/LucidAgentIDE/managed-config.json` (mode 644).
4. **Upgrades:** replace the pkg with the new version; the in-place upgrade
   preserves user data.

## 7. Uninstall

In-place upgrades preserve user data on purpose. A **full** uninstall removes both
the app and the per-user data:

```bash
# 1. Quit + remove the app and forget the receipt
osascript -e 'quit app "LucidAgentIDE"' 2>/dev/null || true
sudo rm -rf /Applications/LucidAgentIDE.app
sudo pkgutil --forget com.lucidagentide.desktop

# 2. Remove user data (the cask `zap` equivalent) — per user, as that user
rm -rf ~/Library/Application\ Support/LucidAgentIDE \
       ~/Library/Caches/com.lucidagentide.desktop \
       ~/Library/Caches/com.lucidagentide.desktop.ShipIt \
       ~/Library/Logs/LucidAgentIDE \
       ~/Library/Preferences/com.lucidagentide.desktop.plist \
       ~/Library/Saved\ Application\ State/com.lucidagentide.desktop.savedState
sudo rm -rf "/Library/Application Support/LucidAgentIDE"   # managed config
```

Skip step 2 to preserve user data across a reinstall.

## 8. Air-gapped sites (#73)

The pkg is self-contained (Bun + uv runtimes are bundled), so install needs no
network. Mirror the `.pkg` to your internal distribution point. For internal
updates, host the electron-updater feed internally and set `updateChannel: "feed"`
+ `updateFeedUrl`; otherwise keep `"managed"` and push each version via the MDM.

## Validation checklist (issue #77 "done when")

- [ ] `brew install --cask lucidagentide` installs and launches with no Gatekeeper prompt.
- [ ] `brew upgrade --cask lucidagentide` upgrades **in place**; `~/Library/Application Support/LucidAgentIDE` is intact.
- [ ] A fleet deploy (Jamf/Munki/Intune) of the `.pkg` installs silently and launches.
- [ ] Installing a newer `.pkg` over the old one upgrades in place, preserving user data.
- [ ] `brew uninstall --zap` (or the step-7 commands) removes the app **and** user data.
