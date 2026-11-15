// Phase C (ADR-0540): end-to-end encrypted chat (contract CE-1 section 13, meet_relay._Wave3ChatE2ee): settings
// `chat_e2ee` ("default" or "required") and `chat_history_share`; device key bundles, wraps and own-device history
// shares, the signed member log of each group chat and channel, envelopes on every message route and
// `/v1/chat/event`. The relay stores what devices send and checks only shapes and sizes: it never judges a signature
// or a ciphertext. Persisted in ext["ce"] exactly as the Python relay keeps it: `{v, since, seq, bundles, wraps,
// logs}` (bundles: principal -> device -> [bundle + rts]; wraps: "principal|device" -> [wrap + seq + rts]; logs:
// channel id -> [entry + rts]). The first read of that part migrates the conversations from before chat encryption.
// A child module of meet_hub: it shares the one lock.

use super::channels::{members_of, CHANNEL_KINDS, CHANNEL_MEMBERS_MAX, NO_CHANNEL};
use super::sfu::e2ee_b64;
use super::*;

/// A message route carrying an envelope (x up to 64 KB plus its tag).
pub const BODY_MAX: usize = 192 * 1024;
/// `POST /v1/chat/keys`.
pub const KEYS_BODY_MAX: usize = 1024 * 1024;
const MODES: [&str; 2] = ["default", "required"];
pub(crate) const PLAIN: &str = "this conversation is end-to-end encrypted; update Lucid to send in it";
const NOT_LINKABLE: &str = "this conversation is end-to-end encrypted, so it cannot be linked to Slack or Teams";
const GUESTS_OFF: &str = "chat is off while guests are here, because this relay requires end-to-end encryption";
const REQUIRED_LINKS: &str = "this relay requires end-to-end encryption, so conversations cannot be linked to Slack or Teams";
const REQUIRED_BRIDGEABLE: &str = "this relay requires end-to-end encryption, so conversations that can be linked to Slack or Teams are off";
const NO_BRIDGE_POLICY: &str = "your organization's policy does not allow conversations that can be linked to Slack or Teams";
pub(super) const NOT_E2EE: &str = "this conversation is not end-to-end encrypted; send plain text in it";
pub(super) const CREATE_OLD: &str = "conversations are end-to-end encrypted; update Lucid to start one";
const NEEDS_LOG: &str = "this conversation is end-to-end encrypted; update Lucid to change who is in it";
const NO_BASELINE: &str = "this conversation's member list has not been recorded yet; open it in Lucid first";
const HAS_BASELINE: &str = "this conversation's member list was already recorded";
const LOG_MOVED: &str = "the member list has changed; fetch it and sign the next entry";
pub(super) const GROUP_OTHER: &str = "a group chat of these people already exists with the other kind of encryption";
const NO_SHARES: &str = "this relay does not allow sharing message history with another device";
pub(super) const NOT_IN: &str = "both people must be in that conversation";
const BUSY: &str = "you joined or left conversations too often; wait a minute";
pub(super) const DEVICE_ONLY: &str = "chat keys belong to a device certificate";
const NOT_ADMIN: &str = "only an admin of this conversation can do that";
const GONE: &str = "that message is no longer kept";
/// Every counter, epoch, seq and time (contract section 2).
const MAX: i64 = (1 << 53) - 1;
/// A bundle's `created` at most this far in the future (seconds).
const SKEW: f64 = 600.0;
/// expires - created.
const BUNDLE_LIFE: i64 = 35 * 86400;
/// How long a published bundle is kept.
const BUNDLE_KEEP_S: f64 = 400.0 * 86400.0;
const BUNDLES_PER_DEVICE: usize = 3;
/// People one GET /v1/chat/devices asks about.
const DEVICES_MAX: usize = 200;
/// Wraps one POST /v1/chat/keys carries.
const WRAPS_MAX: usize = 500;
/// Wraps kept per recipient device (the oldest go).
const WRAPS_KEEP: usize = 50000;
/// A wrap's blob: nonce, key and tag.
const BLOB_MIN: usize = 28;
const BLOB_MAX: usize = 512;
/// Wraps one GET /v1/chat/keys answers.
const KEYS_LIMIT: i64 = 500;
/// Edits, deletes and events kept on one message.
const EVENTS_MAX: usize = 2000;
/// Log entries a conversation view carries (the rest: GET /v1/chat/log).
const LOG_VIEW: usize = 500;
/// People one log entry names.
const LOG_WHO_MAX: usize = 1000;
/// Members of an encrypted channel.
const CHANNEL_MAX: usize = 1000;
/// Channel joins and leaves per person per minute.
const RATE: usize = 10;
const RATE_S: f64 = 60.0;
/// Encrypted files one message names.
pub(super) const FILES_MAX: usize = 10;
const PEM_MAX: usize = 8192;
const CHAIN_MAX: usize = 16384;
/// DER ECDSA (P-256 or P-384).
const SIG_MIN: usize = 8;
const SIG_MAX: usize = 139;
/// Padded payload sizes; `x` adds a 16-byte tag.
const BUCKETS: [usize; 5] = [256, 1024, 4096, 16384, 65536];
const MEMBER: &[u8] = b"lucid-meet-chat-member-v1";
const ZERO: &str = "0000000000000000000000000000000000000000000000000000000000000000";
const ENVELOPE: [&str; 18] = ["v", "d", "sr", "e", "c", "pe", "pc", "k", "r", "s", "t", "q", "a", "ls", "lh", "n", "x", "g"];
const EVENT_KINDS: [&str; 4] = ["react", "vote", "close", "pin"];
const ENTRY: [&str; 8] = ["seq", "op", "by", "by_device", "who", "ts", "prev", "sig"];
/// PC-1: an archive or unarchive entry names the policy it was signed under.
const ENTRY_POLICY: [&str; 9] = ["seq", "op", "by", "by_device", "who", "ts", "prev", "sig", "policy"];
const ENTRY_FIRST: [&str; 11] = ["seq", "op", "by", "by_device", "who", "ts", "prev", "sig", "kind", "bridgeable", "admins"];
const BUNDLE: [&str; 9] = ["principal", "device", "dck", "created", "expires", "serial", "cert", "chain", "sig"];
const WRAP: [&str; 12] = ["cid", "from", "epoch", "to", "eph", "dck_sha256", "blob", "members", "log_seq", "log_hash", "ts", "sig"];
const SHARE: [&str; 10] = ["cid", "orig", "from", "epoch", "to", "eph", "dck_sha256", "blob", "ts", "sig"];
/// `fwd` too: a forwarded encrypted message carries its origin inside the payload (`fw`, CE-1 revision 4).
const PLAIN_FIELDS: [&str; 5] = ["text", "mentions", "preview", "poll", "fwd"];

/// In memory: the settings and each person's recent channel joins and leaves (monotonic times).
pub struct Ce {
    mode: String,
    share: bool,
    checked: bool,
    hits: HashMap<String, VecDeque<f64>>,
}

impl Default for Ce {
    fn default() -> Ce {
        Ce { mode: "default".into(), share: true, checked: false, hits: HashMap::new() }
    }
}

// ── shapes (pure: the relay checks shapes and sizes only) ────────────────────────────────────────────────────

/// _ce_plain_fields: a message request carries a plain-text field (refused in an encrypted conversation).
pub fn plain_fields(body: &Obj) -> bool {
    PLAIN_FIELDS.iter().any(|k| !matches!(body.get(*k), None | Some(Value::Null)))
}

fn same_keys(o: &Obj, keys: &[&str]) -> bool {
    o.len() == keys.len() && keys.iter().all(|k| o.contains_key(*k))
}

fn hex_of(s: &str, least: usize, most: usize) -> bool {
    (least..=most).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn is_principal(s: &str) -> bool {
    (1..=254).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b".!#$%&'*+/=?^_`{|}~@-".contains(&c))
}

fn is_device(s: &str) -> bool {
    hex_of(s, 16, 16)
}

pub(super) fn is_mid(s: &str) -> bool {
    hex_of(s, 32, 32)
}

/// A kept message: a mid, or an older relay id.
fn is_ref(s: &str) -> bool {
    hex_of(s, 12, 32)
}

fn is_hash(s: &str) -> bool {
    hex_of(s, 64, 64)
}

fn is_serial(s: &str) -> bool {
    hex_of(s, 1, 64)
}

fn is_channel_id(s: &str) -> bool {
    s.len() == 18 && s.starts_with("c-") && hex_of(&s[2..], 16, 16)
}

/// _ce_int: a whole number (not a bool, not a float) from `least` to 2^53 - 1.
fn int(v: Option<&Value>, what: &str, least: i64) -> R<i64> {
    match pj::as_int(v) {
        Some(n) if (least..=MAX).contains(&n) => Ok(n),
        _ => bad(format!("{what} must be a whole number from {least} to {MAX}")),
    }
}

/// _ce_match: a string the predicate accepts.
fn matched(v: Option<&Value>, ok: fn(&str) -> bool, message: &str) -> R<String> {
    match v {
        Some(Value::String(s)) if ok(s) => Ok(s.clone()),
        _ => bad(message),
    }
}

fn principal_of(v: Option<&Value>, what: &str) -> R<String> {
    matched(v, is_principal, &format!("{what} must be a lower-case address"))
}

/// _ce_people: lower-case addresses, each once (at most LOG_WHO_MAX).
fn people_of(v: Option<&Value>, what: &str) -> R<Vec<String>> {
    let Some(Value::Array(list)) = v.filter(|v| v.as_array().map(|a| a.len() <= LOG_WHO_MAX).unwrap_or(false)) else {
        return bad(format!("{what} must be a list of people"));
    };
    let out = list.iter().map(|p| principal_of(Some(p), what)).collect::<R<Vec<String>>>()?;
    let unique: HashSet<&String> = out.iter().collect();
    if unique.len() != out.len() {
        return bad(format!("{what} names someone twice"));
    }
    Ok(out)
}

pub(super) fn mid_of(v: Option<&Value>, what: &str) -> R<String> {
    matched(v, is_mid, &format!("{what} must be a message id (32 hex)"))
}

fn sig_of(v: Option<&Value>, what: &str) -> R<String> {
    e2ee_b64(v, SIG_MIN, SIG_MAX, &format!("{what} must be a signature (base64)"))?;
    Ok(v.and_then(Value::as_str).unwrap_or_default().to_string())
}

fn hash_of(v: Option<&Value>, what: &str) -> R<String> {
    matched(v, is_hash, &format!("{what} must be a hash (64 hex)"))
}

/// _ce_device_ref: `{principal, device}` (and `serial`) of a wrap's sender or recipient.
fn device_ref(v: Option<&Value>, what: &str, serial: bool) -> R<Obj> {
    let keys: &[&str] = if serial { &["principal", "device", "serial"] } else { &["principal", "device"] };
    let Some(Value::Object(o)) = v.filter(|v| v.as_object().map(|o| same_keys(o, keys)).unwrap_or(false)) else {
        return bad(format!("{what} must be {{{}}}", keys.join(", ")));
    };
    let mut out = obj([
        ("principal", Value::from(principal_of(o.get("principal"), &format!("{what}.principal"))?)),
        ("device", Value::from(matched(o.get("device"), is_device, &format!("{what}.device must be a device id (16 hex)"))?)),
    ]);
    if serial {
        out.insert("serial".into(), Value::from(matched(o.get("serial"), is_serial, &format!("{what}.serial must be a certificate serial (hex)"))?));
    }
    Ok(out)
}

/// _ce_ref: an optional message reference of a request (thread, reply_to): "" when absent.
fn ref_of(v: Option<&Value>, what: &str) -> R<String> {
    match v {
        None | Some(Value::Null) => Ok(String::new()),
        Some(Value::String(s)) if s.is_empty() => Ok(String::new()),
        _ => matched(v, is_ref, &format!("{what} must be a message id")),
    }
}

/// _ce_lp: each field as its 4-byte big-endian length, then its bytes.
fn lp(fields: &[&[u8]]) -> Vec<u8> {
    let mut out = Vec::with_capacity(fields.iter().map(|f| f.len() + 4).sum());
    for f in fields {
        out.extend_from_slice(&(f.len() as u32).to_be_bytes());
        out.extend_from_slice(f);
    }
    out
}

/// A direct-message conversation's cid: `dm:` + hex(SHA-256(lp(p1, p2))), p1 < p2.
pub(super) fn dm_cid(a: &str, b: &str) -> String {
    let (p1, p2) = if a <= b { (a, b) } else { (b, a) };
    format!("dm:{}", crate::codec::sha256_hex(&lp(&[p1.as_bytes(), p2.as_bytes()])))
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok()).collect()
}

/// _ce_u64 of a stored number (int(value): a float is cut to its whole part).
fn u64_of(v: Option<&Value>) -> Option<[u8; 8]> {
    let n = match v? {
        Value::Number(n) => n.as_u64().or_else(|| n.as_f64().filter(|f| f.is_finite() && *f >= 0.0 && *f < 1.8e19).map(|f| f.trunc() as u64))?,
        Value::Bool(b) => *b as u64,
        _ => return None,
    };
    Some(n.to_be_bytes())
}

fn strs(v: Option<&Value>) -> Option<Vec<&str>> {
    v?.as_array()?.iter().map(Value::as_str).collect()
}

/// _ce_entry_bytes: the signed bytes of a member-log entry (contract section 7.2); None when the entry is not shaped
/// so that they exist.
fn entry_bytes(cid: &str, e: &Obj) -> Option<Vec<u8>> {
    let op = e.get("op")?.as_str()?;
    let first = op == "create" || op == "baseline";
    let mut who = strs(e.get("who"))?;
    who.sort_unstable();
    let mut admins = if first { strs(e.get("admins"))? } else { Vec::new() };
    admins.sort_unstable();
    let seq = u64_of(e.get("seq"))?;
    let ts = u64_of(e.get("ts"))?;
    let prev = unhex(e.get("prev")?.as_str()?)?;
    let kind = if first { e.get("kind")?.as_str()? } else { "" };
    let bridgeable: &[u8] = if first && pj::truthy(e.get("bridgeable")) { b"1" } else { b"0" };
    let (n_who, n_admins) = ((who.len() as u64).to_be_bytes(), (admins.len() as u64).to_be_bytes());
    let (by, by_device) = (e.get("by")?.as_str()?, e.get("by_device")?.as_str()?);
    // PC-1 (CE-1 revision 6): an archive or unarchive entry adds the 32 raw bytes of its policy hash inside the same lp
    let policy = if pc::POLICY_OPS.contains(&op) { Some(unhex(e.get("policy")?.as_str()?)?) } else { None };
    let mut fields: Vec<&[u8]> = vec![MEMBER, cid.as_bytes(), &seq[..], op.as_bytes(), by.as_bytes(), by_device.as_bytes(), &n_who[..]];
    fields.extend(who.iter().map(|p| p.as_bytes()));
    fields.extend([&ts[..], &prev[..], kind.as_bytes(), bridgeable, &n_admins[..]]);
    fields.extend(admins.iter().map(|p| p.as_bytes()));
    if let Some(policy) = &policy {
        fields.push(policy);
    }
    Some(lp(&fields))
}

/// _ce_entry_hash: `prev` of the entry after `e`: SHA-256 of its signed bytes, hex.
fn entry_hash(cid: &str, e: &Obj) -> Option<String> {
    entry_bytes(cid, e).map(|b| crate::codec::sha256_hex(&b))
}

/// _ce_envelope: a checked envelope (contract section 6): exactly its fields, the caller's device and certificate
/// serial, `k` one of `kinds`, `r` = `ref_`, the head (`head` None: a direct message or a call, `ls` 0 and `lh` zero;
/// else `ls` from 1 to `head`), and the sizes. Nothing of the ciphertext or the signature is judged.
pub(super) fn envelope(v: Option<&Value>, kinds: &[&str], ref_: &str, who: &Identity, head: Option<usize>) -> R<Obj> {
    let Some(Value::Object(e)) = v.filter(|v| v.as_object().map(|o| same_keys(o, &ENVELOPE)).unwrap_or(false)) else {
        return bad(format!("enc must be an envelope {{{}}}", ENVELOPE.join(", ")));
    };
    if pj::as_int(e.get("v")) != Some(1) {
        return bad("enc v must be 1");
    }
    let d = matched(e.get("d"), is_device, "enc d must be a device id (16 hex)")?;
    if who.own_device() && d != who.device {
        return forbidden("enc d must be your own device");
    }
    let sr = matched(e.get("sr"), is_serial, "enc sr must be a certificate serial (hex)")?;
    if !who.serial.is_empty() && sr != who.serial {
        return forbidden("enc sr must be your certificate's serial");
    }
    int(e.get("e"), "enc e", 1)?;
    let c = int(e.get("c"), "enc c", 1)?;
    let (pe, pc) = (int(e.get("pe"), "enc pe", 0)?, int(e.get("pc"), "enc pc", 0)?);
    if c != 1 && (pe != 0 || pc != 0) {
        return bad("enc pe and pc are 0 except on the first envelope of an epoch");
    }
    if !e.get("k").and_then(Value::as_str).map(|k| kinds.contains(&k)).unwrap_or(false) {
        return bad(format!("enc k must be {}", kinds.join(" or ")));
    }
    if e.get("r").and_then(Value::as_str) != Some(ref_) {
        return bad(if ref_.is_empty() { "enc r must be empty" } else { "enc r must name the message it is about" });
    }
    int(e.get("s"), "enc s", 1)?;
    for key in ["t", "q"] {
        if e.get(key).and_then(Value::as_str) != Some("") {
            matched(e.get(key), is_ref, &format!("enc {key} must be a message id or empty"))?;
        }
    }
    if !matches!(e.get("a"), Some(Value::Bool(_))) {
        return bad("enc a must be true or false");
    }
    let ls = int(e.get("ls"), "enc ls", 0)?;
    let lh = hash_of(e.get("lh"), "enc lh")?;
    match head {
        None if ls != 0 || lh != ZERO => return bad("enc ls and lh are 0 outside channels and group chats"),
        Some(head) if !(1..=head as i64).contains(&ls) => return bad("enc ls must name an entry of the member list"),
        _ => {}
    }
    e2ee_b64(e.get("n"), 12, 12, "enc n must be a 12-byte nonce (base64)")?;
    let padded = "enc x must be a padded ciphertext (base64)";
    let x = e2ee_b64(e.get("x"), BUCKETS[0] + 16, BUCKETS[BUCKETS.len() - 1] + 16, padded)?;
    if !BUCKETS.contains(&(x.len() - 16)) {
        return bad(padded);
    }
    sig_of(e.get("g"), "enc g")?;
    Ok(e.clone())
}

/// _ce_bundle: a checked device key bundle (contract section 4) of the caller's own device.
fn bundle_of(v: Option<&Value>, who: &Identity, now: f64) -> R<Obj> {
    let Some(Value::Object(b)) = v.filter(|v| v.as_object().map(|o| same_keys(o, &BUNDLE)).unwrap_or(false)) else {
        return bad(format!("bundle must be {{{}}}", BUNDLE.join(", ")));
    };
    if b.get("principal").and_then(Value::as_str) != Some(who.principal.as_str()) || b.get("device").and_then(Value::as_str) != Some(who.device.as_str()) {
        return forbidden("a bundle is published by its own device");
    }
    let point = "dck must be an uncompressed P-384 point (base64)";
    if e2ee_b64(b.get("dck"), 97, 97, point)?[0] != 4 {
        return bad(point);
    }
    let created = int(b.get("created"), "created", 1)?;
    let expires = int(b.get("expires"), "expires", 1)?;
    if created as f64 > now + SKEW {
        return bad("created is in the future");
    }
    if !(created < expires && expires <= created + BUNDLE_LIFE) {
        return bad("a bundle lives at most 35 days");
    }
    if expires as f64 <= now {
        return bad("that bundle has expired");
    }
    let serial = matched(b.get("serial"), is_serial, "serial must be a certificate serial (hex)")?;
    if !who.serial.is_empty() && serial != who.serial {
        return forbidden("serial must be your certificate's serial");
    }
    match b.get("cert") {
        Some(Value::String(c)) if !c.is_empty() && pj::char_len(c) <= PEM_MAX && c.contains("-----BEGIN CERTIFICATE-----") => {}
        _ => return bad("cert must be the device certificate (PEM)"),
    }
    match b.get("chain") {
        Some(Value::String(c)) if pj::char_len(c) <= CHAIN_MAX => {}
        _ => return bad("chain must be PEM or empty"),
    }
    sig_of(b.get("sig"), "sig")?;
    Ok(b.clone())
}

fn now_ms() -> i64 {
    (pj::now() * 1000.0) as i64
}

fn list_value(list: &[String]) -> Value {
    Value::Array(list.iter().cloned().map(Value::from).collect())
}

/// `sorted(a) != sorted(set(b))`: the entry names exactly these people.
fn same_people(named: &[String], people: &[String]) -> bool {
    let mut a = named.to_vec();
    a.sort();
    let mut b = people.to_vec();
    b.sort();
    b.dedup();
    a == b
}

/// _ce_sound_log: a stored log up to its first entry that is not what the routes rely on (a hand-edited
/// state.json): its hash chain would break there anyway.
fn sound_log(cid: &str, entries: &[Value]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for e in entries {
        let ok = e.as_object().map(|o| pj::as_int(o.get("seq")) == Some(out.len() as i64 + 1) && o.get("who").map(Value::is_array).unwrap_or(false) && entry_hash(&format!("ch:{cid}"), o).is_some()).unwrap_or(false);
        if !ok {
            break;
        }
        out.push(e.clone());
    }
    if out.len() != entries.len() {
        log_warn(&format!("state file: member log of {} cut at entry {}", kv(cid), out.len() + 1));
    }
    out
}

/// The where of a message (as the files slice names a conversation).
fn place_of(c: &Conv, who: &Identity) -> Obj {
    match c {
        Conv::Room { room, .. } => obj([("scope", Value::from("room")), ("room", Value::from(room.clone()))]),
        Conv::Channel(cid) => obj([("scope", Value::from("channel")), ("channel", Value::from(cid.clone()))]),
        Conv::Dm(other) => {
            let mut pair = [who.principal.clone(), other.clone()];
            pair.sort();
            obj([("scope", Value::from("dm")), ("pair", list_value(&pair))])
        }
    }
}

fn conv_channel(c: &Conv) -> Option<&str> {
    match c {
        Conv::Channel(cid) => Some(cid.as_str()),
        _ => None,
    }
}

// ── state: settings, storage, migration, retention ──────────────────────────────────────────────────────────

impl State {
    /// _ce_configure: relay.json `chat_e2ee` and `chat_history_share` (Err: the relay does not start).
    pub(super) fn ce_configure(&mut self, s: &m::Settings) -> Result<(), String> {
        let mode = match &s.chat_e2ee {
            Value::String(v) if MODES.contains(&v.as_str()) => v.clone(),
            _ => return Err("relay settings: chat_e2ee must be \"default\" or \"required\"".into()),
        };
        let Value::Bool(share) = s.chat_history_share else { return Err("relay settings: chat_history_share must be true or false".into()) };
        self.ce.mode = mode;
        self.ce.share = share;
        Ok(())
    }

    fn ce_required(&self) -> bool {
        self.ce.mode == "required"
    }

    /// _ce_store: ext["ce"], made sound the first time; existing conversations are migrated then.
    pub(super) fn ce_store(&mut self) -> &mut Obj {
        let present = matches!(self.ext.get("ce"), Some(Value::Object(_)));
        if !self.ce.checked || !present {
            self.ce.checked = true;
            let raw = as_obj(self.ext.get("ce")).cloned().unwrap_or_default();
            let now = now_ms();
            let since = pj::as_int(raw.get("since")).filter(|s| *s >= 1).unwrap_or(now);
            let seq = pj::as_int(raw.get("seq")).filter(|s| *s >= 0).unwrap_or(0);
            let section = |k: &str| as_obj(raw.get(k)).cloned().unwrap_or_default();
            let mut bundles = Obj::new();
            for (principal, devices) in section("bundles") {
                let Value::Object(devices) = devices else { continue };
                let kept: Obj = devices.into_iter().filter_map(|(d, rows)| rows.as_array().map(|r| (d, Value::Array(r.iter().filter(|b| b.is_object()).cloned().collect())))).collect();
                if !kept.is_empty() {
                    bundles.insert(principal, Value::Object(kept));
                }
            }
            let wraps: Obj = section("wraps")
                .into_iter()
                .filter_map(|(k, rows)| rows.as_array().map(|r| (k, Value::Array(r.iter().filter(|w| w.is_object() && pj::as_int(w.get("seq")).is_some()).cloned().collect()))))
                .collect();
            let logs: Obj = section("logs").into_iter().filter_map(|(cid, entries)| entries.as_array().map(|e| (cid.clone(), Value::Array(sound_log(&cid, e))))).collect();
            let part = obj([
                ("v", Value::from(1)),
                ("since", Value::from(since)),
                ("seq", Value::from(seq)),
                ("bundles", Value::Object(bundles)),
                ("wraps", Value::Object(wraps)),
                ("logs", Value::Object(logs)),
            ]);
            self.ext.insert("ce".into(), Value::Object(part));
            self.ce_migrate(now);
        }
        self.ext.get_mut("ce").and_then(Value::as_object_mut).expect("the ce store")
    }

    /// _ce_migrate: conversations from before chat encryption: encrypted from now (their baseline entry records the
    /// members, `POST /v1/chat/log`), or `bridgeable` when a bridge link is active.
    fn ce_migrate(&mut self, now_ms: i64) {
        let old: Vec<String> = self.channels.iter().filter(|(_, ch)| ch.as_object().map(|c| !c.contains_key("e2ee")).unwrap_or(false)).map(|(k, _)| k.clone()).collect();
        let (mut moved, mut linked) = (0, 0);
        for cid in old {
            let bridged = !self.bridge_active(&cid).is_empty();
            let ch = self.channel_mut(&cid);
            ch.insert("e2ee".into(), Value::Bool(!bridged));
            ch.insert("bridgeable".into(), Value::Bool(bridged));
            ch.insert("e2ee_since".into(), if bridged { Value::Null } else { Value::from(now_ms) });
            moved += 1;
            linked += bridged as usize;
        }
        if moved > 0 {
            self.dirty = true;
            log_info(&format!("chat_e2ee migrated conversations={moved} bridgeable={linked}"));
        }
    }

    pub(super) fn ce_part(&mut self, key: &str) -> &mut Obj {
        obj_mut(self.ce_store(), key)
    }

    /// _ce_log: the stored member log of channel `cid` (empty when none).
    pub(super) fn ce_log(&mut self, cid: &str) -> &[Value] {
        self.ce_part("logs").get(cid).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
    }

    fn ce_log_len(&mut self, cid: &str) -> usize {
        self.ce_log(cid).len()
    }

    /// _ce_prune: logs of conversations no longer kept; wraps and shares past their conversation's retention
    /// (envelopes go with their messages, encrypted files with the files slice); bundles older than 400 days.
    pub(super) fn ce_prune(&mut self, now: f64) {
        let channels: HashSet<String> = self.channels.keys().cloned().collect();
        let (mail_s, channel_s, history_s) = (self.mail_s, self.channel_s, self.history_s);
        let cut = |scope: &str| match scope {
            "dm" => (now - mail_s) * 1000.0,
            "ch" => (now - channel_s) * 1000.0,
            "room" => (now - history_s) * 1000.0,
            _ => now * 1000.0,
        };
        let gone: Vec<String> = self.ce_part("logs").keys().filter(|cid| !channels.contains(*cid)).cloned().collect();
        for cid in gone {
            // PC-1: a held conversation's log goes to the hold store
            let entries: Vec<Obj> = self.ce_part("logs").shift_remove(&cid).and_then(|v| v.as_array().cloned()).unwrap_or_default().into_iter().filter_map(|e| e.as_object().cloned()).collect();
            self.pc_hold_items(&format!("ch:{cid}"), "log", &entries, None, None);
        }
        let pairs = self.pc_dm_pairs();
        let keys: Vec<String> = self.ce_part("wraps").keys().cloned().collect();
        for key in keys {
            let rows: Vec<Value> = self.ce_part("wraps").get(&key).and_then(Value::as_array).cloned().unwrap_or_default();
            let mut kept: Vec<Value> = Vec::new();
            for r in rows {
                let row = r.as_object().cloned().unwrap_or_default();
                let cid = pj::py_str(row.get("cid").unwrap_or(&Value::Null));
                let cid = if pj::truthy(row.get("cid")) { cid } else { String::new() };
                let (scope, rest) = cid.split_once(':').unwrap_or((cid.as_str(), ""));
                let signed_cut = self.pc_wrap_cut(&row, &pairs, now);
                if pj::as_num(row.get("rts")).unwrap_or(0.0) >= cut(scope).max(signed_cut) && (scope != "ch" || channels.contains(rest)) {
                    kept.push(r);
                } else {
                    self.pc_hold_items(&cid, "wrap", std::slice::from_ref(&row), Some(&pairs), None);
                }
            }
            if kept.is_empty() {
                self.ce_part("wraps").shift_remove(&key);
            } else {
                self.ce_part("wraps").insert(key, Value::Array(kept));
            }
        }
        let bundle_cut = (now - BUNDLE_KEEP_S) * 1000.0;
        let bundles = self.ce_part("bundles");
        for devices in bundles.values_mut() {
            if let Value::Object(devices) = devices {
                for rows in devices.values_mut() {
                    if let Value::Array(rows) = rows {
                        rows.retain(|b| pj::as_num(b.get("rts")).unwrap_or(0.0) >= bundle_cut);
                    }
                }
                devices.retain(|_, rows| rows.as_array().map(|r| !r.is_empty()).unwrap_or(false));
            }
        }
        bundles.retain(|_, d| d.as_object().map(|d| !d.is_empty()).unwrap_or(false));
        let mono = pj::mono();
        self.ce.hits.retain(|_, hits| hits.back().map(|t| mono - t < RATE_S).unwrap_or(false));
    }

    // ── views and hooks ──

    /// _ce_flags: `{e2ee, e2ee_since, bridgeable}` of a channel.
    pub(super) fn ce_flags(&mut self, cid: &str) -> Obj {
        self.ce_store();
        let ch = self.channel(cid);
        let bridgeable = pj::truthy(ch.and_then(|c| c.get("bridgeable")));
        let since = if bridgeable { Value::Null } else { ch.and_then(|c| c.get("e2ee_since")).cloned().unwrap_or(Value::Null) };
        obj([("e2ee", Value::Bool(!bridgeable)), ("e2ee_since", since), ("bridgeable", Value::Bool(bridgeable))])
    }

    pub(super) fn ce_bridgeable(&mut self, cid: &str) -> bool {
        pj::truthy(self.ce_flags(cid).get("bridgeable"))
    }

    /// _ce_chan_view: a channel view's flags, the first LOG_VIEW entries of its log and how many are stored.
    pub(super) fn ce_chan_view(&mut self, cid: &str, view: &mut Obj) {
        for (k, v) in self.ce_flags(cid) {
            view.insert(k, v);
        }
        // a bridged DM (PC-1 section 5): plaintext, no member log
        if pj::truthy(self.channel(cid).and_then(|c| c.get("bdm"))) {
            return;
        }
        let log = self.ce_log(cid);
        let n = log.len();
        let first: Vec<Value> = log.iter().take(LOG_VIEW).cloned().collect();
        view.insert("log".into(), Value::Array(first));
        view.insert("log_seq".into(), Value::from(n));
    }

    /// _ce_dm_view: what a direct-message history adds: every direct message is encrypted.
    pub(super) fn ce_dm_view(&mut self) -> Obj {
        let since = self.ce_store().get("since").cloned().unwrap_or(Value::Null);
        obj([("e2ee", Value::Bool(true)), ("e2ee_since", since), ("bridgeable", Value::Bool(false))])
    }

    /// _ce_hello: what the hello answer adds.
    pub(super) fn ce_hello(&self) -> Obj {
        obj([("chat_e2ee", Value::from(self.ce.mode.clone())), ("chat_history_share", Value::Bool(self.ce.share))])
    }

    /// _ce_stay_created: the stay id of the call's chat (cid `room:<room>:<stay>`): a large call's E2EE stay, else a
    /// new one.
    pub(super) fn ce_stay_created(&mut self, room: &str) {
        let id = self.sfu_stay(room).unwrap_or_else(|| pj::token_hex(8));
        if let Some(stay) = self.stays.get_mut(room) {
            stay.chat_stay = id;
        }
    }

    /// _ce_join_extra: the call's chat stay and the relay's mode.
    pub(super) fn ce_join_extra(&self, room: &str) -> Obj {
        let stay = self.stays.get(room).map(|s| s.chat_stay.clone()).unwrap_or_default();
        obj([("chat_stay", Value::from(stay)), ("chat_e2ee", Value::from(self.ce.mode.clone()))])
    }

    /// _ce_options: what a stay's room options add: the newest signed catch-up option, once posted.
    pub(super) fn ce_options(&self, room: &str, options: &mut Obj) {
        if let Some(found) = self.stays.get(room).and_then(|s| s.chat_catchup.clone()) {
            options.insert("catchup".into(), Value::Object(found));
        }
    }

    // ── which conversations are encrypted ──

    /// _ce_guests: a web guest is admitted to the call.
    fn ce_guests(&self, room: &str) -> bool {
        self.peers.values().any(|p| p.room == room && p.who.guest && !p.admission_pending)
    }

    /// _ce_room_open: new chat in a call: refused under "required" while a guest is in it.
    pub(super) fn ce_room_open(&self, room: &str) -> R<()> {
        if self.ce_required() && self.ce_guests(room) {
            return Err(E::Conflict(GUESTS_OFF.into()));
        }
        Ok(())
    }

    /// _ce_plain: plain text into a conversation (`room`: a call, `cid`: a channel or group chat, neither: a direct
    /// message): 409 unless it is a call with a guest in it (not under "required") or a bridgeable channel.
    pub(super) fn ce_plain(&mut self, room: Option<&str>, cid: Option<&str>) -> R<()> {
        self.ce_store();
        if let Some(room) = room {
            self.ce_room_open(room)?;
            if !self.ce_guests(room) {
                return Err(E::Conflict(PLAIN.into()));
            }
            return Ok(());
        }
        match cid {
            Some(cid) if self.ce_bridgeable(cid) => Ok(()),
            _ => Err(E::Conflict(PLAIN.into())),
        }
    }

    /// _ce_plain of a checked conversation.
    pub(super) fn ce_plain_in(&mut self, c: &Conv) -> R<()> {
        match c {
            Conv::Room { room, .. } => self.ce_plain(Some(room), None),
            Conv::Channel(cid) => self.ce_plain(None, Some(cid)),
            Conv::Dm(_) => self.ce_plain(None, None),
        }
    }

    /// _ce_head: the highest `ls` an envelope may name (None outside channels and group chats); refuses a channel
    /// that is not encrypted or has no member log yet.
    pub(super) fn ce_head(&mut self, cid: Option<&str>) -> R<Option<usize>> {
        let Some(cid) = cid else { return Ok(None) };
        if self.ce_bridgeable(cid) {
            return bad(NOT_E2EE);
        }
        match self.ce_log_len(cid) {
            0 => Err(E::Conflict(NO_BASELINE.into())),
            n => Ok(Some(n)),
        }
    }

    /// _ce_cap: the most members a channel holds (encrypted: at most CHANNEL_MAX).
    pub(super) fn ce_cap(&mut self, cid: &str) -> usize {
        if self.ce_bridgeable(cid) {
            CHANNEL_MEMBERS_MAX
        } else {
            CHANNEL_MEMBERS_MAX.min(CHANNEL_MAX)
        }
    }

    /// _ce_rate: at most RATE channel joins and leaves per person per minute (429).
    pub(super) fn ce_rate(&mut self, principal: &str) -> R<()> {
        let now = pj::mono();
        let hits = self.ce.hits.entry(principal.to_string()).or_default();
        while hits.front().map(|t| now - t >= RATE_S).unwrap_or(false) {
            hits.pop_front();
        }
        if hits.len() >= RATE {
            return Err(E::Status(429, BUSY.into(), false));
        }
        hits.push_back(now);
        Ok(())
    }

    /// _ce_bridgeable_ok: a new bridgeable conversation: not under "required", and the creator's organization has an
    /// enabled bridge policy.
    pub(super) fn ce_bridgeable_ok(&mut self, who: &Identity) -> R<()> {
        // never in an enclave (PC-1, N15)
        if self.pc_enclave() {
            return forbidden(pc::ENCLAVE_BRIDGEABLE);
        }
        if self.ce_required() {
            return Err(E::Conflict(REQUIRED_BRIDGEABLE.into()));
        }
        let oid = self.bridge_org_of(&who.principal).0;
        if !pj::truthy(self.bridge_policy_of(&oid).get("enabled")) {
            return forbidden(NO_BRIDGE_POLICY);
        }
        Ok(())
    }

    /// _ce_linkable: a bridge link to this conversation: only a bridgeable one, never under "required".
    pub(super) fn ce_linkable(&mut self, cid: &str) -> R<()> {
        if !self.ce_bridgeable(cid) {
            return Err(E::Conflict(NOT_LINKABLE.into()));
        }
        if self.ce_required() {
            return Err(E::Conflict(REQUIRED_LINKS.into()));
        }
        Ok(())
    }

    // ── the member log ──

    /// _ce_entry: a checked log entry of channel `cid` signed by the caller: its shape, `seq` right after the stored
    /// log, `prev` the stored last entry's hash, `ts` not before it.
    fn ce_entry(&mut self, cid: &str, entry: Option<&Value>, who: &Identity, ops: &[&str]) -> R<Obj> {
        let op = entry.and_then(Value::as_object).and_then(|e| e.get("op")).and_then(Value::as_str).filter(|op| ops.contains(op));
        let (Some(op), Some(Value::Object(e))) = (op, entry) else { return bad(format!("log must be a {} entry", ops.join(" or "))) };
        let op = op.to_string();
        let first = op == "create" || op == "baseline";
        let policy_op = pc::POLICY_OPS.contains(&op.as_str());
        let keys: &[&str] = if first {
            &ENTRY_FIRST
        } else if policy_op {
            &ENTRY_POLICY
        } else {
            &ENTRY
        };
        if !same_keys(e, keys) {
            return bad(format!("a {op} entry is {{{}}}", keys.join(", ")));
        }
        let chain = format!("ch:{cid}");
        let (n, last_hash, last_ts) = {
            let log = self.ce_log(cid);
            let last = log.last().and_then(Value::as_object);
            (log.len(), last.map(|l| entry_hash(&chain, l).unwrap_or_default()).unwrap_or_else(|| ZERO.to_string()), last.and_then(|l| pj::as_int(l.get("ts"))))
        };
        let seq = int(e.get("seq"), "seq", 1)?;
        let prev = hash_of(e.get("prev"), "prev")?;
        if seq != n as i64 + 1 || prev != last_hash {
            return Err(E::Conflict(LOG_MOVED.into()));
        }
        if e.get("by").and_then(Value::as_str) != Some(who.principal.as_str()) {
            return forbidden("a log entry is signed by the person who sends it");
        }
        let device = matched(e.get("by_device"), is_device, "by_device must be a device id (16 hex)")?;
        if who.own_device() && device != who.device {
            return forbidden("by_device must be your own device");
        }
        let named = people_of(e.get("who"), "who")?;
        let ts = int(e.get("ts"), "ts", 1)?;
        let sig = sig_of(e.get("sig"), "sig")?;
        let mut out = obj([
            ("seq", Value::from(seq)),
            ("op", Value::from(op.clone())),
            ("by", Value::from(who.principal.clone())),
            ("by_device", Value::from(device)),
            ("who", list_value(&named)),
            ("ts", Value::from(ts)),
            ("prev", Value::from(prev)),
            ("sig", Value::from(sig)),
        ]);
        if policy_op {
            out.insert("policy".into(), Value::from(hash_of(e.get("policy"), "policy")?));
        }
        if last_ts.map(|t| ts < t).unwrap_or(false) {
            return bad("ts must not be before the last entry's");
        }
        if first {
            if !e.get("kind").and_then(Value::as_str).map(|k| CHANNEL_KINDS.contains(&k)).unwrap_or(false) {
                return bad("kind must be public, private or group");
            }
            let Some(Value::Bool(bridgeable)) = e.get("bridgeable") else { return bad("bridgeable must be true or false") };
            let admins = people_of(e.get("admins"), "admins")?;
            out.insert("kind".into(), e["kind"].clone());
            out.insert("bridgeable".into(), Value::Bool(*bridgeable));
            out.insert("admins".into(), list_value(&admins));
        }
        Ok(out)
    }

    /// _ce_first: the `create` (a new conversation) or `baseline` (seq 1 of a migrated one) entry: its members, kind
    /// and bridgeable as the relay has them; a create's admins among its members, a baseline's none.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn ce_first(&mut self, cid: &str, entry: Option<&Value>, who: &Identity, op: &str, people: &[String], kind: &str, bridgeable: bool) -> R<Obj> {
        if matches!(entry, None | Some(Value::Null)) {
            return Err(E::Conflict(if op == "create" { CREATE_OLD } else { NEEDS_LOG }.into()));
        }
        if op == "create" {
            self.pc_check_add(people, "create")?;
        }
        let gone = !self.channels.contains_key(cid);
        let logs = self.ce_part("logs");
        if gone {
            // a log left by a conversation that is gone
            logs.shift_remove(cid);
        }
        if logs.get(cid).and_then(Value::as_array).map(|l| !l.is_empty()).unwrap_or(false) {
            return Err(E::Conflict(HAS_BASELINE.into()));
        }
        let e = self.ce_entry(cid, entry, who, &[op])?;
        let named = strs(e.get("who")).unwrap_or_default().into_iter().map(str::to_string).collect::<Vec<_>>();
        if !same_people(&named, people) {
            return bad(format!("the {op} entry must name exactly the members"));
        }
        if e.get("kind").and_then(Value::as_str) != Some(kind) || e.get("bridgeable") != Some(&Value::Bool(bridgeable)) {
            return bad(format!("the {op} entry must name this conversation's kind and whether it can be linked to Slack or Teams"));
        }
        let admins = strs(e.get("admins")).unwrap_or_default();
        if op == "baseline" && !admins.is_empty() {
            return bad("a baseline entry names no admins");
        }
        if !admins.iter().all(|a| named.iter().any(|n| n == a)) {
            return bad("admins must be members");
        }
        Ok(e)
    }

    /// _ce_admins: the admins of a conversation, replayed from its log (no signature is judged).
    pub(super) fn ce_admins(&mut self, cid: &str) -> HashSet<String> {
        let mut admins: HashSet<String> = HashSet::new();
        for e in self.ce_log(cid).iter().filter_map(Value::as_object) {
            let named = || strs(e.get("who")).unwrap_or_default().into_iter().map(str::to_string);
            match pj::text_of(e, "op").as_str() {
                "create" | "baseline" => admins = strs(e.get("admins")).unwrap_or_default().into_iter().map(str::to_string).collect(),
                "admin" => admins.extend(named()),
                "unadmin" | "leave" | "remove" => {
                    for p in named() {
                        admins.remove(&p);
                    }
                }
                _ => {}
            }
        }
        admins
    }

    /// _ce_entry_in: the entry a membership route of `cid` carries (`join`, `leave`, `add`), naming exactly `people`.
    /// An encrypted conversation needs one; a bridgeable one may go without (None).
    pub(super) fn ce_entry_in(&mut self, cid: &str, who: &Identity, entry: Option<&Value>, op: &str, people: &[String]) -> R<Option<Obj>> {
        // PC-1: an add names apps (in a current policy, every-message) or people, never an archive; no service joins
        if op == "add" || op == "join" {
            self.pc_check_add(people, op)?;
        }
        if matches!(entry, None | Some(Value::Null)) {
            if self.ce_bridgeable(cid) {
                return Ok(None);
            }
            return Err(E::Conflict(NEEDS_LOG.into()));
        }
        let first_op = match self.ce_log(cid).first() {
            None => return Err(E::Conflict(NO_BASELINE.into())),
            Some(e) => e.get("op").and_then(Value::as_str).unwrap_or_default().to_string(),
        };
        let e = self.ce_entry(cid, entry, who, &[op])?;
        let named: Vec<String> = strs(e.get("who")).unwrap_or_default().into_iter().map(str::to_string).collect();
        if !same_people(&named, people) {
            return bad(format!("the {op} entry must name exactly the people it changes"));
        }
        let private = self.channel(cid).map(|c| pj::text_of(c, "kind") == "private").unwrap_or(false);
        if op == "add" && private && first_op == "create" && !self.ce_admins(cid).contains(&who.principal) {
            return forbidden(NOT_ADMIN);
        }
        Ok(Some(e))
    }

    /// _ce_keep: store an entry (with the relay's receive time `rts`) and tell the members.
    pub(super) fn ce_keep(&mut self, cid: &str, e: Obj) {
        let row = with(&e, obj([("rts", Value::from(now_ms()))]));
        let logs = self.ce_part("logs");
        let log = logs.entry(cid.to_string()).or_insert_with(|| Value::Array(Vec::new()));
        if !log.is_array() {
            *log = Value::Array(Vec::new());
        }
        let list = log.as_array_mut().expect("a log");
        list.push(Value::Object(row));
        let n = list.len();
        self.dirty = true;
        let members = members_of(self.channel(cid));
        self.tell(&members, &obj([("type", Value::from("chat_log")), ("channel", Value::from(cid)), ("log_seq", Value::from(n))]), None);
    }

    /// _ce_open: a conversation just made with its create entry.
    pub(super) fn ce_open(&mut self, cid: &str, e: Obj) {
        let bridgeable = e.get("bridgeable") == Some(&Value::Bool(true));
        let ts = e.get("ts").cloned().unwrap_or(Value::Null);
        let ch = self.channel_mut(cid);
        ch.insert("e2ee".into(), Value::Bool(!bridgeable));
        ch.insert("bridgeable".into(), Value::Bool(bridgeable));
        ch.insert("e2ee_since".into(), if bridgeable { Value::Null } else { ts });
        self.ce_keep(cid, e);
    }

    /// _ce_new_id: the id the creator's device chose for a new channel (its create entry names it).
    pub(super) fn ce_new_id(&self, v: Option<&Value>) -> R<String> {
        let cid = matched(v, is_channel_id, "id must be c- and 16 hex")?;
        if self.channels.contains_key(&cid) {
            return Err(E::Conflict("a channel with that id already exists".into()));
        }
        Ok(cid)
    }

    /// _ce_channel_of: the channel a `ch:<id>` cid names.
    fn ce_channel_of(&self, cid: &str) -> R<Option<String>> {
        let Some(id) = cid.strip_prefix("ch:") else { return bad("cid must be ch:<channel id>") };
        Ok(self.channels.contains_key(id).then(|| id.to_string()))
    }

    /// _ce_log_op: check and apply a confirm, remove, admin or unadmin entry.
    fn ce_log_op(&mut self, cid: &str, who: &Identity, e: Obj) -> R<()> {
        let op = pj::text_of(&e, "op");
        let named: Vec<String> = strs(e.get("who")).unwrap_or_default().into_iter().map(str::to_string).collect();
        if op == "confirm" {
            if !named.is_empty() {
                return bad("a confirm entry names nobody");
            }
            self.ce_keep(cid, e);
            return Ok(());
        }
        let members = members_of(self.channel(cid));
        if named.is_empty() || named.iter().any(|p| !members.contains(p)) {
            return bad(format!("a {op} entry names members"));
        }
        if op == "remove" {
            if named.len() != 1 {
                return bad("a remove entry names one member");
            }
            // PC-1: any member removes an app, nobody removes an archive
            let service = pc::service_kind(&named[0]);
            if service == "archive" {
                return forbidden(pc::ARCHIVE_STAYS);
            }
            let itself = named[0] == who.principal;
            if !itself && service != "app" && !self.ce_admins(cid).contains(&who.principal) {
                return forbidden(NOT_ADMIN);
            }
            if itself {
                self.ce_rate(&who.principal)?;
            }
            let left: Vec<String> = members.iter().filter(|p| **p != named[0]).cloned().collect();
            if let Some(marks) = self.channel_read.get_mut(&named[0]).and_then(Value::as_object_mut) {
                marks.shift_remove(cid);
            }
            let ch = self.channel_mut(cid);
            ch.insert("members".into(), list_value(&left));
            if left.is_empty() && pj::text_of(ch, "kind") != "public" && !pj::truthy(ch.get("archived")) {
                ch.insert("archived".into(), f(pj::now()));
            }
            self.ce_keep(cid, e);
            let view = self.channel(cid).cloned().unwrap_or_default();
            self.tell(&members, &obj([("type", Value::from("channel")), ("why", Value::from("removed")), ("channel", Value::Object(view)), ("by", Value::from(who.principal.clone()))]), None);
            self.bridge_recheck("relay", Some(cid), None);
            return Ok(());
        }
        if !self.ce_admins(cid).contains(&who.principal) {
            return forbidden(NOT_ADMIN);
        }
        if op == "admin" && named.iter().any(|p| !pc::service_kind(p).is_empty()) {
            return bad(pc::NO_SERVICE_ADMIN);
        }
        self.ce_keep(cid, e);
        Ok(())
    }

    // ── wraps and shares ──

    /// _ce_in_conv: both principals are in conversation `cid` by the relay's view (403 otherwise).
    pub(super) fn ce_in_conv(&self, cid: &str, a: &str, b: &str) -> R<()> {
        let (scope, rest) = cid.split_once(':').unwrap_or((cid, ""));
        let ok = match scope {
            "dm" if a != b => cid == dm_cid(a, b),
            "dm" => cid == dm_cid(a, a) || self.directory.keys().any(|x| cid == dm_cid(a, x)),
            "ch" => {
                let members = members_of(self.channel(rest));
                self.channel(rest).is_some() && members.iter().any(|m| m == a) && members.iter().any(|m| m == b)
            }
            "room" => {
                let (room, stay) = rest.split_once(':').unwrap_or((rest, ""));
                let here = |p: &str| self.peers.values().any(|s| s.room == room && !s.admission_pending && s.who.principal == p);
                !stay.is_empty() && self.stays.get(room).map(|s| s.chat_stay == stay).unwrap_or(false) && here(a) && here(b)
            }
            _ => return bad("cid must be dm:, ch: or room:"),
        };
        if !ok {
            return forbidden(NOT_IN);
        }
        Ok(())
    }

    /// _ce_wrap: a checked wrap (or share) from the caller's own device.
    fn ce_wrap(&mut self, v: &Value, who: &Identity, share: bool) -> R<Obj> {
        let keys: &[&str] = if share { &SHARE } else { &WRAP };
        let mut item = v.as_object().cloned();
        if let Some(o) = item.as_mut().filter(|o| o.contains_key("share")) {
            if o.get("share") != Some(&Value::Bool(share)) {
                return bad("share must be the same for every item");
            }
            o.shift_remove("share");
        }
        // PC-1: a dm: wrap names the org policies it used
        let mut pols: Option<Value> = None;
        if let Some(o) = item.as_mut().filter(|o| !share && o.contains_key("pols")) {
            pols = o.shift_remove("pols");
        }
        let Some(w) = item.filter(|o| same_keys(o, keys)) else {
            return bad(format!("{} is {{{}}}", if share { "a share" } else { "a wrap" }, keys.join(", ")));
        };
        let cid = match w.get("cid") {
            Some(Value::String(c)) if (1..=200).contains(&pj::char_len(c)) && pj::printable(c) => c.clone(),
            _ => return bad("cid must be a conversation id"),
        };
        let sender = device_ref(w.get("from"), "from", true)?;
        let to = device_ref(w.get("to"), "to", false)?;
        if pj::text_of(&sender, "principal") != who.principal || pj::text_of(&sender, "device") != who.device {
            return forbidden("from must be your own device");
        }
        if !who.serial.is_empty() && pj::text_of(&sender, "serial") != who.serial {
            return forbidden("from.serial must be your certificate's serial");
        }
        let epoch = int(w.get("epoch"), "epoch", 1)?;
        let dck = hash_of(w.get("dck_sha256"), "dck_sha256")?;
        let ts = int(w.get("ts"), "ts", 1)?;
        let sig = sig_of(w.get("sig"), "sig")?;
        let to_principal = pj::text_of(&to, "principal");
        let mut out = obj([
            ("cid", Value::from(cid.clone())),
            ("from", Value::Object(sender)),
            ("epoch", Value::from(epoch)),
            ("to", Value::Object(to)),
            ("eph", w.get("eph").cloned().unwrap_or(Value::Null)),
            ("dck_sha256", Value::from(dck)),
            ("blob", w.get("blob").cloned().unwrap_or(Value::Null)),
            ("ts", Value::from(ts)),
            ("sig", Value::from(sig)),
        ]);
        let point = "eph must be an uncompressed P-384 point (base64)";
        if e2ee_b64(w.get("eph"), 97, 97, point)?[0] != 4 {
            return bad(point);
        }
        e2ee_b64(w.get("blob"), BLOB_MIN, BLOB_MAX, &format!("blob must be at most {BLOB_MAX} bytes (base64)"))?;
        if share {
            out.insert("orig".into(), Value::Object(device_ref(w.get("orig"), "orig", false)?));
            if to_principal != who.principal {
                return forbidden("a share goes to your own device");
            }
            if !["dm:", "ch:", "room:"].iter().any(|p| cid.starts_with(p)) {
                return bad("cid must be dm:, ch: or room:");
            }
            out.insert("share".into(), Value::Bool(true));
        } else {
            out.insert("members".into(), Value::from(hash_of(w.get("members"), "members")?));
            out.insert("log_seq".into(), Value::from(int(w.get("log_seq"), "log_seq", 0)?));
            out.insert("log_hash".into(), Value::from(hash_of(w.get("log_hash"), "log_hash")?));
            let mut named: Vec<String> = Vec::new();
            if let Some(p) = &pols {
                if !cid.starts_with("dm:") {
                    return bad("pols is only for direct messages");
                }
                named = pc::pols(Some(p))?;
                out.insert("pols".into(), Value::Array(named.iter().cloned().map(Value::from).collect()));
            }
            let to = as_obj(out.get("to")).cloned().unwrap_or_default();
            self.pc_wrap_in_conv(&cid, &who.principal, &to, &named)?;
        }
        Ok(out)
    }

    // ── files ──

    /// _ce_files_check: a new upload: encrypted to an encrypted conversation, plain only to one that is not
    /// (`files_start`).
    pub(super) fn ce_files_check(&mut self, place: &Obj, e2ee: bool) -> R<()> {
        let plain_ok = match pj::text_of(place, "scope").as_str() {
            "room" => {
                let room = pj::text_of(place, "room");
                self.ce_room_open(&room)?;
                self.ce_guests(&room)
            }
            "channel" => self.ce_bridgeable(&pj::text_of(place, "channel")),
            _ => false,
        };
        self.ce_store();
        if !e2ee && !plain_ok {
            return Err(E::Conflict(PLAIN.into()));
        }
        if e2ee && plain_ok && pj::text_of(place, "scope") == "channel" {
            return bad(NOT_E2EE);
        }
        Ok(())
    }
}

/// _ce_add_event: an edit, delete or event kept on its target (at most EVENTS_MAX).
fn add_event(target: &mut Obj, eid: &str, who: &Identity, env: Obj, now: f64) -> R<Obj> {
    let events = target.entry("events").or_insert_with(|| Value::Array(Vec::new()));
    if !events.is_array() {
        *events = Value::Array(Vec::new());
    }
    let events = events.as_array_mut().expect("events");
    if events.len() >= EVENTS_MAX {
        return Err(E::Conflict(format!("a message keeps at most {EVENTS_MAX} changes and events")));
    }
    if events.iter().any(|e| e.get("id").and_then(Value::as_str) == Some(eid)) {
        return Err(E::Conflict("an event with that id is already kept".into()));
    }
    let ev = obj([("id", Value::from(eid)), ("from", Value::from(who.principal.clone())), ("ts", f(now)), ("rts", Value::from((now * 1000.0) as i64)), ("enc", Value::Object(env))]);
    events.push(Value::Object(ev.clone()));
    Ok(ev)
}

/// A message request with an envelope (`ce_post`): what the route read from its body.
pub struct Post<'a> {
    pub id: Body<'a>,
    pub enc: Body<'a>,
    pub files: Body<'a>,
    pub thread: Body<'a>,
    pub reply_to: Body<'a>,
    pub also_channel: Body<'a>,
    pub session: Option<String>,
    pub peer: Option<String>,
    pub to: Body<'a>,
    pub channel: Body<'a>,
    /// The request also carries a plain-text field (409).
    pub plain: bool,
}

impl Hub {
    /// `POST /v1/room/options {peer, catchup}`: the signed "let late joiners catch up" option (contract section 7.3),
    /// `{room, stay, by, by_device, serial, on, ts, sig}` of the caller for this call's chat stay. The newest `ts` is
    /// kept with the stay and everyone in the call hears `room_options` with it; an older one changes nothing.
    pub fn ce_catchup(&self, peer_id: &str, who: &Identity, value: Body) -> R<Obj> {
        let keys = ["room", "stay", "by", "by_device", "serial", "on", "ts", "sig"];
        let Some(Value::Object(v)) = value.filter(|v| v.as_object().map(|o| same_keys(o, &keys)).unwrap_or(false)) else {
            return bad(format!("catchup must be {{{}}}", keys.join(", ")));
        };
        let mut st = self.st.lock();
        let r = (|| -> R<Obj> {
            st.owned(peer_id, who)?;
            if st.peers[peer_id].admission_pending {
                return forbidden(ADMISSION_FIRST);
            }
            let room = st.peers[peer_id].room.clone();
            let chat_stay = st.stays.get(&room).map(|s| s.chat_stay.clone()).unwrap_or_default();
            if v.get("room").and_then(Value::as_str) != Some(room.as_str()) || chat_stay.is_empty() || v.get("stay").and_then(Value::as_str) != Some(chat_stay.as_str()) {
                return bad("catchup must name this call and its chat stay");
            }
            if v.get("by").and_then(Value::as_str) != Some(who.principal.as_str()) {
                return forbidden("a catch-up option is signed by the person who sends it");
            }
            let device = matched(v.get("by_device"), is_device, "by_device must be a device id (16 hex)")?;
            let serial = matched(v.get("serial"), is_serial, "serial must be a certificate serial (hex)")?;
            if (who.own_device() && device != who.device) || (!who.serial.is_empty() && serial != who.serial) {
                return forbidden("a catch-up option comes from your own device");
            }
            let Some(Value::Bool(on)) = v.get("on") else { return bad("on must be true or false") };
            let ts = int(v.get("ts"), "ts", 1)?;
            sig_of(v.get("sig"), "sig")?;
            let stay = st.stays.get_mut(&room).expect("the stay");
            let newer = stay.chat_catchup.as_ref().map(|c| ts > pj::as_int(c.get("ts")).unwrap_or(0)).unwrap_or(true);
            let late = stay.late_history;
            if newer {
                stay.chat_catchup = Some(v.clone());
            }
            let attendance = Value::Bool(st.pa_attendance_on());
            if newer {
                let event = obj([
                    ("type", Value::from("room_options")),
                    ("late_history", Value::Bool(late)),
                    ("attendance", attendance.clone()),
                    ("catchup", Value::Object(v.clone())),
                    ("by", Value::from(who.name.clone())),
                    ("principal", Value::from(who.principal.clone())),
                    ("peer", Value::from(peer_id)),
                ]);
                st.broadcast(&room, &event, None);
                log_info(&format!("options room={room} principal={} catchup={}", who.principal, if *on { "on" } else { "off" }));
            }
            let mut options = obj([("late_history", Value::Bool(late)), ("attendance", attendance)]);
            st.ce_options(&room, &mut options);
            Ok(obj([("ok", Value::Bool(true)), ("options", Value::Object(options))]))
        })();
        drop(st);
        self.wake();
        r
    }

    /// `GET /v1/chat/log?cid=ch:<id>&after=&limit=` -> `{e2ee, e2ee_since, bridgeable, entries, log_seq}`: for
    /// members, and for anyone of a public channel (a joiner signs its join after the stored last entry).
    pub fn ce_log_get(&self, session: &str, who: &Identity, cid: &str, after: &str, limit: &str) -> R<Obj> {
        let after = m::number(Some(&Value::from(after)), "after")?.trunc() as i64;
        let limit = (m::number(Some(&Value::from(limit)), "limit")?.trunc() as i64).clamp(1, LOG_VIEW as i64) as usize;
        let mut st = self.st.lock();
        st.session(session, who)?;
        let Some(id) = st.ce_channel_of(cid)? else { return Err(E::NotFound(NO_CHANNEL.into())) };
        let open = st.channel(&id).map(|c| pj::text_of(c, "kind") == "public" || members_of(Some(c)).contains(&who.principal)).unwrap_or(false);
        // PC-1: a linked (mentions) app reads the member log of a conversation that links it
        if !open && !st.pc_linked_reader(&id, who) {
            return Err(E::NotFound(NO_CHANNEL.into()));
        }
        st.pc_service_member(&id, who, true)?;
        let mut out = st.ce_flags(&id);
        let log = st.ce_log(&id);
        let rows: Vec<Value> = log.iter().filter(|e| pj::as_int(e.get("seq")).unwrap_or(0) > after).take(limit).cloned().collect();
        let n = log.len();
        out.insert("entries".into(), Value::Array(rows));
        out.insert("log_seq".into(), Value::from(n));
        Ok(out)
    }

    /// `POST /v1/chat/log {cid, entry}`: the `baseline` of a migrated conversation (seq 1, once), a `confirm` of it,
    /// and the entries no other route carries: `remove` (the person removed, or an admin; the relay's member list
    /// follows), `admin` and `unadmin` (an admin).
    pub fn ce_log_post(&self, session: &str, who: &Identity, cid: Body, entry: Body) -> R<Obj> {
        let cid = pj::str_or(cid);
        let mut st = self.st.lock();
        let r = (|| -> R<(Obj, String, String)> {
            st.session(session, who)?;
            let Some(id) = st.ce_channel_of(&cid)? else { return Err(E::NotFound(NO_CHANNEL.into())) };
            let id = st.member_channel(&id, &who.principal, false)?;
            let op = entry.and_then(Value::as_object).map(|e| pj::text_of(e, "op")).unwrap_or_default();
            if who.is_service() && op != "leave" {
                return forbidden(pc::APP_ROUTES_ONLY);
            }
            match op.as_str() {
                // PC-1: archive, unarchive, link_app and unlink_app from members, and a service's own leave
                "archive" | "unarchive" | "link_app" | "unlink_app" | "leave" => {
                    if st.ce_log_len(&id) == 0 {
                        return Err(E::Conflict(NO_BASELINE.into()));
                    }
                    let e = st.ce_entry(&id, entry, who, &[op.as_str()])?;
                    st.pc_log_op(&id, who, e)?;
                }
                "baseline" => {
                    let ch = st.channel(&id).cloned().unwrap_or_default();
                    let bridgeable = st.ce_bridgeable(&id);
                    let e = st.ce_first(&id, entry, who, "baseline", &members_of(Some(&ch)), &pj::text_of(&ch, "kind"), bridgeable)?;
                    if !bridgeable {
                        let ts = e.get("ts").cloned().unwrap_or(Value::Null);
                        st.channel_mut(&id).insert("e2ee_since".into(), ts);
                    }
                    st.ce_keep(&id, e);
                }
                "confirm" | "remove" | "admin" | "unadmin" => {
                    if st.ce_log_len(&id) == 0 {
                        return Err(E::Conflict(NO_BASELINE.into()));
                    }
                    let e = st.ce_entry(&id, entry, who, &[op.as_str()])?;
                    st.ce_log_op(&id, who, e)?;
                }
                _ => return bad("log must be a baseline, confirm, remove, admin, unadmin, archive, unarchive, link_app or unlink_app entry"),
            }
            let n = st.ce_log_len(&id);
            Ok((obj([("ok", Value::Bool(true)), ("log_seq", Value::from(n))]), id, op))
        })();
        drop(st);
        self.wake();
        let (out, id, op) = r?;
        log_info(&format!("chat_log channel={id} op={op} principal={} seq={}", who.principal, pj::as_int(out.get("log_seq")).unwrap_or(0)));
        Ok(out)
    }

    /// `POST /v1/chat/devices {bundle}`: the caller's own device publishes its chat key bundle (the newest
    /// BUNDLES_PER_DEVICE are kept, each for 400 days). Everyone online hears `chat_devices`.
    pub fn ce_devices_post(&self, session: &str, who: &Identity, bundle: Body) -> R<Obj> {
        let mut st = self.st.lock();
        let r = (|| -> R<()> {
            st.session(session, who)?;
            if !who.own_device() {
                return forbidden(DEVICE_ONLY);
            }
            let b = bundle_of(bundle, who, pj::now())?;
            let dck = b.get("dck").cloned();
            let devices = obj_mut(st.ce_part("bundles"), &who.principal);
            let rows = devices.entry(who.device.clone()).or_insert_with(|| Value::Array(Vec::new()));
            if !rows.is_array() {
                *rows = Value::Array(Vec::new());
            }
            let rows = rows.as_array_mut().expect("bundle rows");
            rows.retain(|r| r.get("dck") != dck.as_ref());
            rows.push(Value::Object(with(&b, obj([("rts", Value::from(now_ms()))]))));
            if rows.len() > BUNDLES_PER_DEVICE {
                let cut = rows.len() - BUNDLES_PER_DEVICE;
                rows.drain(..cut);
            }
            st.dirty = true;
            let mut online: Vec<String> = Vec::new();
            for s in st.sessions.values() {
                if !online.contains(&s.who.principal) {
                    online.push(s.who.principal.clone());
                }
            }
            st.tell(&online, &obj([("type", Value::from("chat_devices")), ("principal", Value::from(who.principal.clone())), ("device", Value::from(who.device.clone()))]), None);
            Ok(())
        })();
        drop(st);
        self.wake();
        r?;
        log_info(&format!("chat_bundle principal={} device={}", who.principal, who.device));
        Ok(obj([("ok", Value::Bool(true))]))
    }

    /// `GET /v1/chat/devices?p=a,b` -> `{devices: [bundle + rts]}`: the kept bundles of these people (at most
    /// DEVICES_MAX).
    pub fn ce_devices_get(&self, session: &str, who: &Identity, people: &str) -> R<Obj> {
        let wanted: Vec<String> = people.split(',').map(str::trim).filter(|p| !p.is_empty()).map(str::to_string).collect();
        if wanted.is_empty() || wanted.len() > DEVICES_MAX {
            return bad(format!("name 1 to {DEVICES_MAX} people (p)"));
        }
        for p in &wanted {
            principal_of(Some(&Value::from(p.as_str())), "p")?;
        }
        let mut st = self.st.lock();
        st.session(session, who)?;
        let bundles = st.ce_part("bundles");
        let mut seen: HashSet<&str> = HashSet::new();
        let mut out: Vec<Value> = Vec::new();
        for p in &wanted {
            if !seen.insert(p.as_str()) {
                continue;
            }
            for rows in bundles.get(p).and_then(Value::as_object).into_iter().flat_map(|d| d.values()) {
                out.extend(rows.as_array().into_iter().flatten().cloned());
            }
        }
        Ok(obj([("devices", Value::Array(out))]))
    }

    /// `POST /v1/chat/keys {wraps, share}`: up to WRAPS_MAX wraps from the caller's device (each recipient device
    /// hears `chat_keys {key_seq}`); `share: true` for an own-device history share (409 when this relay does not allow
    /// them).
    pub fn ce_keys_post(&self, session: &str, who: &Identity, wraps: Body, share: Body) -> R<Obj> {
        let share = m::flag(share, "share")?;
        let Some(Value::Array(items)) = wraps.filter(|w| w.as_array().map(|a| (1..=WRAPS_MAX).contains(&a.len())).unwrap_or(false)) else {
            return bad(format!("wraps must be a list of 1 to {WRAPS_MAX}"));
        };
        let mut st = self.st.lock();
        let r = (|| -> R<(i64, usize)> {
            st.session(session, who)?;
            if !who.own_device() {
                return forbidden(DEVICE_ONLY);
            }
            if share && who.is_service() {
                return Err(E::Conflict(pc::SHARE_PEOPLE.into()));
            }
            if share && !st.ce.share {
                return Err(E::Conflict(NO_SHARES.into()));
            }
            let rows = items.iter().map(|w| st.ce_wrap(w, who, share)).collect::<R<Vec<Obj>>>()?;
            let rts = now_ms();
            let mut seq = pj::as_int(st.ce_store().get("seq")).unwrap_or(0);
            let mut told: IndexMap<(String, String), i64> = IndexMap::new();
            for row in &rows {
                seq += 1;
                let to = as_obj(row.get("to")).cloned().unwrap_or_default();
                let key = (pj::text_of(&to, "principal"), pj::text_of(&to, "device"));
                let wraps = st.ce_part("wraps");
                let kept = wraps.entry(format!("{}|{}", key.0, key.1)).or_insert_with(|| Value::Array(Vec::new()));
                if !kept.is_array() {
                    *kept = Value::Array(Vec::new());
                }
                let kept = kept.as_array_mut().expect("wrap rows");
                kept.push(Value::Object(with(row, obj([("seq", Value::from(seq)), ("rts", Value::from(rts))]))));
                if kept.len() > WRAPS_KEEP {
                    let cut = kept.len() - WRAPS_KEEP;
                    kept.drain(..cut);
                }
                told.insert(key, seq);
            }
            st.ce_store().insert("seq".into(), Value::from(seq));
            st.dirty = true;
            for ((principal, device), n) in told {
                // `key_seq`: the session's event queue owns `seq`
                st.tell_device(&principal, &device, &obj([("type", Value::from("chat_keys")), ("key_seq", Value::from(n))]));
            }
            Ok((seq, rows.len()))
        })();
        drop(st);
        self.wake();
        let (last, n) = r?;
        log_info(&format!("chat_keys principal={} device={} wraps={n} share={}", who.principal, who.device, if share { "yes" } else { "no" }));
        Ok(obj([("ok", Value::Bool(true)), ("seq", Value::from(last))]))
    }

    /// `GET /v1/chat/keys?after=&limit=` -> `{wraps, next}`: the wraps and shares to the caller's device after `seq`
    /// `after`, oldest first.
    pub fn ce_keys_get(&self, session: &str, who: &Identity, after: &str, limit: &str) -> R<Obj> {
        let after = m::number(Some(&Value::from(after)), "after")?.trunc() as i64;
        let limit = (m::number(Some(&Value::from(limit)), "limit")?.trunc() as i64).clamp(1, KEYS_LIMIT) as usize;
        let mut st = self.st.lock();
        st.session(session, who)?;
        if !who.own_device() {
            return forbidden(DEVICE_ONLY);
        }
        let key = format!("{}|{}", who.principal, who.device);
        let out: Vec<Value> = st.ce_part("wraps").get(&key).and_then(Value::as_array).into_iter().flatten().filter(|r| pj::as_int(r.get("seq")).unwrap_or(0) > after).take(limit).cloned().collect();
        let next = out.last().and_then(|r| pj::as_int(r.get("seq"))).unwrap_or(after);
        Ok(obj([("wraps", Value::Array(out)), ("next", Value::from(next))]))
    }

    /// An encrypted message: `/v1/chat` (`room`), `/v1/dm` (`dm`) and `/v1/channels/post` (`channel`) with `{id: mid,
    /// enc, files, thread, reply_to, also_channel}`. `thread`, `reply_to` and `also_channel` must equal the
    /// envelope's `t`, `q` and `a`. Delivered like a plain message: `chat` to the call, `dm` or `channel_message` to
    /// the sessions.
    pub fn ce_post(&self, who: &Identity, scope: &str, p: Post) -> R<Obj> {
        let mid = mid_of(p.id, "id")?;
        let mut st = self.st.lock();
        let r = (|| -> R<(Obj, usize)> {
            let mut to_name = String::new();
            let c = match scope {
                "room" => {
                    let Some(peer) = p.peer.as_deref() else { return bad("a room message needs your room session (peer)") };
                    st.owned(peer, who)?;
                    if st.peers[peer].admission_pending {
                        return forbidden(ADMISSION_FIRST);
                    }
                    let room = st.peers[peer].room.clone();
                    st.ce_room_open(&room)?;
                    Conv::Room { peer: peer.to_string(), room }
                }
                "dm" => {
                    st.session(p.session.as_deref().unwrap_or_default(), who)?;
                    let other = m::principal(p.to);
                    // PC-1: a person's own DM with an app of a current policy; never an archive
                    let entry = match st.directory.get(&other).filter(|e| pj::truthy(Some(*e))).cloned() {
                        Some(e) => Some(e.as_object().cloned().unwrap_or_default()),
                        None => st.pc_dm_peer(who, &other)?,
                    };
                    let Some(entry) = entry.filter(|_| !other.is_empty()) else { return Err(E::NotFound("nobody with that address has used this relay yet".into())) };
                    to_name = Some(pj::s(&entry, "name")).filter(|n| !n.is_empty()).unwrap_or_else(|| other.clone());
                    Conv::Dm(other)
                }
                "channel" => {
                    st.session(p.session.as_deref().unwrap_or_default(), who)?;
                    Conv::Channel(st.member_channel(&pj::str_or(p.channel), &who.principal, true)?)
                }
                _ => return bad(SCOPE_ERROR),
            };
            if p.plain {
                return Err(E::Conflict(PLAIN.into()));
            }
            let head = st.ce_head(conv_channel(&c))?;
            // PC-1: a workflow definition (kind wf) is a message of a DM with an app
            let kinds: &[&str] = match &c {
                Conv::Dm(other) if pc::service_kind(other) == "app" => &["post", "wf"],
                _ => &["post"],
            };
            let env = envelope(p.enc, kinds, "", who, head)?;
            let (t, q) = (pj::text_of(&env, "t"), pj::text_of(&env, "q"));
            let a = env.get("a") == Some(&Value::Bool(true));
            if ref_of(p.thread, "thread")? != t || ref_of(p.reply_to, "reply_to")? != q || m::flag(p.also_channel, "also_channel")? != a {
                return bad("thread, reply_to and also_channel must match the envelope (t, q, a)");
            }
            let room = matches!(c, Conv::Room { .. });
            {
                let empty = Vec::new();
                let rows: Vec<&Obj> = Hub::conv_list(&st, who, &c).unwrap_or(&empty).iter().filter(|m| !room || pj::text_of(m, "kind") == "chat").collect();
                let by_id = |id: &str| rows.iter().find(|m| m.get("id").and_then(Value::as_str) == Some(id));
                if by_id(&mid).is_some() {
                    return Err(E::Conflict("a message with that id is already kept".into()));
                }
                if !t.is_empty() {
                    if room {
                        return bad("a message in a call has no thread");
                    }
                    let Some(root) = by_id(&t) else { return Err(E::NotFound(GONE.into())) };
                    if pj::truthy(root.get("thread")) {
                        return bad("thread must name the first message of the thread");
                    }
                }
                if a && (t.is_empty() || conv_channel(&c).is_none()) {
                    return bad("also_channel is only for a thread reply in a channel");
                }
                if !q.is_empty() && by_id(&q).is_none() {
                    return Err(E::NotFound(GONE.into()));
                }
            }
            let mut now = pj::now();
            if let Some(cid) = conv_channel(&c) {
                now = now.max(st.last_ts(cid) + 1e-6);
            }
            let attached = st.files_ce_attach(who, &place_of(&c, who), p.files, &mid, now)?;
            let org = st.org(&who.principal);
            let mut row = match &c {
                Conv::Room { peer, .. } => obj([
                    ("type", Value::from("chat")),
                    ("kind", Value::from("chat")),
                    ("id", Value::from(mid.clone())),
                    ("from", Value::from(peer.clone())),
                    ("name", Value::from(who.name.clone())),
                    ("principal", Value::from(who.principal.clone())),
                    ("org", org),
                ]),
                Conv::Channel(cid) => obj([("id", Value::from(mid.clone())), ("from", Value::from(who.principal.clone())), ("from_name", Value::from(who.name.clone())), ("from_org", org), ("channel", Value::from(cid.clone()))]),
                Conv::Dm(other) => obj([
                    ("id", Value::from(mid.clone())),
                    ("from", Value::from(who.principal.clone())),
                    ("from_name", Value::from(who.name.clone())),
                    ("from_org", org),
                    ("to", Value::from(other.clone())),
                    ("to_name", Value::from(to_name.clone())),
                ]),
            };
            row.insert("ts".into(), f(now));
            row.insert("rts".into(), Value::from((now * 1000.0) as i64));
            row.insert("enc".into(), Value::Object(env));
            row.insert("events".into(), Value::Array(Vec::new()));
            if !t.is_empty() {
                row.insert("thread".into(), Value::from(t.clone()));
            }
            if !q.is_empty() {
                row.insert("reply_to".into(), Value::from(q));
            }
            if a {
                row.insert("also_channel".into(), Value::Bool(true));
            }
            let n_files = attached.len();
            if !attached.is_empty() {
                row.insert("files".into(), Value::Array(attached.into_iter().map(Value::Object).collect()));
            }
            let me = p.session.clone();
            match &c {
                Conv::Room { room, .. } => {
                    st.room_log(room, &mut row);
                    st.broadcast(room, &row, None);
                }
                Conv::Channel(cid) => {
                    let msgs = st.channel_msgs.entry(cid.clone()).or_default();
                    msgs.push(row.clone());
                    if !t.is_empty() {
                        channels::recount(msgs, &t);
                    }
                    if msgs.len() > channels::CHANNEL_KEEP {
                        let cut = msgs.len() - channels::CHANNEL_KEEP;
                        msgs.drain(..cut);
                    }
                    st.channel_mut(cid).insert("last".into(), f(now));
                    let members = members_of(st.channel(cid));
                    st.tell(&members, &obj([("type", Value::from("channel_message")), ("message", Value::Object(row.clone()))]), me.as_deref());
                    st.pu_message(Some(cid.as_str()), None, &row);
                }
                Conv::Dm(other) => {
                    let msgs = st.dms.entry(conv(&who.principal, other)).or_default();
                    msgs.push(row.clone());
                    if !t.is_empty() {
                        channels::recount(msgs, &t);
                    }
                    if msgs.len() > DM_KEEP {
                        let cut = msgs.len() - DM_KEEP;
                        msgs.drain(..cut);
                    }
                    let told = with(&row, obj([("type", Value::from("dm"))]));
                    st.tell(&[other.clone(), who.principal.clone()], &told, me.as_deref());
                    st.pc_tell_archives(&who.principal, other, &told);
                    st.pu_message(None, Some(other.as_str()), &row);
                }
            }
            st.dirty = true;
            Ok((row, n_files))
        })();
        drop(st);
        self.wake();
        let (out, n_files) = r?;
        log_info(&format!("chat_e2ee_post scope={scope} principal={} files={n_files}", who.principal));
        Ok(out)
    }

    /// `/v1/chat/edit` and `/v1/chat/delete` with `{id, event: mid, enc}`: kept on the target's `events`; everyone in
    /// the conversation hears `chat_event`. Only the author edits; the author, an admin of the conversation's log or
    /// a relay admin deletes, and the target becomes a tombstone keeping only the delete.
    #[allow(clippy::too_many_arguments)]
    pub fn ce_change(&self, who: &Identity, scope: &str, id: &str, event: Body, enc: Body, delete: bool, peer: Option<String>, session: Option<String>, with_: Option<String>, channel: Option<String>) -> R<Obj> {
        let eid = mid_of(event, "event")?;
        let kind = if delete { "delete" } else { "edit" };
        let mut st = self.st.lock();
        let r = (|| -> R<(Obj, bool)> {
            let c = Self::conversation(&st, who, scope, peer.as_deref(), session.as_deref(), with_.as_deref(), channel.as_deref(), !delete)?;
            let head = st.ce_head(conv_channel(&c))?;
            let env = envelope(enc, &[kind], id, who, head)?;
            let i = Self::scoped_index(&st, who, &c, id)?;
            let log_admin = match conv_channel(&c) {
                Some(cid) if delete => st.ce_admins(cid).contains(&who.principal),
                _ => false,
            };
            let may = delete && (st.admins.contains(&who.principal) || log_admin);
            let list = Self::conv_list_mut(&mut st, who, &c).expect("the message's conversation");
            let target = &mut list[i];
            if pj::truthy(target.get("deleted")) {
                if delete {
                    return Ok((target.clone(), false));
                }
                return bad("that message was deleted");
            }
            let author = pj::s(target, if matches!(c, Conv::Room { .. }) { "principal" } else { "from" });
            if author != who.principal && !may {
                return forbidden(format!("only the person who wrote a message can {kind} it"));
            }
            let now = pj::now();
            let ev = add_event(target, &eid, who, env, now)?;
            let mut told = obj([("type", Value::from("chat_event")), ("scope", Value::from(scope)), ("id", Value::from(id)), ("event", Value::Object(ev.clone()))]);
            // PC-1: a held conversation keeps the message as it was before the delete
            let held = if delete { Some(list[i].clone()) } else { None };
            if delete {
                tombstone(list, i, now);
                let target = &mut list[i];
                target.shift_remove("enc");
                target.insert("events".into(), Value::Array(vec![Value::Object(ev)]));
                told.insert("deleted".into(), f(now));
            } else {
                list[i].insert("edited".into(), f(now));
            }
            let out = list[i].clone();
            if let Some(target) = held {
                match &c {
                    Conv::Channel(cid) => st.pc_hold_deleted(&who.principal, "", Some(cid), &target),
                    Conv::Dm(other) => st.pc_hold_deleted(&who.principal, other, None, &target),
                    Conv::Room { .. } => {}
                }
            }
            st.dirty = true;
            Self::tell_conversation(&mut st, who, &c, &told);
            Ok((out, true))
        })();
        drop(st);
        self.wake();
        let (out, changed) = r?;
        if changed {
            log_info(&format!("chat_e2ee_{kind} scope={scope} principal={}", who.principal));
        }
        Ok(out)
    }

    /// `POST /v1/chat/event {scope, peer|session, with|channel, id, event, enc}`: a `react`, `vote`, `close` or `pin`
    /// on a kept message, heard as `chat_event`. Only the poll's author closes it.
    #[allow(clippy::too_many_arguments)]
    pub fn ce_event(&self, who: &Identity, scope: &str, id: &str, event: Body, enc: Body, session: Option<String>, peer: Option<String>, with_: Option<String>, channel: Option<String>) -> R<Obj> {
        let eid = mid_of(event, "event")?;
        let mut st = self.st.lock();
        let r = (|| -> R<(Obj, String)> {
            let c = Self::conversation(&st, who, scope, peer.as_deref(), session.as_deref(), with_.as_deref(), channel.as_deref(), true)?;
            let head = st.ce_head(conv_channel(&c))?;
            let env = envelope(enc, &EVENT_KINDS, id, who, head)?;
            let k = pj::text_of(&env, "k");
            if who.is_service() && k != "react" {
                return forbidden(pc::APP_ROUTES_ONLY);
            }
            let i = Self::scoped_index(&st, who, &c, id)?;
            let list = Self::conv_list_mut(&mut st, who, &c).expect("the message's conversation");
            let target = &mut list[i];
            if pj::truthy(target.get("deleted")) {
                return bad("that message was deleted");
            }
            let author = pj::s(target, if matches!(c, Conv::Room { .. }) { "principal" } else { "from" });
            if k == "close" && author != who.principal {
                return forbidden("only the person who made the poll can close it");
            }
            let ev = add_event(target, &eid, who, env, pj::now())?;
            st.dirty = true;
            let told = obj([("type", Value::from("chat_event")), ("scope", Value::from(scope)), ("id", Value::from(id)), ("event", Value::Object(ev.clone()))]);
            Self::tell_conversation(&mut st, who, &c, &told);
            Ok((obj([("ok", Value::Bool(true)), ("id", Value::from(id)), ("event", Value::Object(ev))]), k))
        })();
        drop(st);
        self.wake();
        let (out, k) = r?;
        log_info(&format!("chat_event scope={scope} principal={} kind={k}", who.principal));
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn who(p: &str, device: &str) -> Identity {
        Identity { principal: p.into(), name: p.to_uppercase(), device: device.into(), ..Default::default() }
    }

    fn hub() -> Hub {
        Hub::new(None, &["ann@x".to_string()], 168.0, 30.0, 365.0, None, Arc::new(LinkStats::new()))
    }

    fn refusal<T>(r: R<T>) -> String {
        match r {
            Err(E::Forbidden(m)) => format!("403 {m}"),
            Err(E::Bad(m)) => format!("400 {m}"),
            Err(E::Conflict(m)) => format!("409 {m}"),
            Err(E::NotFound(m)) => format!("404 {m}"),
            Err(E::Status(s, m, _)) => format!("{s} {m}"),
            Err(e) => format!("other {}", e.message()),
            Ok(_) => "ok".into(),
        }
    }

    /// A signature-shaped value (the relay judges no signature).
    fn sig() -> String {
        pj::b64(&[0x30; 70])
    }

    /// A signed-looking entry of channel `cid` after `log`.
    fn entry(cid: &str, log: &[Value], op: &str, by: &str, named: &[&str], ts: i64) -> Value {
        let prev = log.last().and_then(Value::as_object).map(|l| entry_hash(&format!("ch:{cid}"), l).unwrap()).unwrap_or_else(|| ZERO.into());
        let mut e = json!({"seq": log.len() + 1, "op": op, "by": by, "by_device": "aaaaaaaaaaaaaaaa", "who": named, "ts": ts, "prev": prev, "sig": sig()});
        if op == "create" || op == "baseline" {
            e["kind"] = json!("private");
            e["bridgeable"] = json!(false);
            e["admins"] = if op == "create" { json!([by]) } else { json!([]) };
        }
        e
    }

    #[test]
    fn plain_fields_and_the_plaintext_refusal_matrix() {
        assert!(plain_fields(json!({"enc": {}, "text": "hi"}).as_object().unwrap()));
        for k in PLAIN_FIELDS {
            assert!(plain_fields(json!({k: 1}).as_object().unwrap()), "{k}");
        }
        assert!(!plain_fields(json!({"enc": {}, "text": null, "id": "x"}).as_object().unwrap()));
        let h = hub();
        let ann = who("ann@x", "aaaaaaaaaaaaaaaa");
        let a = h.join("ops", &ann, "", false, None).unwrap()["peer"].as_str().unwrap().to_string();
        let mut st = h.st.lock();
        st.channels.insert("c-1".into(), json!({"id": "c-1", "kind": "private", "name": "ops", "members": ["ann@x"]}));
        st.channels.insert("c-2".into(), json!({"id": "c-2", "kind": "private", "name": "ext", "members": ["ann@x"], "e2ee": false, "bridgeable": true, "e2ee_since": null}));
        let plain = format!("409 {PLAIN}");
        // direct messages: always encrypted
        assert_eq!(refusal(st.ce_plain(None, None)), plain);
        // a call without a web guest, an encrypted (migrated) channel, a bridgeable one
        let room = st.peers[&a].room.clone();
        assert_eq!(refusal(st.ce_plain(Some(&room), None)), plain);
        assert_eq!(refusal(st.ce_plain(None, Some("c-1"))), plain);
        assert_eq!(st.channel("c-1").unwrap()["e2ee"], json!(true));
        assert_eq!(refusal(st.ce_plain(None, Some("c-2"))), "ok");
        // files: plain only where text is, encrypted only where it is not plain
        let place = |scope: &str, k: &str, v: &str| obj([("scope", Value::from(scope)), (k, Value::from(v))]);
        assert_eq!(refusal(st.ce_files_check(&place("channel", "channel", "c-1"), false)), plain);
        assert_eq!(refusal(st.ce_files_check(&place("channel", "channel", "c-2"), true)), format!("400 {NOT_E2EE}"));
        assert_eq!(refusal(st.ce_files_check(&place("dm", "with", "ben@x"), false)), plain);
        assert_eq!(refusal(st.ce_files_check(&place("room", "room", &room), true)), "ok");
        // an envelope into a bridgeable channel is not end-to-end encrypted; an encrypted one needs its baseline
        assert_eq!(refusal(st.ce_head(Some("c-2"))), format!("400 {NOT_E2EE}"));
        assert_eq!(refusal(st.ce_head(Some("c-1"))), format!("409 {NO_BASELINE}"));
        // a web guest in the call: plain text is allowed, except under "required" (no call chat at all)
        drop(st);
        let g = h.join("ops", &who("cy@x", "cccccccccccccccc"), "", false, None).unwrap()["peer"].as_str().unwrap().to_string();
        let mut st = h.st.lock();
        st.peers.get_mut(&g).unwrap().who.guest = true;
        assert_eq!(refusal(st.ce_plain(Some(&room), None)), "ok");
        st.ce.mode = "required".into();
        assert_eq!(refusal(st.ce_plain(Some(&room), None)), format!("409 {GUESTS_OFF}"));
        assert_eq!(refusal(st.ce_room_open(&room)), format!("409 {GUESTS_OFF}"));
        assert_eq!(refusal(st.ce_linkable("c-2")), format!("409 {REQUIRED_LINKS}"));
        assert_eq!(refusal(st.ce_linkable("c-1")), format!("409 {NOT_LINKABLE}"));
        assert_eq!(refusal(st.ce_bridgeable_ok(&ann)), format!("409 {REQUIRED_BRIDGEABLE}"));
    }

    #[test]
    fn member_log_entries_keep_seq_and_prev_continuity() {
        let h = hub();
        let ann = who("ann@x", "aaaaaaaaaaaaaaaa");
        let ben = who("ben@x", "aaaaaaaaaaaaaaaa");
        let mut st = h.st.lock();
        st.channels.insert("c-1".into(), json!({"id": "c-1", "kind": "private", "name": "ops", "members": ["ann@x", "ben@x"]}));
        let people = vec!["ann@x".to_string(), "ben@x".to_string()];
        // without a log a change of members is refused
        assert_eq!(refusal(st.ce_entry_in("c-1", &ann, None, "add", &["cy@x".into()])), format!("409 {NEEDS_LOG}"));
        let base = entry("c-1", &[], "baseline", "ann@x", &["ann@x", "ben@x"], 1000);
        let e = st.ce_first("c-1", Some(&base), &ann, "baseline", &people, "private", false).unwrap();
        st.ce_keep("c-1", e);
        assert_eq!(refusal(st.ce_first("c-1", Some(&base), &ann, "baseline", &people, "private", false)), format!("409 {HAS_BASELINE}"));
        let log: Vec<Value> = st.ce_log("c-1").to_vec();
        assert!(log[0].get("rts").is_some());
        // the next entry: seq right after the log, prev the last entry's hash
        let good = entry("c-1", &log, "confirm", "ben@x", &[], 1001);
        let mut stale = good.clone();
        stale["seq"] = json!(1);
        assert_eq!(refusal(st.ce_entry("c-1", Some(&stale), &ben, &["confirm"])), format!("409 {LOG_MOVED}"));
        let mut skipped = good.clone();
        skipped["seq"] = json!(3);
        assert_eq!(refusal(st.ce_entry("c-1", Some(&skipped), &ben, &["confirm"])), format!("409 {LOG_MOVED}"));
        let mut broken = good.clone();
        broken["prev"] = json!(ZERO);
        assert_eq!(refusal(st.ce_entry("c-1", Some(&broken), &ben, &["confirm"])), format!("409 {LOG_MOVED}"));
        let mut early = good.clone();
        early["ts"] = json!(999);
        assert_eq!(refusal(st.ce_entry("c-1", Some(&early), &ben, &["confirm"])), "400 ts must not be before the last entry's");
        assert_eq!(refusal(st.ce_entry("c-1", Some(&good), &ann, &["confirm"])), "403 a log entry is signed by the person who sends it");
        let mut extra = good.clone();
        extra["kind"] = json!("private");
        assert_eq!(refusal(st.ce_entry("c-1", Some(&extra), &ben, &["confirm"])), "400 a confirm entry is {seq, op, by, by_device, who, ts, prev, sig}");
        let mut twice = good.clone();
        twice["who"] = json!(["ann@x", "ann@x"]);
        assert_eq!(refusal(st.ce_entry("c-1", Some(&twice), &ben, &["confirm"])), "400 who names someone twice");
        assert_eq!(refusal(st.ce_entry("c-1", Some(&good), &ben, &["remove"])), "400 log must be a remove entry");
        let e = st.ce_entry("c-1", Some(&good), &ben, &["confirm"]).unwrap();
        st.ce_keep("c-1", e);
        assert_eq!(st.ce_log_len("c-1"), 2);
        // the stored chain survives a reload; a hand-edited entry cuts it there
        let log: Vec<Value> = st.ce_log("c-1").to_vec();
        assert_eq!(sound_log("c-1", &log).len(), 2);
        let mut edited = log.clone();
        edited[1]["seq"] = json!(5);
        assert_eq!(sound_log("c-1", &edited).len(), 1);
        // admins replay: a baseline names none
        assert!(st.ce_admins("c-1").is_empty());
    }

    #[test]
    fn dm_cids_and_envelopes_are_shaped_as_the_contract_says() {
        assert_eq!(dm_cid("b@x", "a@x"), dm_cid("a@x", "b@x"));
        assert!(dm_cid("a@x", "b@x").starts_with("dm:") && dm_cid("a@x", "b@x").len() == 67);
        let ann = who("ann@x", "aaaaaaaaaaaaaaaa");
        let x = pj::b64(&[0u8; 272]);
        let ok = json!({"v": 1, "d": "aaaaaaaaaaaaaaaa", "sr": "0f", "e": 1, "c": 1, "pe": 0, "pc": 0, "k": "post", "r": "", "s": 1, "t": "", "q": "", "a": false, "ls": 0, "lh": ZERO, "n": "AAAAAAAAAAAAAAAA", "x": x, "g": sig()});
        assert_eq!(refusal(envelope(Some(&ok), &["post"], "", &ann, None)), "ok");
        assert_eq!(refusal(envelope(Some(&ok), &["edit"], "", &ann, None)), "400 enc k must be edit");
        assert_eq!(refusal(envelope(Some(&ok), &["post"], "", &ann, Some(2))), "400 enc ls must name an entry of the member list");
        let mut other = ok.clone();
        other["d"] = json!("bbbbbbbbbbbbbbbb");
        assert_eq!(refusal(envelope(Some(&other), &["post"], "", &ann, None)), "403 enc d must be your own device");
        let mut odd = ok.clone();
        odd["x"] = json!(pj::b64(&[0u8; 300]));
        assert_eq!(refusal(envelope(Some(&odd), &["post"], "", &ann, None)), "400 enc x must be a padded ciphertext (base64)");
        let mut later = ok.clone();
        later["c"] = json!(2);
        later["pe"] = json!(1);
        assert_eq!(refusal(envelope(Some(&later), &["post"], "", &ann, None)), "400 enc pe and pc are 0 except on the first envelope of an epoch");
    }
}
