<!-- GENERATED from control-matrix-r3.csv by `bun run tools/compliance/matrix.ts`. Edit the CSV, not this file. -->

# LUCID Agent IDE: NIST SP 800-171 Rev 3 control matrix

Primary baseline NIST SP 800-171 Rev 3 (May 2024), with a Rev 2 cross-reference column because DoD / CMMC assessments still cite Rev 2.

Sources (requirement ids, titles and withdrawals are copied from these, never invented):

- NIST SP 800-171r3, https://doi.org/10.6028/NIST.SP.800-171r3 (PDF https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-171r3.pdf): requirement ids, titles, and the Withdrawn dispositions.
- NIST OSCAL catalog, https://github.com/usnistgov/oscal-content/blob/main/nist.gov/SP800-171/rev3/json/NIST_SP800-171_rev3_catalog.json: titles cross-checked for the families it was read for.
- NIST change analysis Rev 2 to Rev 3, https://csrc.nist.gov/files/pubs/sp/800/171/r3/final/docs/sp800-171r2-to-r3-analysis.xlsx: the Rev 2 to Rev 3 row mapping.

Coverage: 130 Rev 3 identifiers in 17 families; 97 requirements and 33 withdrawn.

Rev 2 column rule: the Rev 2 requirement on the same row of the NIST change analysis, plus every Rev 2 requirement whose Rev 3 slot is withdrawn with a note naming this requirement (Incorporated into / Addressed by). `[verify]` marks a reference where the two NIST sources disagree.

Responsibility: LUCID (the product implements it), shared (LUCID provides a capability the customer must configure or operate), customer (the organization's process or infrastructure), n-a (withdrawn).
Status of the LUCID part: implemented, partial, planned (an in-flight increment), gap (see poam.md), customer (nothing for LUCID to implement).

Totals over the 97 requirements: implemented 11, partial 28, planned 2, gap 2, customer 54. Responsibility: LUCID 5, shared 36, customer 56.

Paths are relative to the repository root. `evidence.json` is the output of `bun run tools/compliance/evidence.ts --out <dir>` (see evidence-guide.md).

## Access Control

| R3 id | Title | R2 | Responsibility | LUCID implementation | How to verify | Evidence | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 03.01.01 | Account Management | 3.1.1; 3.13.3 | customer | LUCID has no account system of its own: it runs as the signed-in OS user (NSIS perMachine false, desktop/package.json). Managed policy can require a corporate attribution email and restrict its domain (desktop/managed_config.ts emailDomainAllowed, skipAllowed). | Review OS / IdP account procedures. Open managed-config.json and check attribution.allowedDomains. | OS account inventory; managed-config.json | customer |
| 03.01.02 | Access Enforcement | 3.1.2; 3.13.3 | shared | The engine API is loopback-only and token-scoped: UI token opens every route, the agent token opens only AGENT_ROUTES, a paired controller token opens only CONTROLLER_ROUTES (desktop/origin_guard.ts apiAuthorized, desktop/dev.ts AGENT_ROUTES, desktop/controller/routes.ts). Managed workspaceRoots confines the folder browser (desktop/managed_config.ts managedWorkspaceRoots). | Call a human-only route (e.g. /api/compliance/report) with the agent token and confirm 403. Read origin_guard.test.ts. | HTTP 403 transcript; desktop/origin_guard.ts | implemented |
| 03.01.03 | Information Flow Enforcement | 3.1.3; 3.13.3 | shared | CUI lockdown (AskSage-only routing, user flag or managed asksageOnly / models.asksageOnly): every turn, utility completion and Creator provider is clamped to the gov gateway or an attested DGX enclave host, and public web egress is blocked in CUI sessions (desktop/lockdown_route.ts, desktop/cui_policy.ts, desktop/acp_backend.ts asksageLocked). Managed models.allowed / models.denied filter routing (managed_config.ts modelAllowed). | Set managed asksageOnly, restart, try a direct provider and a web search in a CUI session; both are refused and audited. Run evidence.ts and read check 03.01.03. | evidence.json check 03.01.03; lucid-audit.jsonl egress block lines | implemented |
| 03.01.04 | Separation of Duties | 3.1.4; 3.13.3 | customer | Human-only decisions (security approvals, sandbox switch, scheduled jobs) are not reachable with the agent token (desktop/dev.ts AGENT_ROUTES comments). Duty separation between people is the organization's. | Review the organization's role definitions. | SSP roles section | customer |
| 03.01.05 | Least Privilege | 3.1.5; 3.4.9; 3.13.3 | shared | Agent shell commands run in a sandbox backend: Windows AppContainer (tools/appcontainer/lucid_appcontainer.ts), macOS Seatbelt, Linux bubblewrap, or a disclosed passthrough (harness/runs/sandbox_exec.ts). Folder access is explicit grants (desktop/sandbox_grants.ts). Managed security.exec.requireIsolation fails exec closed when isolation is unavailable; security.sandbox.allowUserOff false and lockUserFolders lock it (managed_config.ts). | Run evidence.ts and read check 03.01.05. On Windows, run a command in a contained session and confirm it cannot read an ungranted folder. | evidence.json check 03.01.05; managed-config.json | partial |
| 03.01.06 | Least Privilege – Privileged Accounts | 3.1.6; 3.4.9; 3.13.3 | customer | The per-user installer does not require elevation (NSIS perMachine false, desktop/package.json); LUCID runs as a standard user. | Confirm users run LUCID from a non-administrator account. | OS group membership listing | customer |
| 03.01.07 | Least Privilege – Privileged Functions | 3.1.7; 3.4.9; 3.13.3 | shared | Exec commands are risk-tiered T0 to T4; T4 always prompts and managed policy sets a ceiling (desktop/exec_policy.ts, desktop/managed_config.ts clampToManaged). Approvals are recorded (harness/security/approvals.ts approval_events, EventName approval_granted / approval_denied) and exec decisions go to the OCSF audit file (desktop/audit_export.ts). | Trigger a destructive command; confirm the prompt and an exec decision line in lucid-audit.jsonl. | lucid-audit.jsonl exec lines | partial |
| 03.01.08 | Unsuccessful Logon Attempts | 3.1.8 | customer | No LUCID logon. OS / IdP lockout applies. | Review OS account lockout policy (secpol / MDM). | GPO account lockout export | customer |
| 03.01.09 | System Use Notification | 3.1.9 | shared | The DoD/STIG Notice and Consent banner is shown once per launch in CUI lockdown and must be explicitly acknowledged (desktop/renderer/app.ts DOD_CONSENT_BANNER, showDodBanner). An OS logon banner is the customer's. | Turn lockdown on and relaunch; the banner appears and has no dismiss except acknowledge. | Screenshot of the banner; OS legal notice GPO | partial |
| 03.01.10 | Device Lock | 3.1.10 | customer | No in-app session lock (POA&M P-2); the OS screen lock is the control. | Review OS inactivity lock policy (GPO / MDM). | GPO screen saver / lock export | gap |
| 03.01.11 | Session Termination | 3.1.11 | customer | No LUCID-level user session termination; OS sign-out applies. The embedded collaboration relay drops idle sockets after 120 s (desktop/collab/relay_server.ts idleTimeoutSec). | Review OS session policy. | GPO export | customer |
| 03.01.12 | Remote Access | 3.1.12; 3.1.13 [verify]; 3.1.14; 3.1.15; 3.13.7 | shared | Remote surfaces are opt-in and governed: the embedded collaboration relay (managed collab.allowServe, allowedBinds fail-closed for LAN binds, allowedRelays, desktop/managed_config.ts authorizeRelayBind / authorizeRelayConnect); relay guests authenticate with a verified Firebase ID token (desktop/collab/relay_auth.ts); paired controllers use their own token scope (desktop/controller/store.ts, routes.ts). | Set collab.allowServe false and confirm the relay toggle is disabled; inspect managed-config.json collab block. | managed-config.json; relay refusal message | partial |
| 03.01.13 | Withdrawn: Addressed by 03.13.08. [verify: the NIST r2-to-r3 change analysis xlsx says Incorporated into 03.01.12] | 3.1.13 | n-a |   |   |   | withdrawn |
| 03.01.14 | Withdrawn: Incorporated into 03.01.12. | 3.1.14 | n-a |   |   |   | withdrawn |
| 03.01.15 | Withdrawn: Incorporated into 03.01.12. | 3.1.15 | n-a |   |   |   | withdrawn |
| 03.01.16 | Wireless Access | 3.1.16; 3.1.17 | customer | Not a LUCID function. | Review wireless configuration. | Network configuration records | customer |
| 03.01.17 | Withdrawn: Incorporated into 03.01.16. | 3.1.17 | n-a |   |   |   | withdrawn |
| 03.01.18 | Access Control for Mobile Devices | 3.1.18; 3.1.19 | customer | Not a LUCID function. The remote PWA (tools/remote-pwa) is a relay guest; mobile device control is the customer's MDM. | Review MDM enrollment and encryption policy. | MDM compliance report | customer |
| 03.01.19 | Withdrawn: Incorporated into 03.01.18. | 3.1.19 | n-a |   |   |   | withdrawn |
| 03.01.20 | Use of External Systems | 3.1.20; 3.1.21 | shared | External AI services are governed by CUI lockdown (cui.authorization required for cloud Creator providers, desktop/cui_policy.ts) and managed models.allowed / denied; relays by collab.allowedRelays. | Inspect managed-config.json models and collab blocks; run evidence.ts check 03.01.03. | managed-config.json | partial |
| 03.01.21 | Withdrawn: Incorporated into 03.01.20. | 3.1.21 | n-a |   |   |   | withdrawn |
| 03.01.22 | Publicly Accessible Content | 3.1.22 | customer | Not a LUCID function. | Review publishing procedures. | Procedure document | customer |

## Awareness and Training

| R3 id | Title | R2 | Responsibility | LUCID implementation | How to verify | Evidence | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 03.02.01 | Literacy Training and Awareness | 3.2.1; 3.2.3 | customer | Not a LUCID function. docs/compliance/README.md supports user briefings. | Review training records. | Training records | customer |
| 03.02.02 | Role-Based Training | 3.2.2 | customer | Not a LUCID function. | Review training records. | Training records | customer |
| 03.02.03 | Withdrawn: Incorporated into 03.02.01. | 3.2.3 | n-a |   |   |   | withdrawn |

## Audit and Accountability

| R3 id | Title | R2 | Responsibility | LUCID implementation | How to verify | Evidence | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 03.03.01 | Event Logging | 3.3.1 | shared | Security decisions (scanner block, exec, egress, loop, approval) become versioned SecurityEvents written as OCSF Detection Finding lines to ~/.omp/lucid-audit.jsonl (desktop/audit_export.ts FileSink, LUCID_AUDIT_PATH override). Telemetry events are a frozen EventName list (harness/contracts.ts). Managed logging.enabled false disables the sink. | Run evidence.ts and read check 03.03.01; tail lucid-audit.jsonl after a blocked egress. | lucid-audit.jsonl; evidence.json check 03.03.01 | implemented |
| 03.03.02 | Audit Record Content | 3.3.2 | shared | Each SecurityEvent carries id, UTC ts, host, category, type, decision, severity, tool, tier, sessionId and, when the caller supplies it, identity and orgName (desktop/audit_export.ts). User identity is not always populated. | Read five lines of lucid-audit.jsonl and check the fields. | lucid-audit.jsonl sample | partial |
| 03.03.03 | Audit Record Generation | 3.3.3 | shared | Generation as in 03.03.01. No rotation or retention policy in the file sink; retention is the customer's (SIEM or file archive). | Confirm the file is collected by the SIEM / backup with the retention policy. | SIEM retention setting | partial |
| 03.03.04 | Response to Audit Logging Process Failures | 3.3.4 | shared | Sink failures are counted with the last error and shown in the Logs view (GET /api/audit sink statuses, desktop/audit_export.ts sinkStatuses). No alert is raised; logging never blocks a decision. | Make the audit path unwritable, trigger an event, and read the failed counter in Logs. | Logs view screenshot | partial |
| 03.03.05 | Audit Record Review, Analysis, and Reporting | 3.3.5 | customer | In-app Security event export card (Logs view) and the lucid hub Audit deck read the recent events (desktop/dev.ts /api/audit, harness/launcher/hub_tui.ts). Review is the customer's (SIEM). | Show the SIEM search that ingests lucid-audit.jsonl. | SIEM saved search | customer |
| 03.03.06 | Audit Record Reduction and Report Generation | 3.3.6 | shared | OCSF JSONL is SIEM-ingestable unchanged; the original lines are append-only and time-ordered (desktop/audit_export.ts). Reduction is the SIEM's. | Ingest the file and filter by category. | SIEM report | partial |
| 03.03.07 | Time Stamps | 3.3.7 | LUCID | Event ts is ISO 8601 UTC from the system clock; OCSF time is epoch milliseconds (desktop/audit_export.ts emit, toOcsf). Clock sync is the customer's. | Read a line: ts ends in Z. Check w32tm / timedatectl. | lucid-audit.jsonl line; time sync status | implemented |
| 03.03.08 | Protection of Audit Information | 3.3.8; 3.3.9 | shared | The audit file lives in the user profile under default permissions, append-only by code but not hash-chained; managed logging.sink names a SIEM for off-host copies (connectors are in the private add-on, ADR-A011). | Run evidence.ts and read check 03.03.08; Get-Acl / ls -l on the file. | evidence.json check 03.03.08; ACL listing | partial |
| 03.03.09 | Withdrawn: Incorporated into 03.03.08. | 3.3.9 | n-a |   |   |   | withdrawn |

## Configuration Management

| R3 id | Title | R2 | Responsibility | LUCID implementation | How to verify | Evidence | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 03.04.01 | Baseline Configuration | 3.4.1 | shared | Baseline = the managed policy file or GPO (desktop/managed_config.ts) plus pinned runtimes: Bun, uv and CPython by version and SHA-256 (desktop/build/fetch-runtimes.ts), omp pinned in package.json. | Export managed-config.json and the installed version (evidence.json lucidVersion). | managed-config.json; evidence.json | partial |
| 03.04.02 | Configuration Settings | 3.4.2; 3.13.7 | shared | Managed policy sets and locks the security knobs (exec ceiling, egress allow/deny lists, loop dial, sandbox, models, collab, workspace roots); a managed value only tightens (desktop/managed_config.ts, ADR-0068). | Run evidence.ts and read check 03.04.02; open the policy file or reg query HKLM\Software\Policies\LucidAgentIDE. | evidence.json check 03.04.02 | implemented |
| 03.04.03 | Configuration Change Control | 3.4.3 | customer | LUCID's own changes are recorded as ADRs and gated by CI (.github/workflows/ci.yml). Customer system change control is the customer's. | Review the customer change board records. | Change tickets | customer |
| 03.04.04 | Impact Analyses | 3.4.4 | customer | Release notes per version (desktop/version.ts) inform impact analysis. | Review the impact analysis for the LUCID version in use. | Change ticket | customer |
| 03.04.05 | Access Restrictions for Change | 3.4.5 | shared | The policy file must sit in an admin-only path (%ProgramData%\LucidAgentIDE, /Library/Application Support/LucidAgentIDE, /etc/lucidagentide) or HKLM; on POSIX a group/world-writable file is ignored (desktop/managed_config.ts trustworthy). LUCID never writes it. | Check the ACL of the policy directory (Get-Acl / ls -l). | ACL listing | implemented |
| 03.04.06 | Least Functionality | 3.4.6; 3.4.7; 3.13.7 | shared | Optional surfaces are off by default or lockable: relay serving (collab.allowServe), egress allow-all (disableDangerMode), model routing (models.allowed / denied), update channel (updateChannel managed disables the in-app check). | Inspect managed-config.json; confirm disabled controls show Managed by the org. | managed-config.json; UI screenshot | partial |
| 03.04.07 | Withdrawn: Incorporated into 03.04.06 and 03.04.08. | 3.4.7 | n-a |   |   |   | withdrawn |
| 03.04.08 | Authorized Software – Allow by Exception | 3.4.8; 3.4.7; 3.4.9 | shared | Agent commands are classified and prompted (desktop/exec_policy.ts, harness/omp/acp_config.yml forced-prompt tools); skills install through a scan gate and registry skills need an Ed25519 signature (P-SKILLREG.1). OS allow-listing (WDAC / AppLocker) is the customer's. | Review WDAC / AppLocker policy; run make demo-P-SKILLREG.1. | WDAC policy export | partial |
| 03.04.09 | Withdrawn: Addressed by 03.01.05, 03.01.06, 03.01.07, 03.04.08, and 03.12.03. | 3.4.9 | n-a |   |   |   | withdrawn |
| 03.04.10 | System Component Inventory |   | shared | Release workflow .github/workflows/compliance-evidence.yml produces a CycloneDX SBOM of the lockfiles; harness/maintainer/sbom.ts builds a manifest-level CycloneDX 1.5 SBOM for drift tracking. | Download sbom.cdx.json from the release run artifacts. | sbom.cdx.json | partial |
| 03.04.11 | Information Location |   | shared | docs/compliance/README.md lists every location LUCID stores prompts, transcripts, keys, the KG and logs, per OS. | Compare the README index with the host. | README where-to-look index | implemented |
| 03.04.12 | System and Component Configuration for High-Risk Areas |   | customer | Not a LUCID function. | Review travel procedures. | Procedure document | customer |

## Identification and Authentication

| R3 id | Title | R2 | Responsibility | LUCID implementation | How to verify | Evidence | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 03.05.01 | User Identification and Authentication | 3.5.1 | customer | LUCID inherits the OS sign-in. Relay guests are authenticated by a verified Firebase ID token (desktop/collab/relay_auth.ts); controllers by a per-pairing token (desktop/controller/store.ts). | Review OS / IdP authentication. | IdP configuration | customer |
| 03.05.02 | Device Identification and Authentication | 3.5.2 | customer | Paired controller devices are identified by a per-pairing token id (desktop/controller/store.ts). Network device authentication is the customer's. | Review 802.1X / device certificates. | Device auth configuration | customer |
| 03.05.03 | Multi-Factor Authentication | 3.5.3 | customer | No in-app MFA (POA&M P-3); MFA is enforced at OS sign-in / IdP. | Review IdP MFA policy. | IdP MFA report | gap |
| 03.05.04 | Replay-Resistant Authentication | 3.5.4 | customer | Relay ID tokens are checked for signature, exp and iat skew (desktop/collab/relay_auth.ts). Engine tokens are static bearer secrets on loopback. OS / IdP authentication is the customer's. | Review IdP protocol (Kerberos / OIDC). | IdP configuration | customer |
| 03.05.05 | Identifier Management | 3.5.5 | customer | Not a LUCID function. | Review identifier procedures. | Procedure document | customer |
| 03.05.06 | Withdrawn: Consistency with SP 800-53. | 3.5.6 | n-a |   |   |   | withdrawn |
| 03.05.07 | Password Management | 3.5.7; 3.5.10 | customer | LUCID holds no user passwords. Personal KG passphrases derive keys with PBKDF2-HMAC-SHA256, 600000 iterations (harness/personal/crypto.ts). Password policy is the customer's. | Review the OS / IdP password policy. | Password policy export | customer |
| 03.05.08 | Withdrawn: Consistency with SP 800-53. | 3.5.8 | n-a |   |   |   | withdrawn |
| 03.05.09 | Withdrawn: Consistency with SP 800-53. | 3.5.9 | n-a |   |   |   | withdrawn |
| 03.05.10 | Withdrawn: Incorporated into 03.05.07. | 3.5.10 | n-a |   |   |   | withdrawn |
| 03.05.11 | Authentication Feedback | 3.5.11 | LUCID | The HTTP API returns only masked key status (set + last 4), never the value (desktop/settings_store.ts header). | GET the provider status route and confirm values are masked. | HTTP response sample | implemented |
| 03.05.12 | Authenticator Management |   | shared | Provider keys and tokens are sealed in the engine OS vault (desktop/engine_vault.ts, P-VAULT-KEYS.1 ADR-0472); network auth secrets in the Electron vault (desktop/cred_vault.ts, rotateCredential); controller tokens shown once and stored as an argon2id hash (desktop/controller/store.ts). OAuth tokens stay in omp agent.db (POA&M P-5). Unified vault P-VAULT-V2.1 (ADR-0474) is in flight. | Run evidence.ts and read checks 03.13.10 and 03.13.08. | evidence.json | partial |

## Incident Response

| R3 id | Title | R2 | Responsibility | LUCID implementation | How to verify | Evidence | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 03.06.01 | Incident Handling | 3.6.1 | customer | Not a LUCID function. LUCID produces a redacted incident report (desktop/incident_report.ts) and a support bundle (tools/collect-support-logs.ps1). | Review the incident response plan. | IR plan | customer |
| 03.06.02 | Incident Monitoring, Reporting, and Response Assistance | 3.6.2 | customer | The OCSF audit file and the redacted incident report support tracking (desktop/audit_export.ts, desktop/incident_report.ts). | Review incident tickets. | Incident tickets | customer |
| 03.06.03 | Incident Response Testing | 3.6.3 | customer | Not a LUCID function. | Review IR test records. | IR test report | customer |
| 03.06.04 | Incident Response Training |   | customer | Not a LUCID function. | Review training records. | Training records | customer |
| 03.06.05 | Incident Response Plan |   | customer | Not a LUCID function. | Review the plan. | IR plan | customer |

## Maintenance

| R3 id | Title | R2 | Responsibility | LUCID implementation | How to verify | Evidence | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 03.07.01 | Withdrawn: Recategorized as NCO. | 3.7.1 | n-a |   |   |   | withdrawn |
| 03.07.02 | Withdrawn: Incorporated into 03.07.04 and 03.07.06. | 3.7.2 | n-a |   |   |   | withdrawn |
| 03.07.03 | Withdrawn: Incorporated into 03.08.03. | 3.7.3 | n-a |   |   |   | withdrawn |
| 03.07.04 | Maintenance Tools | 3.7.4; 3.7.2 | customer | Not a LUCID function. | Review maintenance tool list. | Tool inventory | customer |
| 03.07.05 | Nonlocal Maintenance | 3.7.5 | customer | LUCID offers no vendor remote maintenance channel. The remote controller and relay are user features governed under 03.01.12. | Review remote maintenance procedures. | Procedure document | customer |
| 03.07.06 | Maintenance Personnel | 3.7.6; 3.7.2 | customer | Not a LUCID function. | Review authorized maintenance list. | Personnel list | customer |

## Media Protection

| R3 id | Title | R2 | Responsibility | LUCID implementation | How to verify | Evidence | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 03.08.01 | Media Storage | 3.8.1 | customer | Not a LUCID function. | Review media storage controls. | Procedure document | customer |
| 03.08.02 | Media Access | 3.8.2 | customer | Not a LUCID function. | Review media access controls. | Procedure document | customer |
| 03.08.03 | Media Sanitization | 3.8.3; 3.7.3 | customer | Not a LUCID function. README lists every LUCID data location to sanitize. | Review sanitization records. | Sanitization log | customer |
| 03.08.04 | Media Marking | 3.8.4 | customer | Not a LUCID function. The violet CUI session banner marks CUI sessions on screen (desktop/renderer/app.ts renderSessionMode). | Review marking procedures. | Procedure document | customer |
| 03.08.05 | Media Transport | 3.8.5 | customer | Not a LUCID function. | Review transport records. | Transport log | customer |
| 03.08.06 | Withdrawn: Addressed by 03.13.08. | 3.8.6 | n-a |   |   |   | withdrawn |
| 03.08.07 | Media Use | 3.8.7; 3.8.8 | customer | Not a LUCID function. | Review removable media policy. | GPO / MDM export | customer |
| 03.08.08 | Withdrawn: Incorporated into 03.08.07. | 3.8.8 | n-a |   |   |   | withdrawn |
| 03.08.09 | System Backup – Cryptographic Protection | 3.8.9 | shared | The personal KG and CUI KG are AES-256-GCM files (harness/personal/store.ts), so backups of them stay encrypted. Encrypted vault backup / restore is in flight (P-VAULT-UI.1, ADR-0475). Backup of other data is the customer's. | Review backup encryption settings. | Backup configuration | planned |

## Personnel Security

| R3 id | Title | R2 | Responsibility | LUCID implementation | How to verify | Evidence | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 03.09.01 | Personnel Screening | 3.9.1 | customer | Not a LUCID function. | Review screening records. | HR records | customer |
| 03.09.02 | Personnel Termination and Transfer | 3.9.2 | customer | Not a LUCID function. Revoking a paired controller removes its token (desktop/controller/store.ts). | Review termination checklist. | HR checklist | customer |

## Physical Protection

| R3 id | Title | R2 | Responsibility | LUCID implementation | How to verify | Evidence | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 03.10.01 | Physical Access Authorizations | 3.10.1 | customer | Not a LUCID function. | Review facility access list. | Access list | customer |
| 03.10.02 | Monitoring Physical Access | 3.10.2 | customer | Not a LUCID function. | Review physical access logs. | Access logs | customer |
| 03.10.03 | Withdrawn: Incorporated into 03.10.07. | 3.10.3 | n-a |   |   |   | withdrawn |
| 03.10.04 | Withdrawn: Incorporated into 03.10.07. | 3.10.4 | n-a |   |   |   | withdrawn |
| 03.10.05 | Withdrawn: Incorporated into 03.10.07. | 3.10.5 | n-a |   |   |   | withdrawn |
| 03.10.06 | Alternate Work Site | 3.10.6 | customer | Not a LUCID function. | Review telework policy. | Policy document | customer |
| 03.10.07 | Physical Access Control | 3.10.3; 3.10.4; 3.10.5 | customer | Not a LUCID function. | Review entry controls. | Access logs | customer |
| 03.10.08 | Access Control for Transmission |   | customer | Not a LUCID function. | Review cabling protection. | Facility records | customer |

## Risk Assessment

| R3 id | Title | R2 | Responsibility | LUCID implementation | How to verify | Evidence | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 03.11.01 | Risk Assessment | 3.11.1 | customer | This package (README, matrix, POA&M) is input to the customer risk assessment. | Review the risk assessment. | Risk assessment | customer |
| 03.11.02 | Vulnerability Monitoring and Scanning | 3.11.2; 3.11.3 | shared | LUCID source: CodeQL security-extended weekly (.github/workflows/codeql.yml), Dependabot (.github/dependabot.yml), OSV advisories (harness/maintainer/advisory.ts) and osv-scanner on the lockfiles at release (.github/workflows/compliance-evidence.yml). Host scanning is the customer's. | Download osv-results.json from the release run; review the Code scanning tab. | osv-results.json; CodeQL alerts | partial |
| 03.11.03 | Withdrawn: Incorporated into 03.11.02. | 3.11.3 | n-a |   |   |   | withdrawn |
| 03.11.04 | Risk Response |   | customer | docs/compliance/poam.md lists LUCID's open gaps and target increments. | Review risk response records. | POA&M | customer |

## Security Assessment and Monitoring

| R3 id | Title | R2 | Responsibility | LUCID implementation | How to verify | Evidence | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 03.12.01 | Security Assessment | 3.12.1 | customer | tools/compliance/evidence.ts produces repeatable host evidence (evidence.json, evidence.md). | Run make compliance-evidence and attach the output. | evidence.json; evidence.md | customer |
| 03.12.02 | Plan of Action and Milestones | 3.12.2 | customer | LUCID's own POA&M is docs/compliance/poam.md; the Security brief can export an eMASS-aligned POA&M CSV and a STIG Viewer checklist (harness/brief/compliance.ts renderPoamCsv, renderCkl). | Review the customer POA&M. | POA&M | customer |
| 03.12.03 | Continuous Monitoring | 3.12.3; 3.4.9 | customer | The evidence CLI and GET /api/compliance/report can be run on a schedule; the audit file feeds a SIEM. | Review the monitoring strategy. | Monitoring plan | customer |
| 03.12.04 | Withdrawn: Incorporated into 03.15.02. | 3.12.4 | n-a |   |   |   | withdrawn |
| 03.12.05 | Information Exchange |   | customer | CUI leaves the host only to the AskSage gateway or an attested enclave under lockdown (desktop/lockdown_route.ts). Exchange agreements are the customer's. | Review agreements with AskSage / providers. | Agreements | customer |

## System and Communications Protection

| R3 id | Title | R2 | Responsibility | LUCID implementation | How to verify | Evidence | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 03.13.01 | Boundary Protection | 3.13.1; 3.13.5 | shared | Agent egress passes the per-host egress gate and whitelist (desktop/egress_policy.ts, desktop/network_whitelist.ts); the engine API binds loopback and rejects non-loopback Host headers (desktop/origin_guard.ts hostAllowed). Network boundary devices are the customer's. | Attempt an agent fetch to an unlisted host; confirm the prompt and audit line. | lucid-audit.jsonl egress lines | partial |
| 03.13.02 | Withdrawn: Recategorized as NCO. | 3.13.2 | n-a |   |   |   | withdrawn |
| 03.13.03 | Withdrawn: Addressed by 03.01.01, 03.01.02, 03.01.03, 03.01.04, 03.01.05, 03.01.06, and 03.01.07. | 3.13.3 | n-a |   |   |   | withdrawn |
| 03.13.04 | Information in Shared System Resources | 3.13.4 | shared | Contained commands get a private temp dir (~/.omp/lucid-sandbox-tmp) instead of the user %TEMP% under CUI lockdown (harness/runs/sandbox_exec.ts); the CUI KG has its own key and file (harness/personal/store.ts). | Inspect the AppContainer grants (desktop/sandbox_grants.ts) on a contained run. | Sandbox disclosure line | partial |
| 03.13.05 | Withdrawn: Incorporated into 03.13.01. | 3.13.5 | n-a |   |   |   | withdrawn |
| 03.13.06 | Network Communications – Deny by Default – Allow by Exception | 3.13.6 | shared | With allow-all off, an agent request to a host outside the whitelist needs an explicit approval; managed disableDangerMode or allowedHosts hold allow-all off (desktop/egress_policy.ts clampPosture, desktop/network_whitelist.ts). | Run evidence.ts and read check 03.13.06. | evidence.json check 03.13.06 | partial |
| 03.13.07 | Withdrawn: Addressed by 03.01.12, 03.04.02 and 03.04.06. | 3.13.7 | n-a |   |   |   | withdrawn |
| 03.13.08 | Transmission and Storage Confidentiality | 3.13.8; 3.13.16; 3.1.13; 3.8.6 | shared | At rest: provider keys sealed AES-256-GCM under an OS-held master key (desktop/engine_vault.ts); KGs AES-256-GCM (harness/personal/crypto.ts). In transit: TLS from Bun / omp, not a FIPS-validated module (POA&M P-1). Disk encryption is the customer's. FIPS provider P-FIPS.1 (ADR-0473) is in flight. | Run evidence.ts and read check 03.13.08 (vault custody, disk encryption). | evidence.json check 03.13.08 | partial |
| 03.13.09 | Network Disconnect | 3.13.9 | shared | The engine server closes sockets idle for 60 s (desktop/dev.ts Bun.serve idleTimeout); the relay drops guests idle for 120 s (desktop/collab/relay_server.ts idleTimeoutSec). | Review dev.ts Bun.serve options. | Source reference | partial |
| 03.13.10 | Cryptographic Key Establishment and Management | 3.13.10 | LUCID | One random 32-byte master key per vault directory, held by DPAPI (CurrentUser), macOS Keychain or Secret Service, never replaced when unreadable (desktop/engine_vault.ts). KG DEKs are wrapped by a passphrase-derived KEK or the OS keystore (harness/personal/store.ts). | Run evidence.ts and read check 03.13.10. | evidence.json check 03.13.10 | implemented |
| 03.13.11 | Cryptographic Protection | 3.13.11 | LUCID | Algorithms are FIPS-approved (AES-256-GCM, PBKDF2-HMAC-SHA256) but run in Bun BoringSSL, which is not FIPS 140-validated. P-FIPS.1 (ADR-0473, in flight) moves them to the OS validated module (CNG / CoreCrypto / OpenSSL FIPS provider). | Run evidence.ts and read check 03.13.11 (crypto.module, crypto.fips). | evidence.json check 03.13.11 | planned |
| 03.13.12 | Collaborative Computing Devices and Applications | 3.13.12 | customer | None claimed by LUCID. | Review collaboration device policy. | Policy document | customer |
| 03.13.13 | Mobile Code | 3.13.13 | shared | Skills, plugins and registry artifacts pass the scan gate before use; registry skills need a trusted Ed25519 signature (P-SKILLREG.1, P-SKILL.1 demos). | Run make demo-P-SKILLREG.1 and demo-P-SKILL.1. | Demo output | partial |
| 03.13.14 | Withdrawn: Technology-specific. | 3.13.14 | n-a |   |   |   | withdrawn |
| 03.13.15 | Session Authenticity | 3.13.15 | LUCID | Loopback Host check defeats DNS rebinding; every API call carries a scoped token checked by tokenValid (desktop/origin_guard.ts); relay sessions require a verified ID token (desktop/collab/relay_auth.ts). | Send a request with a foreign Host header; expect 403. | HTTP transcript | implemented |
| 03.13.16 | Withdrawn: Incorporated into 03.13.08. | 3.13.16 | n-a |   |   |   | withdrawn |

## System and Information Integrity

| R3 id | Title | R2 | Responsibility | LUCID implementation | How to verify | Evidence | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 03.14.01 | Flaw Remediation | 3.14.1 | shared | Signed auto-update via electron-updater, or managed updateChannel feed / managed (desktop/updater.ts, desktop/managed_config.ts resolveUpdatePolicy). Dependabot keeps dependencies current. | Check the installed version against the latest release (evidence.json lucidVersion). | evidence.json | partial |
| 03.14.02 | Malicious Code Protection | 3.14.2; 3.14.4; 3.14.5 | shared | The fail-closed security gate scans tool calls and ingested content for Unicode prompt-injection (zero-width, bidi, tag block, private use, homoglyphs) and blocks at high severity (scanner-sidecar/scanner.py, harness/security/gate.ts, harness/omp/security_extension.ts). It is not antivirus; endpoint anti-malware is the customer's. | Run make demo-00 (fail-closed proof) and check the EDR console. | Demo output; EDR status | partial |
| 03.14.03 | Security Alerts, Advisories, and Directives | 3.14.3 | customer | LUCID publishes release notes per version (desktop/version.ts). | Review advisory subscription. | Subscription record | customer |
| 03.14.04 | Withdrawn: Incorporated into 03.14.02. | 3.14.4 | n-a |   |   |   | withdrawn |
| 03.14.05 | Withdrawn: Addressed by 03.14.02. | 3.14.5 | n-a |   |   |   | withdrawn |
| 03.14.06 | System Monitoring | 3.14.6; 3.14.7 | shared | Gate blocks, exec / egress / loop decisions and approvals are emitted to the audit file (desktop/audit_export.ts, desktop/security_log.ts lucid-blocks.jsonl). Host monitoring is the customer's. | Show recent events in the Logs view and the SIEM. | SIEM dashboard | partial |
| 03.14.07 | Withdrawn: Incorporated into 03.14.06. | 3.14.7 | n-a |   |   |   | withdrawn |
| 03.14.08 | Information Management and Retention |   | shared | CUI facts live in a separate encrypted KG the agent cannot write (harness/personal/agent_kg.ts vetAgentWrite); GUI turn records keep sanitized text plus a hash of the raw (desktop/turns_log.ts); KB datasets carry a U / CUI compartment (harness/knowledge/migrations/0010_knowledge_vectors.sql). Retention schedules are the customer's. | Review README data locations against the retention schedule. | Retention schedule | partial |

## Planning

| R3 id | Title | R2 | Responsibility | LUCID implementation | How to verify | Evidence | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 03.15.01 | Policy and Procedures |   | customer | Not a LUCID function. | Review policies. | Policy set | customer |
| 03.15.02 | System Security Plan | 3.12.4 | customer | docs/compliance/README.md (boundary, data flows, locations) is SSP input. | Review the SSP. | SSP | customer |
| 03.15.03 | Rules of Behavior |   | customer | Not a LUCID function. The consent banner (03.01.09) restates monitoring terms. | Review signed rules of behavior. | Acknowledgements | customer |

## System and Services Acquisition

| R3 id | Title | R2 | Responsibility | LUCID implementation | How to verify | Evidence | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 03.16.01 | Security Engineering Principles |   | shared | LUCID engineering: fail-closed gate (Makefile test-failclosed), tighten-only managed policy (ADR-0068), metadata-only audit, ADR record per change. | Review DECISIONS.md ADR-0068 and the gate tests. | Source references | implemented |
| 03.16.02 | Unsupported System Components |   | shared | Runtimes are pinned and refreshed deliberately (desktop/build/fetch-runtimes.ts); Dependabot tracks npm and pip (.github/dependabot.yml). Replacing unsupported LUCID versions is the customer's. | Compare the installed version with the supported release. | evidence.json | partial |
| 03.16.03 | External System Services |   | customer | Model providers and AskSage are external services; lockdown restricts which are used (03.01.03). | Review provider agreements. | Agreements | customer |

## Supply Chain Risk Management

| R3 id | Title | R2 | Responsibility | LUCID implementation | How to verify | Evidence | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 03.17.01 | Supply Chain Risk Management Plan |   | customer | Not a LUCID function. SBOM and signatures are inputs. | Review the SCRM plan. | SCRM plan | customer |
| 03.17.02 | Acquisition Strategies, Tools, and Methods |   | customer | Not a LUCID function. | Review acquisition records. | Procurement records | customer |
| 03.17.03 | Supply Chain Requirements and Processes |   | shared | Windows binaries are Authenticode-signed by TECHLEAD 187 LLC via Azure Artifact Signing with a fail-closed release gate (desktop/build/win-signing.cjs, desktop/SIGNING.md); macOS builds are unsigned (POA&M P-4); bundled runtimes are SHA-256 pinned (desktop/build/fetch-runtimes.ts); release SBOM, gitleaks and osv-scanner run in .github/workflows/compliance-evidence.yml. | Get-AuthenticodeSignature on LucidAgentIDE.exe; run evidence.ts and read check 03.17.03. | evidence.json check 03.17.03; signature output | partial |
