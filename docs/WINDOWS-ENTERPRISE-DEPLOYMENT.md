# Windows deployment runbook (MSI / SCCM + MSIX / Intune)

How to package, sign, and deploy **LucidAgentIDE** on managed Windows fleets:
SCCM (ConfigMgr) with the MSI, Intune with either a Win32 wrap of the MSI or the
AppX/MSIX package. Upgrades happen in place and never touch user data.

> **Part of PI-4 / ADR-A009 (issue #345, add-on #75).** The `.msi` and `.appx` are
> built by [`build-desktop.yml`](../.github/workflows/build-desktop.yml)
> (electron-builder, `dist:win`). Managed-config enforcement is the add-on #74
> channel (ADR-A010 GPO/Intune templates); air-gap self-containment is ADR-0225
> and gates this same CI job.

## Package facts

| Property | Value |
| --- | --- |
| Artifacts | `LucidAgent-${version}-x64.msi`, `LucidAgent-${version}-x64.appx` (plus the existing `LucidAgent-Setup.exe` NSIS + `LucidAgent-portable.exe`) |
| Install location | `C:\Program Files\LucidAgentIDE\` (MSI is `perMachine`) |
| App id | `com.lucidagentide.desktop` |
| MSI UpgradeCode | `2568ebca-6784-4546-9463-9765440afaf3`, pinned forever in `desktop/package.json` and enforced by `desktop/win_packaging.test.ts` |
| AppX identity | `TechLead187.LucidAgent`, publisher `CN=TechLead 187 LLC` |
| Signature | **unsigned from CI** by default; Authenticode rides the `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` secrets when present, or the org signs post-build (see 2) |
| Upgrade behavior | MSI major upgrade replaces only what the package owns under Program Files; MSIX updates by version on the same identity |
| User data | `%APPDATA%\LucidAgentIDE` (+ `%LOCALAPPDATA%` cache): settings, the encrypted knowledge graph, `knowledge.duckdb`, the audit log. **Never packaged, never touched** on upgrade or uninstall |
| Admin policy | `%ProgramData%\LucidAgentIDE\managed-config.json`: **not packaged** (deployed via ADR-A010 GPO/ADMX or Intune), so upgrades never clobber it |

Only x64 is built today (matches every other platform's published arch).

## Why upgrades never clobber user state

The package owns only the app under Program Files plus shortcuts. No user-editable
file ships in the MSI or the AppX:

- **Per-user state** lives under `%APPDATA%\LucidAgentIDE`, written by the app at
  runtime. Windows Installer only removes components the package owns, so a major
  upgrade (same UpgradeCode, higher version) swaps the binaries and leaves
  `%APPDATA%` alone. MSIX is stricter still: per-user app data survives updates by
  design.
- **Admin policy** (`managed-config.json`) is deployed out of band (ADR-A010), not
  by these packages.
- **The UpgradeCode is the whole contract.** Same UpgradeCode + higher
  `ProductVersion` = in-place upgrade. A changed UpgradeCode = a second product
  side by side, broken supersedence, orphaned installs. That is why the value is
  pinned in `desktop/package.json` and asserted by `desktop/win_packaging.test.ts`;
  CI fails on drift.

Migration note: earlier fleets that used the NSIS `LucidAgent-Setup.exe` installed
per-user. Moving to the MSI does not migrate or remove that copy automatically:
uninstall the NSIS entry (per user or via script), then deploy the MSI. User data is
unaffected either way because both variants use the same `%APPDATA%\LucidAgentIDE`.

## 1. Build the packages

CI (`build-desktop.yml`, `windows-latest`) builds all four Windows artifacts and
attaches them to the run artifacts, tag releases, and the rolling `latest` release.
The ADR-0225 air-gap smoke runs on the same job before anything is uploaded, so a
non-self-contained installer cannot ship. Locally, on a Windows box:

```powershell
cd desktop
bun install
bun run dist:win     # runtimes (SHA-pinned) -> icons -> build -> NSIS + portable + MSI + AppX
```

Output lands in `desktop/release/`. The MSI build uses WiX via electron-builder;
`warningsAsErrors` is off because the harvested app tree is large.

## 2. Sign

Two supported paths, no secrets in the repo either way:

- **CI signing (preferred once a cert exists).** Put the org's Authenticode cert in
  the `WIN_CSC_LINK` (base64 PFX or a URL) and `WIN_CSC_KEY_PASSWORD` repo secrets.
  The existing "Configure code-signing" step in `build-desktop.yml` exports them
  only when present and electron-builder signs the exe/msi/appx during the build.
- **Post-build signing** (org PKI, HSM, or a signing service):

```powershell
signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 `
  /f org-codesign.pfx /p <password> LucidAgent-1.12.0-x64.msi
signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 `
  /f org-codesign.pfx /p <password> LucidAgent-1.12.0-x64.appx
```

Rules that bite if skipped:

- **MSIX/AppX must be signed** with a cert the target devices trust, and the cert
  subject must equal the package `publisher` (`CN=TechLead 187 LLC`). Intune refuses
  unsigned LOB MSIX. For a different org CN, re-set `appx.publisher` at build time
  or repackage; do not edit the checked-in value casually (the identity test pins
  its shape, and changing publisher makes updates look like a new app).
- **Always timestamp** (`/tr`): signatures must outlive the cert.
- The MSI installs unsigned (SmartScreen warns interactively; SCCM/Intune SYSTEM
  installs do not care), so an unsigned pilot is possible; production should sign.

## 3. SCCM (ConfigMgr): deploy the MSI

1. Content: drop `LucidAgent-${version}-x64.msi` on the content share.
2. **Application** > Create Application > "Windows Installer (*.msi file)". SCCM
   reads ProductCode/ProductVersion automatically.
3. Deployment type defaults are right for this package:
   - Install: `msiexec /i "LucidAgent-<version>-x64.msi" /qn /norestart`
   - Uninstall: `msiexec /x {ProductCode} /qn /norestart`
   - Detection method: Windows Installer ProductCode (auto-filled).
   - Install behavior: **Install for system** (the MSI is perMachine).
4. Deploy to a device collection. No reboot required.
5. **Upgrades:** import the next version's MSI as a new application revision (or a
   new application with a supersedence rule). Same UpgradeCode means Windows
   Installer performs a major upgrade in place: old binaries out, new in,
   `%APPDATA%` untouched. Each version has a distinct ProductCode, so detection
   stays unambiguous per revision.

## 4. Intune: Win32 wrap of the MSI (recommended path)

Intune's LOB MSI type works too, but the Win32 app type gives requirements,
detection, and supersedence control, so it is the default here:

1. Wrap: `IntuneWinAppUtil.exe -c <folder-with-msi> -s LucidAgent-<version>-x64.msi -o <out>`
   producing `LucidAgent-<version>-x64.intunewin`.
2. Intune > Apps > Windows > Add > **Win32 app**; upload the `.intunewin`.
   - Install: `msiexec /i "LucidAgent-<version>-x64.msi" /qn /norestart`
   - Uninstall: `msiexec /x {ProductCode} /qn /norestart`
   - Install behavior: **System**.
   - Detection: MSI ProductCode (paste from the MSI; `Get-MsiProductCode` or the
     SCCM console shows it).
3. **Upgrades:** add the next version as a new Win32 app, set a **supersedence**
   relationship on the previous one (mode: update). The major upgrade preserves
   user data exactly as in the SCCM path.

## 5. Intune: MSIX/AppX line-of-business app

For fleets standardized on MSIX servicing:

1. Sign the `.appx` with an org cert trusted by the devices (2). Deploy the trust
   (cert to `Trusted People`/root via Intune certificate profile) if the org CA is
   not already trusted.
2. Intune > Apps > Windows > Add > **Line-of-business app**; upload the signed
   `.appx`.
3. **Upgrades:** upload the next version on the same identity
   (`TechLead187.LucidAgent` + publisher). MSIX updates in place by version;
   per-user data survives by design.

AppContainer note: MSIX runs the app inside the packaged-app sandbox with
virtualized filesystem/registry writes. LucidAgentIDE's own runtime containment
(ADR-A020 / `lucid-appcontainer`) is independent of the install technology; both
compose. If a capability the app needs is blocked under full MSIX
containerization on an older Windows build, fall back to the Win32/MSI path (4).

## 6. Validation checklist (runner-bound)

Same discipline as Linux (#76) / macOS (#77): the packaging contract is enforced in
CI (`win_packaging.test.ts` + the ADR-0225 air-gap smoke); the fleet checks below
need a real Windows device or VM per target channel.

- [ ] Fresh install (SCCM or Intune, SYSTEM context) lands in Program Files, app
      launches, first run needs **no network** for runtimes (ADR-0225).
- [ ] Create state (settings change, a knowledge-graph entry), install version
      N+1 in place, state intact under `%APPDATA%\LucidAgentIDE`.
- [ ] `msiexec /x` uninstall leaves `%APPDATA%\LucidAgentIDE` behind (user data is
      the user's; org wipe policy is a separate Intune script if wanted).
- [ ] Signed artifacts: `signtool verify /pa` passes; MSIX installs without the
      sideload trust prompt.
- [ ] Supersedence: N -> N+1 shows as an upgrade, not a second entry in
      Programs and Features.
