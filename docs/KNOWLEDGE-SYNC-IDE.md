# Knowledge Sync, IDE side: the personal knowledge graph and sessions across one user's devices (PROPOSAL)

**Status:** proposal, design only, no code. Owner answers to §7 recorded (2026-11-15) together with the
second-round review corrections. Review requested: @mlcyclops (owner of the IDE side and co-owner of the
envelope spec). Builds on LUCIDMeetingHub#5 (approved 2026-09-22), the Hub's `docs/KNOWLEDGE_SYNC_PLAN.md`,
the co-owned contract `docs/specs/knowledge-envelope-v1.md`, the IDE tracker #360 (lanes L0-L6, closed),
#457 (L1 envelope and `memory.fact` journal, merged 2026-11-12, shipped in v2.5.4-beta.1) and #524 (the
Protector Spec v1 VMK this design keys off, ADR-0454, merged 2026-11-12, shipped in v2.5.4-beta.1).

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
| Envelope v1 (JCS, UUIDv7, HLC, ChaCha20-Poly1305, Ed25519) | `src/sync_envelope.py`, vectors pinned | `harness/knowledge/envelope.ts` (#457, on master since 2026-11-12, v2.5.4-beta.1), vectors reproduce, spec pinned by `spec_pin.test.ts` |
| Identity: user key, device subkeys, epochs, folder pairing | `src/sync_identity.py` (`SyncIdentity`, `Enrollment`) | none (L5 not started) |
| Journal, fold, cursors, torn-line skip | `src/sync_journal.py` | append only (#457, on master) |
| Out-of-line bodies (spec §6.1) | built (`blob_status`, `fetch_blob`) | none |
| Emitters | `meeting.index`, `knowledge.chunk`, `meeting.record` (opt-in), `contact.mark` | `memory.fact` from the agent memory store (#457, provisional body) |
| Consumers | `contact.mark`, `meeting.index`; `memory.fact` inert-but-ready | none |
| Sharing with people | Phase 4 bundles | none |

Facts that shape the design:

- **On Hub `main`, only the first device holds the user private key.** `SyncIdentity.create(generate_user_key=True)`
  stores `user_priv`; an enrollee only adopts `user_pub` (`adopt_user_key`), and `Enrollment.approve` needs
  `build_cert`, which signs with `user_priv`. Whichever install is set up first is the only one that can pair
  new devices. LUCIDMeetingHub#40 (open, review requested) adds two ways out: a **second approver** and a
  **recovery kit** (§4.1).
- **On Hub `main`, revocation does not reach the other devices** (LUCIDMeetingHub#39, reproduced with three
  devices): the new epoch is never wrapped to the devices that remain, the revoked certificate is re-adopted
  from `devices/` on the next poll, and no other device learns of it. #40 fixes this with signed removal
  records; the IDE implements the fixed behavior, not `main`'s.
- **Every app install is its own device.** The Hub and the IDE on one machine are two devices of one user,
  each with its own signing and wrapping keys. That is what keeps the two apps independent: neither reads the
  other's vault.
- **Private sync keys live in the app's vault.** The Hub uses vault named blobs (`sync_identity`,
  `sync_devices`, `sync_epochs`), so a locked vault pauses sync. The landed L1 code (#457) instead reads a
  plaintext identity JSON from `LUCID_KSYNC_IDENTITY`; this proposal replaces that (§4.1).
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
- `session.chunk` for transcripts, in append-only slices with large slices out of line. It is specified here
  but not emitted until a dedicated redaction pass exists (owner answer Q4).

The IDE also consumes the Hub's `knowledge.chunk` and `meeting.index`, which retires the same-machine-only
`ide-inbox` folder drop (L3). CUI content never syncs: every turn records its compartment, and any item
produced by a CUI turn, or by a turn whose compartment is missing or unreadable, is excluded from every class.
A tombstone that retracts an already-synced item is the only exception (owner answer Q3; §4.3).

## 4. Decisions

### 4.1 Identity and keys

- **First device: the IDE on the user's main desktop** (owner ruling 3, "the IDE owns first-run identity").
  The Hub keeps its ability to generate a key for Hub-only users (`create(generate_user_key=True)`), unchanged.
- The IDE stores `device_sign_priv`, `device_wrap_priv`, `user_priv` (approvers only) and the epoch keys
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
- **Who holds the user key (Q1, confirmed by the owner): two approvers plus a recovery kit, as built in
  LUCIDMeetingHub#40.** Single-holder is out: with one key holder, losing that machine meant no device could be
  paired or revoked again. The IDE implements the
  same three folder records as the Hub, byte-compatible, so either app can play either role:
  - **Removal record** `devices/revoked/<device fp>.json`, signed by the user key:
    `{device, revoked, order (µs), by, user, epoch, excluded[]}`. Every device applies removals before
    adopting certificates, never re-adopts a removed device, and refuses its items. Key holders wrap every
    epoch they hold to every certified device lacking it, and ONLY key holders do (a device that has not
    seen a removal yet could otherwise forward the new epoch to the removed device). A device seals nothing
    until it holds an epoch minted after every removal it knows of. Two approvers removing devices
    concurrently settle on one more epoch excluding both.
  - **Approver record** `devices/approvers/<device fp>.json`: `user_priv` wrapped to that one device's
    certified X25519 key (HKDF info `lucid/user/wrap/v1`, AAD `<user fp>|<device fp>`), signed by the user
    key. Revoking an approver cannot take the key back; the UI warns, and the answer to a lost approver is a
    new identity.
  - **Recovery kit**: a file plus a 160-bit code shown once. It seals `user_priv` and the held epoch keys
    (HKDF-SHA256 info `lucid/recovery/v1`, ChaCha20-Poly1305, header as AAD), and restores onto an enrolled
    or a fresh device. It is kept off the sync folder.
  - **Setup for this user (owner-confirmed):** the IDE on the desktop creates the identity; the IDE on the Mac is
    promoted to second approver once paired; a recovery kit is exported at setup and stored apart from its
    code. Losing both approvers and the kit is the remaining reset: a new identity, then re-pair.

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
| `kg.fact` | the fact's `sync_id` | LWW per item, `tombstone` = forget | `{sync_id, entity: <entity natural key>, statement, scope, trust_label, confidence, status, source_session_id?, promoted_at}` |
| `kg.link` | JCS (spec §2) of the array `[from, relation, to]` (entity natural keys) | LWW per item, `tombstone` = unrelate | `{from, to, relation}` |

- **`kg.entity` keys are unambiguous because `kind` is a closed set.** `kind` is one of the store's `UserKind`
  values (`user:preference`, ...), none of which contains `|`, so the first `|` always ends the kind and a
  `|` inside `name` cannot make two entities share a key. A reader MUST reject a `kg.entity` whose `kind` is
  not a known `UserKind`.
- **`kg.link` keys are an unambiguous encoding.** `from`, `relation` and `to` are user-controlled and may
  contain `|`, so joining them with a separator would let two different links share a key and overwrite or
  tombstone each other. The natural key is the JCS serialization of the three-element array, which escapes
  every string, so distinct triples always produce distinct keys. The key is then hashed as for every class
  (spec §3.4).
- **Every fact has a stable `sync_id`, minted once.** A fact's local id is a device-local Snowflake, and the
  header carries only the hash of the natural key, so a device that received a fact could not otherwise name
  it again. The rules:
  - The device that first emits a fact mints `sync_id` = `kf_` + a UUIDv7 (spec §3.1) and stores it on the
    local fact. Facts that exist before sync is turned on get one at their first emit.
  - A device that applies a received fact stores the received `sync_id` on the local fact it creates or
    updates.
  - Every later update and every tombstone for that fact, from any device, reuses the same `sync_id`, so a
    fact received from another device can still be forgotten here and the forget reaches the device that
    made it.
  - A `kg.fact` body without a `sync_id`, or whose `sync_id` does not hash to the header's `key`, MUST be
    rejected.
- **References use natural keys, not ids.** A fact names its entity by natural key, not Snowflake id, so two
  devices that both learned "dark mode" converge on one entity. The consumer maps a natural key to its local
  entity id, creating the entity if needed.
- **Forget propagates.** Forgetting a fact on one device forgets it on all of them, because the forget is a
  tombstone on the fact's `sync_id`. That is what a user expects from "forget". The durable outbox below
  makes this hold when the sync folder is offline at the moment of the forget.
- **Scope travels with the fact.** `work` and `personal` sync, each behind its own class toggle, both on by
  default.
- **`cui` is refused by name.** A `kg.fact` with `scope: "cui"` MUST NOT be produced and MUST be rejected on
  read. The isolated CUI store (ADR-0014) is never read by the sync layer at all.
- **Nothing learned in a CUI turn is emitted (owner answer Q3).** CUI mode is set per chat session (ADR-0219),
  so a CUI session can sit in an ordinary workspace and write `work` facts to the main store. Every mutation
  reached from a turn carries that turn's compartment tag (§4.4); a mutation whose turn is tagged CUI, has no
  tag, or has a tag that cannot be read is not emitted (fail-closed). A mutation not reached from a turn (a
  Knowledge panel edit, an import) takes the compartment selected in that window, with the same rule. A
  tombstone for an item that was already synced is the one exception: it names only an item every device
  already holds and adds nothing from the CUI turn, so it is always emitted, and a forget made from a CUI
  session still reaches every device.
- **Writes are emitted at the store's existing mutation points:**
  - `addFact`, `upsertEntity` (first creation only);
  - `addLink` / `removeLink` (a `removeLink` without a relation emits one tombstone per link it removed);
  - `forgetFact`.
  These are reached from `learnFromTurn`, `agentRetain`, `relateEntities`, `unrelateEntities`, `forgetFact`,
  `importChatExport` and `addReportToKg`.
- **Every emit goes through a durable local outbox.** A mutation made while the sync folder is unreachable
  (or an append that fails) must still reach the other devices; otherwise a `forgetFact` or `removeLink` made
  offline would leave the user's deleted data on every other device. The rules:
  - The outbox lives inside the encrypted personal store (under the VMK), never in the sync root. An entry
    holds the class, the natural key, the body or the tombstone flag, and the item id and HLC stamp assigned
    at mutation time, so a late flush keeps the order the user acted in.
  - The mutation and its outbox entry are saved in the same store write. The mutation reports success only
    after that write succeeds; if the outbox write fails, the mutation fails and the store is left unchanged.
  - A flush runs at every poll while the store is unlocked and the folder is reachable: it seals each entry
    under the epoch current at flush time (so an entry queued before a removal is never sealed to the removed
    device), appends it to this device's journal, and drops the entry only after the append is durable.
  - A crash between the append and the drop re-appends the item with the same `id` and HLC stamp at the next
    flush; folding it a second time changes nothing (same id, same clock, same content), so this is harmless.
  - The UI shows "N changes waiting to sync" while the outbox is not empty.
  - This replaces, for every class in this proposal, the L1 posture in #457 that a failure to emit never
    fails the mutation. `memory.fact` keeps the #457 posture until its body freezes (L2).
- **Applying is a fold into the open store**, then a save, only while the store is unlocked. An applied item
  is not re-emitted (its `device` is not ours).
- **Not synced:**
  - the export audit trail (`exports`), which is per device by design;
  - the named KG packs and compiled KBs (DuckDB, P-KGPACK), which are a separate increment if wanted.

### 4.4 Sessions: `session.index` and `session.chunk`

- **Every turn records its compartment (owner answer Q3).** Sessions carry no compartment tag today. v1 adds
  one, written with each turn at turn time: the compartment the chat session ran that turn under (ADR-0219
  sets CUI mode per chat session, so a workspace-level rule is not enough). Turns recorded before the tag
  ships have no tag and are treated as CUI.
- `session.index`, natural key = session id, LWW per item:
  - body: `{title, cwd_label, cwd_device, model, turns, kind, created, updated, bytes}`;
  - on by default, so every device's session list shows every device's sessions, read-only, with a
    "from Mac" chip;
  - metadata only, and still under the Q3 rule: a session is indexed only while every turn in it carries a
    readable, non-CUI tag. The first CUI, untagged or unreadable turn stops its index updates, and if the
    session was already indexed a tombstone removes it from the other devices.
- `session.chunk`, natural key = `session_id + "#" + seq`, append-only. **Specified, not emitted (owner
  answer Q4).** Transcripts stay local-only until a dedicated redaction pass exists, with its own ADR.
  Dropping what the existing scanner flags is not enough: it finds hidden characters and secret patterns,
  not everything sensitive in prompts and code. When it ships:
  - body: `{session, seq, from_line, to_line, lines: [...]}`, out of line as a blob (§6.1) above 32 KB;
  - emitted at turn end, carrying the records appended since the last chunk, after the redaction pass;
  - the in-place `title` record is NOT copied (its content rides `session.index`);
  - a reader rebuilds the transcript by concatenating chunks in `seq` order.
- **Transcript sync defaults to off, with a per-workspace opt-in (owner answer Q5),** offered only once the
  Q4 redaction exists. Reasons:
  - they are large (3.4 GB on one machine);
  - they contain tool output and file contents.
- **Never synced, in any class:**
  - `credential_pin` records (they identify the account a device used);
  - any item from a turn tagged CUI, untagged, or with an unreadable tag (Q3, fail-closed); a tombstone that
    retracts an already-synced item is the only exception (§4.3).
- **Remote sessions show in the session list from their `session.index`.** With transcripts local-only, a
  remote session shows its metadata and says its transcript stays on the device that ran it. When
  `session.chunk` ships, remote sessions open read-only in the transcript view; resuming one needs a
  workspace on this device, so "resume here" is offered only when the session's git remote matches a local
  checkout, and otherwise the UI says why.

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
   natural keys and merge policies above (owner answer Q2). This is not an envelope change (§8).
   - `kg.*` bodies freeze at `body_v: 1` with the two key rules of §4.3: `kg.fact` carries the stable
     `sync_id` that is its natural key, and the `kg.link` natural key is the JCS of `[from, relation, to]`.
     The §3.4 natural-key table gains these rows, including the closed `kind` set behind `kg.entity`.
   - `session.index` freezes at `body_v: 1` with S4, when its emitter ships.
   - `session.chunk` is registered with a provisional body (`body_v: null`, like `memory.fact`) until the
     redaction ADR (Q4), so every reader skips it.
2. Add `scope: "cui"` on `kg.fact` to the §4.1 refusals, refused by name with a sentence.
3. State that `session.chunk` bodies above 32 KB MUST go out of line (§6.1).
4. Add the device-management records from LUCIDMeetingHub#40 to §6 (folder layout): `devices/revoked/`,
   `devices/approvers/`, the recovery kit format, and the epoch rules (only key holders re-share; seal
   nothing until an epoch excludes every known removal). #40 does not edit the pinned spec either, so this
   addendum is where both apps' implementations get their normative text.

The Hub then needs only to know the new classes exist and skip them (§7 handshake: unknown class → skip that
class, sync the rest) until it wants to consume them. The Hub's pre-meeting brief reading `kg.fact` is a
natural later consumer.

## 5. Increments (IDE lanes; each its own PR, demo, and ADR)

| # | Increment | Depends on |
|---|---|---|
| **S0** | Spec addendum (§4.6), co-owned docs PR in both repos, pins bumped together | this review |
| **S1** | IDE sync core: identity, epochs, folder enrollment, removal/approver records and epoch re-sharing (Hub#40 semantics), recovery kit format, journal reader + fold, cursors, §6.1 blobs, the durable outbox (§4.3). Proven two-way against the Hub's Python (a Hub-written journal folds in the IDE and vice versa; a Hub removal is honored by the IDE and vice versa; a Hub-made kit restores into the IDE), with the Hub's convergence and three-device removal tests ported | #457 (L1 envelope, on master), #524 (VMK for key custody, on master), LUCIDMeetingHub#40 (open) |
| **S2** | Pairing + folder UX in Settings (L5): create the user key or join with a pairing code, pick the sync folder, device list with approver chip, make approver, revoke (with the approver warning), recovery kit export/restore, status including changes waiting in the outbox | S1 |
| **S3** | Per-turn compartment tag (§4.4); `kg.*` emit + fold with `sync_id` and the JCS link key; two-device demo over a real folder: a fact learned on the PC is recalled on the Mac; a fact received from the PC is forgotten on the Mac and the forget reaches the PC; a forget made while the folder is offline arrives after reconnect; nothing from a CUI or untagged turn is emitted | S0, S2 |
| **S4** | `session.index` (on, Q3 rule), remote sessions in the session list from their metadata | S0, S2, S3 (compartment tag) |
| **S5** | L3: Knowledge panel ingests Hub `knowledge.chunk` and `meeting.index` | S1 |
| **S6** | Hub: registry knows the new classes (skip), later consumes `kg.fact` in the brief | S0 |
| later | Transcript redaction pass (its own ADR, Q4), then `session.chunk` with the per-workspace opt-in (Q5) and read-only remote transcripts | S4, redaction ADR |

S1-S3 is the minimum for "one knowledge graph on every machine". S4 adds session metadata; transcripts wait
for the redaction pass.

## 6. Threat model delta

- **Bodies are confidential; headers are not.** Bodies are ChaCha20-Poly1305 under per-item keys derived
  from the epoch key, and a stolen copy of the folder cannot decrypt them without a device's wrap key, which
  lives only inside that device's VMK-sealed store. Everything else in the folder is readable by anyone who
  can read the share.
- **What someone with a copy of the folder learns, in plaintext:**
  - per item header: the envelope version (`v`), the item id (`id`, a UUIDv7 that carries its creation time),
    the class (`type`), the hashed logical key (`key`), the body schema version (`body_v`), the user and device
    fingerprints, `source_app`, `origin` (kind, ref, shared_by), `created`, the HLC clock (millisecond time,
    counter, device), `supersedes`, the `tombstone` flag, `consent` scope, and `enc` (algorithm and epoch key
    id);
  - from journal lines: the ciphertext and signature lengths;
  - from the folder itself: file names, sizes and modification times of journal segments and blobs, the
    device records under `devices/` (certificates, pending pairing codes, removal and approver records) and
    the epoch records under `epochs/`;
  - so: how many items of which class each device writes, and when; which items are updated, forgotten or
    unlinked, and when; when devices were paired, promoted or removed; and the approximate size of every body,
    which for `session.index` and blobs tracks how much work was done.
- **Hashed keys of guessable names can be confirmed offline.** `key` is a truncated SHA-256 of the class and
  the casefolded natural key, with no secret in it. For low-entropy natural keys an attacker can hash a
  dictionary and test it: `kg.entity` (`kind|name`, e.g. `user:preference|dark mode`), `kg.link` (built from
  entity keys and a relation), and the Hub's `contact.mark` and `person.profile` (display names). Keys built
  from random ids (`kg.fact` `sync_id`, `session.index` and `session.chunk` session ids, Hub meeting stems
  only where they are random) do not leak this way. A keyed hash would close it but is an envelope change
  (spec §8), so v1 accepts it and says so here.
- **A device thief with the unlocked laptop reads what that device can read,** as today. Revoking the device
  mints a new epoch that every remaining device receives and the stolen one never does; it stops future
  access only, and the UI says so (Hub decision 10). If the stolen device was an approver it keeps the user
  key, so the answer there is a new identity, and the UI says that too.
- **A recovery kit plus its code is the whole account** up to the day it was made: keep them apart and off
  the folder. The code is random (160 bits), so the kit has no password to brute-force.
- **Anyone who can write to the folder** can try to inject items. Items are signed by certified device keys,
  and an unknown device or a bad signature is rejected (`verify_item_author`). They can also delete or
  truncate files: that is denial of service, not disclosure, and the local copy survives.

## 7. Owner answers (2026-11-15)

- **Q1, confirmed:** two approvers plus a recovery kit, as LUCIDMeetingHub#40 builds it. The desktop IDE
  creates the identity, the Mac IDE is promoted to second approver once paired, and a recovery kit is
  exported at setup and stored apart from its code. Single-holder is out. (§4.1)
- **Q2, confirmed:** the five classes `kg.entity`, `kg.fact`, `kg.link`, `session.index`, `session.chunk`.
  `kg.*` body v1 freezes only with the two key fixes: `kg.fact` carries a stable `sync_id` that every later
  update and tombstone reuses, and `kg.link` uses the JCS of `[from, relation, to]` as its key. (§4.3, §4.6)
- **Q3, per-turn compartment tags:** the compartment is recorded on every turn, and CUI-tagged turns are
  excluded from every sync class. A turn with no tag, or a tag that cannot be read, is excluded too
  (fail-closed). Workspace-only exclusion is not enough because CUI mode is set per chat session
  (ADR-0219). (§4.3, §4.4)
- **Q4, transcripts stay local-only** until a dedicated redaction pass exists, with its own ADR. The scanner
  finds hidden characters and secret patterns, not everything sensitive in prompts and code.
  `session.chunk` is specified but not emitted; `session.index` (metadata only) may sync, under the Q3
  exclusion. (§4.4)
- **Q5, transcript sync defaults to off,** with a per-workspace opt-in, once Q4's redaction exists. (§4.4)
