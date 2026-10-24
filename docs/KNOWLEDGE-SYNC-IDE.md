# Knowledge Sync, IDE side: the personal knowledge graph and sessions across one user's devices (PROPOSAL)

**Status:** proposal, design only, no code. Review requested: @mlcyclops (owner of the IDE side and
co-owner of the envelope spec). Builds on LUCIDMeetingHub#5 (approved 2026-09-22), the Hub's
`docs/KNOWLEDGE_SYNC_PLAN.md`, the co-owned contract `docs/specs/knowledge-envelope-v1.md`, the IDE tracker
#360 (lanes L0-L6), open PR #457 (L1), and #524 (the Protector Spec v1 VMK this design keys off).

## 1. The ask

One user, several machines (today a Windows PC and a MacBook Pro, each running LUCID IDE and Lucid Meeting
Hub). They want:

1. The **personal knowledge graph** (`lucid-personal.kg.enc`) to be one graph on every machine.
2. **Agent sessions** from one machine readable, and eventually resumable, on the others.
3. Hub meetings, contacts and notes, which already sync Hub to Hub, to reach the IDE on every machine.
4. **No cloud service.** The user has a Synology NAS (`\\FastNas`) that both machines reach over SMB. The Hub
   plan's own Phase 1 exit test already names "this machine's `\\FastNas\...` share" as its folder.

Out of scope: sharing with other people. The Hub's Phase 4 file bundles already cover that, and nothing here
changes them.

## 2. What exists

| Piece | Hub | IDE |
|---|---|---|
| Envelope v1 (JCS, UUIDv7, HLC, ChaCha20-Poly1305, Ed25519) | `src/sync_envelope.py`, vectors pinned | `harness/knowledge/envelope.ts` in PR #457 (open since 2026-10-04), vectors reproduce |
| Identity: user key, device subkeys, epochs, folder pairing | `src/sync_identity.py` (`SyncIdentity`, `Enrollment`) | none (L5 not started) |
| Journal, fold, cursors, torn-line skip | `src/sync_journal.py` | append only, in #457 |
| Out-of-line bodies (spec §6.1) | built (`blob_status`, `fetch_blob`) | none |
| Emitters | `meeting.index`, `knowledge.chunk`, `meeting.record` (opt-in), `contact.mark` | `memory.fact` from the agent memory store (#457, provisional body) |
| Consumers | `contact.mark`, `meeting.index`; `memory.fact` inert-but-ready | none |
| Sharing with people | Phase 4 bundles | none |

Facts that shape the design:

- **Only the first device holds the user private key.** `SyncIdentity.create(generate_user_key=True)` stores
  `user_priv`; an enrollee only adopts `user_pub` (`adopt_user_key`), and `Enrollment.approve` needs
  `build_cert`, which signs with `user_priv`. Whichever install is set up first is the only one that can pair
  new devices.
- **Every app install is its own device.** The Hub and the IDE on one machine are two devices of one user,
  each with its own signing and wrapping keys. That is what keeps the two apps independent: neither reads the
  other's vault.
- **Private sync keys live in the app's vault.** The Hub uses vault named blobs (`sync_identity`,
  `sync_devices`, `sync_epochs`), so a locked vault pauses sync. #457 instead reads a plaintext identity JSON
  from `LUCID_KSYNC_IDENTITY`; this proposal replaces that (§4.1).
- **Neither Hub has sync enabled today.** No `[sync]` section and no sync blobs on either machine, so the
  first device can be chosen deliberately.
- **Session files are not append-only.** `~/.omp/agent/sessions/<encoded cwd>/<timestamp>_<uuid>.jsonl`
  begins with a fixed-width `{"type":"title",...,"pad":...}` record that is rewritten in place; everything
  after it is appended. Records seen: `session` (id, cwd), `message`, `custom`, `custom_message`,
  `model_change`, `thinking_level_change`, `ttsr_injection`, `credential_pin` (provider + a 64-hex hash of
  the account in use). On this PC: 14,700 files, 3.4 GB.
- **Graph ids are device-local.** Entities, facts and links are Snowflake ids; `upsertEntity` dedupes by
  `(name, kind)` only within one store. Two devices that each learn "dark mode" create two entity ids, so a
  merge keyed on entity id would duplicate entities.

## 3. Design in one paragraph

No new transport and no new crypto. The IDE becomes two more devices (PC, Mac) under the same user identity
as the Hubs, writing its own journal into the same sync root on the NAS. The IDE implements the Hub's
identity, journal, fold and blob formats byte for byte, proven against the Hub's own Python the way #524
pinned the protector file. Three new item-class families carry the IDE's data:

- `kg.entity`, `kg.fact`, `kg.link` for the personal graph;
- `session.index` for session metadata;
- `session.chunk` for transcripts, in append-only slices with large slices out of line.

The IDE also consumes the Hub's `knowledge.chunk` and `meeting.index`, which retires the same-machine-only
`ide-inbox` folder drop (L3). CUI never syncs.

## 4. Decisions

### 4.1 Identity and keys

- **First device: the IDE on the user's main desktop** (owner ruling 3, "the IDE owns first-run identity").
  The Hub keeps its ability to generate a key for Hub-only users (`create(generate_user_key=True)`), unchanged.
- The IDE stores `device_sign_priv`, `device_wrap_priv`, `user_priv` (first device only) and the epoch keys
  **inside the encrypted personal store, under the VMK** (#524). It does not use a plaintext identity file.
  - A locked knowledge graph pauses sync, with the same "sync paused: locked" semantics as the Hub.
  - A Windows Hello or Touch ID unlock resumes it.
  - The sync root never holds a private key (the spec refuses an identity path inside the root; #457 already
    enforces that).
- **Pairing reuses the Hub's folder handshake unchanged:**
  1. The new device writes `devices/pending/<6-digit code>.json`.
  2. The key holder approves the code shown on both screens.
  3. The new device claims its certificate and wrapped epoch from `devices/` and `epochs/`.
  The IDE implements both halves, so IDE↔IDE, IDE↔Hub and Hub↔Hub all pair the same way.
- **Open (Q1):** with one key holder, losing that machine means no new devices can be paired until a new
  user key is minted. Options:
  - (a) accept it and document the reset;
  - (b) let the user export `user_priv` sealed under their passphrase as a recovery file;
  - (c) certify a second "approver" device.
  I recommend (a) for v1.

### 4.2 Transport

- The sync root is a folder the user picks. On this user's machines that is a NAS share, for example
  `\\FastNas\home\LucidSync` on Windows and the same share mounted on the Mac.
  - Each device appends only to `journal/<own device fp>/`.
  - Readers poll `(mtime, size)` (spec §6, Hub D6).
  - Off the home network the app keeps working on its local copy and catches up when the folder is reachable.
- The Mac needs the share mounted at login. The app does not mount it; it shows "sync folder unreachable"
  until the volume appears.
- A direct device-to-device transport (LAN or the existing collab relay, ADRs 0193-0201) is a later
  increment. The spec already says "the relay carries the same segments; the format does not change with
  transport".

### 4.3 The personal knowledge graph: `kg.entity`, `kg.fact`, `kg.link`

| Class | Natural key (§3.4) | Merge | Body v1 |
|---|---|---|---|
| `kg.entity` | `kind + "|" + name` | per-field LWW | `{name, kind, trust_label, confidence}` |
| `kg.fact` | the fact's id in the producing store | LWW per item, `tombstone` = forget | `{entity: <entity natural key>, statement, scope, trust_label, confidence, status, source_session_id?, promoted_at}` |
| `kg.link` | `from + "|" + relation + "|" + to` (entity natural keys) | LWW per item, `tombstone` = unrelate | `{from, to, relation}` |

- **References use natural keys, not ids.** A fact names its entity by natural key, not Snowflake id, so two
  devices that both learned "dark mode" converge on one entity. The consumer maps a natural key to its local
  entity id, creating the entity if needed.
- **Forget propagates.** Forgetting a fact on one device forgets it on all of them, because the forget is a
  tombstone on the fact's logical key. That is what a user expects from "forget".
- **Scope travels with the fact.** `work` and `personal` sync, each behind its own class toggle, both on by
  default.
- **`cui` is refused by name.** A `kg.fact` with `scope: "cui"` MUST NOT be produced and MUST be rejected on
  read. The isolated CUI store (ADR-0014) is never read by the sync layer at all.
- **Writes are emitted at the store's existing mutation points:**
  - `addFact`, `upsertEntity` (first creation only);
  - `addLink` / `removeLink`;
  - `forgetFact`.
  These are reached from `learnFromTurn`, `agentRetain`, `relateEntities`, `unrelateEntities`, `forgetFact`,
  `importChatExport` and `addReportToKg`. A failure to emit never fails the mutation (#457's posture).
- **Applying is a fold into the open store**, then a save, only while the store is unlocked. An applied item
  is not re-emitted (its `device` is not ours).
- **Not synced:**
  - the export audit trail (`exports`), which is per device by design;
  - the named KG packs and compiled KBs (DuckDB, P-KGPACK), which are a separate increment if wanted.

### 4.4 Sessions: `session.index` and `session.chunk`

- `session.index`, natural key = session id, LWW per item:
  - body: `{title, cwd_label, cwd_device, model, turns, kind, created, updated, bytes}`;
  - on by default, so every device's session list shows every device's sessions, read-only, with a
    "from Mac" chip.
- `session.chunk`, natural key = `session_id + "#" + seq`, append-only:
  - body: `{session, seq, from_line, to_line, lines: [...]}`, out of line as a blob (§6.1) above 32 KB;
  - emitted at turn end, carrying the records appended since the last chunk;
  - the in-place `title` record is NOT copied (its content rides `session.index`);
  - a reader rebuilds the transcript by concatenating chunks in `seq` order.
- **Transcripts are opt-in.** A global toggle "Sync session transcripts" defaults **off**, with per-workspace
  overrides. Reasons:
  - they are large (3.4 GB on one machine);
  - they contain tool output and file contents.
- **Records never synced:**
  - `credential_pin` (it identifies the account a device used);
  - any record the existing scanner flags as a secret (open, Q4);
  - sessions whose workspace is marked CUI, or that ran while the CUI compartment was selected. Sessions carry
    no compartment tag today, so v1 needs one recorded at turn time (open, Q3).
- **Remote sessions open read-only in the transcript view.** Resuming one needs a workspace on this device;
  v1 offers "resume here" only when the session's git remote matches a local checkout, and otherwise says why.

### 4.5 Hub data in the IDE

- **L3, as planned:** the IDE Knowledge panel ingests `knowledge.chunk` from the journal. It is the same
  rendered markdown the `ide-inbox` drop writes (one renderer, Hub plan §4d), so a meeting recorded by the
  Mac's Hub reaches the PC's IDE.
- `meeting.index` feeds the IDE's meeting list (P-MEET.1) on machines with no Hub.
- The drop stays until parity is proven, then retires (the Hub's call, not the IDE's).

### 4.6 Spec changes (proposed addendum, not applied here)

`knowledge-envelope-v1.md` is pinned by sha256 in both repos, so this PR proposes and does not edit it. The
addendum would:

1. Add `kg.entity`, `kg.fact`, `kg.link`, `session.index`, `session.chunk` to the §4 registry with the
   natural keys, merge policies and frozen `body_v: 1` bodies above. This is not an envelope change (§8).
2. Add `scope: "cui"` on `kg.fact` to the §4.1 refusals, refused by name with a sentence.
3. State that `session.chunk` bodies above 32 KB MUST go out of line (§6.1).

The Hub then needs only to know the new classes exist and skip them (§7 handshake: unknown class → skip that
class, sync the rest) until it wants to consume them. The Hub's pre-meeting brief reading `kg.fact` is a
natural later consumer.

## 5. Increments (IDE lanes; each its own PR, demo, and ADR)

| # | Increment | Depends on |
|---|---|---|
| **S0** | Spec addendum (§4.6), co-owned docs PR in both repos, pins bumped together | this review |
| **S1** | IDE sync core: identity, epochs, folder enrollment, journal reader + fold, cursors, §6.1 blobs. Proven two-way against the Hub's Python (a Hub-written journal folds in the IDE and vice versa), with the Hub's convergence property test ported | #457 (L1 envelope), #524 (VMK for key custody) |
| **S2** | Pairing + folder UX in Settings (L5): create the user key or join with a pairing code, pick the sync folder, device list, revoke, status | S1 |
| **S3** | `kg.*` emit + fold; two-device demo over a real folder: a fact learned on the PC is recalled on the Mac; forget propagates; CUI refused | S0, S2 |
| **S4** | `session.index` (on), then `session.chunk` (opt-in), read-only remote sessions in the timeline | S0, S2 |
| **S5** | L3: Knowledge panel ingests Hub `knowledge.chunk` and `meeting.index` | S1 |
| **S6** | Hub: registry knows the new classes (skip), later consumes `kg.fact` in the brief | S0 |

S1-S3 is the minimum for "one knowledge graph on every machine". S4 adds sessions.

## 6. Threat model delta

- **The NAS sees ciphertext only.** Bodies are ChaCha20-Poly1305 under per-item keys derived from the epoch
  key. Headers carry hashed logical keys, a timestamp clock, the device fingerprint and the class name, so
  someone with the folder learns how many items of which class each device writes, and when.
- **A stolen NAS copy is useless** without a device's wrap key, which lives only inside that device's
  VMK-sealed store.
- **A device thief with the unlocked laptop reads what that device can read,** as today. Revoking the device
  mints a new epoch; it stops future access only, and the UI says so (Hub decision 10).
- **Anyone who can write to the folder** can try to inject items. Items are signed by certified device keys,
  and an unknown device or a bad signature is rejected (`verify_item_author`). They can also delete or
  truncate files: that is denial of service, not disclosure, and the local copy survives.

## 7. Questions for the owner

- **Q1** Who holds the user key, and the recovery story (§4.1): accept single-holder for v1?
- **Q2** Confirm the new classes, and that `kg.*` bodies freeze at v1 now (unlike `memory.fact`, the graph's
  shape is the IDE's own and is known).
- **Q3** CUI and sessions: record a compartment tag per turn so CUI-scoped sessions can be excluded, or
  exclude by workspace only?
- **Q4** Transcript scrubbing: is "drop records the scanner flags as secrets" enough, or do transcripts stay
  local-only until a dedicated redaction pass exists?
- **Q5** Default for transcript sync: off with per-workspace opt-in (proposed), or on for the user's own
  devices?
