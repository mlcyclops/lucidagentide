# Collecting NIST SP 800-171 Rev 3 evidence from a LUCID Agent IDE host

Run these on the workstation being assessed, as the user who runs LUCID unless a step says administrator. Commands are given for PowerShell (Windows) and bash (macOS / Linux). Nothing here prints a secret value: the vault is reported by custody and entry count only.

## 0. The automated report (all families)

From a LUCID source checkout (or the `resources/repo` folder of an installed build), with Bun installed:

```powershell
bun run tools/compliance/evidence.ts --out "$env:USERPROFILE\lucid-evidence"
# check a specific installed binary's signature:
bun run tools/compliance/evidence.ts --out "$env:USERPROFILE\lucid-evidence" --installer "$env:LOCALAPPDATA\Programs\LucidAgentIDE\LucidAgentIDE.exe"
```

```bash
bun run tools/compliance/evidence.ts --out ~/lucid-evidence
make compliance-evidence EVIDENCE_OUT=~/lucid-evidence
```

It writes `evidence.json` (Contract D `ComplianceReport`) and `evidence.md`, and prints the failing requirement ids. The same JSON is served to the window at `GET /api/compliance/report` (UI token only). Checks it computes: 03.01.03 CUI lockdown, 03.01.05 sandbox policy, 03.03.01 / 03.03.08 audit sink, 03.04.02 managed policy, 03.13.06 egress posture, 03.13.08 vault custody + disk encryption, 03.13.10 key custody, 03.13.11 crypto module, 03.17.03 binary signature, plus 03.01.10 and 03.05.03 stated as customer controls. Run it elevated on Windows to let `manage-bde` read BitLocker status; otherwise disk encryption may report `unknown` with the reason.

Release-level evidence (SBOM, gitleaks, osv-scanner, a runner copy of the report) is the artifact of the `Compliance evidence` GitHub Actions run for the release tag (`.github/workflows/compliance-evidence.yml`).

## 03.01 Access Control

Managed policy and CUI lockdown (03.01.03, 03.01.05, 03.01.12, 03.01.20):

```powershell
Get-Content "$env:ProgramData\LucidAgentIDE\managed-config.json"
reg query "HKLM\Software\Policies\LucidAgentIDE" /s
Get-Acl "$env:ProgramData\LucidAgentIDE" | Format-List Owner, AccessToString
```

```bash
cat "/Library/Application Support/LucidAgentIDE/managed-config.json"   # macOS
cat /etc/lucidagentide/managed-config.json                              # Linux
ls -l /etc/lucidagentide/managed-config.json                            # must not be group/world writable
```

Screens: Settings shows "Managed by <org>" on locked controls; with lockdown on, the DoD Notice and Consent banner appears at launch (03.01.09) and the titlebar shows the CUI / Search session toggle with the violet CUI banner.

Token scoping (03.01.02): with the app running, a request without the UI token is refused.

```powershell
$port = 5319   # default Agent engine port (Creator 5320; PORT / LUCID_PORT override it), desktop/build_flavor.ts
try { Invoke-WebRequest "http://127.0.0.1:$port/api/compliance/report" -UseBasicParsing } catch { $_.Exception.Response.StatusCode }   # Forbidden
```

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5319/api/compliance/report   # 403
```

## 03.03 Audit and Accountability

```powershell
Get-Item "$env:USERPROFILE\.omp\lucid-audit.jsonl" | Format-List FullName, Length, LastWriteTimeUtc
Get-Content "$env:USERPROFILE\.omp\lucid-audit.jsonl" -Tail 5
Get-Acl "$env:USERPROFILE\.omp\lucid-audit.jsonl" | Format-List Owner, AccessToString
Copy-Item "$env:USERPROFILE\.omp\lucid-audit.jsonl" "$env:USERPROFILE\lucid-evidence\"
w32tm /query /status   # 03.03.07 clock source
```

```bash
ls -l ~/.omp/lucid-audit.jsonl
tail -n 5 ~/.omp/lucid-audit.jsonl
cp ~/.omp/lucid-audit.jsonl ~/lucid-evidence/
timedatectl 2>/dev/null || sntp -d time.apple.com 2>/dev/null | tail -n 1
```

Each line is an OCSF Detection Finding (class_uid 2004) with `time` in epoch milliseconds. Screen: Logs view, "Security event export (SIEM)" card shows sink delivery and failure counts (03.03.04) and recent events.

## 03.04 Configuration Management

```powershell
Get-Content "$env:USERPROFILE\lucid-evidence\evidence.json" | Select-String lucidVersion
```

Download `sbom.cdx.json` from the release's `Compliance evidence` run (03.04.10). The "Where to look" table in `README.md` is the information-location record (03.04.11).

## 03.05 Identification and Authentication

LUCID has no own logon; collect OS / IdP evidence:

```powershell
net accounts                                   # lockout and password policy
dsregcmd /status | Select-String "AzureAdJoined|DomainJoined|NgcSet"   # Windows Hello for Business (MFA)
```

```bash
pwpolicy getaccountpolicies 2>/dev/null | head -n 40   # macOS
```

## 03.13 System and Communications Protection

Disk encryption (03.13.08), administrator:

```powershell
manage-bde -status C:
Get-BitLockerVolume | Format-Table MountPoint, VolumeStatus, ProtectionStatus, EncryptionMethod
reg query "HKLM\SYSTEM\CurrentControlSet\Control\Lsa\FipsAlgorithmPolicy" /v Enabled   # OS FIPS policy (03.13.11)
```

```bash
fdesetup status                                  # macOS
lsblk -o NAME,TYPE,MOUNTPOINT | grep crypt       # Linux
cat /proc/sys/crypto/fips_enabled                # Linux kernel FIPS mode
```

Vault custody (03.13.10): `evidence.json` `vault.custody` is `dpapi`, `keychain` or `libsecret` when the master key is OS-held; `plaintext-file` means no OS vault was usable.

```powershell
Get-ChildItem "$env:USERPROFILE\.omp\lucid-engine-vault"   # secrets.v1.json + master.dpapi; contents are ciphertext
```

Egress posture (03.13.06): `evidence.json` `egress.allowAll` must be `false`; the whitelist is `~/.omp/lucid-whitelist.json`.

## 03.14 System and Information Integrity

```powershell
Get-AuthenticodeSignature "$env:LOCALAPPDATA\Programs\LucidAgentIDE\LucidAgentIDE.exe" | Format-List Status, SignerCertificate, TimeStamperCertificate
Get-MpComputerStatus | Format-List AMServiceEnabled, AntivirusSignatureLastUpdated   # endpoint anti-malware (03.14.02)
```

```bash
codesign --verify --deep --strict --verbose=2 /Applications/LucidAgentIDE.app   # expected to fail: macOS builds are unsigned (POA&M P-4)
spctl --assess --verbose /Applications/LucidAgentIDE.app
```

From a source checkout, `make demo-00` proves the scan gate fails closed when the scanner dies.

## 03.17 Supply Chain Risk Management

From the release run of `Compliance evidence`: `sbom.cdx.json`, `gitleaks.json` (redacted), `osv-results.json`, `tool-exit-codes.txt`, `evidence/`. Pair them with the signature output above (03.17.03).

## Families with no LUCID evidence

03.02 Awareness and Training, 03.06 Incident Response, 03.07 Maintenance, 03.08 Media Protection, 03.09 Personnel Security, 03.10 Physical Protection, 03.11 Risk Assessment, 03.12 Security Assessment and Monitoring, 03.15 Planning, 03.16 System and Services Acquisition: evidence comes from the organization's records. For incident support LUCID can produce a redacted support bundle: `powershell -ExecutionPolicy Bypass -File tools\collect-support-logs.ps1`.
