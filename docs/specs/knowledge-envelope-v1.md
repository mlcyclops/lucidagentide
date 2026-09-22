# Knowledge Item Envelope, version 1

**Status:** frozen wire format; `memory.fact` **body** schema provisional (see §4.2).
**Owners:** `mlcyclops/lucidagentide` (host) and `mlcyclops/LUCIDMeetingHub` (pins a
vendored copy). Approved by the owner ruling on LUCIDMeetingHub#5, 2026-09-22.
**Conformance vectors:** `knowledge-envelope-v1.vectors.json`,
sha256 `7afaffb29b038bac01768daef736b370c58111d0ba902547356a35b094266d6d`.

The key words MUST, MUST NOT, SHOULD, MAY are to be interpreted as in RFC 2119.

This document defines the only format in which knowledge crosses between Lucid apps and
devices. It is deliberately small: the sync machinery reads the envelope, and the body is
ciphertext no infrastructure can read.

Changing anything in §2-§6 is a version bump. The vectors file is the operative test: an
implementation is conformant exactly when it reproduces every value in it from the same
inputs. Prose is not the contract; the vectors are.

---

## 1. Why the details are pinned this hard

Two independent implementations (Python in the Hub, TypeScript in the IDE) must produce
byte-identical signed bytes. When they do not, nothing crashes - signatures fail to verify
and the other device's items are silently skipped, which presents to the user as "sync
doesn't work" with no error anywhere. Every rule below exists to remove one way that can
happen.

---

## 2. Canonicalization (normative)

Canonical bytes are **RFC 8785 (JCS)**, with two restrictions that remove its two hardest
parts rather than implementing them:

1. **Header keys MUST match `^[a-z][a-z0-9_]*$`.** JCS sorts by UTF-16 code unit; most
   languages sort by code point. The two orders differ only outside the Basic Multilingual
   Plane, so an ASCII-lowercase key rule makes them identical and every implementation can
   use its native sort.
2. **Floating-point numbers MUST NOT appear anywhere in a header.** JCS would require
   reproducing ECMAScript's Number-to-string algorithm exactly. Integers MUST be within
   ±(2^53 - 1). Bodies are ciphertext, so their JSON shape never affects a signature -
   this restriction applies to the header only.

Additionally: UTF-8 output, no insignificant whitespace (`,`/`:` separators), object keys
sorted ascending, no `NaN`/`Infinity`, no lone surrogates.

An implementation MUST **reject** (not coerce) a header containing a float, a
non-conforming key, or an out-of-range integer. The vectors file contains
`must_reject: true` cases for each.

---

## 3. The envelope

```jsonc
{
  "v": 1,                          // envelope schema version
  "id": "ki_<uuidv7>",             // §3.1
  "type": "contact.mark",          // §4 registry; anything else MUST be rejected
  "key": "<32 hex>",               // §3.4 hashed logical key - what merges across devices
  "body_v": 1,                     // BODY schema version for this class; null = provisional
  "user": "u_<16 hex>",            // fingerprint of the user public key
  "device": "d_<16 hex>",          // fingerprint of the authoring device signing key
  "source_app": "meeting-hub",     // "meeting-hub" | "lucid-ide"
  "origin": { "kind": "meeting", "ref": "ki_...", "shared_by": null },
  "created": "2026-09-22T00:00:00Z",
  "clock": { "hlc": "<§3.2>" },
  "supersedes": null,              // id of the revision this replaces
  "tombstone": false,
  "consent": { "scope": "self" },  // "self" | "shared:<grant-id>"
  "enc": { "alg": "c20p-hkdf-v1", "key": "ek_2026q3" },
  "body": "<base64 ciphertext>",
  "sig": "<base64 Ed25519>"
}
```

The **header** is the envelope minus `body` and `sig`. It is both the signed material and
the AEAD associated data, so metadata and ciphertext cannot be recombined across items.

Unknown header fields MUST be preserved verbatim when re-serializing (they are covered by
the signature) and MUST NOT be interpreted.

### 3.1 Item ids

`ki_` + a UUIDv7 (RFC 9562): 48-bit big-endian milliseconds since the Unix epoch, then 74
random bits, with version and variant set. Ids are time-sortable, which is what makes a
segment scan and dedup cheap.

### 3.2 Hybrid logical clock

`<ISO-8601 UTC with exactly 3 fractional digits>-<counter, 4 digits>-<device fingerprint>`,
e.g. `2026-09-20T10:26:40.302Z-0000-d_47fad3bdd44d3be6`.

On each stamp: if the wall clock is not strictly greater than the previous stamp's, reuse
the previous stamp's milliseconds and increment the counter. A counter above 9999 in one
millisecond MUST be an error, not a silent wrap.

Total order for merge: `(milliseconds, counter, device fingerprint)`. The device tiebreak
is what makes the order total rather than partial - which is precisely what lets two
devices fold the same items in different arrival orders and land on identical state.

An HLC, not a wall clock, because wall clocks go **backwards** (NTP correction, VM resume,
a user fixing a timezone) and a backwards jump would silently reorder that device's writes.

### 3.3 Fingerprints

`u_` or `d_` + the first 8 bytes of `SHA-256(raw public key)`, hex.

### 3.4 Logical key

`key` = the first 16 bytes of `SHA-256(utf8(type + "|" + casefold(trim(natural_key))))`,
hex. Two devices that independently record the same thing MUST produce the same `key`, or
the merge in §4.4 sees two objects where the user sees one.

It is **hashed** because a plaintext key would put contact names and meeting titles in
cleartext metadata on a substrate the whole design assumes is untrusted. A hashed key
still merges; it is meaningless to anyone who does not already know the name.

Natural keys per class (v1):

| Class | Natural key |
|---|---|
| `contact.mark`, `person.profile` | the person's display name |
| `meeting.index`, `meeting.record` | the meeting's stable local identifier (the Hub uses its record filename stem) |
| `knowledge.chunk` | the source document identifier |
| `memory.fact` | the fact's own id in the producing store |

An implementation MUST reject an empty or whitespace-only natural key rather than hashing
it - a shared empty key would merge unrelated items into one.

---

## 4. Item class registry

| `type` | `body_v` | Merge policy | Sync default |
|---|---|---|---|
| `memory.fact` | **null (provisional)** | LWW per item id | on |
| `knowledge.chunk` | 1 | append-only + `supersedes` | on (text; blobs on demand) |
| `meeting.index` | 1 | LWW per item id | on |
| `meeting.record` | 1 | append-only + `supersedes` | **off** (per-meeting opt-in) |
| `contact.mark` | 1 | **per-field** LWW | on |
| `person.profile` | 1 | **per-field** LWW | on |

### 4.1 Types that do not exist in this format

These identifiers have **no representation** in v1 and MUST NOT be added in a
v1-compatible revision. An implementation MUST reject each one by name with an explanatory
error, so the refusal is a sentence a user can read rather than a lookup failure:

| Refused id | Why |
|---|---|
| `voiceprint` | a biometric identifier of the user AND of third parties who never consented to it leaving the capture machine |
| `provider_key` | provider API keys never leave the vault (SECURITY.md) |
| `oauth_token` | OAuth tokens never leave the vault (SECURITY.md) |
| `vault_passphrase` | not stored at all, let alone synced (SECURITY.md) |
| `brief` | pre-meeting briefs are device-local ephemera; regenerate instead of syncing |

This is structural on purpose: the sync layer cannot ship what it cannot name. The
voiceprint line is absolute for v1 **including the user's own "Me" profile** (owner ruling,
LUCIDMeetingHub#5 decision 7).

### 4.2 `memory.fact` is deliberately unfrozen

`body_v` is `null` until lucidagentide#356 lands. The real fact shape is then dumped from
the fixed reader and frozen as `body_v: 1` - guessing it now and correcting later would
mean a migration of data users already synced. Producers MUST NOT emit `memory.fact` items
while `body_v` is null; consumers MUST ignore them.

### 4.3 Frozen bodies

- `meeting.index`: `{title, app, start, end, participants[], summary, decisions[], todos[]}`
- `contact.mark`: `{name, lucid_user, collab_approved, notes, email_sha256?, pubkey?, updated}`
  (the plaintext email address is never carried - only its SHA-256, per the hashed-email
  directory decision)
- `meeting.record`, `knowledge.chunk`, `person.profile`: as produced today by the Hub's
  existing records; content unchanged by this spec.

### 4.4 Merge policies (normative)

- **append-only**: dedup by `id`; a re-process emits a NEW item with `supersedes`. Content
  is never merged.
- **LWW per item**: the highest HLC revision of an id wins; `tombstone: true` retracts.
- **per-field LWW**: each body field carries the HLC of the item that set it; fields merge
  independently.
- **Consent booleans ratchet.** For a field named in `consent_fields` (v1:
  `collab_approved` on `contact.mark`), plain LWW is not acceptable: a device with a fast
  clock could resurrect revoked consent, and "regardless of clock" cannot be expressed by
  comparing clocks. The rule is therefore causal, not temporal:

  > The field is `false` if any item set it `false` and **no item that names that
  > revocation in `supersedes` set it `true`**.

  A device that has SEEN a revocation can re-grant by superseding it explicitly - which is
  exactly what a user clicking "approve again" on a contact whose UI shows "revoked on
  laptop" produces. A device that has NOT seen the revocation cannot accidentally undo it,
  because it has nothing to supersede. The outcome does not depend on arrival order or on
  either clock, so both devices converge to the same value.

  Merge state for these fields MUST therefore retain the revocation item ids, not just the
  current boolean.

No general CRDT library. The only concurrently-mutable state is small per-field records;
per-field LWW over a total HLC order converges, and every merge stays explainable to a user
("the laptop's newer edit won").

---

## 5. Cryptography

| Purpose | Algorithm |
|---|---|
| User identity, device signing | Ed25519 |
| Device key wrapping | X25519 ECDH → HKDF-SHA256 → ChaCha20-Poly1305 |
| Body encryption | ChaCha20-Poly1305 (RFC 8439) |
| Key derivation | HKDF-SHA256 |

**Content key** = `HKDF-SHA256(ikm = epoch_key, salt = utf8(item_id),
info = utf8("lucid/ki/body/v1"), length = 32)`.
**Nonce** = 12 zero bytes. This is safe *because* the key is unique per item; an
implementation MUST NOT reuse a content key for a second item.

**Why not XChaCha20-Poly1305** (which the original proposal named): neither the Hub's only
crypto dependency (`cryptography`) nor Node/Bun ships it, so both sides would need
libsodium bindings - a native artifact in a PyInstaller freeze on three platforms.
XChaCha exists to make *random* 192-bit nonces safe, and this design has no random nonces.

**AEAD associated data** = the canonical header bytes.
**Signature** = Ed25519 over `SHA-256(canonical_header) || SHA-256(body_ciphertext)`, by
the authoring device's signing key.

Verification order: check `v`, verify the signature, then decrypt. The AEAD tag re-checks
the header independently, so a tampered header fails twice.

### 5.1 Identity and epochs

- One **user key** (Ed25519) per user, generated once, on the first device.
- Per-device **subkeys**: Ed25519 (sign) + X25519 (wrap), certified by the user key. A
  device certificate is `{device, label, sign_pub, wrap_pub, created}` canonicalized and
  signed by the user key.
- **Epoch keys** are 32 random bytes, wrapped to each device's X25519 public key. Device
  revocation mints a NEW epoch wrapped only to the surviving devices.
- Revocation stops **future** access only. Content a revoked device already decrypted is
  out of reach - stated plainly in user-facing copy (owner ruling, decision 10).

---

## 6. Journal layout and transport

```
<sync-root>/
  u_<user fp>/
    spec.json                       # {envelope_v, class_versions, spec_sha256}
    devices/<device fp>.json        # device certificates (public)
    devices/pending/<code>.json     # enrollment requests
    epochs/<epoch id>.<device fp>   # epoch key wrapped to that device
    journal/<device fp>/000001.jl   # one envelope per line, append-only
    blobs/<item id>.enc             # large bodies, fetched on demand
```

- A device MUST append only to its own `journal/<own fp>/` directory. No two devices ever
  write the same file, which is what makes any dumb file replicator (SMB, Syncthing,
  OneDrive, a USB stick) a valid transport with no merge logic.
- Segments rotate at a size cap. A partially replicated trailing line MUST be skipped, not
  treated as corruption; the reader's cursor advances only past fully verified lines.
- Readers SHOULD poll (stat `mtime`+`size`) rather than rely on filesystem change
  notification, which is unreliable on network and cloud-sync folders.
- The relay (later) carries the same segments; the format does not change with transport.

---

## 7. Startup handshake

Each app reads `spec.json` at the sync root and compares `envelope_v` and the per-class
`body_v` map with its own.

- Equal → sync.
- Remote `envelope_v` higher → **degrade to no-sync** with a user-visible message naming
  the version. Never a partial apply.
- A class whose `body_v` is unknown or provisional → skip that class, sync the rest.

Non-breaking by construction: a mismatch degrades to no-sync, never to broken apps.

---

## 8. Versioning

The envelope version changes only for a header-shape change. A frozen body schema changes
via its class's `body_v`. Both repos pin this file by sha256 and fail their own test suite
on divergence, mirroring the `omp` CLI-surface drift monitor that already keeps the two
repos honest (LUCIDMeetingHub `docs/INTEGRATION.md`).
