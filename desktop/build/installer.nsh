# Copyright (c) 2026 TechLead 187 LLC
# SPDX-License-Identifier: BUSL-1.1

# desktop/build/installer.nsh - electron-builder NSIS include (package.json build.nsis.include; the
# Creator overlay inherits it through its `...cfg.nsis` spread).
#
# P-LEGIBLE.1 (ADR-0384): every launch writes `local-agent-manifest.json` into the app's userData dir,
# and endpoint collectors (Intune remediation, Defender live response) read that file to identify the
# install. userData deliberately survives an uninstall (settings, vault key, logs), so without this hook
# the manifest would keep reporting an install that is gone. On a real uninstall we delete ONLY the
# manifest (and a temp file a crashed write could have left), never the directory or anything else in it.
#
# Which directories: Electron names userData after the app name. The standard build never calls
# app.setName, so it is the package name (APP_PACKAGE_NAME = lucidagentide-desktop); the Creator flavor
# calls app.setName(productName) (PRODUCT_FILENAME = LucidCreator). A non-default LUCID_PORT suffixes the
# dir with -<port> (desktop/main.ts). Both names come from electron-builder's own defines, so this file
# holds no flavor-specific string; clearing the manifest from a dir a flavor never writes to is a no-op.

!define LUCID_AGENT_MANIFEST "local-agent-manifest.json"

# Delete the manifest from $APPDATA\<BASE> and every $APPDATA\<BASE>-<port> sibling.
!macro lucidRemoveAgentManifest BASE
  Push $R0
  Push $R1
  Delete "$APPDATA\${BASE}\${LUCID_AGENT_MANIFEST}"
  Delete "$APPDATA\${BASE}\${LUCID_AGENT_MANIFEST}.*.tmp"
  FindFirst $R0 $R1 "$APPDATA\${BASE}-*"
  ${DoWhile} $R1 != ""
    Delete "$APPDATA\$R1\${LUCID_AGENT_MANIFEST}"
    Delete "$APPDATA\$R1\${LUCID_AGENT_MANIFEST}.*.tmp"
    FindNext $R0 $R1
  ${Loop}
  FindClose $R0
  Pop $R1
  Pop $R0
!macroend

!macro customUnInstall
  # An auto-update runs the old uninstaller with --updated; the app is still installed, so keep it.
  ${ifNot} ${isUpdated}
    # Electron always uses per-user app data, even for a per-machine install (same switch as
    # electron-builder's own --delete-app-data path).
    ${if} $installMode == "all"
      SetShellVarContext current
    ${endif}
    !insertmacro lucidRemoveAgentManifest "${APP_PACKAGE_NAME}"
    !insertmacro lucidRemoveAgentManifest "${PRODUCT_FILENAME}"
    ${if} $installMode == "all"
      SetShellVarContext all
    ${endif}
  ${endif}
!macroend
