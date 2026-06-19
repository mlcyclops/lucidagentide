# Signing, notarization & auto-update

The desktop app builds **unsigned by default** — the GitHub Actions workflow
([`build-desktop.yml`](../.github/workflows/build-desktop.yml)) produces working
installers with zero certificates. Signing is **opt-in**: add the secrets below
and the same workflow signs (and, on macOS, notarizes) automatically. Auto-update
works either way, but macOS auto-update *requires* a signed build.

## How auto-update works

- Packaged builds check the project's **GitHub Releases** on launch
  (`publish` provider in [`package.json`](package.json); wired in
  [`updater.ts`](updater.ts) via `electron-updater`).
- A newer release downloads in the background; the app then prompts
  **Restart now / Later**.
- The feed is the release assets electron-builder emits beside each installer:
  `latest.yml` (Windows) / `latest-mac.yml` (macOS) + the `.blockmap` files. The
  workflow attaches all of them to the Release on tag builds.

To cut a release: bump `version` in `package.json`, then

```bash
git tag v0.2.0 && git push origin v0.2.0
```

The workflow builds every installer, uploads the metadata, and installed apps
pick it up on next launch.

> **macOS:** Squirrel.Mac refuses to apply **unsigned** updates — mac auto-update
> only works once you add the Apple signing secrets below. Windows (NSIS)
> auto-updates unsigned (SmartScreen may still warn until you sign).

## GitHub repository secrets

Add under **Settings → Secrets and variables → Actions**. All are optional;
omit a group to skip that platform's signing.

### Windows — Authenticode

| Secret | Value |
| --- | --- |
| `WIN_CSC_LINK` | Base64 of your code-signing `.pfx`/`.p12`: `base64 -w0 cert.pfx` |
| `WIN_CSC_KEY_PASSWORD` | The `.pfx` password |

### macOS — Developer ID + notarization

| Secret | Value |
| --- | --- |
| `MAC_CSC_LINK` | Base64 of your "Developer ID Application" `.p12` |
| `MAC_CSC_KEY_PASSWORD` | The `.p12` password |
| `APPLE_ID` | Your Apple Developer account email |
| `APPLE_APP_SPECIFIC_PASSWORD` | An app-specific password (appleid.apple.com) |
| `APPLE_TEAM_ID` | Your 10-character Apple Team ID |

With the mac secrets present, the workflow signs with the Developer ID identity
and runs `notarytool`; the hardened-runtime entitlements are already in
[`build/entitlements.mac.plist`](build/entitlements.mac.plist).

## Signing locally (optional)

electron-builder reads the same env vars locally:

```bash
# Windows (PowerShell): $env:CSC_LINK=...; $env:CSC_KEY_PASSWORD=...
# macOS/Linux:
export CSC_LINK="$(base64 -w0 cert.p12)"
export CSC_KEY_PASSWORD="…"
# macOS also: APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID
cd desktop && bun run dist:win    # or dist:mac on a Mac
```

Never commit certificates or passwords — they belong only in CI secrets or your
local shell env. `*.p12`, `*.pfx`, `*.key`, and `*.pem` are git-ignored.
