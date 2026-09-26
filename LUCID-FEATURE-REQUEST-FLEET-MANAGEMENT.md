# Feature Request: Fleet Management for Project-Bound Lucid Instances

## Proposed title

**Fleet Management: Project-bound multi-instance Lucid workspaces with isolated session, settings, and Knowledge state**

## Summary

Lucid already supports more than one Electron instance by assigning non-default instances a different `LUCID_PORT`. That is enough to bypass Electron's single-instance lock, but it is not enough to operate multiple independent engineering agents against multiple repositories at the same time.

A practical multi-repository workflow needs a higher-level concept: a **Fleet Profile**.

A Fleet Profile should bind one Lucid instance to one project/repository and provide a stable project identity across restarts. It should isolate project-specific workspace state, session visibility, Personal Knowledge state, runtime port/process state, and last-session metadata while continuing to share user-level authentication and provider configuration where appropriate.

This request is based on a real multi-project workflow where four independent Lucid agents were needed simultaneously:

- IntelliGRC Automation
- Compliance Island
- Customer Portal
- Apollo2D365

A PowerShell prototype was built to prove the behavior and identify the boundaries Lucid needs to own natively.

## User story

As an engineer working on multiple repositories simultaneously, I want to start a dedicated Lucid instance for each project so that:

- each Lucid remains associated with its repository;
- changing folders in one instance does not change another;
- session history for one repository never disappears because another instance changed workspace;
- Personal Knowledge for one project cannot be concurrently modified by another project instance;
- every instance can be started, stopped, resumed, and health-checked independently;
- I cannot accidentally start two Lucid instances against the same repository unless I explicitly choose to;
- I can run several long-running agents in parallel, similar to multiple independent VS Code windows.

## Current behavior

### What already works

`desktop/main.ts` reads `LUCID_PORT`. For non-default ports, Electron changes the `userData` directory before acquiring the single-instance lock. This allows multiple Electron processes to coexist.

Example:

```text
Lucid #1 -> port 5319
Lucid #2 -> port 55101
Lucid #3 -> port 55102
Lucid #4 -> port 55103
```

This solves **Electron process identity**.

It does not solve **project identity**.

### Failure mode

The GUI workspace is stored in the GUI settings file. By default this is:

```text
~/.omp/lucid-gui.json
```

The settings include:

```text
workspace
recentWorkspaces
```

`desktop/workspace.ts` loads the active workspace from that settings store, and `setWorkspace()` writes a newly selected workspace back to it.

Multiple Lucid processes using different ports can therefore still read and write the same workspace setting.

Observed sequence:

```text
Lucid A starts on Repo A
Lucid B starts on Repo A because both read the same GUI settings

User changes Lucid B to Repo B

Lucid B writes Repo B to ~/.omp/lucid-gui.json

Lucid A later reads the same GUI settings
Lucid A now also believes Repo B is the current workspace
```

This becomes especially disruptive because the session view is workspace-sensitive.

`desktop/sessions.ts` scans:

```text
~/.omp/agent/sessions
```

and filters sessions by comparing the cwd stored inside each session with the current Lucid workspace.

Conceptually:

```text
session.cwd == currentWorkspace()
```

When one Lucid changes the shared workspace, the session list in other Lucids can change too.

From the user's perspective:

- history disappeared;
- the wrong project's sessions appeared;
- an existing session looked lost;
- long-running work became unreliable.

The underlying JSONL session may still exist; the UI is filtering against a workspace value that another process changed.

## Reproduction

1. Start Lucid instance A on Repo A.
2. Start Lucid instance B on another `LUCID_PORT`.
3. Observe that B opens using the same current workspace as A.
4. In B, change the workspace to Repo B.
5. Return to A.
6. Refresh or trigger settings/session reads.
7. A may now identify Repo B as the current workspace.
8. A's session sidebar now filters for Repo B.
9. Repo A history appears to vanish.
10. Resume behavior becomes unreliable.

The impact increases when 3-5 Lucid instances run concurrently.

## Root cause

The system currently has several different identity scopes that are not aligned.

### Electron/process identity

Already isolated by port:

```text
LUCID_PORT
-> non-default port
-> port-specific Electron userData
-> independent Electron single-instance lock
```

### Workspace identity

Not natively isolated:

```text
all Lucids
    |
    +--> ~/.omp/lucid-gui.json
             |
             +--> workspace
             +--> recentWorkspaces
```

### OMP sessions

Shared root, but each session records its cwd:

```text
~/.omp/agent/sessions/<encoded-cwd>/*.jsonl
```

The shared session root is not inherently the problem. The important requirement is that each Lucid has a stable current workspace while filtering that tree.

### Personal Knowledge

The encrypted personalization store defaults under:

```text
~/.omp
```

Lucid already supports `LUCID_PERSONAL_DIR`, which relocates Personal Knowledge artifacts.

Running several processes against the same writable encrypted store is undesirable without explicit inter-process locking or a broker.

# Prototype / workaround implemented

## Version 1: port-only launcher

The first prototype:

1. found an available TCP port;
2. set `LUCID_PORT`;
3. launched another Lucid executable;
4. repeated for additional windows.

This proved multiple Electron windows could coexist.

It did **not** isolate workspaces.

## Version 2: health-aware launcher

The launcher was extended to:

- select free dynamic ports;
- wait for `http://127.0.0.1:<port>/api/health`;
- verify the instance remained healthy;
- retry on startup failure;
- log launches.

This improved startup reliability but still did not fix workspace collision.

## Version 3: detached lifecycle

Another issue was found: some launcher implementations created Lucid as a child of the launcher console.

Closing the launcher could therefore terminate Lucid.

The prototype was changed to launch Lucid as a detached Windows process.

A native Fleet Manager should own lifecycle explicitly rather than depend on shell-parent behavior.

## Version 4: project-bound profiles

The key fix was to isolate project state, not just port.

For each project, the launcher sets:

```text
LUCID_PORT
LUCID_GUI_SETTINGS_FILE
LUCID_PERSONAL_DIR
```

Separate profile directories are created per project.

Example:

```text
%LOCALAPPDATA%\LucidProjectLauncher\profiles\INTELLIGRC\
    lucid-gui.json
    personal\
    session-backups\

%LOCALAPPDATA%\LucidProjectLauncher\profiles\COMPLIANCE-ISLAND\
    lucid-gui.json
    personal\
    session-backups\

%LOCALAPPDATA%\LucidProjectLauncher\profiles\CUSTOMER-PORTAL\
    lucid-gui.json
    personal\
    session-backups\

%LOCALAPPDATA%\LucidProjectLauncher\profiles\APOLLO2D365\
    lucid-gui.json
    personal\
    session-backups\
```

Each project receives its own `lucid-gui.json` with its fixed workspace.

This uses Lucid's existing:

```text
LUCID_GUI_SETTINGS_FILE
```

The code currently calls it a test seam, but the prototype demonstrated that the same concept solves real production multi-instance isolation.

The prototype also sets:

```text
LUCID_PERSONAL_DIR
```

so each project's encrypted Personal Knowledge store has a separate location.

## Example fleet

```text
Project             Repository                                              Preferred port
-------------------------------------------------------------------------------------------------
INTELLIGRC           C:\Source\IntelliGRC-Automation                       55101
COMPLIANCE-ISLAND    C:\Source\CI Deploy\Compliance Island                55102
CUSTOMER-PORTAL      C:\Users\...\repos\customer-portal                  55103
APOLLO2D365          C:\Source\apollo2D365                                 55104
```

The stable identity should be the project profile, not the port.

## Prototype registry

The workaround keeps a registry similar to:

```json
[
  {
    "projectKey": "INTELLIGRC",
    "repoPath": "C:\\Source\\IntelliGRC-Automation",
    "port": 55101,
    "settingsFile": "...\\profiles\\INTELLIGRC\\lucid-gui.json",
    "personalDir": "...\\profiles\\INTELLIGRC\\personal",
    "launchedAt": "..."
  }
]
```

Used for:

- running-project status;
- preferred ports;
- duplicate repository protection;
- stable project association.

## Duplicate protection

The prototype refuses a second healthy registered Lucid against the same normalized repository path.

Example:

```text
REFUSING DUPLICATE REPOSITORY INSTANCE

Repository:
C:\Source\IntelliGRC-Automation

Already running:
INTELLIGRC

Use the existing Lucid window for this repository.
```

Native Fleet Management should do this using live instance identity, not only a local registry.

## Session protection

OMP's normal session storage was intentionally left in place:

```text
~/.omp/agent/sessions
```

We did **not** relocate `PI_CODING_AGENT_DIR`.

Reason: Lucid's current session UI directly scans the normal OMP session directory and filters by cwd.

Relocating the OMP root per instance would require changes to the session reader and other memory/usage surfaces.

Instead, the prototype:

- keeps the canonical OMP session tree;
- pins each Lucid to its own workspace;
- backs up matching JSONL session files before launching a project profile.

# Proposed native feature

## Feature name

**Fleet Management**

## Core concept

Introduce a first-class `FleetProfile`.

A Fleet Profile is a stable Lucid project identity that survives:

- app restarts;
- computer restarts;
- dynamic port changes;
- Lucid upgrades.

A profile is bound to:

```text
Profile ID
Project name
Workspace/repository
Project settings
Personal Knowledge policy
Last session
Runtime instance state
```

The profile should not be identified by port.

## Proposed configuration model

```json
{
  "version": 1,
  "profiles": {
    "2f0af7a2-...": {
      "id": "2f0af7a2-...",
      "name": "IntelliGRC",
      "workspace": "C:\\Source\\IntelliGRC-Automation",
      "workspaceMode": "locked",
      "knowledgeMode": "isolated",
      "preferredPort": 55101,
      "lastPort": 55101,
      "lastSessionId": "01J...",
      "lastModel": "gpt-5.6-luna",
      "createdAt": "...",
      "lastOpenedAt": "..."
    }
  }
}
```

## Proposed filesystem layout

```text
~/.omp/
    fleet/
        fleet.json

        profiles/
            <profile-id>/
                gui.json
                runtime.json
                personal/
                    lucid-personal.kg.enc
                    lucid-cui.kg.enc
                    ...
```

OMP sessions can initially remain under:

```text
~/.omp/agent/sessions
```

Optionally, new sessions can also record:

```text
lucidProfileId
```

for stronger attribution and future workspace moves.

# Recommended configuration separation

## 1. Global user state

Shared across Fleet members:

- OAuth/provider credentials
- user identity
- global appearance
- model catalog
- managed policy
- OS credential vault references

## 2. Project/profile state

Isolated per Fleet member:

- workspace
- project recent folders
- repo
- project-specific settings
- project Personal Knowledge location/policy
- last session
- optional preferred model
- project feature flags

## 3. Runtime state

Ephemeral:

- PID
- port
- health
- start time
- current session
- crash state

# Stable instance identity

Current secondary Electron `userData` is keyed by port.

For Fleet Management, introduce:

```text
LUCID_INSTANCE_ID=<fleet-profile-id>
```

Then:

```text
userData = <base>/fleet/<profile-id>/electron
```

Port becomes runtime state.

Backward compatibility:

```text
if LUCID_INSTANCE_ID is set:
    use profile-specific userData
else if LUCID_PORT != DEFAULT_PORT:
    retain current port-specific behavior
else:
    retain current normal behavior
```

# Workspace locking behavior

A Fleet Profile should default to:

```text
workspaceMode = locked
```

If the user selects another repository, prompt:

```text
This Lucid instance is bound to:

C:\Source\IntelliGRC-Automation

Open the selected folder as:

[ New Fleet Instance ]
[ Rebind This Profile ]
[ Cancel ]
```

Default should be **New Fleet Instance**.

Rebinding should require explicit confirmation because it changes which sessions are visible.

# Fleet dashboard UX

Example:

```text
FLEET

IntelliGRC
C:\Source\IntelliGRC-Automation
Branch: feature/intelligrc-foundation
Status: RUNNING
Model: GPT-5.6-Luna
Session: IntelliGRC API discovery
Knowledge: Unlocked
[ Focus ] [ Stop ] [...]

Compliance Island
C:\Source\CI Deploy\Compliance Island
Status: RUNNING
[ Focus ] [ Stop ] [...]

Customer Portal
C:\...\customer-portal
Status: RUNNING
[ Focus ] [ Stop ] [...]

Apollo2D365
C:\Source\apollo2D365
Status: STOPPED
Last session: Apollo/D365 integration review
[ Start ] [ Resume ]
```

Recommended card fields:

- profile name
- repo/workspace
- Git branch
- clean/dirty indicator
- running/stopped/crashed
- model
- PID
- port
- current session
- last session
- Personal Knowledge locked/unlocked
- CUI mode
- last activity
- warnings

# Start workflow

1. Resolve Fleet Profile.
2. Confirm workspace exists.
3. Normalize path.
4. Check for another active Fleet instance owning the same path.
5. If duplicate exists, focus it or require explicit override.
6. Allocate an available local port.
7. Load/create profile-scoped GUI settings.
8. Load/create profile-scoped Knowledge state.
9. Create profile-scoped Electron `userData`.
10. Spawn Lucid detached from Fleet Manager.
11. Wait for `/api/health`.
12. Query instance identity.
13. Verify profile ID, workspace, PID, and port.
14. Mark RUNNING.
15. Optionally resume last session.

# Proposed instance identity API

Add:

```text
GET /api/instance
```

Example:

```json
{
  "instanceId": "2f0af7a2-...",
  "profileName": "IntelliGRC",
  "workspace": "C:\\Source\\IntelliGRC-Automation",
  "pid": 18432,
  "port": 55101,
  "version": "1.x.x",
  "sessionId": "01J..."
}
```

This allows Fleet Management to discover actual live ownership rather than trust stale registry records.

# Port allocation

Do not require user-managed ports.

Preferred behavior:

- ask the OS for an available loopback port; or
- allocate from a Lucid-managed pool.

Port may be kept as `lastPort` for diagnostics, but not identity.

# Lifecycle requirements

States:

```text
STOPPED
STARTING
RUNNING
STOPPING
CRASHED
UNHEALTHY
```

Requirements:

- Start exactly one process.
- Detach the Lucid process from temporary launcher shells.
- Closing Fleet Manager does not terminate running fleet instances unless requested.
- Closing one Lucid updates only its own Fleet state.
- Stale runtime records self-heal.
- On Fleet Manager restart, query live instances and reconcile state.

# Session behavior

Changing, starting, stopping, or crashing another Fleet member must never alter the visible session history of a running member.

Recommended first implementation:

- keep canonical OMP session tree;
- enforce `instance.currentWorkspace == profile.workspace`;
- optionally add `lucidProfileId` to future session metadata.

# Personal Knowledge behavior

Recommended default:

```text
Project Personal Knowledge: isolated per Fleet Profile
```

Possible policies:

```text
Isolated
Shared read-only
Shared managed
None
```

A shared writable encrypted store should require proper locking, transactions, or a single broker.

# Authentication and secrets

Fleet isolation should not duplicate provider credentials into every project settings file.

Separate:

```text
global credentials/auth
```

from:

```text
project settings
```

OAuth and OS-vault-backed credentials should remain user-level where possible.

# Crash recovery

At startup:

1. read Fleet profiles;
2. enumerate active Lucid processes/endpoints;
3. query `/api/instance`;
4. reconcile PID/port/profile ownership;
5. mark missing processes STOPPED or CRASHED;
6. never delete OMP sessions automatically;
7. surface Resume for the last valid session.

# Duplicate repository policy

Default:

```text
one active Fleet Profile per normalized workspace path
```

If duplicate launch is requested:

```text
This repository is already open in IntelliGRC.

[ Focus Existing ]
[ Open Duplicate Anyway ]
[ Cancel ]
```

Git worktrees with distinct paths should be allowed.

# CLI support

Suggested:

```text
lucid fleet list
lucid fleet add --name IntelliGRC --workspace "C:\Source\IntelliGRC-Automation"
lucid fleet start IntelliGRC
lucid fleet stop IntelliGRC
lucid fleet restart IntelliGRC
lucid fleet focus IntelliGRC
lucid fleet status
lucid fleet remove IntelliGRC
lucid fleet start --all
```

# Migration

On first Fleet use:

```text
We found an existing Lucid workspace:

C:\Source\apollo2D365

Create a Fleet Profile for it?

[ Create Profile ]
[ Keep Legacy Mode ]
```

When adopting:

- do not move or rewrite OMP JSONL sessions;
- preserve cwd;
- associate matching sessions with the profile;
- offer optional Personal Knowledge adoption;
- never silently overwrite encrypted Knowledge.

# Acceptance criteria

## Multi-instance isolation

Four Fleet Profiles can run simultaneously, each with a stable profile identity and distinct project state.

## Workspace isolation

Changing workspace in one member does not change another member's workspace or session list.

## Session persistence

Restarting a Fleet member restores sessions for its repository/profile and can resume the prior session without closing other Fleet members.

## Duplicate protection

Starting a second instance for an already-owned workspace detects the existing instance and defaults to Focus Existing.

## Knowledge isolation

Isolated Fleet profiles read/write different encrypted stores. Locking or unlocking one does not affect another.

## Lifecycle

Closing Fleet Manager does not terminate running agents. Stopping one agent does not stop another.

## Crash recovery

A crash does not destroy OMP sessions. Other fleet members continue. The crashed member can be restarted and resumed.

## Backward compatibility

Users who never enable Fleet Management keep current single-instance behavior.

# Testing requirements

## Unit tests

- profile schema
- path normalization
- duplicate workspace detection
- port allocation
- stale registry reconciliation
- state transitions
- migration of legacy workspace metadata
- Knowledge policy resolution

## Integration test

1. create Repo A and Repo B;
2. start Fleet A;
3. start Fleet B;
4. verify distinct `/api/instance` identities;
5. verify A workspace == Repo A;
6. verify B workspace == Repo B;
7. change B;
8. verify A remains unchanged;
9. create sessions in both;
10. verify each only surfaces its own session set.

## Process-lifecycle test

Start Fleet A, terminate Fleet Manager/launcher, verify Fleet A remains alive.

## Crash test

Kill Fleet B and verify Fleet A stays alive, B is marked crashed/stopped, and B's session data remains resumable.

## Knowledge isolation test

Create two Personal Knowledge stores and mutate both concurrently. Verify neither store changes due to writes from the other instance.

# Suggested implementation phases

## Phase 1 - profile isolation

- FleetProfile schema
- `LUCID_INSTANCE_ID`
- profile-scoped GUI settings
- profile-scoped workspace
- backward compatibility

## Phase 2 - process manager

- Fleet dashboard
- dynamic port allocation
- detached launch
- health checks
- `/api/instance`
- start/stop/focus/restart
- duplicate protection

## Phase 3 - sessions and Knowledge

- last-session tracking
- Resume
- profile/session association
- Knowledge policy
- migration/adoption

## Phase 4 - CLI and worktrees

- `lucid fleet ...`
- start-all
- worktree awareness
- fleet diagnostics/export

# Key lessons from the prototype

1. **Port isolation is not project isolation.**
2. **Stable profile identity should not equal port.**
3. `LUCID_GUI_SETTINGS_FILE` demonstrated that profile-scoped settings solve the workspace collision.
4. OMP's existing cwd-based session layout can remain initially if each instance has a stable project workspace.
5. Personal Knowledge needs an explicit concurrency/isolation policy.
6. Fleet lifecycle must be owned natively; launcher-parent process behavior is too fragile.
7. Live instance identity is better than a stale local registry for duplicate detection.

# Value

Fleet Management turns Lucid from a single-workspace desktop agent into a practical control plane for several concurrent project agents.

```text
Fleet
 |
 +-- IntelliGRC Agent
 |     +-- repo
 |     +-- sessions
 |     +-- project Knowledge
 |
 +-- Compliance Island Agent
 |     +-- repo
 |     +-- sessions
 |     +-- project Knowledge
 |
 +-- Customer Portal Agent
 |     +-- repo
 |     +-- sessions
 |     +-- project Knowledge
 |
 `-- Apollo2D365 Agent
       +-- repo
       +-- sessions
       +-- project Knowledge
```

This is useful for engineering leads, consultants/MSPs, product teams with several repositories, long-running parallel agent workflows, and enterprise environments where each repo has different skills, Knowledge, secrets, and operating rules.

Most of the required primitives already exist in Lucid. The missing piece is a first-class orchestration layer that binds them together as a Fleet.
