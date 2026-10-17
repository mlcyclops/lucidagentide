# Signing, notarization & auto-update

**Every released Windows build is Authenticode-signed by TECHLEAD 187 LLC.**
A *release run* of [`build-desktop.yml`](../.github/workflows/build-desktop.yml)
or [`build-creator.yml`](../.github/workflows/build-creator.yml) is any run
whose bytes reach a GitHub Release: a `v*` / `creator-v*` tag push, a
`publish_latest` dispatch, or a `beta_release` dispatch. On such a run the
Windows leg **fails** when no signer is configured, twice over: the "Configure
code-signing" step exits non-zero, and `build/win-signing.cjs` throws inside
electron-builder's own config load (`LUCID_RELEASE_RUN=1`). That is P-RELEASE.7
(ADR-0450); `make demo-P-RELEASE.7` proves it. A plain test dispatch (no
publish, no tag) may still build unsigned, so forks and secretless runs keep
producing working installers.

macOS is not yet signed or notarized (no Apple certificate); add the Apple
secrets below and the same workflow signs and notarizes automatically. Auto-update
works either way, but macOS auto-update *requires* a signed build.

The publisher is one string everywhere a user can see it: the certificate's CN
`TECHLEAD 187 LLC` is also `package.json` `author` (which becomes the exe and
installer `CompanyName`, the NSIS Add/Remove Programs publisher and the default
copyright), `appx.publisherDisplayName`, the Linux `vendor`/`maintainer`, the
updater's `publisherName`, and the About dialog. CI's "Verify Authenticode
signatures" step checks the signature **and** the `CompanyName` on every exe.

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
> auto-updates either way; once signed, the updater also checks that each
> update is signed by TECHLEAD 187 LLC.

## GitHub repository secrets

Add under **Settings → Secrets and variables → Actions**. All are optional;
omit a group to skip that platform's signing.

### Windows: Authenticode via Azure Artifact Signing (what this repo uses)

Windows builds (Agent and Creator) are signed by **Azure Artifact Signing**
(formerly Trusted Signing), ADR-0447. The account and certificate profile are
not secrets and live in [`build/win-signing.cjs`](build/win-signing.cjs):

| Setting | Value |
| --- | --- |
| Endpoint | `https://eus.codesigning.azure.net/` (East US) |
| Account | `techlead187signing` (resource group `rg-tl187-codesigning`) |
| Certificate profile | `techlead187-public` (Public Trust, identity validation `978e38c4-…`) |
| Certificate subject | `CN=TECHLEAD 187 LLC, O=TECHLEAD 187 LLC, L=Sun City Center, S=Florida, C=US` |
| Signer identity | Entra app `lucid-ci-signer` (client id `3fd18477-69f8-47c7-bdc9-97098ff5c876`), role **Artifact Signing Certificate Profile Signer** scoped to the profile only |

| Secret | Value |
| --- | --- |
| `AZURE_TENANT_ID` | Entra tenant id (`5c55c021-336f-4429-b737-c18c8157146d`) |
| `AZURE_CLIENT_ID` | `lucid-ci-signer`'s client id. Its presence is the switch: the workflow sets `LUCID_WIN_AZURE_SIGN=1` |
| `AZURE_CLIENT_SECRET` | A client secret of `lucid-ci-signer` (expires **2027-10-14**; rotate before then) |

How it behaves:

- **No `AZURE_CLIENT_ID` (and no `WIN_CSC_LINK`):** a test dispatch builds
  unsigned; a release run (tag, `publish_latest`, `beta_release`) **fails**
  before the build starts (P-RELEASE.7).
- **`AZURE_CLIENT_ID` present:** electron-builder signs every exe, the msi and
  the appx through `Invoke-TrustedSigning`, RFC 3161 timestamped (the
  certificates live 72 hours and renew daily). If the other two secrets are
  missing the build **fails** rather than ship unsigned, and the "Verify
  Authenticode signatures" step fails the job unless every installer and the
  app exe is `Valid`, signed by `CN=TECHLEAD 187 LLC` and timestamped.
- `app-update.yml` carries `publisherName: TECHLEAD 187 LLC`, so an installed
  signed app refuses an update signed by anyone else.
- `appx.publisher` in `package.json` must equal the certificate subject byte
  for byte. If the identity validation is ever renewed with different details,
  update both `build/win-signing.cjs` and `appx.publisher` (and note that a new
  publisher makes MSIX see a new app).

Rotate the client secret (it is piped straight into GitHub, never displayed):

```bash
az ad app credential reset --id 3fd18477-69f8-47c7-bdc9-97098ff5c876 \
  --display-name github-actions-signing --years 1 --append --query password -o tsv \
  | gh secret set AZURE_CLIENT_SECRET -R mlcyclops/lucidagentide
```

**SmartScreen.** Signing replaces "Unknown publisher" with **TECHLEAD 187 LLC**
immediately. The "Windows protected your PC" screen is reputation-based and
fades as signed downloads accumulate; no certificate type skips it. If a signed
release keeps warning, submit it at <https://www.microsoft.com/wdsi> as a
software developer.

### Windows: Authenticode with your own `.pfx` (fallback, e.g. a fork)

Used only when `AZURE_CLIENT_ID` is absent.

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
# Windows, Azure Artifact Signing (PowerShell, on Windows only):
#   $env:LUCID_WIN_AZURE_SIGN="1"; $env:AZURE_TENANT_ID=...; $env:AZURE_CLIENT_ID=...; $env:AZURE_CLIENT_SECRET=...
# Windows, your own .pfx (PowerShell): $env:CSC_LINK=...; $env:CSC_KEY_PASSWORD=...
# macOS/Linux:
export CSC_LINK="$(base64 -w0 cert.p12)"
export CSC_KEY_PASSWORD="…"
# macOS also: APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID
cd desktop && bun run dist:win    # or dist:mac on a Mac
```

Never commit certificates or passwords — they belong only in CI secrets or your
local shell env. `*.p12`, `*.pfx`, `*.key`, and `*.pem` are git-ignored.
