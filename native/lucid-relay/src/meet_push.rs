// Parity wave B (contract PB-1 section 5) and NT-1 (docs/notify/contract.md sections 3 and 3.10): iPhone pushes
// through APNs, only to an iPhone device that is not live for push, org opt-in (relay.json `push`), never on an
// enclave relay. Every push carries its details sealed to the receiving device (PS-1: P-256 ECDH, HKDF-SHA-256,
// AES-256-GCM on AWS-LC, the inner padded to one fixed size per channel), so Apple sees only the outer fields. Calls
// ring CallKit iPhones through PushKit (`apns-push-type: voip` on `<topic>.voip`), a new CRL reaches the iPhones as a
// background push, and invites carry their kind, ring and settle lifecycle. A child module of meet_hub: it shares the
// hub's one lock. Persisted in state.json as the Python keeps it: `push_tokens` {principal: {device: {token, env, ts,
// serial, seal, sk, seal_prev, sk_prev, voip, callkit}}} (the seal keys are guarded like push.secret) and the invite
// records' `kind`, `ring`, `settled`, `settled_ts`; the thread-id secret is state_dir/push.secret (32 random bytes,
// mode 0600; random per process without a state folder). The sender is HTTP/2 over rustls (hyper's http2 client) with
// an ES256 JWT signed on AWS-LC, on its own thread. Android devices (NT-1 revision "Android (FCM)") register with
// `platform: "android"` and an FCM token (their rows add `platform`; a row without it is an iPhone's) and get the
// same sealed pushes as FCM data messages through the FCM sender (HTTP v1, an OAuth 2.0 token from an RS256
// service-account assertion), on its own thread.

use super::*;
use crate::meet_org_policy as op;
use aws_lc_rs::{aead, agreement, hkdf};

/// A person's message pushes for one conversation (per device): at most one per RATE_S seconds (monotonic).
const RATE_S: f64 = 30.0;
const TOKEN_MIN: usize = 64;
const TOKEN_MAX: usize = 200;
/// An FCM registration token's length in characters (letters, digits, `:`, `_`, `-`).
const FCM_TOKEN_MIN: usize = 100;
const FCM_TOKEN_MAX: usize = 4096;
const ENVS: [&str; 2] = ["sandbox", "production"];
/// Registration `platform`: an iPhone (APNs, the default) or an Android device (FCM).
const IOS: &str = "ios";
const ANDROID: &str = "android";
const SECRET_FILE: &str = "push.secret";
/// The per-person key: HMAC-SHA256(secret, KEY_LABEL + principal).
const KEY_LABEL: &str = "lucid-meet-push\n";
const TITLE: &str = "Lucid Meet";
/// PS-1 (section 3.3): the seal's and the origin MAC's domains.
const SEAL: &str = "lucid-meet-push-seal-v1";
const ORIGIN: &str = "lucid-meet-push-origin-v1";
/// apns-expiration of every push but calls (s); a background `crl` push's.
const MESSAGE_TTL: i64 = 3600;
const CRL_TTL: i64 = 6 * 3600;
/// At most one `crl` push per device this often; each waits a random 0 to CRL_SPREAD seconds (3.4).
const CRL_EVERY: f64 = 15.0 * 60.0;
const CRL_SPREAD: f64 = 10.0 * 60.0;
/// A session is live for push while its latest /v1/inbox request started this recently (3.6).
const LIVE_FOR: f64 = 15.0;
/// How long a call, missed or meeting push is remembered (once only).
const ONCE_KEEP: f64 = 86400.0;
/// An invite or change starting within this may be Time Sensitive (3.4).
const SOON: f64 = 3600.0;
/// A call rings this long, then the relay settles it missed; a join this soon after missed or cancelled still
/// answers (3.5).
pub const RING_SECONDS: f64 = 45.0;
const ANSWER_GRACE: f64 = 10.0;
/// The ring bucket per inviter and invitee: RING_TOKENS, one back every RING_REFILL seconds, at most RING_HOURLY
/// rings in any hour; meeting pushes per organizer and attendee in any hour (3.7).
const RING_TOKENS: f64 = 3.0;
const RING_REFILL: f64 = 30.0;
const RING_HOURLY: usize = 10;
const MEETING_HOURLY: usize = 3;
const HOUR: f64 = 3600.0;
/// The occurrences a meeting push looks at.
const OCCURRENCE_DAYS: f64 = 400.0;

pub const PUSH_OFF: &str = "push notifications are off on this relay";
const BAD_TOKEN: &str = "token must be 64 to 200 hex characters";
const BAD_ENV: &str = "env must be sandbox or production";
const NO_SANDBOX: &str = "sandbox push tokens are off on this relay";
const BAD_SEAL: &str = "seal must be a P-256 public key (base64 of 65 bytes)";
const BAD_SK: &str = "sk must name the seal key";
const BAD_VOIP: &str = "voip_token must be 64 to 200 hex characters";
const BAD_CALLKIT: &str = "callkit must be true or false";
const BAD_PLATFORM: &str = "platform must be ios or android";
const BAD_FCM_TOKEN: &str = "an android token must be 100 to 4096 letters, digits, colons, underscores or hyphens";
const ANDROID_NO_VOIP: &str = "an android registration takes no voip_token, and callkit must be false";
const PLATFORM_OFF: &str = "push notifications for this platform are off on this relay";
const BAD_PHONE: &str = "phone must be true or false";
pub const SETTLE_HOW: &str = "how must be declined";
pub const SETTLE_NONE: &str = "no such invitation";
pub const INBOX_WAIT_ERROR: &str = "wait must be 1 to 25 seconds";

/// `GET /v1/inbox` `wait` (3.6): ASCII digits, 1 to 25 seconds (the route reads an absent one as 25, POLL_WAIT).
pub fn inbox_wait(text: &str) -> R<f64> {
    match text.parse::<u32>() {
        Ok(n) if text.bytes().all(|c| c.is_ascii_digit()) && (1..=25).contains(&n) => Ok(f64::from(n)),
        _ => bad(INBOX_WAIT_ERROR),
    }
}

/// The APNs push type a sealed push travels in (on Android, FCM data `ch`); the seal names it, so a seal made for one
/// does not open in another.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Channel {
    Alert,
    Voip,
    Background,
}

impl Channel {
    pub fn name(self) -> &'static str {
        match self {
            Channel::Alert => "alert",
            Channel::Voip => "voip",
            Channel::Background => "background",
        }
    }

    /// The padded inner's one length (3.3): 2560 for every alert push, 1024 for every VoIP and background push.
    pub fn size(self) -> usize {
        match self {
            Channel::Alert => 2560,
            Channel::Voip | Channel::Background => 1024,
        }
    }

    /// Apple's payload limit.
    pub fn limit(self) -> usize {
        match self {
            Channel::Voip => 5120,
            Channel::Alert | Channel::Background => 4096,
        }
    }
}

/// An alert push's (fallback words, category, sound) by kind (3.4). `remind` is never a push.
pub fn alert_words(kind: &str) -> Option<(&'static str, &'static str, &'static str)> {
    Some(match kind {
        "msg" => ("New message", "msg", "msg-lucid.wav"),
        "call" => ("Incoming call", "call", "ring-lucid.wav"),
        "live" => ("Invitation to join a call", "call", "ring-lucid.wav"),
        "missed" => ("Missed call", "missed", "msg-lucid.wav"),
        "invite" => ("New meeting invite", "mtg", "msg-lucid.wav"),
        "update" => ("Meeting changed", "mtg", "msg-lucid.wav"),
        "cancel" => ("Meeting canceled", "mtg", "msg-lucid.wav"),
        _ => return None,
    })
}

/// The rank of a notification level: off below mentions below all.
fn rank(level: &str) -> u8 {
    match level {
        "off" => 0,
        "mentions" => 1,
        _ => 2,
    }
}

/// A uniformly random delay from 0 to `most` seconds.
fn spread(most: f64) -> f64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&pj::random_bytes(8));
    most * (u64::from_be_bytes(b) as f64 / u64::MAX as f64)
}

/// The ring bucket of one inviter and invitee (3.7), in memory.
struct Bucket {
    tokens: f64,
    at: f64,
    /// (monotonic time, invite id) of the rings of the last hour.
    hour: VecDeque<(f64, String)>,
}

impl Bucket {
    fn new(now: f64) -> Bucket {
        Bucket { tokens: RING_TOKENS, at: now, hour: VecDeque::new() }
    }

    fn refill(&mut self, now: f64) {
        self.tokens = (self.tokens + (now - self.at).max(0.0) / RING_REFILL).min(RING_TOKENS);
        self.at = now;
        while self.hour.front().map(|(t, _)| now - t >= HOUR).unwrap_or(false) {
            self.hour.pop_front();
        }
    }
}

/// One device's `crl` pushes: when the last went (monotonic) and the one waiting (due, the CRL's thisUpdate).
#[derive(Default)]
struct CrlPush {
    sent: Option<f64>,
    due: Option<(f64, i64)>,
}

/// In memory: the senders (APNs for iPhones, FCM for Android devices; both None: push is off), the relay's push
/// settings, the secret, the rate books, the ring buckets, the live-for-push polls, the wrap rider cursors and the
/// delayed pushes.
pub struct Push {
    sender: Option<apns::Sender>,
    fcm: Option<fcm::Sender>,
    sandbox: bool,
    /// relay.json `push.voip` and `topic`, and `notify_previews`.
    voip: bool,
    topic: String,
    previews: bool,
    state_dir: Option<PathBuf>,
    secret: Vec<u8>,
    /// Tests move the relay's clock by this many seconds (0 in service).
    skew: f64,
    /// (principal, device, conversation key) -> monotonic time of the last message push.
    last: HashMap<(String, String, String), f64>,
    /// (principal, device, `invite:<id>` or `meeting:<id>:<start>`, kind) -> monotonic time: once only.
    once: HashMap<(String, String, String, String), f64>,
    /// (inviter, invitee) -> ring bucket.
    rings: HashMap<(String, String), Bucket>,
    /// (organizer, attendee) -> monotonic times of the meeting pushes of the last hour.
    meeting_book: HashMap<(String, String), VecDeque<f64>>,
    /// session -> monotonic time its latest /v1/inbox request started.
    polled: HashMap<String, f64>,
    /// (principal, device) -> the highest `after` that device fetched with GET /v1/chat/keys.
    cursors: HashMap<(String, String), i64>,
    /// (due wall time, invitee, invite id): `missed` pushes waiting out the answer grace.
    missed: Vec<(f64, String, String)>,
    /// (principal, device) -> its `crl` pushes.
    crl: HashMap<(String, String), CrlPush>,
}

impl Push {
    pub fn new(state_dir: Option<&std::path::Path>) -> Push {
        Push {
            sender: None,
            fcm: None,
            sandbox: true,
            voip: false,
            topic: String::new(),
            previews: true,
            state_dir: state_dir.map(|d| d.to_path_buf()),
            secret: Vec::new(),
            skew: 0.0,
            last: HashMap::new(),
            once: HashMap::new(),
            rings: HashMap::new(),
            meeting_book: HashMap::new(),
            polled: HashMap::new(),
            cursors: HashMap::new(),
            missed: Vec::new(),
            crl: HashMap::new(),
        }
    }

    /// The relay's wall clock (seconds).
    fn now(&self) -> f64 {
        pj::now() + self.skew
    }

    /// The relay's monotonic clock (seconds).
    fn mono(&self) -> f64 {
        pj::mono() + self.skew
    }

    /// _push_secret: state_dir/push.secret (made once, mode 0600), or a random one per process without a state folder.
    fn secret(&mut self) -> &[u8] {
        if self.secret.is_empty() {
            self.secret = match &self.state_dir {
                Some(dir) => {
                    let path = dir.join(SECRET_FILE);
                    let mut key = std::fs::read(&path).unwrap_or_default();
                    if key.len() != 32 {
                        key = pj::random_bytes(32);
                        if let Err(e) = write_secret(dir, &key) {
                            log_warn(&format!("cannot write {}: {e}", path.display()));
                        }
                    }
                    key
                }
                None => pj::random_bytes(32),
            };
        }
        &self.secret
    }
}

fn write_secret(dir: &std::path::Path, key: &[u8]) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!("{SECRET_FILE}.tmp"));
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut fh = opts.open(&tmp)?;
    fh.write_all(key)?;
    fh.sync_all()?;
    drop(fh);
    std::fs::rename(&tmp, dir.join(SECRET_FILE))
}

fn hmac(key: &[u8], data: &[u8]) -> [u8; 32] {
    let k = aws_lc_rs::hmac::Key::new(aws_lc_rs::hmac::HMAC_SHA256, key);
    let mut out = [0u8; 32];
    out.copy_from_slice(aws_lc_rs::hmac::sign(&k, data).as_ref());
    out
}

/// The first 16 bytes of HMAC-SHA-256 under the person key, 32 lower-case hex: thread-id, `c`, collapse ids, `o`.
pub fn tag(person_key: &[u8], data: &[u8]) -> String {
    crate::codec::hex(&hmac(person_key, data)[..16])
}

/// An APNs token, 64 to 200 hex characters, kept in lower case.
fn hex_token(v: Option<&Value>) -> Option<String> {
    match v {
        Some(Value::String(t)) if (TOKEN_MIN..=TOKEN_MAX).contains(&t.len()) && t.bytes().all(|c| c.is_ascii_hexdigit()) => Some(t.to_ascii_lowercase()),
        _ => None,
    }
}

/// _push_token: an APNs device token.
fn token_of(v: Body) -> R<String> {
    match hex_token(v) {
        Some(t) => Ok(t),
        None => bad(BAD_TOKEN),
    }
}

/// An FCM registration token: FCM_TOKEN_MIN to FCM_TOKEN_MAX letters, digits, `:`, `_` or `-`, kept as sent.
fn fcm_token(v: Option<&Value>) -> Option<String> {
    match v {
        Some(Value::String(t)) if (FCM_TOKEN_MIN..=FCM_TOKEN_MAX).contains(&t.len()) && t.bytes().all(|c| c.is_ascii_alphanumeric() || b":_-".contains(&c)) => Some(t.clone()),
        _ => None,
    }
}

/// A row registered by an Android device (`platform: "android"`); any other is an iPhone's.
fn android_row(row: &Obj) -> bool {
    row.get("platform").and_then(Value::as_str) == Some(ANDROID)
}

/// An uncompressed P-256 point on the curve (65 bytes).
pub fn seal_point(raw: &[u8]) -> bool {
    raw.len() == 65 && raw[0] == 4 && agreement::ParsedPublicKey::try_from(agreement::UnparsedPublicKey::new(&agreement::ECDH_P256, raw)).is_ok()
}

/// `sk`: the first 8 hex of SHA-256 of the seal key's 65 bytes.
pub fn sk_of(raw: &[u8]) -> String {
    crate::codec::sha256_hex(raw)[..8].to_string()
}

/// A stored seal key: base64 of a P-256 point named by `sk`.
fn stored_seal(seal: Option<&Value>, sk: Option<&Value>) -> bool {
    let raw = seal.and_then(Value::as_str).and_then(pj::b64_strict);
    raw.filter(|r| seal_point(r)).map(|r| sk.and_then(Value::as_str) == Some(sk_of(&r).as_str())).unwrap_or(false)
}

/// _push_stored: one device's registration from state.json has the shape the relay keeps. An iPhone's row may lack
/// `platform` (kept before Android); an Android row has `platform: "android"`, its FCM token, no `env`, no VoIP token,
/// `callkit` false and a seal key.
fn stored_entry(o: &Obj) -> bool {
    let android = match o.get("platform") {
        None => false,
        Some(Value::String(p)) if p == IOS || p == ANDROID => p == ANDROID,
        Some(_) => return false,
    };
    let token_ok = if android {
        fcm_token(o.get("token")).is_some()
    } else {
        o.get("token").and_then(Value::as_str).map(|t| t == t.to_ascii_lowercase() && hex_token(Some(&Value::from(t))).is_some()).unwrap_or(false)
    };
    let env_ok = o.get("env").and_then(Value::as_str).map(|e| if android { e.is_empty() } else { ENVS.contains(&e) }).unwrap_or(false);
    let prev_ok = match (o.get("seal_prev").and_then(Value::as_str), o.get("sk_prev").and_then(Value::as_str)) {
        (Some(""), Some("")) => true,
        (Some(_), Some(_)) => stored_seal(o.get("seal_prev"), o.get("sk_prev")),
        _ => false,
    };
    let voip_ok = match o.get("voip").and_then(Value::as_str) {
        Some("") => true,
        Some(t) => !android && t == t.to_ascii_lowercase() && hex_token(Some(&Value::from(t))).is_some(),
        None => false,
    };
    let callkit_ok = match o.get("callkit") {
        Some(Value::Bool(c)) => !(android && *c),
        _ => false,
    };
    // PH-1 section 5.4: `phone` is kept only as true
    let phone_ok = matches!(o.get("phone"), None | Some(Value::Bool(true)));
    o.len() == 10 + usize::from(o.contains_key("platform")) + usize::from(o.contains_key("phone"))
        && phone_ok
        && token_ok
        && env_ok
        && pj::as_int(o.get("ts")).is_some()
        && o.get("serial").map(Value::is_string).unwrap_or(false)
        && (stored_seal(o.get("seal"), o.get("sk")) || (!android && legacy_row(o)))
        && prev_ok
        && voip_ok
        && callkit_ok
}

/// MV-1: a pre-NT-1 app's registration: no seal key (pushes go out as the PB-1 payload).
fn legacy_row(o: &Obj) -> bool {
    ["seal", "sk", "seal_prev", "sk_prev"].iter().all(|k| pj::text_of(o, k).is_empty())
}

/// MV-1: the PB-1 payload and APNs headers of a push to a legacy row: `msg`, `call` and `live` only, as the 0.96.3
/// relay sent them (no seal, no preview); None for any other kind.
fn build_legacy(person_key: &[u8], kind: &str, conv: &str, badge: i64, topic: &str, sent_s: i64) -> Option<(Obj, Vec<(&'static str, String)>)> {
    let call = matches!(kind, "call" | "live");
    if !call && kind != "msg" {
        return None;
    }
    let tid = tag(person_key, conv.as_bytes());
    let mut aps = obj([
        ("alert", Value::Object(obj([("title", Value::from(TITLE)), ("body", Value::from(if call { "Incoming call" } else { "New message" }))]))),
        ("badge", Value::from(badge)),
        ("sound", Value::from("default")),
        ("thread-id", Value::from(tid.clone())),
    ]);
    if call {
        aps.insert("interruption-level".into(), Value::from("time-sensitive"));
    }
    let payload = obj([("aps", Value::Object(aps)), ("c", Value::from(tid.clone()))]);
    let expiration = if call { 0 } else { sent_s + MESSAGE_TTL };
    let headers = vec![
        ("apns-push-type", "alert".to_string()),
        ("apns-topic", topic.to_string()),
        ("apns-priority", "10".to_string()),
        ("apns-expiration", expiration.to_string()),
        ("apns-collapse-id", tid),
    ];
    Some((payload, headers))
}

/// MV-1: a row kept by a 0.96.3 relay (`{token, env, ts, serial}`) as the legacy row of this relay.
fn legacy_of(o: &Obj) -> Obj {
    let mut row = o.clone();
    for k in ["seal", "sk", "seal_prev", "sk_prev", "voip"] {
        row.insert(k.into(), Value::from(""));
    }
    row.insert("callkit".into(), Value::Bool(false));
    row
}

/// The id a reply or thread names: a plain message's `reply_to` is its preview `{id, name, text}`, an encrypted one's
/// the id itself.
fn ref_id(v: Option<&Value>) -> Option<&str> {
    match v? {
        Value::String(s) => Some(s.as_str()),
        Value::Object(o) => o.get("id").and_then(Value::as_str),
        _ => None,
    }
}

/// An invite record has not been settled.
fn unsettled(inv: &Obj) -> bool {
    inv.get("settled").and_then(Value::as_str).is_none()
}

/// `ring_ms_left` (3.5): the 45 s ring left at `now`, by the relay's clock.
fn ring_left(inv: &Obj, now: f64) -> i64 {
    (45_000 - ((now - pj::num(inv, "ts")) * 1000.0) as i64).max(0)
}

// ── PS-1: the seal (section 3.3) ─────────────────────────────────────────────────────────────────────────────

/// CE-1 padding to one fixed size: the inner, 0x80, then zero bytes up to `size`; None when it does not fit.
pub fn pad(inner: &[u8], size: usize) -> Option<Vec<u8>> {
    if inner.len() + 1 > size {
        return None;
    }
    let mut out = Vec::with_capacity(size);
    out.extend_from_slice(inner);
    out.push(0x80);
    out.resize(size, 0);
    Some(out)
}

/// `info = lp(SEAL, channel, device id, sk, eph_raw, seal_raw)`.
pub fn seal_info(channel: Channel, device: &str, sk: &str, eph: &[u8], seal: &[u8]) -> Vec<u8> {
    op::lp(&[SEAL.as_bytes(), channel.name().as_bytes(), device.as_bytes(), sk.as_bytes(), eph, seal])
}

/// `k = HKDF-SHA-256(z, salt = 32 zero bytes, info, 32 bytes)`.
pub fn seal_key(z: &[u8], info: &[u8]) -> Result<[u8; 32], String> {
    let prk = hkdf::Salt::new(hkdf::HKDF_SHA256, &[0u8; 32]).extract(z);
    let parts = [info];
    let mut k = [0u8; 32];
    prk.expand(&parts, hkdf::HKDF_SHA256).and_then(|okm| okm.fill(&mut k)).map_err(|_| "cannot derive the seal key".to_string())?;
    Ok(k)
}

/// PS-1 with a given ephemeral key and nonce: `(s, info, k)`, `s = base64(eph_raw || nonce || AES-256-GCM(k, nonce,
/// padded, aad = info))`.
pub fn seal_with(esk: &agreement::PrivateKey, nonce: [u8; 12], seal: &[u8], channel: Channel, device: &str, sk: &str, padded: &[u8]) -> Result<(String, Vec<u8>, [u8; 32]), String> {
    let eph = esk.compute_public_key().map_err(|_| "cannot make the ephemeral key".to_string())?.as_ref().to_vec();
    let info = seal_info(channel, device, sk, &eph, seal);
    let z = agreement::agree(esk, agreement::UnparsedPublicKey::new(&agreement::ECDH_P256, seal), "the seal key is not a P-256 point".to_string(), |z| Ok(z.to_vec()))?;
    let k = seal_key(&z, &info)?;
    let key = aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM, &k).map_err(|_| "cannot make the seal key".to_string())?);
    let mut buf = padded.to_vec();
    key.seal_in_place_append_tag(aead::Nonce::assume_unique_for_key(nonce), aead::Aad::from(info.as_slice()), &mut buf).map_err(|_| "cannot seal".to_string())?;
    let mut raw = Vec::with_capacity(eph.len() + nonce.len() + buf.len());
    raw.extend_from_slice(&eph);
    raw.extend_from_slice(&nonce);
    raw.extend_from_slice(&buf);
    Ok((pj::b64(&raw), info, k))
}

/// PS-1 with a fresh ephemeral P-256 key and 12 random nonce bytes.
fn seal_fresh(seal: &[u8], channel: Channel, device: &str, sk: &str, padded: &[u8]) -> Result<String, String> {
    let esk = agreement::PrivateKey::generate(&agreement::ECDH_P256).map_err(|_| "cannot make the ephemeral key".to_string())?;
    let mut nonce = [0u8; 12];
    nonce.copy_from_slice(&pj::random_bytes(12));
    seal_with(&esk, nonce, seal, channel, device, sk, padded).map(|(s, _, _)| s)
}

/// `o` (3.4): the first 16 bytes, as hex, of HMAC-SHA-256(person key, `lp(ORIGIN, channel, sk, s)`).
pub fn origin(person_key: &[u8], channel: Channel, sk: &str, s: &str) -> String {
    tag(person_key, &op::lp(&[ORIGIN.as_bytes(), channel.name().as_bytes(), sk.as_bytes(), s.as_bytes()]))
}

/// The size rule (3.4): the inner's canonical JSON padded for the channel; an inner that does not fit drops `wrap`,
/// then `env`. None when it still does not fit.
pub fn fit(inner: &mut Obj, channel: Channel) -> Option<Vec<u8>> {
    for gone in ["", "wrap", "env"] {
        if !gone.is_empty() && inner.shift_remove(gone).is_none() {
            continue;
        }
        if let Some(padded) = op::canonical_json(&Value::Object(inner.clone())).ok().and_then(|b| pad(&b, channel.size())) {
            return Some(padded);
        }
    }
    None
}

/// The outer payload and APNs headers of one sealed push (3.4): the alert with its fallback words, category, sound,
/// interruption level and `thread-id`; the VoIP push content-free; the background `crl` push.
#[allow(clippy::too_many_arguments)]
pub fn build(person_key: &[u8], channel: Channel, inner: &Obj, s: &str, sk: &str, badge: i64, time_sensitive: bool, topic: &str, sent_s: i64) -> (Obj, Vec<(&'static str, String)>) {
    let kind = pj::text_of(inner, "k");
    let conv = pj::text_of(inner, "conv");
    let o = origin(person_key, channel, sk, s);
    let sealed = |mut p: Obj| {
        p.insert("s".into(), Value::from(s));
        p.insert("sk".into(), Value::from(sk));
        p.insert("o".into(), Value::from(o.clone()));
        p
    };
    let expiration = match ttl(channel, &kind) {
        0 => 0,
        t => sent_s + t,
    };
    match channel {
        Channel::Voip => {
            let payload = sealed(obj([("c", Value::from(tag(person_key, conv.as_bytes())))]));
            let headers = vec![("apns-push-type", "voip".to_string()), ("apns-topic", format!("{topic}.voip")), ("apns-priority", "10".to_string()), ("apns-expiration", expiration.to_string())];
            (payload, headers)
        }
        Channel::Background => {
            let payload = sealed(obj([("aps", Value::Object(obj([("content-available", Value::from(1))])))]));
            let headers = vec![
                ("apns-push-type", "background".to_string()),
                ("apns-topic", topic.to_string()),
                ("apns-priority", "5".to_string()),
                ("apns-expiration", expiration.to_string()),
                ("apns-collapse-id", tag(person_key, b"crl")),
            ];
            (payload, headers)
        }
        Channel::Alert => {
            let (body, category, sound) = alert_words(&kind).unwrap_or(("New message", "msg", "msg-lucid.wav"));
            let call = kind == "call" || kind == "live";
            let tid = alert_thread(person_key, &kind, &conv);
            let level = if call || time_sensitive { "time-sensitive" } else { "active" };
            let aps = obj([
                ("alert", Value::Object(obj([("title", Value::from(TITLE)), ("body", Value::from(body))]))),
                ("badge", Value::from(badge)),
                ("sound", Value::from(sound)),
                ("thread-id", Value::from(tid.clone())),
                ("mutable-content", Value::from(1)),
                ("category", Value::from(category)),
                ("interruption-level", Value::from(level)),
            ]);
            let payload = sealed(obj([("aps", Value::Object(aps)), ("c", Value::from(tid))]));
            let headers = vec![
                ("apns-push-type", "alert".to_string()),
                ("apns-topic", topic.to_string()),
                ("apns-priority", "10".to_string()),
                ("apns-expiration", expiration.to_string()),
                ("apns-collapse-id", alert_collapse(person_key, inner)),
            ];
            (payload, headers)
        }
    }
}

/// How long a push may wait for the device (s; 0: now or never, 3.4): calls 0, the background `crl` push CRL_TTL,
/// every other push MESSAGE_TTL.
fn ttl(channel: Channel, kind: &str) -> i64 {
    match channel {
        Channel::Voip => 0,
        Channel::Background => CRL_TTL,
        Channel::Alert if kind == "call" || kind == "live" => 0,
        Channel::Alert => MESSAGE_TTL,
    }
}

/// An alert push's `thread-id` and `c` (3.4): the tag of its conversation, or of `meetings` for the meeting kinds.
fn alert_thread(person_key: &[u8], kind: &str, conv: &str) -> String {
    let meeting = matches!(kind, "invite" | "update" | "cancel");
    tag(person_key, if meeting { b"meetings".as_slice() } else { conv.as_bytes() })
}

/// An alert push's collapse id (3.4): the tag of `invite:<id>` for calls and missed calls, `meeting:<id>:<start>`
/// for the meeting kinds, else `msg:<id>`.
fn alert_collapse(person_key: &[u8], inner: &Obj) -> String {
    let (kind, id) = (pj::text_of(inner, "k"), pj::text_of(inner, "id"));
    let collapse = match kind.as_str() {
        "call" | "live" | "missed" => format!("invite:{id}"),
        "invite" | "update" | "cancel" => format!("meeting:{id}:{}", pj::as_int(inner.get("start")).unwrap_or(0)),
        _ => format!("msg:{id}"),
    };
    tag(person_key, collapse.as_bytes())
}

/// The FCM HTTP v1 request body of one sealed push to an Android device (NT-1 revision "Android (FCM)") and the size
/// of its data as FCM counts it (keys and values, bytes). Data only, never a `notification` block: the app builds the
/// notification from the sealed inner, so Google sees what Apple sees. `data` carries what the APNs payload carries
/// outside `aps` (`c`, `s`, `sk`, `o`), the channel `ch` and, for alerts, the collapse tag `collapse` and the two
/// `aps` fields the app needs before the seal opens: the category `cat` and the badge count `badge` (decimal);
/// `android` carries the priority (HIGH for alerts and calls, NORMAL for background), the time to live of the APNs
/// expiration rule and the APNs collapse id as `collapse_key` when there is one.
pub fn build_fcm(person_key: &[u8], channel: Channel, inner: &Obj, s: &str, sk: &str, badge: i64, token: &str) -> (Value, usize) {
    let kind = pj::text_of(inner, "k");
    let mut data = obj([("ch", Value::from(channel.name()))]);
    let collapse = match channel {
        Channel::Alert => {
            data.insert("c".into(), Value::from(alert_thread(person_key, &kind, &pj::text_of(inner, "conv"))));
            Some(alert_collapse(person_key, inner))
        }
        Channel::Voip => {
            data.insert("c".into(), Value::from(tag(person_key, pj::text_of(inner, "conv").as_bytes())));
            None
        }
        Channel::Background => Some(tag(person_key, b"crl")),
    };
    data.insert("s".into(), Value::from(s));
    data.insert("sk".into(), Value::from(sk));
    data.insert("o".into(), Value::from(origin(person_key, channel, sk, s)));
    if let (Channel::Alert, Some(c)) = (channel, &collapse) {
        let (_, category, _) = alert_words(&kind).unwrap_or(("New message", "msg", "msg-lucid.wav"));
        data.insert("collapse".into(), Value::from(c.as_str()));
        data.insert("cat".into(), Value::from(category));
        data.insert("badge".into(), Value::from(badge.to_string()));
    }
    let size = data.iter().map(|(k, v)| k.len() + v.as_str().map(str::len).unwrap_or_default()).sum();
    let priority = if channel == Channel::Background { "NORMAL" } else { "HIGH" };
    let mut android = obj([("priority", Value::from(priority)), ("ttl", Value::from(format!("{}s", ttl(channel, &kind))))]);
    if let Some(c) = collapse {
        android.insert("collapse_key".into(), Value::from(c));
    }
    let message = obj([("token", Value::from(token)), ("data", Value::Object(data)), ("android", Value::Object(android))]);
    (Value::Object(obj([("message", Value::Object(message))])), size)
}

/// A push handed to its sender: true when queued; a full queue drops it with one line.
fn queued(ok: bool, to: &str, device: &str, kind: &str) -> bool {
    if !ok {
        log_warn(&format!("push_dropped principal={to} device={} kind={kind} why=queue", kv(device)));
    }
    ok
}

/// The occurrence a meeting push names (3.3 `start`, `end`): the first with its end after `now` (within
/// OCCURRENCE_DAYS), else the meeting's own times; whole seconds.
fn occurrence(m: &Obj, now: f64) -> (i64, i64) {
    let (start, end) = (pj::num(m, "start"), pj::num(m, "end"));
    let found = meetings::meeting_occurrences(start, end, &pj::text_of(m, "recurrence"), &pj::text_of(m, "tz"), now, now + OCCURRENCE_DAYS * 86400.0, 2).into_iter().find(|(_, e)| *e > now);
    let (s, e) = found.unwrap_or((start, end));
    (s as i64, e as i64)
}

impl State {
    /// _push_load: the registrations from state.json (an unsound one is dropped; one without a seal key with its own
    /// line, the app registers again at launch), then the restart rule of 3.5.
    pub(super) fn pu_load(&mut self, raw: &Obj) {
        for (principal, devices) in as_obj(raw.get("push_tokens")).into_iter().flatten() {
            let mut kept = Obj::new();
            for (device, entry) in as_obj(Some(devices)).into_iter().flatten() {
                match entry.as_object() {
                    Some(o) if stored_entry(o) => {
                        kept.insert(device.clone(), entry.clone());
                    }
                    Some(o) if !o.contains_key("seal") && stored_entry(&legacy_of(o)) => {
                        kept.insert(device.clone(), Value::Object(legacy_of(o)));
                    }
                    _ => log_warn(&format!("state file: push token of {principal} device={} unreadable; ignored", kv(device))),
                }
            }
            if !kept.is_empty() {
                self.push_tokens.insert(principal.clone(), Value::Object(kept));
            }
        }
        let now = self.pu.now();
        self.nt_load(now);
    }

    /// After a restart (3.5): invites whose 45 s passed while the relay was down are settled `missed` at their ring's
    /// end, with no push and no `invite_settled` event (hello's `settled` carries them).
    fn nt_load(&mut self, now: f64) {
        let mut changed = false;
        for list in self.invites.values_mut() {
            for inv in list.iter_mut().filter(|i| unsettled(i)) {
                let end = pj::num(inv, "ts") + RING_SECONDS;
                if end <= now {
                    inv.insert("settled".into(), Value::from("missed"));
                    inv.insert("settled_ts".into(), f(end));
                    changed = true;
                }
            }
        }
        if changed {
            self.dirty = true;
        }
    }

    /// The relay's wall clock the invite lifecycle runs on (seconds).
    pub(super) fn nt_now(&self) -> f64 {
        self.pu.now()
    }

    /// Push is on: enabled in relay.json, and the APNs key or the FCM service account read and its sender running.
    pub(super) fn pu_on(&self) -> bool {
        self.pu.sender.is_some() || self.pu.fcm.is_some()
    }

    /// _push_person_key: what register answers (`key`, base64): the app derives thread-ids, `c` and collapse ids and
    /// checks `o` with it.
    fn pu_person_key(&mut self, principal: &str) -> [u8; 32] {
        hmac(self.pu.secret(), format!("{KEY_LABEL}{principal}").as_bytes())
    }

    /// _push_id: the thread-id and `c` of one conversation as `principal` sees it.
    #[cfg(test)]
    fn pu_id(&mut self, principal: &str, conv: &str) -> String {
        let key = self.pu_person_key(principal);
        tag(&key, conv.as_bytes())
    }

    /// The person is on Do not disturb.
    pub(super) fn pu_dnd(&self, principal: &str) -> bool {
        self.status_of(principal).get("state").and_then(Value::as_str) == Some("dnd")
    }

    /// Live for push (3.6): the device has a room seat, or a presence session with a poll open or whose latest
    /// /v1/inbox request started less than LIVE_FOR seconds ago. A session that never polled is not live.
    fn pu_live(&self, principal: &str, device: &str) -> bool {
        let now = self.pu.mono();
        self.peers.values().any(|p| p.who.principal == principal && p.who.device == device)
            || self.sessions.values().any(|s| s.who.principal == principal && s.who.device == device && (s.waiters > 0 || self.pu.polled.get(&s.session_id).map(|t| now - t < LIVE_FOR).unwrap_or(false)))
    }

    /// A /v1/inbox request of this session starts now (live for push).
    pub(super) fn nt_polled(&mut self, session: &str) {
        let now = self.pu.mono();
        self.pu.polled.insert(session.to_string(), now);
    }

    /// GET /v1/chat/keys `after` of this device: the wrap rider cursor (3.4) only moves forward.
    pub(super) fn nt_keys_fetched(&mut self, principal: &str, device: &str, after: i64) {
        let cursor = self.pu.cursors.entry((principal.to_string(), device.to_string())).or_insert(0);
        *cursor = (*cursor).max(after);
    }

    /// _push_badge: what the person has unread, by their levels: direct messages of a sender at level all (hello's
    /// `unread`), and per channel or group chat they are in, at level all the main conversation's messages of others
    /// after their read mark, at mentions those of others (thread replies too) that mention them, at off none.
    fn pu_badge(&self, principal: &str) -> i64 {
        let mut n: i64 = self.unread(principal).iter().filter(|(from, _)| self.pu_level(principal, &format!("dm:{from}")) == "all").filter_map(|(_, c)| c.as_i64()).sum();
        let marks = as_obj(self.channel_read.get(principal));
        for (cid, ch) in self.channels.iter() {
            if !channels::members_of(ch.as_object()).iter().any(|p| p == principal) {
                continue;
            }
            let level = self.pu_level(principal, &format!("channel:{cid}"));
            if level == "off" {
                continue;
            }
            let mark = marks.and_then(|o| pj::as_num(o.get(cid))).unwrap_or(0.0);
            let fresh = self.channel_msgs.get(cid).into_iter().flatten().filter(|m| pj::num(m, "ts") > mark && pj::text_of(m, "from") != principal && !pj::truthy(m.get("deleted")) && !pj::truthy(m.get("imported")));
            let count = if level == "all" {
                fresh.filter(|m| !pj::truthy(m.get("thread")) || pj::truthy(m.get("also_channel"))).count()
            } else {
                fresh.filter(|m| m.get("mentions").and_then(Value::as_array).map(|l| l.iter().any(|p| p.as_str() == Some(principal))).unwrap_or(false)).count()
            };
            n += count as i64;
        }
        n
    }

    /// The person's wave A level for a conversation: its own, else for a channel (not a group chat) their
    /// channel_default, else "all".
    fn pu_level(&self, principal: &str, conv: &str) -> String {
        let prefs = as_obj(self.prefs.get(principal));
        if let Some(level) = prefs.and_then(|p| as_obj(p.get("notify"))).and_then(|n| n.get(conv)).and_then(Value::as_str) {
            return level.to_string();
        }
        let channel = conv.strip_prefix("channel:").and_then(|cid| self.channel(cid));
        if channel.map(|c| pj::text_of(c, "kind") != "group").unwrap_or(false) {
            if let Some(d) = prefs.and_then(|p| p.get("channel_default")).and_then(Value::as_str) {
                return d.to_string();
            }
        }
        "all".into()
    }

    /// _nt_previews_off (3.9), the one predicate: previews are off for a push to `person` about conversation `conv`
    /// when the relay's notify_previews is false, the relay is an enclave, or the newest signed policy that covers
    /// the person or any member of the conversation (both people of a DM, every member of a group chat or channel)
    /// says `{"previews": "off"}`.
    pub(super) fn nt_previews_off(&mut self, person: &str, conv: &str) -> bool {
        if !self.pu.previews || self.pc_enclave() {
            return true;
        }
        let mut people = vec![person.to_string()];
        if let Some(other) = conv.strip_prefix("dm:") {
            people.push(other.to_string());
        } else if let Some(cid) = conv.strip_prefix("channel:") {
            people.extend(channels::members_of(self.channel(cid)));
        }
        let policies = self.pc_current();
        people.iter().any(|p| pc::covering(&policies, p).is_some_and(op::previews_off))
    }

    /// The registered devices of `to` that are not live for push: (device, its row).
    fn nt_offline(&self, to: &str) -> Vec<(String, Obj)> {
        as_obj(self.push_tokens.get(to)).into_iter().flatten().filter(|(d, _)| !self.pu_live(to, d)).filter_map(|(d, r)| r.as_object().map(|o| (d.clone(), o.clone()))).collect()
    }

    /// Seal `inner` to one device and queue it on `channel`: `dev` added, the size rule, then for an iPhone the outer
    /// payload and headers and Apple's limit, for an Android device the FCM message and FCM's data limit. True when
    /// queued.
    fn nt_push(&mut self, to: &str, device: &str, row: &Obj, channel: Channel, mut inner: Obj, time_sensitive: bool) -> bool {
        let kind = pj::text_of(&inner, "k");
        let dropped = |why: &str| log_warn(&format!("push_dropped principal={to} device={} kind={kind} why={why}", kv(device)));
        if legacy_row(row) {
            if channel != Channel::Alert {
                return false;
            }
            let key = self.pu_person_key(to);
            let badge = self.pu_badge(to);
            let Some((payload, headers)) = build_legacy(&key, &kind, &pj::text_of(&inner, "conv"), badge, &self.pu.topic, self.pu.now() as i64) else { return false };
            return self.nt_queue(to, device, row, false, kind, headers, pj::dumps_compact(&Value::Object(payload)).into_bytes());
        }
        inner.insert("dev".into(), Value::from(device));
        let Some(padded) = fit(&mut inner, channel) else {
            dropped("size");
            return false;
        };
        let Some(seal) = row.get("seal").and_then(Value::as_str).and_then(pj::b64_strict) else {
            dropped("seal");
            return false;
        };
        let sk = pj::text_of(row, "sk");
        let s = match seal_fresh(&seal, channel, device, &sk, &padded) {
            Ok(s) => s,
            Err(_) => {
                dropped("seal");
                return false;
            }
        };
        let key = self.pu_person_key(to);
        let badge = if channel == Channel::Alert { self.pu_badge(to) } else { 0 };
        if android_row(row) {
            let token = pj::text_of(row, "token");
            let (message, size) = build_fcm(&key, channel, &inner, &s, &sk, badge, &token);
            if size > fcm::DATA_LIMIT {
                dropped("size");
                return false;
            }
            let job = fcm::Job { principal: to.to_string(), device: device.to_string(), token, kind: kind.clone(), body: pj::dumps_compact(&message).into_bytes() };
            let Some(sender) = &self.pu.fcm else { return false };
            return queued(sender.send(job), to, device, &kind);
        }
        let sent_s = self.pu.now() as i64;
        let (payload, headers) = build(&key, channel, &inner, &s, &sk, badge, time_sensitive, &self.pu.topic, sent_s);
        let bytes = pj::dumps_compact(&Value::Object(payload)).into_bytes();
        if bytes.len() > channel.limit() {
            dropped("size");
            return false;
        }
        self.nt_queue(to, device, row, channel == Channel::Voip, kind, headers, bytes)
    }

    /// Queue one built push to the device's token (its VoIP token for `voip`). True when queued.
    #[allow(clippy::too_many_arguments)]
    fn nt_queue(&self, to: &str, device: &str, row: &Obj, voip: bool, kind: String, headers: Vec<(&'static str, String)>, payload: Vec<u8>) -> bool {
        let job = apns::Job {
            principal: to.to_string(),
            device: device.to_string(),
            token: pj::text_of(row, if voip { "voip" } else { "token" }),
            sandbox: pj::text_of(row, "env") == "sandbox",
            voip,
            kind: kind.clone(),
            headers,
            payload,
        };
        let Some(sender) = &self.pu.sender else { return false };
        queued(sender.send(job), to, device, &kind)
    }

    // ── messages ─────────────────────────────────────────────────────────────────────────────────────────────

    /// _push_message: a new message in a direct conversation (`dm`: the other person) or a channel or group chat
    /// (`cid`), already kept. Each recipient's level decides: all pushes, mentions only when they are mentioned or it
    /// replies to them (its reply_to or thread root is theirs), off never; a thread reply kept out of the main
    /// conversation pushes (unless off) only when it mentions or answers them. Never under Do not disturb. At most
    /// one per device and conversation every RATE_S seconds, except a reply to them or a mention the relay can see.
    /// The inner carries the stored CE-1 envelope and, for a sender epoch new to that device, the wrap rider, unless
    /// previews are off (3.9). A call's chat never pushes.
    pub(super) fn pu_message(&mut self, cid: Option<&str>, dm: Option<&str>, msg: &Obj) {
        if !self.pu_on() {
            return;
        }
        let from = pj::text_of(msg, "from");
        let rows: &[Obj] = match (cid, dm) {
            (Some(cid), _) => self.channel_msgs.get(cid).map(Vec::as_slice).unwrap_or_default(),
            (None, Some(other)) => self.dms.get(&conv(&from, other)).map(Vec::as_slice).unwrap_or_default(),
            (None, None) => return,
        };
        let author = |id: Option<&str>| id.and_then(|id| rows.iter().find(|r| r.get("id").and_then(Value::as_str) == Some(id))).map(|r| pj::text_of(r, "from"));
        let answered: Vec<String> = [author(ref_id(msg.get("reply_to"))), author(ref_id(msg.get("thread")))].into_iter().flatten().collect();
        let mentioned: Vec<String> = msg.get("mentions").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect();
        let (recipients, conv_key, ce_cid) = match (cid, dm) {
            (Some(cid), _) => (channels::members_of(self.channel(cid)), format!("channel:{cid}"), format!("ch:{cid}")),
            (None, Some(other)) => (vec![other.to_string()], format!("dm:{from}"), ce::dm_cid(&from, other)),
            (None, None) => return,
        };
        // a thread reply kept out of the main conversation only reaches the people it mentions or answers
        let side = pj::truthy(msg.get("thread")) && !pj::truthy(msg.get("also_channel"));
        let env = msg.get("enc").and_then(Value::as_object).cloned();
        let inner = obj([
            ("v", Value::from(1)),
            ("k", Value::from("msg")),
            ("ts", Value::from((self.pu.now() * 1000.0) as i64)),
            ("from", Value::from(from.clone())),
            ("conv", Value::from(conv_key.clone())),
            ("id", Value::from(pj::text_of(msg, "id"))),
            ("thread", Value::from(pj::text_of(msg, "thread"))),
            ("files", Value::from(msg.get("files").and_then(Value::as_array).map(Vec::len).unwrap_or(0))),
            ("enc", Value::Bool(env.is_some())),
        ]);
        let now = self.pu.mono();
        self.pu.last.retain(|_, at| now - *at < RATE_S);
        for to in recipients.into_iter().filter(|p| *p != from) {
            let reply = answered.contains(&to);
            let theirs = reply || mentioned.contains(&to);
            let push = match self.pu_level(&to, &conv_key).as_str() {
                "all" => theirs || !side,
                "mentions" => theirs,
                _ => false,
            };
            if !push || !self.push_tokens.contains_key(&to) || self.pu_dnd(&to) {
                continue;
            }
            let previews = env.is_some() && !self.nt_previews_off(&to, &conv_key);
            let mut mine = inner.clone();
            mine.insert("reply".into(), Value::Bool(reply));
            for (device, row) in self.nt_offline(&to) {
                let rate = (to.clone(), device.clone(), conv_key.clone());
                if !theirs && self.pu.last.contains_key(&rate) {
                    continue;
                }
                let mut item = mine.clone();
                if let Some(e) = env.as_ref().filter(|_| previews) {
                    item.insert("env".into(), Value::Object(e.clone()));
                    if let Some(w) = self.nt_rider(&to, &device, &ce_cid, e) {
                        item.insert("wrap".into(), Value::Object(w));
                    }
                }
                if self.nt_push(&to, &device, &row, Channel::Alert, item, false) {
                    self.pu.last.insert(rate, now);
                }
            }
        }
    }

    /// PH-1 revision 2 (contract section 10.3): an inbound text, already kept in `to`'s thread with `number`: the `msg`
    /// push to the person's devices that are not live for push, `conv` `sms:<number>`, `from` `phone:<number>`, at
    /// level all (a text mentions no one and answers nothing), never under Do not disturb, at most one per device and
    /// conversation every RATE_S seconds. A text is plain at the carrier, so its preview is the inner's `text` (its
    /// first PREVIEW characters), present only when previews are on (3.9).
    pub(super) fn pu_sms(&mut self, to: &str, number: &str, msg: &Obj) {
        const PREVIEW: usize = 200;
        if !self.pu_on() || !self.push_tokens.contains_key(to) || self.pu_dnd(to) {
            return;
        }
        let conv_key = format!("sms:{number}");
        if self.pu_level(to, &conv_key) != "all" {
            return;
        }
        let mut inner = obj([
            ("v", Value::from(1)),
            ("k", Value::from("msg")),
            ("ts", Value::from((self.pu.now() * 1000.0) as i64)),
            ("from", Value::from(format!("phone:{number}"))),
            ("conv", Value::from(conv_key.clone())),
            ("id", Value::from(pj::text_of(msg, "id"))),
            ("thread", Value::from("")),
            ("files", Value::from(0)),
            ("enc", Value::Bool(false)),
            ("reply", Value::Bool(false)),
            ("sms", Value::Bool(true)),
        ]);
        if !self.nt_previews_off(to, &conv_key) {
            inner.insert("text".into(), Value::from(pj::clip(&pj::text_of(msg, "text"), PREVIEW)));
        }
        let now = self.pu.mono();
        self.pu.last.retain(|_, at| now - *at < RATE_S);
        for (device, row) in self.nt_offline(to) {
            let rate = (to.to_string(), device.clone(), conv_key.clone());
            if self.pu.last.contains_key(&rate) {
                continue;
            }
            if self.nt_push(to, &device, &row, Channel::Alert, inner.clone(), false) {
                self.pu.last.insert(rate, now);
            }
        }
    }

    /// The wrap rider (3.4): the newest CE-1 wrap of (cid, the envelope's sender device, its epoch) to this device
    /// whose `seq` is above the device's key cursor, as `{eph, blob, dck_sha256}`.
    fn nt_rider(&mut self, to: &str, device: &str, cid: &str, env: &Obj) -> Option<Obj> {
        let cursor = self.pu.cursors.get(&(to.to_string(), device.to_string())).copied().unwrap_or(0);
        let sender = pj::text_of(env, "d");
        let epoch = pj::as_int(env.get("e"))?;
        let rows = self.ce_part("wraps").get(&format!("{to}|{device}"))?.as_array()?;
        let found = rows.iter().rev().filter_map(Value::as_object).find(|r| {
            pj::as_int(r.get("seq")).unwrap_or(0) > cursor && pj::text_of(r, "cid") == cid && pj::as_int(r.get("epoch")) == Some(epoch) && r.get("from").and_then(|f| f.get("device")).and_then(Value::as_str) == Some(sender.as_str())
        })?;
        let part = |k: &str| found.get(k).cloned().unwrap_or(Value::Null);
        Some(obj([("eph", part("eph")), ("blob", part("blob")), ("dck_sha256", part("dck_sha256"))]))
    }

    // ── calls: kind, ring, settle (3.5, 3.7) ─────────────────────────────────────────────────────────────────

    /// _pb_call_key: the conversation a call room belongs to for `to`, as the apps find it: the direct call of the two
    /// of them (`dm:<from>`), a channel's call they are a member of (`channel:<id>`), else the room (`room:<room>`).
    fn nt_call_key(&self, from: &str, to: &str, room: &str) -> String {
        let mut pair = [from.to_lowercase(), to.to_lowercase()];
        pair.sort();
        let digest = crate::codec::sha256_hex(pair.join("|").as_bytes());
        if room == format!("dm-{}", &digest[..16]) {
            return format!("dm:{from}");
        }
        // _bridge_room: a bridged DM's `bdm:<link id>` rings as `cv-bdm-<link id>`
        let channel = self.channels.iter().find(|(cid, ch)| bridge::room(&cid.trim().to_lowercase()) == room && channels::members_of(ch.as_object()).iter().any(|m| m == to));
        match channel {
            Some((cid, _)) => format!("channel:{cid}"),
            None => format!("room:{room}"),
        }
    }

    /// A call's level (section 2 gate 2): the lowest of the room's conversation and `dm:<caller>`.
    pub(super) fn nt_call_level(&self, from: &str, to: &str, room: &str) -> String {
        let room_level = self.pu_level(to, &self.nt_call_key(from, to, room));
        let caller = self.pu_level(to, &format!("dm:{from}"));
        if rank(&room_level) <= rank(&caller) {
            room_level
        } else {
            caller
        }
    }

    /// An invite's `kind` (section 2) and `others`: `live` when someone other than the inviter and the invitee is
    /// seated in the room (admitted), or the room is a scheduled meeting's, not canceled, during one of its
    /// occurrences; else `call`.
    pub(super) fn nt_kind(&self, from: &str, to: &str, room: &str, now: f64) -> (&'static str, usize) {
        let mut seated: Vec<&str> = Vec::new();
        for p in self.peers.values() {
            let who = p.who.principal.as_str();
            if p.room == room && !p.admission_pending && who != from && who != to && !seated.contains(&who) {
                seated.push(who);
            }
        }
        let meeting = as_obj(self.meetings.get(room)).filter(|m| !pj::truthy(m.get("canceled"))).map(|m| {
            !meetings::meeting_occurrences(pj::num(m, "start"), pj::num(m, "end"), &pj::text_of(m, "recurrence"), &pj::text_of(m, "tz"), now, now, 1).is_empty()
        });
        let live = !seated.is_empty() || meeting.unwrap_or(false);
        (if live { "live" } else { "call" }, seated.len())
    }

    /// A new invite's `ring` (3.7): false only when the inviter's bucket for this invitee is empty or the hourly cap
    /// is reached (that ring takes no token and is not pushed). Do not disturb and a call level `off` hold the ring back
    /// privately: no token, `ring: true`. A ring takes one token.
    pub(super) fn nt_ring(&mut self, from: &str, to: &str, room: &str, id: &str) -> bool {
        if self.pu_dnd(to) || self.nt_call_level(from, to, room) == "off" {
            return true;
        }
        let now = self.pu.mono();
        let b = self.pu.rings.entry((from.to_string(), to.to_string())).or_insert_with(|| Bucket::new(now));
        b.refill(now);
        if b.tokens < 1.0 || b.hour.len() >= RING_HOURLY {
            return false;
        }
        b.tokens -= 1.0;
        b.hour.push_back((now, id.to_string()));
        true
    }

    /// An answered ring is refunded: its token goes back and it does not count toward the hourly cap.
    fn nt_refund(&mut self, from: &str, to: &str, id: &str) {
        let now = self.pu.mono();
        if let Some(b) = self.pu.rings.get_mut(&(from.to_string(), to.to_string())) {
            if let Some(i) = b.hour.iter().position(|(_, x)| x == id) {
                b.hour.remove(i);
                b.refill(now);
                b.tokens = (b.tokens + 1.0).min(RING_TOKENS);
            }
        }
    }

    /// _nt_call: a ringing invite (`kind` call or live, `ring` true) to the invitee's devices that are not live for
    /// push: a CallKit iPhone (`voip` registered, push.voip on) through PushKit, an Android device on the voip
    /// channel through FCM (its one token), any other as an alert; once per invite and device; not under Do not
    /// disturb or a call level `off`.
    pub(super) fn nt_call(&mut self, inv: &Obj, others: usize) {
        let (from, to, room, id, kind) = (pj::text_of(inv, "from"), pj::text_of(inv, "to"), pj::text_of(inv, "room"), pj::text_of(inv, "id"), pj::text_of(inv, "kind"));
        if !self.pu_on() || !self.push_tokens.contains_key(&to) || self.pu_dnd(&to) || self.nt_call_level(&from, &to, &room) == "off" {
            return;
        }
        let now = self.pu.now();
        let mut inner = obj([
            ("v", Value::from(1)),
            ("k", Value::from(kind.clone())),
            ("ts", Value::from((now * 1000.0) as i64)),
            ("from", Value::from(from.clone())),
            ("conv", Value::from(self.nt_call_key(&from, &to, &room))),
            ("id", Value::from(id.clone())),
            ("room", Value::from(room)),
            ("ring_ms_left", Value::from(ring_left(inv, now))),
        ]);
        if kind == "live" {
            inner.insert("others".into(), Value::from(others));
        }
        // PH-1 section 5.4: a phone call carries its `phone` and rings only the devices registered with `phone: true`
        let caller = inv.get("phone").cloned();
        if let Some(p) = &caller {
            inner.insert("phone".into(), p.clone());
        }
        let mono = self.pu.mono();
        for (device, row) in self.nt_offline(&to) {
            if caller.is_some() && !phone::row_rings(&row) {
                continue;
            }
            let once = (to.clone(), device.clone(), format!("invite:{id}"), kind.clone());
            if self.pu.once.contains_key(&once) {
                continue;
            }
            let callkit = self.pu.voip && !pj::text_of(&row, "voip").is_empty() && row.get("callkit") == Some(&Value::Bool(true));
            let channel = if callkit || android_row(&row) { Channel::Voip } else { Channel::Alert };
            if self.nt_push(&to, &device, &row, channel, inner.clone(), false) {
                self.pu.once.insert(once, mono);
            }
        }
    }

    /// The `missed` alert push (3.5) of an invite settled missed or cancelled, after the answer grace: only for a ring
    /// that was pushable (ring true, not Do not disturb, call level not off), to devices not live for push, once.
    fn nt_missed(&mut self, inv: &Obj) {
        let (from, to, room, id) = (pj::text_of(inv, "from"), pj::text_of(inv, "to"), pj::text_of(inv, "room"), pj::text_of(inv, "id"));
        let why = inv.get("settled").and_then(Value::as_str).unwrap_or_default().to_string();
        if !matches!(why.as_str(), "missed" | "cancelled") || inv.get("ring") != Some(&Value::Bool(true)) {
            return;
        }
        if !self.pu_on() || !self.push_tokens.contains_key(&to) || self.pu_dnd(&to) || self.nt_call_level(&from, &to, &room) == "off" {
            return;
        }
        let mut inner = obj([
            ("v", Value::from(1)),
            ("k", Value::from("missed")),
            ("ts", Value::from((self.pu.now() * 1000.0) as i64)),
            ("from", Value::from(from.clone())),
            ("conv", Value::from(self.nt_call_key(&from, &to, &room))),
            ("id", Value::from(id.clone())),
            ("room", Value::from(room)),
            ("why", Value::from(why)),
        ]);
        // PH-1 section 5.1: a missed phone call names its caller (`phone`), to the devices it rang
        let caller = inv.get("phone").cloned();
        if let Some(p) = &caller {
            inner.insert("phone".into(), p.clone());
        }
        let mono = self.pu.mono();
        for (device, row) in self.nt_offline(&to) {
            if caller.is_some() && !phone::row_rings(&row) {
                continue;
            }
            let once = (to.clone(), device.clone(), format!("invite:{id}"), "missed".to_string());
            if self.pu.once.contains_key(&once) {
                continue;
            }
            if self.nt_push(&to, &device, &row, Channel::Alert, inner.clone(), false) {
                self.pu.once.insert(once, mono);
            }
        }
    }

    /// Settle invite `id` of `to` (`how`: answered, declined, missed or cancelled; `device`: the session's for answered
    /// and declined, "" when the relay settled it): every session of `to` hears `invite_settled`. An answered ring is
    /// refunded; missed and cancelled queue the `missed` push after the answer grace.
    pub(super) fn nt_settle(&mut self, to: &str, id: &str, how: &str, device: &str, now: f64) {
        let Some(inv) = self.invites.get_mut(to).and_then(|l| l.iter_mut().find(|i| pj::text_of(i, "id") == id)) else { return };
        inv.insert("settled".into(), Value::from(how));
        inv.insert("settled_ts".into(), f(now));
        let (from, room) = (pj::text_of(inv, "from"), pj::text_of(inv, "room"));
        // PH-1 section 5.1: a phone call's ring settled: declined and missed end the caller's call
        if inv.contains_key("phone") {
            self.phone_settled(&room, id, how);
        }
        self.dirty = true;
        let event = obj([("type", Value::from("invite_settled")), ("id", Value::from(id)), ("room", Value::from(room)), ("how", Value::from(how)), ("device", Value::from(device))]);
        self.tell(&[to.to_string()], &event, None);
        match how {
            "answered" => self.nt_refund(&from, to, id),
            "missed" | "cancelled" => self.pu.missed.push((now + ANSWER_GRACE, to.to_string(), id.to_string())),
            _ => {}
        }
        log_info(&format!("invite_settled id={id} principal={to} how={how}"));
    }

    /// The person joined `room` from a device: their unsettled invites to it are `answered`, and so is one settled
    /// missed or cancelled less than ANSWER_GRACE seconds ago (late answers win).
    pub(super) fn nt_joined(&mut self, who: &Identity, room: &str) {
        let now = self.pu.now();
        let ids: Vec<String> = self
            .invites
            .get(&who.principal)
            .into_iter()
            .flatten()
            .filter(|i| pj::text_of(i, "room") == room)
            .filter(|i| match i.get("settled").and_then(Value::as_str) {
                None => true,
                Some("missed" | "cancelled") => now - pj::num(i, "settled_ts") <= ANSWER_GRACE,
                Some(_) => false,
            })
            .map(|i| pj::text_of(i, "id"))
            .collect();
        for id in ids {
            self.nt_settle(&who.principal, &id, "answered", &who.device, now);
        }
    }

    /// The inviter's seat left `room` and nobody is in it any more: their unsettled invites to it are `cancelled`.
    pub(super) fn nt_left(&mut self, inviter: &str, room: &str) {
        let now = self.pu.now();
        let mut due: Vec<(String, String)> = Vec::new();
        for (to, list) in self.invites.iter() {
            for inv in list.iter().filter(|i| unsettled(i) && pj::text_of(i, "from") == inviter && pj::text_of(i, "room") == room) {
                due.push((to.clone(), pj::text_of(inv, "id")));
            }
        }
        for (to, id) in due {
            self.nt_settle(&to, &id, "cancelled", "", now);
        }
    }

    /// hello's NT-1 fields: `push_voip`, `notify_previews` (false when the relay setting is false or on an enclave)
    /// and `settled` `[{id, room, how, ts}]`, the invites settled in the last INVITE_TTL.
    pub(super) fn nt_hello(&self, principal: &str) -> Obj {
        let now = self.pu.now();
        let settled: Vec<Value> = self
            .invites
            .get(principal)
            .into_iter()
            .flatten()
            .filter(|i| !unsettled(i) && now - pj::num(i, "settled_ts") <= INVITE_TTL)
            .map(|i| Value::Object(obj([("id", i.get("id").cloned().unwrap_or(Value::Null)), ("room", i.get("room").cloned().unwrap_or(Value::Null)), ("how", i.get("settled").cloned().unwrap_or(Value::Null)), ("ts", i.get("settled_ts").cloned().unwrap_or(Value::Null))])))
            .collect();
        obj([("push_voip", Value::Bool(self.pu_on() && self.pu.voip)), ("notify_previews", Value::Bool(self.pu.previews && !self.pc_enclave())), ("settled", Value::Array(settled))])
    }

    /// The NT-1 timer, every second: rings past RING_SECONDS settle `missed`, the `missed` pushes whose grace passed,
    /// the `crl` pushes whose delay passed, and the books pruned. True when sessions were told something.
    fn nt_tick(&mut self) -> bool {
        let (now, mono) = (self.pu.now(), self.pu.mono());
        let mut due: Vec<(String, String)> = Vec::new();
        for (to, list) in self.invites.iter() {
            for inv in list.iter().filter(|i| unsettled(i) && now - pj::num(i, "ts") >= RING_SECONDS) {
                due.push((to.clone(), pj::text_of(inv, "id")));
            }
        }
        let told = !due.is_empty();
        for (to, id) in due {
            self.nt_settle(&to, &id, "missed", "", now);
        }
        let (ready, waiting): (Vec<_>, Vec<_>) = std::mem::take(&mut self.pu.missed).into_iter().partition(|(at, _, _)| *at <= now);
        self.pu.missed = waiting;
        for (_, to, id) in ready {
            if let Some(inv) = self.invites.get(&to).and_then(|l| l.iter().find(|i| pj::text_of(i, "id") == id)).cloned() {
                self.nt_missed(&inv);
            }
        }
        self.nt_crl_due(mono);
        // the books
        self.pu.once.retain(|_, at| mono - *at < ONCE_KEEP);
        self.pu.last.retain(|_, at| mono - *at < RATE_S);
        let sessions: HashSet<String> = self.sessions.keys().cloned().collect();
        self.pu.polled.retain(|s, _| sessions.contains(s));
        self.pu.rings.retain(|_, b| {
            b.refill(mono);
            !b.hour.is_empty() || b.tokens < RING_TOKENS
        });
        self.pu.meeting_book.retain(|_, times| {
            times.retain(|t| mono - *t < HOUR);
            !times.is_empty()
        });
        self.pu.crl.retain(|_, c| c.due.is_some() || c.sent.map(|t| mono - t < CRL_EVERY).unwrap_or(false));
        told
    }

    // ── meetings (3.8) ───────────────────────────────────────────────────────────────────────────────────────

    /// Sharing for Time Sensitive (3.4): the same org's signed policy covers the organizer and me; or we have a DM in
    /// which both of us wrote; or we are both members of a group chat or private channel in which I wrote or which I
    /// created. A public channel never counts.
    fn nt_shares(&mut self, organizer: &str, me: &str) -> bool {
        let policies = self.pc_current();
        if let (Some(a), Some(b)) = (pc::covering(&policies, organizer), pc::covering(&policies, me)) {
            if a.get("org").is_some() && a.get("org") == b.get("org") {
                return true;
            }
        }
        let wrote = |rows: &[Obj], p: &str| rows.iter().any(|r| pj::text_of(r, "from") == p);
        if self.dms.get(&conv(organizer, me)).map(|rows| wrote(rows.as_slice(), organizer) && wrote(rows.as_slice(), me)).unwrap_or(false) {
            return true;
        }
        self.channels.iter().any(|(cid, ch)| {
            let Some(c) = ch.as_object() else { return false };
            let members = channels::members_of(Some(c));
            pj::text_of(c, "kind") != "public"
                && members.iter().any(|p| p == organizer)
                && members.iter().any(|p| p == me)
                && (pj::text_of(c, "created_by") == me || self.channel_msgs.get(cid).map(|rows| wrote(rows.as_slice(), me)).unwrap_or(false))
        })
    }

    /// _nt_meeting: a meeting push of `kind` (invite, update or cancel) about meeting `m` to each of `people` but the
    /// organizer: only to devices not live for push, never under Do not disturb, once per device and occurrence, at
    /// most MEETING_HOURLY per organizer and attendee in any hour; `invite` and `update` Time Sensitive when the
    /// occurrence starts within the hour and the two share an organization or a conversation.
    pub(super) fn nt_meeting(&mut self, kind: &str, m: &Obj, people: &[String]) {
        if !self.pu_on() {
            return;
        }
        let organizer = m.get("organizer").and_then(|o| o.get("principal")).and_then(Value::as_str).unwrap_or_default().to_string();
        let id = pj::text_of(m, "id");
        let (now, mono) = (self.pu.now(), self.pu.mono());
        let (start, end) = occurrence(m, now);
        for to in people.iter().filter(|p| **p != organizer) {
            if !self.push_tokens.contains_key(to) || self.pu_dnd(to) {
                continue;
            }
            let book = (organizer.clone(), to.clone());
            let held = {
                let times = self.pu.meeting_book.entry(book.clone()).or_default();
                times.retain(|t| mono - *t < HOUR);
                times.len() >= MEETING_HOURLY
            };
            if held {
                log_info(&format!("push_held principal={to} kind={kind} why=meeting_limit"));
                continue;
            }
            let soon = kind != "cancel" && (0.0..=SOON).contains(&(start as f64 - now)) && self.nt_shares(&organizer, to);
            let inner = obj([
                ("v", Value::from(1)),
                ("k", Value::from(kind)),
                ("ts", Value::from((now * 1000.0) as i64)),
                ("from", Value::from(organizer.clone())),
                ("conv", Value::from(format!("meeting:{id}"))),
                ("id", Value::from(id.clone())),
                ("start", Value::from(start)),
                ("end", Value::from(end)),
            ]);
            let mut sent = false;
            for (device, row) in self.nt_offline(to) {
                let once = (to.clone(), device.clone(), format!("meeting:{id}:{start}"), kind.to_string());
                if self.pu.once.contains_key(&once) {
                    continue;
                }
                if self.nt_push(to, &device, &row, Channel::Alert, inner.clone(), soon) {
                    self.pu.once.insert(once, mono);
                    sent = true;
                }
            }
            if sent {
                self.pu.meeting_book.entry(book).or_default().push_back(mono);
            }
        }
    }

    // ── the background `crl` push (3.4) ──────────────────────────────────────────────────────────────────────

    /// A `crl` event (a new CRL the relay adopts, `this_update` in seconds): each registered device's background push
    /// waits a random 0 to CRL_SPREAD seconds, and at most one goes per device every CRL_EVERY (one waiting is sent
    /// when the window ends, plus its delay, naming the newest CRL).
    pub(super) fn nt_crl(&mut self, this_update: i64) {
        if !self.pu_on() {
            return;
        }
        let now = self.pu.mono();
        let devices: Vec<(String, String)> = self.push_tokens.iter().flat_map(|(p, d)| as_obj(Some(d)).into_iter().flatten().map(move |(device, _)| (p.clone(), device.clone()))).collect();
        for key in devices {
            let plan = self.pu.crl.entry(key).or_default();
            let start = plan.sent.map(|t| (t + CRL_EVERY).max(now)).unwrap_or(now);
            plan.due = Some(match plan.due {
                Some((at, _)) => (at, this_update),
                None => (start + spread(CRL_SPREAD), this_update),
            });
        }
    }

    /// The `crl` pushes whose time came: to a device still registered and not live for push (a live one heard the
    /// `crl` event).
    fn nt_crl_due(&mut self, mono: f64) {
        let ready: Vec<((String, String), i64)> = self.pu.crl.iter().filter_map(|(k, c)| c.due.filter(|(at, _)| *at <= mono).map(|(_, id)| (k.clone(), id))).collect();
        for ((to, device), id) in ready {
            if let Some(c) = self.pu.crl.get_mut(&(to.clone(), device.clone())) {
                c.due = None;
            }
            let Some(row) = as_obj(self.push_tokens.get(&to)).and_then(|d| as_obj(d.get(&device))).cloned() else { continue };
            if self.pu_live(&to, &device) {
                continue;
            }
            let inner = obj([
                ("v", Value::from(1)),
                ("k", Value::from("crl")),
                ("ts", Value::from((self.pu.now() * 1000.0) as i64)),
                ("from", Value::from("")),
                ("conv", Value::from("")),
                ("id", Value::from(id.to_string())),
            ]);
            if self.nt_push(&to, &device, &row, Channel::Background, inner, false) {
                self.pu.crl.entry((to, device)).or_default().sent = Some(mono);
            }
        }
    }

    // ── registrations ────────────────────────────────────────────────────────────────────────────────────────

    /// drop_serials: the registrations made with a revoked certificate go.
    pub(super) fn pu_drop_serials(&mut self, serials: &HashSet<String>) {
        let revoked = |e: &Value| e.get("serial").and_then(Value::as_str).map(|s| serials.contains(s)).unwrap_or(false);
        let affected: Vec<String> = self.push_tokens.iter().filter(|(_, d)| as_obj(Some(d)).map(|d| d.values().any(&revoked)).unwrap_or(false)).map(|(p, _)| p.clone()).collect();
        let before: Vec<_> = affected.iter().map(|p| self.pstate(p)).collect();
        let mut dropped = Vec::new();
        for (principal, devices) in self.push_tokens.iter_mut() {
            let Some(devices) = devices.as_object_mut() else { continue };
            devices.retain(|device, e| {
                let gone = e.get("serial").and_then(Value::as_str).map(|s| serials.contains(s)).unwrap_or(false);
                if gone {
                    dropped.push((principal.clone(), device.clone()));
                }
                !gone
            });
        }
        if dropped.is_empty() {
            return;
        }
        self.push_tokens.retain(|_, d| d.as_object().map(|o| !o.is_empty()).unwrap_or(false));
        self.dirty = true;
        for (principal, device) in dropped {
            log_info(&format!("push_drop principal={principal} device={} why=revoked", kv(&device)));
        }
        for (p, b) in affected.iter().zip(&before) {
            self.presence_changed(p, b);
        }
    }

    /// Forget one device's registration; true when there was one.
    fn pu_forget(&mut self, principal: &str, device: &str) -> bool {
        let Some(devices) = self.push_tokens.get_mut(principal).and_then(Value::as_object_mut) else { return false };
        let removed = devices.shift_remove(device).is_some();
        if devices.is_empty() {
            self.push_tokens.shift_remove(principal);
        }
        if removed {
            self.dirty = true;
        }
        removed
    }
}

impl Hub {
    /// _push_configure: relay.json `push` and `notify_previews`, once at start (enclave and the shape were checked when
    /// relay.json was read): the APNs sender when its keys are set, the FCM sender when `push.fcm` is set, each on its
    /// own. Anything wrong at run time turns that sender off with one line; the key's and the service account's paths
    /// and bytes are never logged.
    pub fn push_configure(self: &Arc<Self>, s: &m::Settings) {
        self.st.lock().pu.previews = s.notify_previews;
        if !s.push.enabled {
            return;
        }
        let previews = if s.notify_previews { "" } else { ", previews off" };
        if s.push.apns() {
            self.apns_configure(&s.push, previews);
        }
        if let Some(f) = &s.push.fcm {
            self.fcm_configure(f, previews);
        }
    }

    fn apns_configure(self: &Arc<Self>, p: &m::PushSettings, previews: &str) {
        let key = match apns::Key::load(&p.team_id, &p.key_id, &p.key_file) {
            Ok(k) => k,
            Err(why) => return log_warn(&format!("push off: {why}")),
        };
        let weak = Arc::downgrade(self);
        let gone: apns::OnGone = Arc::new(move |job: &apns::Job, why: &str| {
            if let Some(hub) = weak.upgrade() {
                hub.push_gone(&job.principal, &job.device, &job.token, why, job.voip);
            }
        });
        let started = apns::Endpoint::apple().and_then(|ep| apns::Sender::start(key, ep, gone));
        match started {
            Ok(sender) => {
                let mut st = self.st.lock();
                st.pu.sender = Some(sender);
                st.pu.sandbox = p.sandbox;
                st.pu.voip = p.voip;
                st.pu.topic = p.topic.clone();
                let kinds = if p.voip { "alert and voip" } else { "alert" };
                log_info(&format!("push on: {kinds}{previews} topic={} sandbox={}", p.topic, if p.sandbox { "yes" } else { "no" }));
            }
            Err(e) => log_warn(&format!("push off: {e}")),
        }
    }

    fn fcm_configure(self: &Arc<Self>, f: &m::FcmSettings, previews: &str) {
        let account = match fcm::Account::load(&f.credentials_file) {
            Ok(a) => a,
            Err(why) => return log_warn(&format!("push off for android: {why}")),
        };
        let weak = Arc::downgrade(self);
        let gone: fcm::OnGone = Arc::new(move |job: &fcm::Job, why: &str| {
            if let Some(hub) = weak.upgrade() {
                hub.push_gone(&job.principal, &job.device, &job.token, why, false);
            }
        });
        match fcm::Endpoint::google().and_then(|ep| fcm::Sender::start(account, ep, &f.project_id, gone)) {
            Ok(sender) => {
                self.st.lock().pu.fcm = Some(sender);
                log_info(&format!("push on: android{previews} project={}", f.project_id));
            }
            Err(e) => log_warn(&format!("push off for android: {e}")),
        }
    }

    /// push_register (`POST /v1/push/register {platform, token, env, seal, sk, voip_token, callkit}`, section 3.2 and
    /// revision "Android (FCM)"): this device's APNs or FCM token and seal key (one per device, replaced by a new one; a
    /// token another device registered moves here; a new seal key moves the old one to `seal_prev`). `platform` is
    /// `ios` (the default) or `android`; an Android device sends its FCM token, no `env` (ignored), no `voip_token` and
    /// `callkit` false or absent, and always a seal key. `{ok, key, voip}`: the person's push key (base64) and whether
    /// calls ring this device on the voip channel (PushKit on an iPhone; always on Android).
    pub fn push_register(&self, who: &Identity, body: &Obj) -> R<Obj> {
        let mut st = self.st.lock();
        if !st.pu_on() {
            return Err(E::Unavailable(PUSH_OFF.into()));
        }
        if !who.own_device() {
            return forbidden(m::FINISH_SETUP);
        }
        let android = match body.get("platform") {
            None | Some(Value::Null) => false,
            Some(Value::String(p)) if p == IOS || p == ANDROID => p == ANDROID,
            Some(_) => return bad(BAD_PLATFORM),
        };
        if (android && st.pu.fcm.is_none()) || (!android && st.pu.sender.is_none()) {
            return Err(E::Unavailable(PLATFORM_OFF.into()));
        }
        let (token, env) = if android {
            (fcm_token(body.get("token")).map_or_else(|| bad(BAD_FCM_TOKEN), Ok)?, String::new())
        } else {
            let token = token_of(body.get("token"))?;
            let env = match body.get("env") {
                Some(Value::String(e)) if ENVS.contains(&e.as_str()) => e.clone(),
                _ => return bad(BAD_ENV),
            };
            if env == "sandbox" && !st.pu.sandbox {
                return bad(NO_SANDBOX);
            }
            (token, env)
        };
        // MV-1: a pre-NT-1 app registers `{token, env}` only (PB-1): a legacy row, no seal, plain pushes
        let legacy = !android && !["seal", "sk", "voip_token", "callkit"].iter().any(|k| body.contains_key(*k));
        let (seal_b64, sk, voip_token, callkit) = if legacy {
            (String::new(), String::new(), String::new(), false)
        } else {
            let Some(seal) = body.get("seal").and_then(Value::as_str).and_then(pj::b64_strict).filter(|r| seal_point(r)) else { return bad(BAD_SEAL) };
            let sk = sk_of(&seal);
            if body.get("sk").and_then(Value::as_str) != Some(sk.as_str()) {
                return bad(BAD_SK);
            }
            if android {
                if !matches!(body.get("voip_token"), None | Some(Value::Null)) || !matches!(body.get("callkit"), None | Some(Value::Bool(false))) {
                    return bad(ANDROID_NO_VOIP);
                }
                (pj::b64(&seal), sk, String::new(), false)
            } else {
                let voip_token = match body.get("voip_token") {
                    None | Some(Value::Null) => String::new(),
                    v => match hex_token(v) {
                        Some(t) => t,
                        None => return bad(BAD_VOIP),
                    },
                };
                let Some(Value::Bool(callkit)) = body.get("callkit") else { return bad(BAD_CALLKIT) };
                (pj::b64(&seal), sk, voip_token, *callkit)
            }
        };
        // PH-1 section 5.4: the device takes phone calls (kept on its row only when true)
        let phone = match body.get("phone") {
            None | Some(Value::Null) => false,
            Some(Value::Bool(b)) => *b,
            Some(_) => return bad(BAD_PHONE),
        };
        // PR-1 1.4: whoever loses this token to the new registration, and the caller, may change presence
        let holds = |d: &Value| as_obj(Some(d)).map(|d| d.values().any(|e| e.get("token").and_then(Value::as_str) == Some(token.as_str()))).unwrap_or(false);
        let mut holders: Vec<String> = st.push_tokens.iter().filter(|(p, d)| **p != who.principal && holds(d)).map(|(p, _)| p.clone()).collect();
        holders.push(who.principal.clone());
        let before: Vec<_> = holders.iter().map(|p| st.pstate(p)).collect();
        let old = as_obj(st.push_tokens.get(&who.principal)).and_then(|d| as_obj(d.get(&who.device))).cloned();
        let (seal_prev, sk_prev) = match &old {
            _ if legacy => (String::new(), String::new()),
            Some(o) if pj::text_of(o, "seal") != seal_b64 => (pj::text_of(o, "seal"), pj::text_of(o, "sk")),
            Some(o) => (pj::text_of(o, "seal_prev"), pj::text_of(o, "sk_prev")),
            None => (String::new(), String::new()),
        };
        for devices in st.push_tokens.values_mut().filter_map(Value::as_object_mut) {
            devices.retain(|_, e| e.get("token").and_then(Value::as_str) != Some(token.as_str()));
        }
        st.push_tokens.retain(|_, d| d.as_object().map(|o| !o.is_empty()).unwrap_or(false));
        let voip = if callkit { voip_token } else { String::new() };
        let rings = android || (st.pu.voip && !voip.is_empty());
        let platform = if android { ANDROID } else { IOS };
        let mut entry = obj([
            ("token", Value::from(token)),
            ("env", Value::from(env.clone())),
            ("ts", Value::from((pj::now() * 1000.0) as i64)),
            ("serial", Value::from(m::serial(&who.serial))),
            ("seal", Value::from(seal_b64)),
            ("sk", Value::from(sk)),
            ("seal_prev", Value::from(seal_prev)),
            ("sk_prev", Value::from(sk_prev)),
            ("voip", Value::from(voip)),
            ("callkit", Value::Bool(callkit)),
            ("platform", Value::from(platform)),
        ]);
        if phone {
            entry.insert("phone".into(), Value::Bool(true));
        }
        let devices = st.push_tokens.entry(who.principal.clone()).or_insert_with(|| Value::Object(Obj::new()));
        if !devices.is_object() {
            *devices = Value::Object(Obj::new());
        }
        devices.as_object_mut().expect("a device map").insert(who.device.clone(), Value::Object(entry));
        st.dirty = true;
        for (p, b) in holders.iter().zip(&before) {
            st.presence_changed(p, b);
        }
        let key = st.pu_person_key(&who.principal);
        drop(st);
        self.wake();
        log_info(&format!("push_register principal={} device={} platform={platform} env={} voip={}", who.principal, kv(&who.device), kv(&env), if rings { "yes" } else { "no" }));
        Ok(obj([("ok", Value::Bool(true)), ("key", Value::from(pj::b64(&key))), ("voip", Value::Bool(rings))]))
    }

    /// AC-1 4.9 `meet/push`: registered devices `(alert, voip)` (counts only; never a token).
    pub fn push_device_counts(&self) -> (usize, usize) {
        let st = self.st.lock();
        let entries = st.push_tokens.values().filter_map(Value::as_object).flat_map(|d| d.values().filter_map(Value::as_object));
        entries.fold((0, 0), |(a, v), e| (a + 1, v + usize::from(e.get("voip").and_then(Value::as_str).map(|t| !t.is_empty()).unwrap_or(false))))
    }

    /// push_unregister (`POST /v1/push/unregister {}`): this device gets no more pushes. `{ok, removed}`.
    pub fn push_unregister(&self, who: &Identity) -> R<Obj> {
        let mut st = self.st.lock();
        if !st.pu_on() {
            return Err(E::Unavailable(PUSH_OFF.into()));
        }
        if !who.own_device() {
            return forbidden(m::FINISH_SETUP);
        }
        let before = st.pstate(&who.principal);
        let removed = st.pu_forget(&who.principal, &who.device);
        st.presence_changed(&who.principal, &before);
        drop(st);
        self.wake();
        if removed {
            log_info(&format!("push_unregister principal={} device={}", who.principal, kv(&who.device)));
        }
        Ok(obj([("ok", Value::Bool(true)), ("removed", Value::Bool(removed))]))
    }

    /// APNs said the token is no longer valid (410, or 400 BadDeviceToken), or FCM did (404 UNREGISTERED, or 400
    /// INVALID_ARGUMENT about the token): on an APNs VoIP request only the device's VoIP token goes, on any other
    /// request the whole registration, unless the device registered another one meanwhile.
    fn push_gone(&self, principal: &str, device: &str, token: &str, why: &str, voip: bool) {
        let mut st = self.st.lock();
        let field = if voip { "voip" } else { "token" };
        let same = as_obj(st.push_tokens.get(principal)).and_then(|d| as_obj(d.get(device))).map(|e| pj::text_of(e, field) == token).unwrap_or(false);
        if !same {
            return;
        }
        if voip {
            if let Some(row) = st.push_tokens.get_mut(principal).and_then(|d| d.get_mut(device)).and_then(Value::as_object_mut) {
                row.insert("voip".into(), Value::from(""));
            }
            st.dirty = true;
            drop(st);
            log_info(&format!("push_voip_dropped principal={principal} device={} why={why}", kv(device)));
        } else {
            let before = st.pstate(principal);
            if st.pu_forget(principal, device) {
                st.presence_changed(principal, &before);
                drop(st);
                self.wake();
                log_info(&format!("push_drop principal={principal} device={} why={why}", kv(device)));
            }
        }
    }

    /// The own-device rule of `/v1/invite/settle` and `/v1/notify/reads`: a seed, a service or a device without an
    /// id of its own gets 403 before any session check (the Python relay's order).
    pub fn nt_own_device(&self, who: &Identity) -> R<()> {
        if !who.own_device() || who.seed || who.is_service() {
            return forbidden(m::FINISH_SETUP);
        }
        Ok(())
    }

    /// `POST /v1/invite/settle {session, id, how}` (3.5): the caller's own device declines one of their own
    /// invitations. Another person's id, the inviter's and an unknown one all answer 404; a settled one answers its
    /// `how` and changes nothing. `{ok, how}`.
    pub fn invite_settle(&self, session: &str, who: &Identity, id: Body, how: Body) -> R<Obj> {
        self.nt_own_device(who)?;
        let id = id.and_then(Value::as_str).unwrap_or_default().to_string();
        let mut st = self.st.lock();
        let r = (|| -> R<(Obj, bool)> {
            st.session(session, who)?;
            if how.and_then(Value::as_str) != Some("declined") {
                return bad(SETTLE_HOW);
            }
            let found = st.invites.get(&who.principal).and_then(|l| l.iter().find(|i| !id.is_empty() && pj::text_of(i, "id") == id)).map(|i| i.get("settled").and_then(Value::as_str).map(str::to_string));
            match found {
                None => Err(E::NotFound(SETTLE_NONE.into())),
                Some(Some(how)) => Ok((obj([("ok", Value::Bool(true)), ("how", Value::from(how))]), false)),
                Some(None) => {
                    let now = st.pu.now();
                    st.nt_settle(&who.principal, &id, "declined", &who.device, now);
                    Ok((obj([("ok", Value::Bool(true)), ("how", Value::from("declined"))]), true))
                }
            }
        })();
        drop(st);
        let (out, changed) = r?;
        if changed {
            self.wake();
        }
        Ok(out)
    }

    /// `GET /v1/notify/reads` (section 4.3, the iPhone's background refresh, no session): the caller's read marks
    /// `{reads: {"dm:<other>": ts, "channel:<id>": ts}}` (seconds). Own device only.
    pub fn notify_reads(&self, who: &Identity) -> R<Obj> {
        self.nt_own_device(who)?;
        let st = self.st.lock();
        let mut reads = Obj::new();
        for (other, ts) in as_obj(st.read.get(&who.principal)).into_iter().flatten() {
            reads.insert(format!("dm:{other}"), ts.clone());
        }
        for (cid, ts) in as_obj(st.channel_read.get(&who.principal)).into_iter().flatten() {
            reads.insert(format!("channel:{cid}"), ts.clone());
        }
        // PH-1 revision 2: text threads, `sms:<number>`
        reads.extend(st.sms_reads(&who.principal));
        Ok(obj([("reads", Value::Object(reads))]))
    }

    /// The NT-1 timer (the upkeep thread, every second): ring timeouts, the delayed `missed` and `crl` pushes.
    pub fn push_tick(&self) {
        let told = self.st.lock().nt_tick();
        if told {
            self.wake();
        }
    }
}

/// The APNs sender: HTTP/2 over rustls to api.push.apple.com or api.sandbox.push.apple.com (the token's registered
/// env picks), one connection per host kept open, authenticated by an ES256 JWT (`kid`; `iss`, `iat`) re-signed every
/// 50 minutes. Jobs queue to its own thread; the hub never waits on Apple.
pub mod apns {
    use crate::meet::log_warn;
    use crate::meet_json::{self as pj, obj};
    use aws_lc_rs::rand::SystemRandom;
    use aws_lc_rs::signature::{EcdsaKeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
    use bytes::Bytes;
    use http_body_util::{BodyExt, Full};
    use hyper::client::conn::http2::SendRequest;
    use hyper_util::rt::{TokioExecutor, TokioIo};
    use rustls::pki_types::ServerName;
    use rustls::ClientConfig;
    use serde_json::Value;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    pub const PRODUCTION: &str = "api.push.apple.com";
    pub const SANDBOX: &str = "api.sandbox.push.apple.com";
    /// Pushes waiting for the sender; past it a push is dropped (and logged).
    const QUEUE: usize = 1000;
    /// Connecting, the TLS handshake and one request each.
    const TIMEOUT: Duration = Duration::from_secs(10);
    /// The largest answer read from Apple, Google's token endpoint or FCM (small JSON documents); past it the call fails.
    pub const ANSWER_MAX: usize = 64 * 1024;
    /// Apple refuses a provider token older than an hour and one renewed more often than every 20 minutes.
    pub const JWT_EVERY: Duration = Duration::from_secs(50 * 60);

    /// One push for the sender thread: the device token, the headers the hub chose (push type, topic, priority,
    /// expiration, collapse id) and the payload.
    pub struct Job {
        pub principal: String,
        pub device: String,
        pub token: String,
        pub sandbox: bool,
        /// A VoIP request: APNs saying the token is gone clears only the device's VoIP token.
        pub voip: bool,
        /// The kind (for the log lines only).
        pub kind: String,
        pub headers: Vec<(&'static str, String)>,
        pub payload: Vec<u8>,
    }

    /// Called with the job and why when APNs says its token is no longer valid.
    pub type OnGone = Arc<dyn Fn(&Job, &str) + Send + Sync>;

    /// The provider key (.p8, PKCS#8 P-256) and the JWT made with it.
    pub struct Key {
        team_id: String,
        key_id: String,
        pair: EcdsaKeyPair,
        jwt: parking_lot::Mutex<Option<(String, Instant)>>,
    }

    impl Key {
        /// Read the key file: refused when it cannot be read, when group or others may read it (POSIX), or when it is
        /// not a P-256 private key. The reasons never name the file or show its bytes.
        pub fn load(team_id: &str, key_id: &str, path: &str) -> Result<Key, String> {
            let data = std::fs::read(path).map_err(|_| "key_file cannot be read".to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = std::fs::metadata(path).map_err(|_| "key_file cannot be read".to_string())?.permissions().mode();
                if mode & 0o077 != 0 {
                    return Err("key_file must be readable by the relay only (mode 600)".into());
                }
            }
            Key::from_pem(team_id, key_id, &data)
        }

        pub fn from_pem(team_id: &str, key_id: &str, pem: &[u8]) -> Result<Key, String> {
            let not_p256 = || "key_file is not a P-256 private key".to_string();
            let der = match rustls_pemfile::private_key(&mut &pem[..]) {
                Ok(Some(rustls::pki_types::PrivateKeyDer::Pkcs8(k))) => k,
                _ => return Err(not_p256()),
            };
            let pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, der.secret_pkcs8_der()).map_err(|_| not_p256())?;
            Ok(Key { team_id: team_id.to_string(), key_id: key_id.to_string(), pair, jwt: parking_lot::Mutex::new(None) })
        }

        /// The provider token: the one made less than JWT_EVERY ago, else a new one.
        pub fn token(&self) -> Result<String, String> {
            let mut held = self.jwt.lock();
            if let Some((t, at)) = held.as_ref() {
                if at.elapsed() < JWT_EVERY {
                    return Ok(t.clone());
                }
            }
            let t = self.sign(pj::now() as i64)?;
            *held = Some((t.clone(), Instant::now()));
            Ok(t)
        }

        /// Apple refused the token (expired or invalid): the next push makes a new one.
        pub fn forget(&self) {
            *self.jwt.lock() = None;
        }

        /// An ES256 JWT: header `{alg, kid}`, claims `{iss, iat}`, signature R || S (64 bytes), all base64url.
        pub fn sign(&self, iat: i64) -> Result<String, String> {
            let header = obj([("alg", Value::from("ES256")), ("kid", Value::from(self.key_id.clone()))]);
            let claims = obj([("iss", Value::from(self.team_id.clone())), ("iat", Value::from(iat))]);
            let input = format!("{}.{}", crate::codec::b64u(pj::dumps_compact(&Value::Object(header)).as_bytes()), crate::codec::b64u(pj::dumps_compact(&Value::Object(claims)).as_bytes()));
            let sig = self.pair.sign(&SystemRandom::new(), input.as_bytes()).map_err(|_| "cannot sign the provider token".to_string())?;
            Ok(format!("{input}.{}", crate::codec::b64u(sig.as_ref())))
        }
    }

    /// Where pushes go: the TLS client (webpki roots, ALPN h2) and the production and sandbox hosts.
    pub struct Endpoint {
        tls: Arc<ClientConfig>,
        production: (String, u16),
        sandbox: (String, u16),
    }

    impl Endpoint {
        pub fn apple() -> Result<Endpoint, String> {
            Endpoint::new(None, (PRODUCTION.into(), 443), (SANDBOX.into(), 443))
        }

        /// `ca`: a PEM file of the roots to trust instead of the webpki set.
        pub fn new(ca: Option<&str>, production: (String, u16), sandbox: (String, u16)) -> Result<Endpoint, String> {
            let mut cfg = (*crate::meet_tls::client_config(ca, None)?).clone();
            cfg.alpn_protocols = vec![b"h2".to_vec()];
            Ok(Endpoint { tls: Arc::new(cfg), production, sandbox })
        }

        fn host(&self, sandbox: bool) -> &(String, u16) {
            if sandbox {
                &self.sandbox
            } else {
                &self.production
            }
        }

        fn authority(&self, sandbox: bool) -> String {
            match self.host(sandbox) {
                (h, 443) => h.clone(),
                (h, p) => format!("{h}:{p}"),
            }
        }
    }

    /// The handle the hub keeps: jobs go to the sender thread without waiting.
    pub struct Sender {
        tx: tokio::sync::mpsc::Sender<Job>,
    }

    impl Sender {
        pub fn start(key: Key, ep: Endpoint, gone: OnGone) -> Result<Sender, String> {
            let (tx, rx) = tokio::sync::mpsc::channel(QUEUE);
            let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?;
            let ctx = Arc::new(Ctx { key, ep, gone });
            std::thread::Builder::new().name("relay-push".into()).spawn(move || runtime.block_on(run(ctx, rx))).map_err(|e| e.to_string())?;
            Ok(Sender { tx })
        }

        /// A sender whose jobs land in the receiver (tests of the send rules).
        #[cfg(test)]
        pub fn capture() -> (Sender, tokio::sync::mpsc::Receiver<Job>) {
            let (tx, rx) = tokio::sync::mpsc::channel(QUEUE);
            (Sender { tx }, rx)
        }

        /// Queue one push; false when the queue is full.
        pub fn send(&self, job: Job) -> bool {
            self.tx.try_send(job).is_ok()
        }
    }

    struct Ctx {
        key: Key,
        ep: Endpoint,
        gone: OnGone,
    }

    pub(super) type Conn = SendRequest<Full<Bytes>>;

    async fn run(ctx: Arc<Ctx>, mut rx: tokio::sync::mpsc::Receiver<Job>) {
        let mut conns: [Option<Conn>; 2] = [None, None];
        while let Some(job) = rx.recv().await {
            let i = usize::from(job.sandbox);
            if conns[i].as_ref().map(|c| c.is_closed()).unwrap_or(true) {
                conns[i] = match connect(&ctx.ep, job.sandbox).await {
                    Ok(c) => Some(c),
                    Err(e) => {
                        log_warn(&format!("push failed principal={} device={} kind={} why={}", job.principal, crate::meet::kv(&job.device), job.kind, crate::meet::kv(&e)));
                        continue;
                    }
                };
            }
            let Some(conn) = conns[i].clone() else { continue };
            tokio::spawn(deliver(ctx.clone(), conn, job));
        }
    }

    async fn connect(ep: &Endpoint, sandbox: bool) -> Result<Conn, String> {
        dial(&ep.tls, ep.host(sandbox)).await
    }

    /// One HTTP/2 connection over TLS (ALPN h2) to `host`; connecting and the TLS handshake each within TIMEOUT (the
    /// FCM sender's too).
    pub(super) async fn dial(tls: &Arc<ClientConfig>, host: &(String, u16)) -> Result<Conn, String> {
        let (host, port) = host.clone();
        let tcp = tokio::time::timeout(TIMEOUT, tokio::net::TcpStream::connect((host.as_str(), port))).await.map_err(|_| "connect timed out".to_string())?.map_err(|e| e.to_string())?;
        let name = ServerName::try_from(host).map_err(|e| e.to_string())?;
        let tls = tokio::time::timeout(TIMEOUT, tokio_rustls::TlsConnector::from(tls.clone()).connect(name, tcp)).await.map_err(|_| "TLS handshake timed out".to_string())?.map_err(|e| e.to_string())?;
        let (send, conn) = hyper::client::conn::http2::Builder::new(TokioExecutor::new()).handshake(TokioIo::new(tls)).await.map_err(|e| e.to_string())?;
        tokio::spawn(async move {
            let _ = conn.await;
        });
        Ok(send)
    }

    /// What APNs answered: delivered, the token is gone (410, 400 BadDeviceToken), or another failure.
    #[derive(Debug, PartialEq)]
    pub enum Outcome {
        Sent,
        Gone(String),
        Failed(String),
    }

    /// Read APNs' answer (status and its `{reason}`).
    pub fn outcome(status: u16, body: &[u8]) -> Outcome {
        let reason = serde_json::from_slice::<Value>(body).ok().and_then(|v| v.get("reason").and_then(Value::as_str).map(str::to_string)).unwrap_or_default();
        match (status, reason.as_str()) {
            (200, _) => Outcome::Sent,
            (410, _) => Outcome::Gone("410".into()),
            (400, "BadDeviceToken") => Outcome::Gone("BadDeviceToken".into()),
            _ => Outcome::Failed(format!("{status} {reason}").trim().to_string()),
        }
    }

    /// An answer's body, at most ANSWER_MAX bytes: a larger one fails while it is read, never held whole.
    pub async fn answer_body<B>(body: B) -> Result<Bytes, String>
    where
        B: hyper::body::Body<Data = Bytes>,
        B::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
    {
        Ok(http_body_util::Limited::new(body, ANSWER_MAX).collect().await.map_err(|e| e.to_string())?.to_bytes())
    }

    /// AC-1 4.9 `meet/push`: pushes sent and failed (by reason) in the last 24 hours, kept in memory.
    static OUTCOMES: std::sync::Mutex<std::collections::VecDeque<(f64, Option<String>)>> = std::sync::Mutex::new(std::collections::VecDeque::new());
    const OUTCOMES_KEEP: usize = 100_000;
    const DAY: f64 = 86_400.0;

    /// One push's outcome: None sent, Some(reason) failed (the reason cut to 40 characters, never a token).
    pub fn note(failed: Option<&str>) {
        let now = crate::meet_json::now();
        let Ok(mut q) = OUTCOMES.lock() else { return };
        while q.front().map(|(t, _)| now - t > DAY).unwrap_or(false) || q.len() >= OUTCOMES_KEEP {
            q.pop_front();
        }
        q.push_back((now, failed.map(|r| r.chars().take(40).collect())));
    }

    /// `(sent24h, failed24h by reason)`.
    pub fn counts() -> (u64, std::collections::BTreeMap<String, u64>) {
        let now = crate::meet_json::now();
        let mut sent = 0;
        let mut failed = std::collections::BTreeMap::new();
        if let Ok(q) = OUTCOMES.lock() {
            for (_, why) in q.iter().filter(|(t, _)| now - t <= DAY) {
                match why {
                    None => sent += 1,
                    Some(r) => *failed.entry(r.clone()).or_insert(0) += 1,
                }
            }
        }
        (sent, failed)
    }

    async fn deliver(ctx: Arc<Ctx>, mut conn: Conn, job: Job) {
        let failed = |why: &str| {
            note(Some(if why.starts_with(|c: char| c.is_ascii_digit()) { why } else { "unreachable" }));
            log_warn(&format!("push failed principal={} device={} kind={} why={}", job.principal, crate::meet::kv(&job.device), job.kind, crate::meet::kv(why)))
        };
        let jwt = match ctx.key.token() {
            Ok(t) => t,
            Err(e) => return failed(&e),
        };
        let mut req = hyper::Request::builder().method("POST").uri(format!("https://{}/3/device/{}", ctx.ep.authority(job.sandbox), job.token)).header("authorization", format!("bearer {jwt}"));
        for (name, value) in &job.headers {
            req = req.header(*name, value.as_str());
        }
        let req = match req.header("content-type", "application/json").body(Full::new(Bytes::from(job.payload.clone()))) {
            Ok(r) => r,
            Err(e) => return failed(&e.to_string()),
        };
        let work = async {
            conn.ready().await.map_err(|e| e.to_string())?;
            let res = conn.send_request(req).await.map_err(|e| e.to_string())?;
            let status = res.status().as_u16();
            let body = answer_body(res.into_body()).await?;
            Ok::<_, String>((status, body))
        };
        let answer = tokio::time::timeout(TIMEOUT, work).await.unwrap_or_else(|_| Err("timed out".to_string()));
        match answer.map(|(status, body)| outcome(status, &body)) {
            Ok(Outcome::Sent) => note(None),
            Ok(Outcome::Gone(why)) => {
                note(Some(&why));
                (ctx.gone)(&job, &why)
            }
            Ok(Outcome::Failed(why)) => {
                if why.contains("ExpiredProviderToken") || why.contains("InvalidProviderToken") {
                    ctx.key.forget();
                }
                failed(&why);
            }
            Err(e) => failed(&e),
        }
    }
}

/// The FCM sender (NT-1 revision "Android (FCM)"): HTTP/2 over rustls to fcm.googleapis.com, the HTTP v1 API
/// (`POST /v1/projects/<project_id>/messages:send`), authorized by an OAuth 2.0 access token that the service account
/// gets from oauth2.googleapis.com with an RS256 assertion signed on AWS-LC, kept until RENEW_BEFORE before it
/// expires. Jobs queue to its own thread, as the APNs sender's do; the hub never waits on Google. FCM saying the token
/// is gone (404 UNREGISTERED, 400 INVALID_ARGUMENT about the token) drops the registration; anything else (429, 5xx)
/// is logged and the push dropped, as APNs failures are.
pub mod fcm {
    use super::apns::{answer_body, dial, note, Conn, Outcome};
    use crate::meet::log_warn;
    use crate::meet_json::{self as pj, obj};
    use aws_lc_rs::rand::SystemRandom;
    use aws_lc_rs::signature::{RsaKeyPair, RSA_PKCS1_SHA256};
    use bytes::Bytes;
    use http_body_util::Full;
    use rustls::ClientConfig;
    use serde_json::Value;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    pub const SEND_HOST: &str = "fcm.googleapis.com";
    pub const TOKEN_HOST: &str = "oauth2.googleapis.com";
    /// The assertion's audience: Google's token endpoint.
    pub const AUDIENCE: &str = "https://oauth2.googleapis.com/token";
    pub const SCOPE: &str = "https://www.googleapis.com/auth/firebase.messaging";
    /// `grant_type`, form encoded.
    const GRANT: &str = "urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer";
    /// Pushes waiting for the sender; past it a push is dropped (and logged).
    const QUEUE: usize = 1000;
    /// Connecting, the TLS handshake and one request each.
    const TIMEOUT: Duration = Duration::from_secs(10);
    /// The assertion's lifetime (Google takes at most an hour).
    const ASSERTION_SECONDS: i64 = 3600;
    /// An access token is used until this long before it expires.
    pub const RENEW_BEFORE: Duration = Duration::from_secs(5 * 60);
    /// The longest access token lifetime kept, whatever `expires_in` says (Google's tokens last an hour).
    const TOKEN_SECONDS_MAX: u64 = 3600;
    /// FCM's limit on a message's data: its keys and values, in bytes.
    pub const DATA_LIMIT: usize = 4096;

    /// One push for the sender thread: the device's FCM token and the request body the hub built.
    pub struct Job {
        pub principal: String,
        pub device: String,
        pub token: String,
        /// The kind (for the log lines only).
        pub kind: String,
        pub body: Vec<u8>,
    }

    /// Called with the job and why when FCM says its token is no longer valid.
    pub type OnGone = Arc<dyn Fn(&Job, &str) + Send + Sync>;

    /// The service account (its email and RSA key) and the access token it was given.
    pub struct Account {
        email: String,
        pair: RsaKeyPair,
        access: parking_lot::Mutex<Option<(String, Instant)>>,
    }

    impl Account {
        /// Read the service account key file: refused when it cannot be read, when group or others may read it
        /// (POSIX), or when it is not a service account key. The reasons never name the file or show its bytes.
        pub fn load(path: &str) -> Result<Account, String> {
            let data = std::fs::read(path).map_err(|_| "credentials_file cannot be read".to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = std::fs::metadata(path).map_err(|_| "credentials_file cannot be read".to_string())?.permissions().mode();
                if mode & 0o077 != 0 {
                    return Err("credentials_file must be readable by the relay only (mode 600)".into());
                }
            }
            Account::from_json(&data)
        }

        /// A service account key (JSON): `client_email` and `private_key` (PEM, PKCS#8 RSA).
        pub fn from_json(data: &[u8]) -> Result<Account, String> {
            let not_account = || "credentials_file is not a service account key (client_email, private_key)".to_string();
            let v: Value = serde_json::from_slice(data).map_err(|_| not_account())?;
            let email = v.get("client_email").and_then(Value::as_str).filter(|e| !e.is_empty()).ok_or_else(not_account)?;
            let pem = v.get("private_key").and_then(Value::as_str).ok_or_else(not_account)?;
            let pair = match rustls_pemfile::private_key(&mut pem.as_bytes()) {
                Ok(Some(rustls::pki_types::PrivateKeyDer::Pkcs8(k))) => RsaKeyPair::from_pkcs8(k.secret_pkcs8_der()).map_err(|_| not_account())?,
                _ => return Err(not_account()),
            };
            Ok(Account { email: email.to_string(), pair, access: parking_lot::Mutex::new(None) })
        }

        /// The RS256 assertion: header `{alg, typ}`, claims `{iss, scope, aud, iat, exp}` (an hour), signature
        /// RSASSA-PKCS1-v1_5 with SHA-256, all base64url.
        pub fn assertion(&self, iat: i64) -> Result<String, String> {
            let header = obj([("alg", Value::from("RS256")), ("typ", Value::from("JWT"))]);
            let claims = obj([("iss", Value::from(self.email.clone())), ("scope", Value::from(SCOPE)), ("aud", Value::from(AUDIENCE)), ("iat", Value::from(iat)), ("exp", Value::from(iat + ASSERTION_SECONDS))]);
            let input = format!("{}.{}", crate::codec::b64u(pj::dumps_compact(&Value::Object(header)).as_bytes()), crate::codec::b64u(pj::dumps_compact(&Value::Object(claims)).as_bytes()));
            let mut sig = vec![0u8; self.pair.public_modulus_len()];
            self.pair.sign(&RSA_PKCS1_SHA256, &SystemRandom::new(), input.as_bytes(), &mut sig).map_err(|_| "cannot sign the FCM assertion".to_string())?;
            Ok(format!("{input}.{}", crate::codec::b64u(&sig)))
        }

        /// The access token kept, while it is good for more than RENEW_BEFORE.
        pub fn cached(&self) -> Option<String> {
            self.access.lock().as_ref().filter(|(_, until)| Instant::now() < *until).map(|(t, _)| t.clone())
        }

        /// Keep an access token Google gave for `expires_in` seconds (at most TOKEN_SECONDS_MAX: the token endpoint's
        /// number is never trusted past it), until RENEW_BEFORE before it expires.
        pub fn keep(&self, token: &str, expires_in: u64) {
            let life = Duration::from_secs(expires_in.min(TOKEN_SECONDS_MAX)).saturating_sub(RENEW_BEFORE);
            *self.access.lock() = Instant::now().checked_add(life).map(|until| (token.to_string(), until));
        }

        /// FCM refused the access token: the next push gets a new one.
        pub fn forget(&self) {
            *self.access.lock() = None;
        }
    }

    /// Where pushes and token requests go: the TLS client (webpki roots, ALPN h2), the FCM host and the token host.
    pub struct Endpoint {
        tls: Arc<ClientConfig>,
        send: (String, u16),
        token: (String, u16),
    }

    impl Endpoint {
        pub fn google() -> Result<Endpoint, String> {
            Endpoint::new(None, (SEND_HOST.into(), 443), (TOKEN_HOST.into(), 443))
        }

        /// `ca`: a PEM file of the roots to trust instead of the webpki set.
        pub fn new(ca: Option<&str>, send: (String, u16), token: (String, u16)) -> Result<Endpoint, String> {
            let mut cfg = (*crate::meet_tls::client_config(ca, None)?).clone();
            cfg.alpn_protocols = vec![b"h2".to_vec()];
            Ok(Endpoint { tls: Arc::new(cfg), send, token })
        }
    }

    fn authority(host: &(String, u16)) -> String {
        match host {
            (h, 443) => h.clone(),
            (h, p) => format!("{h}:{p}"),
        }
    }

    /// The handle the hub keeps: jobs go to the sender thread without waiting.
    pub struct Sender {
        tx: tokio::sync::mpsc::Sender<Job>,
    }

    impl Sender {
        pub fn start(account: Account, ep: Endpoint, project_id: &str, gone: OnGone) -> Result<Sender, String> {
            let (tx, rx) = tokio::sync::mpsc::channel(QUEUE);
            let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?;
            let ctx = Arc::new(Ctx { account, ep, path: format!("/v1/projects/{project_id}/messages:send"), gone });
            std::thread::Builder::new().name("relay-fcm".into()).spawn(move || runtime.block_on(run(ctx, rx))).map_err(|e| e.to_string())?;
            Ok(Sender { tx })
        }

        /// A sender whose jobs land in the receiver (tests of the send rules).
        #[cfg(test)]
        pub fn capture() -> (Sender, tokio::sync::mpsc::Receiver<Job>) {
            let (tx, rx) = tokio::sync::mpsc::channel(QUEUE);
            (Sender { tx }, rx)
        }

        /// Queue one push; false when the queue is full.
        pub fn send(&self, job: Job) -> bool {
            self.tx.try_send(job).is_ok()
        }
    }

    struct Ctx {
        account: Account,
        ep: Endpoint,
        path: String,
        gone: OnGone,
    }

    /// One push that did not go: counted (`fcm-token` when no access token could be had) and logged.
    fn failed(job: &Job, why: &str, counted: &str) {
        note(Some(counted));
        log_warn(&format!("push failed principal={} device={} kind={} why={}", job.principal, crate::meet::kv(&job.device), job.kind, crate::meet::kv(why)));
    }

    /// The jobs in order: the access token (kept, else fetched here, so one fetch serves every push waiting), then
    /// each push on the one FCM connection.
    async fn run(ctx: Arc<Ctx>, mut rx: tokio::sync::mpsc::Receiver<Job>) {
        let mut conn: Option<Conn> = None;
        while let Some(job) = rx.recv().await {
            let bearer = match access(&ctx).await {
                Ok(t) => t,
                Err(e) => {
                    failed(&job, &e, "fcm-token");
                    continue;
                }
            };
            if conn.as_ref().map(|c| c.is_closed()).unwrap_or(true) {
                conn = match dial(&ctx.ep.tls, &ctx.ep.send).await {
                    Ok(c) => Some(c),
                    Err(e) => {
                        failed(&job, &e, "unreachable");
                        continue;
                    }
                };
            }
            let Some(c) = conn.clone() else { continue };
            tokio::spawn(deliver(ctx.clone(), c, job, bearer));
        }
    }

    /// One POST on `conn` within TIMEOUT: the status and the body.
    async fn post(mut conn: Conn, uri: String, bearer: Option<&str>, content_type: &str, body: Vec<u8>) -> Result<(u16, Bytes), String> {
        let mut req = hyper::Request::builder().method("POST").uri(uri).header("content-type", content_type);
        if let Some(b) = bearer {
            req = req.header("authorization", format!("Bearer {b}"));
        }
        let req = req.body(Full::new(Bytes::from(body))).map_err(|e| e.to_string())?;
        let work = async {
            conn.ready().await.map_err(|e| e.to_string())?;
            let res = conn.send_request(req).await.map_err(|e| e.to_string())?;
            let status = res.status().as_u16();
            let body = answer_body(res.into_body()).await?;
            Ok::<_, String>((status, body))
        };
        tokio::time::timeout(TIMEOUT, work).await.unwrap_or_else(|_| Err("timed out".to_string()))
    }

    /// The access token: the one kept, else a new one for the assertion from Google's token endpoint (`{access_token,
    /// expires_in}`), kept until RENEW_BEFORE before it expires.
    async fn access(ctx: &Ctx) -> Result<String, String> {
        if let Some(t) = ctx.account.cached() {
            return Ok(t);
        }
        let form = format!("grant_type={GRANT}&assertion={}", ctx.account.assertion(pj::now() as i64)?);
        let conn = dial(&ctx.ep.tls, &ctx.ep.token).await?;
        let (status, body) = post(conn, format!("https://{}/token", authority(&ctx.ep.token)), None, "application/x-www-form-urlencoded", form.into_bytes()).await?;
        let answer: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        if status != 200 {
            return Err(format!("token {status} {}", answer["error"].as_str().unwrap_or_default()).trim().to_string());
        }
        let token = answer["access_token"].as_str().filter(|t| !t.is_empty()).ok_or("the token answer has no access_token")?;
        ctx.account.keep(token, answer["expires_in"].as_u64().unwrap_or(0));
        Ok(token.to_string())
    }

    /// Read FCM's answer: 200 sent; 404 UNREGISTERED, or 400 INVALID_ARGUMENT about the registration token, gone;
    /// anything else failed (`<status> <errorCode, else status>`).
    pub fn outcome(status: u16, body: &[u8]) -> Outcome {
        if status == 200 {
            return Outcome::Sent;
        }
        let v: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
        let error = &v["error"];
        let details = error["details"].as_array().map(Vec::as_slice).unwrap_or_default();
        let code = details.iter().find_map(|d| d["errorCode"].as_str()).or_else(|| error["status"].as_str()).unwrap_or_default();
        let about_token = details.iter().flat_map(|d| d["fieldViolations"].as_array().into_iter().flatten()).any(|f| f["field"].as_str() == Some("message.token"))
            || error["message"].as_str().is_some_and(|m| m.contains("registration token"));
        match (status, code) {
            (404, "UNREGISTERED") => Outcome::Gone("UNREGISTERED".into()),
            (400, "INVALID_ARGUMENT") if about_token => Outcome::Gone("INVALID_ARGUMENT".into()),
            _ => Outcome::Failed(format!("{status} {code}").trim().to_string()),
        }
    }

    async fn deliver(ctx: Arc<Ctx>, conn: Conn, job: Job, bearer: String) {
        let uri = format!("https://{}{}", authority(&ctx.ep.send), ctx.path);
        match post(conn, uri, Some(&bearer), "application/json", job.body.clone()).await.map(|(status, body)| outcome(status, &body)) {
            Ok(Outcome::Sent) => note(None),
            Ok(Outcome::Gone(why)) => {
                note(Some(&why));
                (ctx.gone)(&job, &why)
            }
            Ok(Outcome::Failed(why)) => {
                if why.starts_with("401") {
                    ctx.account.forget();
                }
                failed(&job, &why, &why);
            }
            Err(e) => failed(&job, &e, "unreachable"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::apns::{Endpoint, Job, Key, Outcome, Sender};
    use super::*;
    use aws_lc_rs::encoding::{AsDer, Pkcs8V1Der};
    use aws_lc_rs::rand::SystemRandom;
    use aws_lc_rs::rsa::KeySize;
    use aws_lc_rs::signature::{EcdsaKeyPair, KeyPair, RsaKeyPair, UnparsedPublicKey, ECDSA_P256_SHA256_ASN1_SIGNING, ECDSA_P256_SHA256_FIXED, ECDSA_P256_SHA256_FIXED_SIGNING, ECDSA_P384_SHA384_FIXED_SIGNING, RSA_PKCS1_2048_8192_SHA256};
    use serde_json::json;
    use tokio::sync::mpsc::Receiver;

    /// The shared vectors (tests/vectors in the Meeting Hub, copied next to this crate's other vectors).
    const SEALS: &str = include_str!("../tests/push_seal_v1.json");
    const WORDS: &str = include_str!("../tests/notify_words_v1.json");
    const PREVIEWS: &str = include_str!("../tests/notify_preview_v1.json");

    const TOKEN: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
    const VOIP: &str = "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";
    const IPHONE: &str = "bbbbbbbbbbbbbbbb";
    const TOPIC: &str = "com.lucid.LucidMeet";
    /// An FCM registration token shaped as Firebase makes them, and an Android device.
    const FCM: &str = "dGVzdC1kZXZpY2UtdG9rZW4:APA91bH-sl_0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRS";
    const PIXEL: &str = "9999999999999999";
    const PROJECT: &str = "lucid-meet-5c92c";
    const EMAIL: &str = "lucid-relay@lucid-meet-5c92c.iam.gserviceaccount.com";

    fn who(p: &str, device: &str) -> Identity {
        Identity { principal: p.into(), name: p.to_uppercase(), device: device.into(), serial: "1A".into(), ..Default::default() }
    }

    fn hub() -> Hub {
        Hub::new(None, &[], 168.0, 30.0, 365.0, None, Arc::new(LinkStats::new()))
    }

    /// A hub with push on (VoIP too), its pushes caught.
    fn hub_on() -> (Hub, Receiver<Job>) {
        let h = hub();
        let (sender, rx) = Sender::capture();
        {
            let mut st = h.st.lock();
            st.pu.sender = Some(sender);
            st.pu.voip = true;
            st.pu.topic = TOPIC.into();
        }
        (h, rx)
    }

    fn session(h: &Hub, w: &Identity) -> String {
        h.hello(w, "", &Obj::new()).unwrap()["session"].as_str().unwrap().to_string()
    }

    fn error<T: std::fmt::Debug>(r: R<T>) -> String {
        let e = r.unwrap_err();
        let code = match &e {
            E::Bad(_) => 400,
            E::Forbidden(_) => 403,
            E::NotFound(_) => 404,
            E::Unavailable(_) => 501,
            _ => 0,
        };
        format!("{code} {}", e.message())
    }

    fn row(v: Value) -> Obj {
        v.as_object().unwrap().clone()
    }

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    fn channel_of(name: &str) -> Channel {
        match name {
            "voip" => Channel::Voip,
            "background" => Channel::Background,
            _ => Channel::Alert,
        }
    }

    /// A device's seal key: the private key, its base64 public key and `sk`.
    fn seal_key_pair() -> (agreement::PrivateKey, String, String) {
        let k = agreement::PrivateKey::generate(&agreement::ECDH_P256).unwrap();
        let raw = k.compute_public_key().unwrap().as_ref().to_vec();
        let sk = sk_of(&raw);
        (k, pj::b64(&raw), sk)
    }

    /// What the iPhone does with a push (4.2 rule 1, 4.4 step 1; make_push_seal_v1.open_push): the inner, or why it
    /// is refused.
    #[allow(clippy::too_many_arguments)]
    fn open(keys: &[(String, &agreement::PrivateKey)], person: &[u8], channel: Channel, category: &str, payload: &Value, seen: &mut HashSet<String>, now_ms: i64, device: &str) -> Result<Value, &'static str> {
        let text = |k: &str| payload.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
        let (sk, s, o) = (text("sk"), text("s"), text("o"));
        let Some((_, mine)) = keys.iter().find(|(k, _)| *k == sk) else { return Err("unknown_key") };
        if origin(person, channel, &sk, &s) != o {
            return Err("bad_origin");
        }
        let raw = pj::b64_strict(&s).ok_or("bad_seal")?;
        if raw.len() < 65 + 12 + 16 {
            return Err("bad_seal");
        }
        let (eph, nonce, ct) = (&raw[..65], &raw[65..77], &raw[77..]);
        let me = mine.compute_public_key().map_err(|_| "bad_seal")?.as_ref().to_vec();
        let info = seal_info(channel, device, &sk, eph, &me);
        let z = agreement::agree(mine, agreement::UnparsedPublicKey::new(&agreement::ECDH_P256, eph), "bad_seal", |z| Ok(z.to_vec()))?;
        let k = seal_key(&z, &info).map_err(|_| "bad_seal")?;
        let key = aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM, &k).map_err(|_| "bad_seal")?);
        let mut n = [0u8; 12];
        n.copy_from_slice(nonce);
        let mut buf = ct.to_vec();
        let padded = key.open_in_place(aead::Nonce::assume_unique_for_key(n), aead::Aad::from(info.as_slice()), &mut buf).map_err(|_| "bad_seal")?;
        if padded.len() != channel.size() {
            return Err("bad_seal");
        }
        let end = padded.iter().rposition(|b| *b != 0).ok_or("bad_seal")?;
        if padded[end] != 0x80 {
            return Err("bad_seal");
        }
        let inner: Value = serde_json::from_slice(&padded[..end]).map_err(|_| "bad_seal")?;
        if op::canonical_json(&inner).ok().as_deref() != Some(&padded[..end]) {
            return Err("bad_seal");
        }
        let kind = inner["k"].as_str().unwrap_or_default().to_string();
        let kind_ok = match channel {
            Channel::Voip => kind == "call" || kind == "live",
            Channel::Background => kind == "crl",
            Channel::Alert => alert_words(&kind).map(|w| w.1) == Some(category),
        };
        if !kind_ok {
            return Err("wrong_kind");
        }
        if inner["dev"].as_str() != Some(device) {
            return Err("wrong_device");
        }
        if (now_ms - inner["ts"].as_i64().unwrap_or(0)).abs() > 3_600_000 {
            return Err("stale_ts");
        }
        if !seen.insert(tag(person, format!("{kind}{}", inner["id"].as_str().unwrap_or_default()).as_bytes())) {
            return Err("replay");
        }
        Ok(inner)
    }

    #[test]
    fn the_seal_vectors_match_ps1() {
        let v: Value = serde_json::from_str(SEALS).unwrap();
        let person = unhex(v["person_key_hex"].as_str().unwrap());
        let device = v["device"].as_str().unwrap();
        let now_s = v["now_s"].as_i64().unwrap();
        assert_eq!((v["seal_domain"].as_str(), v["origin_domain"].as_str()), (Some(SEAL), Some(ORIGIN)));
        assert_eq!(v["sizes"], json!({"alert": Channel::Alert.size(), "voip": Channel::Voip.size(), "background": Channel::Background.size()}));
        let mine = agreement::PrivateKey::from_private_key(&agreement::ECDH_P256, &unhex(v["seal_priv_hex"].as_str().unwrap())).unwrap();
        let prev = agreement::PrivateKey::from_private_key(&agreement::ECDH_P256, &unhex(v["seal_prev"]["priv_hex"].as_str().unwrap())).unwrap();
        let pubs = [
            (v["sk"].as_str().unwrap().to_string(), pj::b64_strict(v["seal_pub_b64"].as_str().unwrap()).unwrap()),
            (v["seal_prev"]["sk"].as_str().unwrap().to_string(), pj::b64_strict(v["seal_prev"]["pub_b64"].as_str().unwrap()).unwrap()),
        ];
        // the published keys are the private keys', on the curve, and named by the relay's sk
        assert_eq!(mine.compute_public_key().unwrap().as_ref(), pubs[0].1.as_slice());
        assert_eq!(prev.compute_public_key().unwrap().as_ref(), pubs[1].1.as_slice());
        for (sk, raw) in &pubs {
            assert!(seal_point(raw));
            assert_eq!(&sk_of(raw), sk);
        }
        let keys = [(pubs[0].0.clone(), &mine), (pubs[1].0.clone(), &prev)];
        let mut seen: HashSet<String> = HashSet::new();
        for c in v["seal"].as_array().unwrap() {
            let name = c["name"].as_str().unwrap();
            let channel = channel_of(c["channel"].as_str().unwrap());
            let inner = c["inner"].as_object().unwrap();
            // canonical inner, padded to the channel's one size
            let bytes = op::canonical_json(&c["inner"]).unwrap();
            assert_eq!(crate::codec::hex(&bytes), c["inner_hex"].as_str().unwrap(), "{name}");
            let padded = pad(&bytes, channel.size()).unwrap();
            assert_eq!(crate::codec::hex(&padded), c["padded_hex"].as_str().unwrap(), "{name}");
            let mut fitted = inner.clone();
            assert_eq!(fit(&mut fitted, channel), Some(padded.clone()), "{name}");
            // the seal with the vector's ephemeral key and nonce: the same info, key and bytes
            let sk = c["sk"].as_str().unwrap();
            let seal = &pubs.iter().find(|(k, _)| k == sk).unwrap().1;
            let esk = agreement::PrivateKey::from_private_key(&agreement::ECDH_P256, &unhex(c["eph_priv_hex"].as_str().unwrap())).unwrap();
            let mut nonce = [0u8; 12];
            nonce.copy_from_slice(&unhex(c["nonce_hex"].as_str().unwrap()));
            let (s, info, k) = seal_with(&esk, nonce, seal, channel, device, sk, &padded).unwrap();
            assert_eq!(crate::codec::hex(&info), c["info_hex"].as_str().unwrap(), "{name}");
            assert_eq!(crate::codec::hex(&k), c["key_hex"].as_str().unwrap(), "{name}");
            assert_eq!(s, c["s"].as_str().unwrap(), "{name}");
            // one length per channel: alert 65 + 12 + 2560 + 16 bytes, VoIP and background 65 + 12 + 1024 + 16
            assert_eq!(s.len(), if channel == Channel::Alert { 3540 } else { 1492 }, "{name}");
            assert_eq!(origin(&person, channel, sk, &s), c["o"].as_str().unwrap(), "{name}");
            // the outer payload and headers
            let kind = inner["k"].as_str().unwrap();
            let badge = c["payload"]["aps"]["badge"].as_i64().unwrap_or(0);
            let soon = kind != "call" && kind != "live" && c["payload"]["aps"]["interruption-level"] == json!("time-sensitive");
            let (payload, headers) = build(&person, channel, inner, &s, sk, badge, soon, TOPIC, now_s);
            let payload = Value::Object(payload);
            assert_eq!(payload, c["payload"], "{name}");
            let len = pj::dumps_compact(&payload).len();
            assert_eq!(len as i64, c["payload_len"].as_i64().unwrap(), "{name}");
            assert!(len <= channel.limit(), "{name}");
            let headers: Obj = headers.into_iter().map(|(k, v)| (k.to_string(), Value::from(v))).collect();
            assert_eq!(Value::Object(headers), c["headers"], "{name}");
            // and the iPhone opens it
            assert_eq!(open(&keys, &person, channel, c["category"].as_str().unwrap(), &c["payload"], &mut seen, now_s * 1000, device), Ok(c["inner"].clone()), "{name}");
        }
        for c in v["bad"].as_array().unwrap() {
            let name = c["name"].as_str().unwrap();
            let reason = c["reason"].as_str().unwrap();
            let mut now_seen = if reason == "replay" { seen.clone() } else { HashSet::new() };
            let got = open(&keys, &person, channel_of(c["channel"].as_str().unwrap()), c["category"].as_str().unwrap(), &c["payload"], &mut now_seen, now_s * 1000, device);
            assert_eq!(got.err(), Some(reason), "{name}");
        }
    }

    #[test]
    fn padding_is_one_size_and_a_long_inner_drops_wrap_then_env() {
        // 1023 bytes fit a 1024-byte VoIP inner, 1024 do not
        assert_eq!(pad(&[b'x'; 1023], 1024).map(|p| p.len()), Some(1024));
        assert!(pad(&[b'x'; 1024], 1024).is_none());
        // a DM call from a 254-character principal names it twice and still fits
        let long = format!("{}@acme.test", "p".repeat(244));
        let mut call = row(json!({"v": 1, "k": "call", "dev": IPHONE, "ts": 1_794_000_298_500_i64, "from": long, "conv": format!("dm:{long}"), "id": "f".repeat(32), "room": "dm-cccccccccccccccc", "ring_ms_left": 45000}));
        assert_eq!(fit(&mut call, Channel::Voip).map(|p| p.len()), Some(1024));
        // a message: the rider goes first, then the envelope; the padded length never changes
        let big = |n: usize| json!({"x": "a".repeat(n)});
        let mut msg = row(json!({"v": 1, "k": "msg", "dev": IPHONE, "ts": 1, "from": "ann@x", "conv": "dm:ann@x", "id": "m", "thread": "", "reply": false, "files": 0, "enc": true, "env": big(1800), "wrap": big(700)}));
        assert_eq!(fit(&mut msg, Channel::Alert).map(|p| p.len()), Some(2560));
        assert!(msg.contains_key("env") && !msg.contains_key("wrap"));
        let mut msg = row(json!({"v": 1, "k": "msg", "dev": IPHONE, "ts": 1, "from": "ann@x", "conv": "dm:ann@x", "id": "m", "thread": "", "reply": false, "files": 0, "enc": true, "env": big(4096), "wrap": big(10)}));
        assert_eq!(fit(&mut msg, Channel::Alert).map(|p| p.len()), Some(2560));
        assert!(!msg.contains_key("env") && !msg.contains_key("wrap"));
    }

    #[test]
    fn the_fallback_words_match_the_vectors() {
        let v: Value = serde_json::from_str(WORDS).unwrap();
        assert_eq!(v["fallback_title"]["ios"], json!(TITLE));
        for c in v["fallback"].as_array().unwrap() {
            let kind = c["kind"].as_str().unwrap();
            match alert_words(kind) {
                Some((body, category, _)) => assert_eq!((json!(body), json!(category)), (c["body"].clone(), c["category"].clone()), "{kind}"),
                // reminders are made on the iPhone and never pass through the relay
                None => assert_eq!(kind, "remind"),
            }
        }
    }

    /// Register a device the NT-1 way; its seal key back.
    fn register(h: &Hub, w: &Identity, token: &str, voip: Option<&str>, callkit: bool) -> (agreement::PrivateKey, Obj) {
        let (k, seal, sk) = seal_key_pair();
        let mut b = row(json!({"session": "x", "token": token, "env": "sandbox", "seal": seal, "sk": sk, "callkit": callkit}));
        if let Some(v) = voip {
            b.insert("voip_token".into(), json!(v));
        }
        let answer = h.push_register(w, &b).unwrap();
        (k, answer)
    }

    fn shown(h: &Hub, p: &str) -> (&'static str, bool) {
        h.st.lock().presence_of(p)
    }

    /// PR-1 1.2: available, away, away (mobile) and offline.
    #[test]
    fn presence_follows_activity_and_push_registrations() {
        let (h, _rx) = hub_on();
        let (ann, ben, ben_pc) = (who("ann@x", "aaaaaaaaaaaaaaaa"), who("ben@x", IPHONE), who("ben@x", "cccccccccccccccc"));
        let a = session(&h, &ann);
        assert_eq!(shown(&h, "ben@x"), ("offline", false));
        // hello: active by default; false opens it away; a bad value is refused
        let phone = h.hello_active(&ben, "", &Obj::new(), false).unwrap()["session"].as_str().unwrap().to_string();
        assert_eq!(shown(&h, "ben@x"), ("away", false));
        assert_eq!(error(crate::meet_hub::parse_active(Some(&json!("yes")), Some(true))), "400 active must be true or false");
        assert_eq!(error(h.activity(&phone, &ben, None)), "400 active must be true or false");
        // two sessions, one idle: available; both idle: away; every session hears it
        let pc = session(&h, &ben_pc);
        assert_eq!(shown(&h, "ben@x"), ("available", false));
        let answer = h.activity(&pc, &ben_pc, Some(&json!(false))).unwrap();
        assert_eq!((&answer["presence"], &answer["mobile"]), (&json!("away"), &json!(false)));
        let last = events_of(&h, &a, &ann, "presence").last().cloned().unwrap();
        assert_eq!((&last["principal"], &last["online"], &last["presence"], &last["mobile"]), (&json!("ben@x"), &json!(true), &json!("away"), &json!(false)));
        // no event when nothing changed
        let count = events_of(&h, &a, &ann, "presence").len();
        h.activity(&pc, &ben_pc, Some(&json!(false))).unwrap();
        assert_eq!(events_of(&h, &a, &ann, "presence").len(), count);
        h.activity(&phone, &ben, Some(&json!(true))).unwrap();
        assert_eq!(shown(&h, "ben@x"), ("available", false));
        // gone without a push registration: offline; with one (device seen lately): away (mobile)
        h.bye(&pc, &ben_pc).unwrap();
        h.bye(&phone, &ben).unwrap();
        assert_eq!(shown(&h, "ben@x"), ("offline", false));
        let phone = session(&h, &ben);
        register(&h, &ben, TOKEN, None, false);
        h.bye(&phone, &ben).unwrap();
        assert_eq!(shown(&h, "ben@x"), ("away", true));
        let last = events_of(&h, &a, &ann, "presence").last().cloned().unwrap();
        assert_eq!((&last["online"], &last["presence"], &last["mobile"]), (&json!(false), &json!("away"), &json!(true)));
        let people = h.hello(&who("ann@x", "dddddddddddddddd"), "", &Obj::new()).unwrap()["people"].clone();
        let entry = people.as_array().unwrap().iter().find(|p| p["principal"] == json!("ben@x")).cloned().unwrap();
        assert_eq!((&entry["online"], &entry["presence"], &entry["mobile"]), (&json!(false), &json!("away"), &json!(true)));
        // the device not seen for more than PRESENCE_MOBILE_DAYS: offline
        {
            let mut st = h.st.lock();
            let old = pj::now() - crate::meet_hub::PRESENCE_MOBILE_DAYS * 86400.0 - 60.0;
            st.directory["ben@x"]["devices"][IPHONE]["last_seen"] = json!(old);
            assert_eq!(st.presence_of("ben@x"), ("offline", false));
            st.directory["ben@x"]["devices"][IPHONE]["last_seen"] = json!(pj::now());
            // push off on the relay: offline
            let sender = st.pu.sender.take();
            assert_eq!(st.presence_of("ben@x"), ("offline", false));
            st.pu.sender = sender;
        }
        // unregister announces offline
        h.push_unregister(&ben).unwrap();
        assert_eq!(shown(&h, "ben@x"), ("offline", false));
        let last = events_of(&h, &a, &ann, "presence").last().cloned().unwrap();
        assert_eq!((&last["presence"], &last["mobile"]), (&json!("offline"), &json!(false)));
    }

    #[test]
    fn register_takes_the_seal_key_and_the_voip_token() {
        let h = hub();
        let ben = who("ben@x", IPHONE);
        let (_, seal, sk) = seal_key_pair();
        let good = row(json!({"token": TOKEN, "env": "sandbox", "seal": seal, "sk": sk, "voip_token": VOIP, "callkit": true}));
        assert_eq!(error(h.push_register(&ben, &good)), "501 push notifications are off on this relay");
        let (h, _rx) = hub_on();
        assert_eq!(error(h.push_register(&who("ben@x", ""), &good)), "403 finish setting up this device first");
        let with = |k: &str, v: Value| {
            let mut b = good.clone();
            b.insert(k.into(), v);
            b
        };
        let without = |k: &str| {
            let mut b = good.clone();
            b.shift_remove(k);
            b
        };
        for bad_token in [json!("ab"), json!("g".repeat(64)), json!("a".repeat(201)), json!(1), Value::Null] {
            assert_eq!(error(h.push_register(&ben, &with("token", bad_token))), "400 token must be 64 to 200 hex characters");
        }
        assert_eq!(error(h.push_register(&ben, &with("env", json!("dev")))), "400 env must be sandbox or production");
        let mut off_curve = vec![4u8];
        off_curve.extend([7u8; 64]);
        for bad_seal in [json!(pj::b64(&off_curve)), json!(pj::b64(&[4u8; 33])), json!("not base64"), json!(1)] {
            assert_eq!(error(h.push_register(&ben, &with("seal", bad_seal))), "400 seal must be a P-256 public key (base64 of 65 bytes)");
        }
        assert_eq!(error(h.push_register(&ben, &without("seal"))), "400 seal must be a P-256 public key (base64 of 65 bytes)");
        for bad_sk in [json!("zzzzzzzz"), json!(format!("{sk}0")), Value::Null] {
            assert_eq!(error(h.push_register(&ben, &with("sk", bad_sk))), "400 sk must name the seal key");
        }
        for bad_voip in [json!(""), json!("zz"), json!(5)] {
            assert_eq!(error(h.push_register(&ben, &with("voip_token", bad_voip))), "400 voip_token must be 64 to 200 hex characters");
        }
        for bad_callkit in [json!("yes"), json!(1), Value::Null] {
            assert_eq!(error(h.push_register(&ben, &with("callkit", bad_callkit))), "400 callkit must be true or false");
        }
        assert_eq!(error(h.push_register(&ben, &without("callkit"))), "400 callkit must be true or false");
        // the answer: the person key and whether this relay rings the device through PushKit
        let got = h.push_register(&ben, &good).unwrap();
        assert_eq!(got.keys().collect::<Vec<_>>(), ["ok", "key", "voip"]);
        assert_eq!(pj::b64_strict(got["key"].as_str().unwrap()).unwrap().len(), 32);
        assert_eq!(got["voip"], json!(true));
        let entry = h.st.lock().push_tokens["ben@x"][IPHONE].clone();
        assert_eq!(entry.as_object().unwrap().keys().collect::<Vec<_>>(), ["token", "env", "ts", "serial", "seal", "sk", "seal_prev", "sk_prev", "voip", "callkit", "platform"]);
        assert_eq!((&entry["seal"], &entry["sk"], &entry["seal_prev"], &entry["voip"], &entry["callkit"], &entry["platform"]), (&json!(seal), &json!(sk), &json!(""), &json!(VOIP), &json!(true), &json!("ios")));
        // platform ios is the default, said or not; anything else is refused
        assert_eq!(h.push_register(&ben, &with("platform", json!("ios"))).unwrap()["voip"], json!(true));
        for bad_platform in [json!("iOS"), json!("web"), json!(1), json!(true)] {
            assert_eq!(error(h.push_register(&ben, &with("platform", bad_platform))), "400 platform must be ios or android");
        }
        // an FCM token is not an iPhone's
        assert_eq!(error(h.push_register(&ben, &with("token", json!(FCM)))), "400 token must be 64 to 200 hex characters");
        // FCM off: an Android device is told so
        assert_eq!(error(h.push_register(&ben, &with("platform", json!("android")))), "501 push notifications for this platform are off on this relay");
        // a new seal key moves the old one to seal_prev; callkit false or no voip_token: no VoIP
        let (_, seal2, sk2) = seal_key_pair();
        let mut next = with("seal", json!(seal2.clone()));
        next.insert("sk".into(), json!(sk2.clone()));
        next.insert("callkit".into(), json!(false));
        assert_eq!(h.push_register(&ben, &next).unwrap()["voip"], json!(false));
        let entry = h.st.lock().push_tokens["ben@x"][IPHONE].clone();
        assert_eq!((&entry["seal"], &entry["seal_prev"], &entry["sk_prev"], &entry["voip"]), (&json!(seal2), &json!(seal), &json!(sk), &json!("")));
        assert_eq!(h.push_register(&ben, &without("voip_token")).unwrap()["voip"], json!(false));
        // relay voip off: never
        h.st.lock().pu.voip = false;
        assert_eq!(h.push_register(&ben, &good).unwrap()["voip"], json!(false));
        // the same token on another device moves there; sandbox tokens off
        let other = who("cy@x", "cccccccccccccccc");
        h.push_register(&other, &good).unwrap();
        assert!(!h.st.lock().push_tokens.contains_key("ben@x"));
        assert_eq!(h.push_unregister(&other).unwrap(), row(json!({"ok": true, "removed": true})));
        assert_eq!(h.push_unregister(&other).unwrap(), row(json!({"ok": true, "removed": false})));
        h.st.lock().pu.sandbox = false;
        assert_eq!(error(h.push_register(&ben, &good)), "400 sandbox push tokens are off on this relay");
        assert!(h.push_register(&ben, &with("env", json!("production"))).is_ok());
    }

    #[test]
    fn stored_tokens_load_when_sound_and_old_rows_without_a_seal_stay_legacy() {
        let h = hub();
        let mut st = h.st.lock();
        let (_, seal, sk) = seal_key_pair();
        let good = json!({"token": TOKEN, "env": "production", "ts": 1, "serial": "1a", "seal": seal, "sk": sk, "seal_prev": "", "sk_prev": "", "voip": VOIP, "callkit": true});
        let mut wrong_sk = good.clone();
        wrong_sk["sk"] = json!("00000000");
        let raw = row(json!({"push_tokens": {
            "ben@x": {IPHONE: good, "cccccccccccccccc": {"token": TOKEN, "env": "production", "ts": 1, "serial": ""}},
            "cy@x": {"cccccccccccccccc": wrong_sk},
        }}));
        st.pu_load(&raw);
        let legacy = json!({"token": TOKEN, "env": "production", "ts": 1, "serial": "", "seal": "", "sk": "", "seal_prev": "", "sk_prev": "", "voip": "", "callkit": false});
        assert_eq!(Value::Object(st.push_tokens.clone()), json!({"ben@x": {IPHONE: good, "cccccccccccccccc": legacy}}));
    }

    #[test]
    fn hello_says_push_voip_previews_and_settled() {
        let h = hub();
        let ann = who("ann@x", "aaaaaaaaaaaaaaaa");
        let first = h.hello(&ann, "", &Obj::new()).unwrap();
        assert_eq!((&first["push"], &first["push_voip"], &first["notify_previews"], &first["settled"]), (&json!(false), &json!(false), &json!(true), &json!([])));
        let (h, _rx) = hub_on();
        h.st.lock().pu.previews = false;
        let on = h.hello(&ann, "", &Obj::new()).unwrap();
        assert_eq!((&on["push"], &on["push_voip"], &on["notify_previews"]), (&json!(true), &json!(true), &json!(false)));
    }

    /// PH-1 revision 2 (contract 10.3): an inbound text pushes `msg` with `conv: "sms:<number>"`, `from:
    /// "phone:<number>"` and, while previews are on, the text as its preview.
    #[test]
    fn an_inbound_text_pushes_msg_with_its_number_and_preview() {
        let (h, mut rx) = hub_on();
        let ben = who("ben@x", IPHONE);
        let (key, _) = register(&h, &ben, TOKEN, None, true);
        let number = "+13055550147";
        let msg = row(json!({"id": "s-0011223344556677", "dir": "in", "text": "Running late", "ts": pj::now(), "status": "received"}));
        h.st.lock().pu_sms("ben@x", number, &msg);
        let jobs = sent(&mut rx);
        assert_eq!(jobs.len(), 1);
        let inner = inner_of(&h, &jobs[0], &key);
        assert_eq!((&inner["k"], &inner["conv"], &inner["from"], &inner["id"]), (&json!("msg"), &json!("sms:+13055550147"), &json!("phone:+13055550147"), &json!("s-0011223344556677")));
        assert_eq!((&inner["text"], &inner["enc"], &inner["sms"], &inner["dev"]), (&json!("Running late"), &json!(false), &json!(true), &json!(IPHONE)));
        assert_eq!(payload_of(&jobs[0])["aps"]["category"], json!("msg"));
        // one per device and conversation every RATE_S
        h.st.lock().pu_sms("ben@x", number, &msg);
        assert!(sent(&mut rx).is_empty());
        // previews off: no text
        fresh(&h);
        h.st.lock().pu.previews = false;
        h.st.lock().pu_sms("ben@x", number, &msg);
        let jobs = sent(&mut rx);
        assert_eq!(jobs.len(), 1);
        assert_eq!(inner_of(&h, &jobs[0], &key).get("text"), None);
        // the thread's level off: none
        fresh(&h);
        level(&h, "sms:+13055550147", json!("off"), "all");
        h.st.lock().pu_sms("ben@x", number, &msg);
        assert!(sent(&mut rx).is_empty());
    }

    fn sent(rx: &mut Receiver<Job>) -> Vec<Job> {
        let mut out = Vec::new();
        while let Ok(j) = rx.try_recv() {
            out.push(j);
        }
        out
    }

    fn payload_of(j: &Job) -> Value {
        serde_json::from_slice(&j.payload).unwrap()
    }

    fn header(j: &Job, name: &str) -> Option<String> {
        j.headers.iter().find(|(k, _)| *k == name).map(|(_, v)| v.clone())
    }

    /// Open a caught push with the device's seal key: its inner.
    fn inner_of(h: &Hub, j: &Job, key: &agreement::PrivateKey) -> Value {
        let person = h.st.lock().pu_person_key(&j.principal);
        let p = payload_of(j);
        let channel = if j.voip {
            Channel::Voip
        } else if header(j, "apns-push-type").as_deref() == Some("background") {
            Channel::Background
        } else {
            Channel::Alert
        };
        let category = p["aps"]["category"].as_str().unwrap_or_default().to_string();
        let sk = p["sk"].as_str().unwrap().to_string();
        let now_ms = (h.st.lock().pu.now() * 1000.0) as i64;
        open(&[(sk, key)], &person, channel, &category, &p, &mut HashSet::new(), now_ms, &j.device).unwrap()
    }

    /// Ann's encrypted direct message to Ben, kept as the relay keeps one, then the push rules.
    fn dm(h: &Hub, id: &str, extra: Value) {
        let env = json!({"v": 1, "d": "a1a1a1a1a1a1a1a1", "e": 7, "s": 1, "x": "c2VhbGVk"});
        let mut msg = row(json!({"id": id, "from": "ann@x", "to": "ben@x", "ts": pj::now(), "enc": env}));
        msg.extend(row(extra));
        let mut st = h.st.lock();
        st.dms.entry(conv("ann@x", "ben@x")).or_default().push(msg.clone());
        st.pu_message(None, Some("ben@x"), &msg);
    }

    fn post(h: &Hub, cid: &str, from: &str, id: &str, extra: Value) {
        let mut msg = row(json!({"id": id, "channel": cid, "from": from, "ts": pj::now(), "text": "x"}));
        msg.extend(row(extra));
        let mut st = h.st.lock();
        st.channel_msgs.entry(cid.to_string()).or_default().push(msg.clone());
        st.pu_message(Some(cid), None, &msg);
    }

    fn fresh(h: &Hub) {
        h.st.lock().pu.last.clear();
    }

    fn level(h: &Hub, conv_key: &str, level: Value, default: &str) {
        let mut st = h.st.lock();
        st.prefs.insert("ben@x".into(), json!({"rev": 1, "notify": {conv_key: level}, "sections": [], "channel_default": default}));
    }

    fn skew(h: &Hub, s: f64) {
        h.st.lock().pu.skew += s;
    }

    #[test]
    fn a_direct_message_push_is_sealed_with_the_envelope_and_rider() {
        let (h, mut rx) = hub_on();
        let (ann, ben, desk) = (who("ann@x", "aaaaaaaaaaaaaaaa"), who("ben@x", IPHONE), who("ben@x", "dddddddddddddddd"));
        session(&h, &ann);
        // Ben is online on his desktop: his iPhone still gets the push
        let sd = session(&h, &desk);
        h.inbox(&sd, &desk, 0, 0.0).unwrap();
        let (key, answer) = register(&h, &ben, TOKEN, None, true);
        let person = pj::b64_strict(answer["key"].as_str().unwrap()).unwrap();
        // a wrap of Ann's sender epoch 7 to Ben's iPhone, above its key cursor: the rider
        {
            let mut st = h.st.lock();
            let w = json!({"cid": ce::dm_cid("ann@x", "ben@x"), "from": {"principal": "ann@x", "device": "a1a1a1a1a1a1a1a1", "serial": "1a"}, "epoch": 7, "to": {"principal": "ben@x", "device": IPHONE}, "eph": "RVBI", "dck_sha256": "d".repeat(64), "blob": "QkxPQg==", "ts": 1, "sig": "c2ln", "seq": 5, "rts": 1});
            st.ce_part("wraps").insert(format!("ben@x|{IPHONE}"), json!([w]));
        }
        dm(&h, "m1", json!({}));
        let jobs = sent(&mut rx);
        assert_eq!(jobs.len(), 1);
        let j = &jobs[0];
        assert_eq!((j.principal.as_str(), j.device.as_str(), j.token.as_str(), j.sandbox, j.voip), ("ben@x", IPHONE, TOKEN, true, false));
        let tid = tag(&person, b"dm:ann@x");
        assert_eq!(tid, h.st.lock().pu_id("ben@x", "dm:ann@x"));
        let p = payload_of(j);
        assert_eq!(p["aps"], json!({"alert": {"title": "Lucid Meet", "body": "New message"}, "badge": 1, "sound": "msg-lucid.wav", "thread-id": tid, "mutable-content": 1, "category": "msg", "interruption-level": "active"}));
        assert_eq!(p.as_object().unwrap().keys().collect::<Vec<_>>(), ["aps", "c", "s", "sk", "o"]);
        assert_eq!((p["c"].as_str(), p["s"].as_str().map(str::len)), (Some(tid.as_str()), Some(3540)));
        assert_eq!(header(j, "apns-push-type").as_deref(), Some("alert"));
        assert_eq!(header(j, "apns-topic").as_deref(), Some(TOPIC));
        assert_eq!(header(j, "apns-collapse-id"), Some(tag(&person, b"msg:m1")));
        let expires: i64 = header(j, "apns-expiration").unwrap().parse().unwrap();
        assert!((expires - pj::now() as i64 - 3600).abs() <= 5);
        // nothing of the people or the message outside the seal
        let mut outer = p.clone();
        outer.as_object_mut().unwrap().shift_remove("s");
        let text = pj::dumps_compact(&outer);
        assert!(!text.contains("ann") && !text.contains("ANN") && !text.contains("a1a1a1a1"));
        let inner = inner_of(&h, j, &key);
        assert_eq!((&inner["k"], &inner["from"], &inner["conv"], &inner["id"], &inner["thread"], &inner["reply"], &inner["files"], &inner["enc"]), (&json!("msg"), &json!("ann@x"), &json!("dm:ann@x"), &json!("m1"), &json!(""), &json!(false), &json!(0), &json!(true)));
        assert_eq!(inner["env"]["e"], json!(7));
        assert_eq!(inner["wrap"], json!({"eph": "RVBI", "blob": "QkxPQg==", "dck_sha256": "d".repeat(64)}));
        // the device fetched its keys past the wrap: no rider
        h.st.lock().nt_keys_fetched("ben@x", IPHONE, 5);
        fresh(&h);
        dm(&h, "m2", json!({}));
        let inner = inner_of(&h, &sent(&mut rx)[0], &key);
        assert!(inner.get("env").is_some() && inner.get("wrap").is_none());
        // at most one per 30 s for the conversation, but a reply to Ben always pushes
        dm(&h, "m3", json!({}));
        assert!(sent(&mut rx).is_empty());
        h.st.lock().dms.entry(conv("ann@x", "ben@x")).or_default().push(row(json!({"id": "b1", "from": "ben@x", "to": "ann@x", "ts": pj::now()})));
        dm(&h, "m4", json!({"reply_to": "b1"}));
        let inner = inner_of(&h, &sent(&mut rx)[0], &key);
        assert_eq!(inner["reply"], json!(true));
        // previews off at the relay: no env, no wrap
        fresh(&h);
        h.st.lock().pu.previews = false;
        dm(&h, "m5", json!({}));
        let inner = inner_of(&h, &sent(&mut rx)[0], &key);
        assert!(inner.get("env").is_none() && inner.get("wrap").is_none() && inner["enc"] == json!(true));
        h.st.lock().pu.previews = true;
        // the iPhone polling: live for push for 15 s after its latest poll started
        fresh(&h);
        let si = session(&h, &ben);
        h.inbox(&si, &ben, 0, 0.0).unwrap();
        dm(&h, "m6", json!({}));
        assert!(sent(&mut rx).is_empty());
        skew(&h, 14.0);
        dm(&h, "m7", json!({}));
        assert!(sent(&mut rx).is_empty());
        skew(&h, 2.0);
        fresh(&h);
        dm(&h, "m8", json!({}));
        assert_eq!(sent(&mut rx).len(), 1);
        h.bye(&si, &ben).unwrap();
        // Do not disturb: nothing
        fresh(&h);
        h.set_status(&sd, &desk, Some(&json!("dnd")), None, None).unwrap();
        dm(&h, "m9", json!({}));
        assert!(sent(&mut rx).is_empty());
        h.set_status(&sd, &desk, Some(&json!("auto")), None, None).unwrap();
        // level off: nothing; mentions: only a reply to Ben
        level(&h, "dm:ann@x", json!("off"), "all");
        dm(&h, "m10", json!({}));
        assert!(sent(&mut rx).is_empty());
        level(&h, "dm:ann@x", json!("mentions"), "all");
        dm(&h, "m11", json!({}));
        assert!(sent(&mut rx).is_empty());
        dm(&h, "m12", json!({"reply_to": "b1"}));
        let jobs = sent(&mut rx);
        assert_eq!(jobs.len(), 1);
        // the badge counts only senders at level all: Ann is at mentions now
        assert_eq!(payload_of(&jobs[0])["aps"]["badge"], json!(0));
    }

    #[test]
    fn channel_pushes_follow_the_levels_mentions_and_threads_and_carry_no_text() {
        let (h, mut rx) = hub_on();
        let (ann, ben, cy) = (who("ann@x", "aaaaaaaaaaaaaaaa"), who("ben@x", IPHONE), who("cy@x", "cccccccccccccccc"));
        session(&h, &ann);
        let (key, _) = register(&h, &ben, TOKEN, None, true);
        register(&h, &cy, &"ab".repeat(32), None, true);
        {
            let mut st = h.st.lock();
            st.channels.insert("c-01".into(), json!({"id": "c-01", "kind": "public", "name": "general", "members": ["ann@x", "ben@x"], "bridgeable": true}));
            st.channels.insert("g-01".into(), json!({"id": "g-01", "kind": "group", "name": "", "members": ["ann@x", "ben@x"]}));
        }
        let c_of = |j: &Job| payload_of(j)["c"].as_str().unwrap().to_string();
        // level all (the default): every main-conversation message; Cy is not a member; a plain message's inner has no
        // text
        post(&h, "c-01", "ann@x", "r1", json!({}));
        let jobs = sent(&mut rx);
        assert_eq!(jobs.len(), 1);
        assert_eq!(c_of(&jobs[0]), h.st.lock().pu_id("ben@x", "channel:c-01"));
        let inner = inner_of(&h, &jobs[0], &key);
        assert_eq!((&inner["enc"], inner.get("env"), inner.get("text")), (&json!(false), None, None));
        // a thread reply kept out of the main conversation: only when it answers or mentions Ben
        fresh(&h);
        post(&h, "c-01", "ann@x", "t1", json!({"thread": "r1"}));
        assert!(sent(&mut rx).is_empty());
        post(&h, "c-01", "ben@x", "b1", json!({}));
        sent(&mut rx);
        post(&h, "c-01", "ann@x", "t2", json!({"thread": "b1"}));
        let jobs = sent(&mut rx);
        assert_eq!(jobs.len(), 1);
        assert_eq!(inner_of(&h, &jobs[0], &key)["thread"], json!("b1"));
        fresh(&h);
        post(&h, "c-01", "ann@x", "t3", json!({"thread": "r1", "also_channel": true}));
        assert_eq!(sent(&mut rx).len(), 1);
        // the channel default at mentions: only a mention or a reply; a visible mention skips the 30 s rate
        level(&h, "dm:nobody@x", json!("all"), "mentions");
        post(&h, "c-01", "ann@x", "m1", json!({}));
        assert!(sent(&mut rx).is_empty());
        post(&h, "c-01", "ann@x", "m2", json!({"mentions": ["ben@x"]}));
        assert_eq!(sent(&mut rx).len(), 1);
        post(&h, "c-01", "ann@x", "m3", json!({"reply_to": {"id": "b1", "name": "BEN", "text": "x"}}));
        let jobs = sent(&mut rx);
        assert_eq!(jobs.len(), 1);
        // at mentions the badge counts the mentions only
        assert_eq!(payload_of(&jobs[0])["aps"]["badge"], json!(1));
        // a group chat is not a channel: the channel default does not apply
        post(&h, "g-01", "ann@x", "g1", json!({}));
        assert_eq!(sent(&mut rx).len(), 1);
        // a channel's own level off: nothing
        fresh(&h);
        level(&h, "channel:c-01", json!("off"), "all");
        post(&h, "c-01", "ann@x", "o1", json!({"mentions": ["ben@x"]}));
        assert!(sent(&mut rx).is_empty());
        // the preview fixtures' text never appears in a push of a plain conversation
        level(&h, "dm:nobody@x", json!("all"), "all");
        let previews: Value = serde_json::from_str(PREVIEWS).unwrap();
        for (i, c) in previews["preview"].as_array().unwrap().iter().enumerate() {
            let Some(text) = c["payload"]["t"].as_str().filter(|t| t.trim().len() >= 8) else { continue };
            fresh(&h);
            post(&h, "c-01", "ann@x", &format!("p{i}"), json!({"text": text}));
            let jobs = sent(&mut rx);
            assert_eq!(jobs.len(), 1, "{}", c["name"]);
            assert!(!String::from_utf8(jobs[0].payload.clone()).unwrap().contains(text));
            let inner = inner_of(&h, &jobs[0], &key);
            assert!(!pj::dumps_compact(&inner).contains(text), "{}", c["name"]);
        }
    }

    #[test]
    fn previews_off_by_a_members_policy_is_one_predicate() {
        let (h, _rx) = hub_on();
        let mut st = h.st.lock();
        st.channels.insert("c-01".into(), json!({"id": "c-01", "kind": "private", "name": "ops", "members": ["ann@x", "ben@x"]}));
        assert!(!st.nt_previews_off("ben@x", "dm:ann@x"));
        assert!(!st.nt_previews_off("ben@x", "channel:c-01"));
        st.pu.previews = false;
        assert!(st.nt_previews_off("ben@x", "dm:ann@x"));
        st.pu.previews = true;
        drop(st);
        h.pc_configure(&m::Settings { enclave: true, client_ca: String::new(), ..m::Settings::default() });
        assert!(h.st.lock().nt_previews_off("ben@x", "room:ops"));
        assert_eq!(h.hello(&who("ann@x", "aaaaaaaaaaaaaaaa"), "", &Obj::new()).unwrap()["notify_previews"], json!(false));
    }

    fn dm_room(a: &str, b: &str) -> String {
        let mut pair = [a, b];
        pair.sort();
        format!("dm-{}", &crate::codec::sha256_hex(pair.join("|").as_bytes())[..16])
    }

    fn invites(answer: &Obj) -> Vec<Value> {
        answer["invites"].as_array().unwrap().clone()
    }

    fn events_of(h: &Hub, sid: &str, w: &Identity, kind: &str) -> Vec<Value> {
        h.inbox(sid, w, 0, 0.0).unwrap()["events"].as_array().unwrap().iter().filter(|e| e["type"] == json!(kind)).cloned().collect()
    }

    #[test]
    fn calls_ring_callkit_iphones_through_pushkit_and_others_by_alert() {
        let (h, mut rx) = hub_on();
        let (ann, ben, cy, pad_) = (who("ann@x", "aaaaaaaaaaaaaaaa"), who("ben@x", IPHONE), who("cy@x", "cccccccccccccccc"), who("ben@x", "eeeeeeeeeeeeeeee"));
        let sa = session(&h, &ann);
        session(&h, &cy);
        // ben is known to the relay (he said hello once) and offline now (bye)
        let sb = session(&h, &ben);
        h.bye(&sb, &ben).unwrap();
        let (key, answer) = register(&h, &ben, TOKEN, Some(VOIP), true);
        let person = pj::b64_strict(answer["key"].as_str().unwrap()).unwrap();
        let (pad_key, _) = register(&h, &pad_, &"ab".repeat(32), None, false);
        let room = dm_room("ann@x", "ben@x");
        let got = h.invite(&sa, &ann, Some(&json!("ben@x")), Some(&json!(room)), None).unwrap();
        let inv = &invites(&got)[0];
        assert_eq!(inv.as_object().unwrap().keys().collect::<Vec<_>>(), ["id", "from", "from_name", "to", "room", "ts", "host", "kind", "ring", "ring_ms_left"]);
        assert_eq!((&inv["kind"], &inv["ring"], &inv["ring_ms_left"]), (&json!("call"), &json!(true), &json!(45000)));
        let id = inv["id"].as_str().unwrap().to_string();
        let mut jobs = sent(&mut rx);
        assert_eq!(jobs.len(), 2);
        jobs.sort_by_key(|j| !j.voip);
        // the CallKit iPhone: a content-free VoIP push on <topic>.voip
        let v = &jobs[0];
        assert_eq!((v.voip, v.token.as_str(), v.device.as_str()), (true, VOIP, IPHONE));
        let hv: Vec<(&str, &str)> = v.headers.iter().map(|(k, x)| (*k, x.as_str())).collect();
        assert_eq!(hv, [("apns-push-type", "voip"), ("apns-topic", "com.lucid.LucidMeet.voip"), ("apns-priority", "10"), ("apns-expiration", "0")]);
        let p = payload_of(v);
        assert_eq!(p.as_object().unwrap().keys().collect::<Vec<_>>(), ["c", "s", "sk", "o"]);
        assert_eq!((p["c"].as_str().unwrap(), p["s"].as_str().unwrap().len()), (tag(&person, b"dm:ann@x").as_str(), 1492));
        let inner = inner_of(&h, v, &key);
        assert_eq!((&inner["k"], &inner["room"], &inner["id"], &inner["conv"]), (&json!("call"), &json!(room), &json!(id), &json!("dm:ann@x")));
        assert!((44_000..=45_000).contains(&inner["ring_ms_left"].as_i64().unwrap()));
        // the iPad without CallKit: a Time Sensitive alert that rings
        let a = &jobs[1];
        assert!(!a.voip);
        let p = payload_of(a);
        assert_eq!((&p["aps"]["alert"]["body"], &p["aps"]["category"], &p["aps"]["sound"], &p["aps"]["interruption-level"]), (&json!("Incoming call"), &json!("call"), &json!("ring-lucid.wav"), &json!("time-sensitive")));
        assert_eq!((header(a, "apns-expiration").as_deref(), header(a, "apns-collapse-id")), (Some("0"), Some(tag(&person, format!("invite:{id}").as_bytes()))));
        assert_eq!(inner_of(&h, a, &pad_key)["k"], json!("call"));
        // someone else seated: a live invitation, with how many are there
        h.join("ops", &cy, "", false, None).unwrap();
        let got = h.invite(&sa, &ann, Some(&json!("ben@x")), Some(&json!("ops")), None).unwrap();
        assert_eq!(invites(&got)[0]["kind"], json!("live"));
        let jobs = sent(&mut rx);
        let v = jobs.iter().find(|j| j.voip).unwrap();
        let inner = inner_of(&h, v, &key);
        assert_eq!((&inner["k"], &inner["others"], &inner["conv"]), (&json!("live"), &json!(1), &json!("room:ops")));
        let a = jobs.iter().find(|j| !j.voip).unwrap();
        assert_eq!(payload_of(a)["aps"]["alert"]["body"], json!("Invitation to join a call"));
        // a person Ben set to off cannot ring him by inviting him to another room; it still answers ring: true
        level(&h, "dm:ann@x", json!("off"), "all");
        let got = h.invite(&sa, &ann, Some(&json!("ben@x")), Some(&json!("elsewhere")), None).unwrap();
        assert_eq!(invites(&got)[0]["ring"], json!(true));
        assert!(sent(&mut rx).is_empty());
    }

    /// MV-1: a 0.96.3 app registers `{token, env}`: a legacy row that gets the PB-1 payload for messages and calls
    /// only; a later NT-1 registration replaces it; a 0.96.3 state row loads as one.
    #[test]
    fn a_pre_nt1_app_keeps_plain_pushes_for_messages_and_calls() {
        let (h, mut rx) = hub_on();
        let (ann, ben) = (who("ann@x", "aaaaaaaaaaaaaaaa"), who("ben@x", IPHONE));
        let sa = session(&h, &ann);
        let sb = session(&h, &ben);
        h.bye(&sb, &ben).unwrap();
        let answer = h.push_register(&ben, &row(json!({"token": TOKEN, "env": "sandbox"}))).unwrap();
        assert_eq!(answer["voip"], json!(false));
        let person = pj::b64_strict(answer["key"].as_str().unwrap()).unwrap();
        let stored = h.st.lock().push_tokens["ben@x"][IPHONE].clone();
        assert!(stored_entry(stored.as_object().unwrap()));
        assert_eq!((&stored["seal"], &stored["sk"], &stored["voip"], &stored["callkit"]), (&json!(""), &json!(""), &json!(""), &json!(false)));
        // any NT-1 field: full NT-1 validation
        assert_eq!(error(h.push_register(&ben, &row(json!({"token": TOKEN, "env": "sandbox", "callkit": false})))), format!("400 {BAD_SEAL}"));
        dm(&h, "m1", json!({}));
        let jobs = sent(&mut rx);
        assert_eq!(jobs.len(), 1);
        let tid = tag(&person, b"dm:ann@x");
        assert_eq!(payload_of(&jobs[0]), json!({"aps": {"alert": {"title": "Lucid Meet", "body": "New message"}, "badge": 1, "sound": "default", "thread-id": tid}, "c": tid}));
        assert_eq!((header(&jobs[0], "apns-collapse-id"), jobs[0].voip, jobs[0].token.as_str()), (Some(tid), false, TOKEN));
        let room = dm_room("ann@x", "ben@x");
        h.invite(&sa, &ann, Some(&json!("ben@x")), Some(&json!(room)), None).unwrap();
        let jobs = sent(&mut rx);
        assert_eq!(jobs.len(), 1);
        let p = payload_of(&jobs[0]);
        assert_eq!((&p["aps"]["alert"]["body"], &p["aps"]["interruption-level"], &p["aps"]["sound"]), (&json!("Incoming call"), &json!("time-sensitive"), &json!("default")));
        assert_eq!(header(&jobs[0], "apns-expiration").as_deref(), Some("0"));
        // a meeting kind or the missed push: nothing for a legacy row
        let mut st = h.st.lock();
        let inner = row(json!({"v": 1, "k": "missed", "conv": "dm:ann@x", "id": "x"}));
        let r = st.push_tokens["ben@x"][IPHONE].as_object().unwrap().clone();
        assert!(!st.nt_push("ben@x", IPHONE, &r, Channel::Alert, inner, false));
        // a 0.96.3 state row loads as a legacy row
        let raw = row(json!({"push_tokens": {"ben@x": {IPHONE: {"token": TOKEN, "env": "production", "ts": 1, "serial": "1a"}}}}));
        st.push_tokens.clear();
        st.pu_load(&raw);
        assert_eq!(st.push_tokens["ben@x"][IPHONE]["seal"], json!(""));
        drop(st);
        // NT-1 registration replaces it
        register(&h, &ben, TOKEN, None, false);
        assert_ne!(h.st.lock().push_tokens["ben@x"][IPHONE]["seal"], json!(""));
    }

    /// MV-2: a silent invitation (ring false) is neither told to nor listed in hello for a pre-NT-1 app's session.
    #[test]
    fn a_silent_invitation_skips_pre_nt1_apps() {
        let (h, _rx) = hub_on();
        let (ann, old, new) = (who("ann@x", "aaaaaaaaaaaaaaaa"), who("ben@x", "dddddddddddddddd"), who("ben@x", "eeeeeeeeeeeeeeee"));
        let sa = session(&h, &ann);
        let client = |v: &str| row(json!({"app": "hub", "version": v, "platform": "windows"}));
        let so = h.hello_active(&old, "", &client("0.96.3"), true).unwrap()["session"].as_str().unwrap().to_string();
        let sn = h.hello_active(&new, "", &client("0.97.0"), true).unwrap()["session"].as_str().unwrap().to_string();
        let ring = |room: &str| invites(&h.invite(&sa, &ann, Some(&json!("ben@x")), Some(&json!(room)), None).unwrap())[0]["ring"].as_bool().unwrap();
        assert!(ring("r1") && ring("r2") && ring("r3") && !ring("r4"));
        assert_eq!((events_of(&h, &so, &old, "invite").len(), events_of(&h, &sn, &new, "invite").len()), (3, 4));
        let listed = |v: &str, w: &Identity| invites(&h.hello_active(w, "", &client(v), true).unwrap()).len();
        assert_eq!((listed("0.96.3", &old), listed("0.97.0", &new)), (3, 4));
        let ios = row(json!({"app": "ios", "version": "0.96.9"}));
        assert_eq!(invites(&h.hello_active(&old, "", &ios, true).unwrap()).len(), 3);
        let other = row(json!({"app": "watch", "version": "0.1"}));
        assert_eq!(invites(&h.hello_active(&old, "", &other, true).unwrap()).len(), 4);
    }

    #[test]
    fn the_ring_bucket_takes_three_refills_every_30_s_caps_10_an_hour_and_refunds_answers() {
        let (h, mut rx) = hub_on();
        let (ann, ben) = (who("ann@x", "aaaaaaaaaaaaaaaa"), who("ben@x", IPHONE));
        let sa = session(&h, &ann);
        let desk = who("ben@x", "dddddddddddddddd");
        let sd = session(&h, &desk);
        register(&h, &ben, TOKEN, Some(VOIP), true);
        let ring = |room: &str| {
            let got = h.invite(&sa, &ann, Some(&json!("ben@x")), Some(&json!(room)), None).unwrap();
            invites(&got)[0]["ring"].as_bool().unwrap()
        };
        assert!(ring("r1") && ring("r2") && ring("r3"));
        assert_eq!(sent(&mut rx).len(), 3);
        // a fourth within 30 s: ring false in the answer and the event, no push
        assert!(!ring("r4"));
        assert!(sent(&mut rx).is_empty());
        let told = events_of(&h, &sd, &desk, "invite");
        assert_eq!(told.last().unwrap()["ring"], json!(false));
        // Do not disturb and level off never take a token and never set ring false
        h.set_status(&sd, &desk, Some(&json!("dnd")), None, None).unwrap();
        assert!(ring("d1"));
        h.set_status(&sd, &desk, Some(&json!("auto")), None, None).unwrap();
        level(&h, "dm:ann@x", json!("off"), "all");
        assert!(ring("o1"));
        level(&h, "dm:ann@x", json!("all"), "all");
        assert!(!ring("r5"));
        // one more after 30 s, up to 10 in an hour
        for i in 4..=10 {
            skew(&h, 31.0);
            assert!(ring(&format!("q{i}")), "ring {i}");
        }
        skew(&h, 31.0);
        assert!(!ring("q11"));
        // an answered ring is refunded: Ben joins the last room
        h.join("q10", &desk, "", false, None).unwrap();
        assert!(ring("q12"));
    }

    #[test]
    fn invites_settle_by_decline_join_timer_and_caller_leave() {
        let (h, mut rx) = hub_on();
        let (ann, ben, desk) = (who("ann@x", "aaaaaaaaaaaaaaaa"), who("ben@x", IPHONE), who("ben@x", "dddddddddddddddd"));
        let sa = session(&h, &ann);
        let sb = session(&h, &ben);
        let sd = session(&h, &desk);
        let (key, answer) = register(&h, &ben, TOKEN, None, false);
        let person = pj::b64_strict(answer["key"].as_str().unwrap()).unwrap();
        let invite = |room: &str| invites(&h.invite(&sa, &ann, Some(&json!("ben@x")), Some(&json!(room)), None).unwrap())[0]["id"].as_str().unwrap().to_string();
        // the iPhone is live (its session polls), so only the settle events matter here
        h.inbox(&sb, &ben, 0, 0.0).unwrap();
        let one = invite("r1");
        sent(&mut rx);
        // settle authorization
        let declined = json!("declined");
        let how = Some(&declined);
        assert_eq!(error(h.invite_settle(&sb, &ben, Some(&json!(one)), Some(&json!("missed")))), "400 how must be declined");
        assert_eq!(error(h.invite_settle(&sb, &ben, Some(&json!("0123456789abcdef")), how)), "404 no such invitation");
        assert_eq!(error(h.invite_settle(&sa, &ann, Some(&json!(one)), how)), "404 no such invitation");
        let legacy = who("ben@x", "");
        let sl = session(&h, &legacy);
        assert_eq!(error(h.invite_settle(&sl, &legacy, Some(&json!(one)), how)), "403 finish setting up this device first");
        assert_eq!(h.invite_settle(&sb, &ben, Some(&json!(one)), how).unwrap(), row(json!({"ok": true, "how": "declined"})));
        let told = events_of(&h, &sd, &desk, "invite_settled");
        assert_eq!(told.len(), 1);
        assert_eq!((&told[0]["id"], &told[0]["room"], &told[0]["how"], &told[0]["device"]), (&json!(one), &json!("r1"), &json!("declined"), &json!(IPHONE)));
        assert_eq!(h.invite_settle(&sb, &ben, Some(&json!(one)), how).unwrap(), row(json!({"ok": true, "how": "declined"})));
        assert_eq!(events_of(&h, &sd, &desk, "invite_settled").len(), 1);
        // 45 s without an answer: missed (device ""), and after the 10 s grace a Missed call push to the offline iPhone
        h.bye(&sb, &ben).unwrap();
        let two = invite("r2");
        assert_eq!(sent(&mut rx).len(), 1);
        skew(&h, 46.0);
        h.push_tick();
        let told = events_of(&h, &sd, &desk, "invite_settled");
        assert_eq!((&told[1]["id"], &told[1]["how"], &told[1]["device"]), (&json!(two), &json!("missed"), &json!("")));
        assert!(sent(&mut rx).is_empty());
        skew(&h, 11.0);
        h.push_tick();
        let jobs = sent(&mut rx);
        assert_eq!(jobs.len(), 1);
        let p = payload_of(&jobs[0]);
        assert_eq!((&p["aps"]["alert"]["body"], &p["aps"]["category"], &p["aps"]["interruption-level"]), (&json!("Missed call"), &json!("missed"), &json!("active")));
        assert_eq!(header(&jobs[0], "apns-collapse-id"), Some(tag(&person, format!("invite:{two}").as_bytes())));
        let inner = inner_of(&h, &jobs[0], &key);
        assert_eq!((&inner["k"], &inner["why"], &inner["id"]), (&json!("missed"), &json!("missed"), &json!(two)));
        // a join within 10 s of missed answers it, and no missed push goes
        let three = invite("r3");
        skew(&h, 46.0);
        h.push_tick();
        h.join("r3", &desk, "", false, None).unwrap();
        skew(&h, 11.0);
        h.push_tick();
        assert_eq!(sent(&mut rx).len(), 1);
        let told = events_of(&h, &sd, &desk, "invite_settled");
        assert_eq!((&told.last().unwrap()["id"], &told.last().unwrap()["how"], &told.last().unwrap()["device"]), (&json!(three), &json!("answered"), &json!("dddddddddddddddd")));
        // the caller leaves an empty room before Ben joins: cancelled, then Missed call
        let a = h.join("r4", &ann, "", false, None).unwrap()["peer"].as_str().unwrap().to_string();
        let four = invite("r4");
        sent(&mut rx);
        h.leave(&a, &ann).unwrap();
        let told = events_of(&h, &sd, &desk, "invite_settled");
        assert_eq!((&told.last().unwrap()["id"], &told.last().unwrap()["how"]), (&json!(four), &json!("cancelled")));
        skew(&h, 11.0);
        h.push_tick();
        let jobs = sent(&mut rx);
        assert_eq!(inner_of(&h, &jobs[0], &key)["why"], json!("cancelled"));
        // settled invites stay joinable and in hello, with the settled list
        let hello = h.hello(&desk, "", &Obj::new()).unwrap();
        let settled: Vec<(Value, Value)> = hello["settled"].as_array().unwrap().iter().map(|s| (s["id"].clone(), s["how"].clone())).collect();
        assert_eq!(settled, [(json!(one), json!("declined")), (json!(two), json!("missed")), (json!(three), json!("answered")), (json!(four), json!("cancelled"))]);
        assert_eq!(hello["settled"][0].as_object().unwrap().keys().collect::<Vec<_>>(), ["id", "room", "how", "ts"]);
        assert!(hello["invites"].as_array().unwrap().iter().all(|i| i.get("settled").is_some()));
        assert!(h.join("r1", &desk, "", false, None).is_ok());
    }

    #[test]
    fn overdue_invites_settle_missed_at_load_without_a_push() {
        let dir = std::env::temp_dir().join(format!("meet-nt-{}", pj::token_hex(4)));
        std::fs::create_dir_all(&dir).unwrap();
        let ts = pj::now() - 100.0;
        let state = json!({"v": 2, "invites": {"ben@x": [
            {"id": "0123456789abcdef", "from": "ann@x", "from_name": "Ann", "to": "ben@x", "room": "r1", "ts": ts, "host": null, "kind": "call", "ring": true},
            {"id": "fedcba9876543210", "from": "ann@x", "from_name": "Ann", "to": "ben@x", "room": "r2", "ts": pj::now(), "host": null, "kind": "call", "ring": true},
        ]}});
        std::fs::write(dir.join("state.json"), pj::dumps(&state)).unwrap();
        let h = Hub::new(Some(dir.clone()), &[], 168.0, 30.0, 365.0, None, Arc::new(LinkStats::new()));
        {
            let st = h.st.lock();
            let list = &st.invites["ben@x"];
            assert_eq!((&list[0]["settled"], &list[0]["settled_ts"]), (&json!("missed"), &pj::f(ts + RING_SECONDS)));
            assert!(list[1].get("settled").is_none());
            assert!(st.pu.missed.is_empty());
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn meeting_pushes_are_limited_and_time_sensitive_only_between_people_who_share() {
        let (h, mut rx) = hub_on();
        let (ann, ben) = (who("ann@x", "aaaaaaaaaaaaaaaa"), who("ben@x", IPHONE));
        let sa = session(&h, &ann);
        session(&h, &ben);
        let (key, answer) = register(&h, &ben, TOKEN, None, true);
        let person = pj::b64_strict(answer["key"].as_str().unwrap()).unwrap();
        let soon = pj::now() + 1800.0;
        let create = |title: &str, start: f64| {
            h.meeting_create(&sa, &ann, Some(&json!(title)), Some(&json!(start)), Some(&json!(start + 1800.0)), Some(&json!(["ben@x"])), None, None, None, None, None).unwrap()["id"].as_str().unwrap().to_string()
        };
        // a stranger's invite within the hour is active, not Time Sensitive
        let m1 = create("One", soon);
        let jobs = sent(&mut rx);
        assert_eq!(jobs.len(), 1);
        let p = payload_of(&jobs[0]);
        assert_eq!((&p["aps"]["alert"]["body"], &p["aps"]["category"], &p["aps"]["interruption-level"], &p["aps"]["thread-id"]), (&json!("New meeting invite"), &json!("mtg"), &json!("active"), &json!(tag(&person, b"meetings"))));
        let inner = inner_of(&h, &jobs[0], &key);
        assert_eq!((&inner["k"], &inner["from"], &inner["conv"], &inner["id"], &inner["start"]), (&json!("invite"), &json!("ann@x"), &json!(format!("meeting:{m1}")), &json!(m1), &json!(soon as i64)));
        assert_eq!(header(&jobs[0], "apns-collapse-id"), Some(tag(&person, format!("meeting:{m1}:{}", soon as i64).as_bytes())));
        // a DM where only the organizer wrote does not count; one where both wrote does
        h.st.lock().dms.entry(conv("ann@x", "ben@x")).or_default().push(row(json!({"id": "a1", "from": "ann@x", "to": "ben@x", "ts": 1.0})));
        create("Two", soon);
        assert_eq!(payload_of(&sent(&mut rx)[0])["aps"]["interruption-level"], json!("active"));
        h.st.lock().dms.entry(conv("ann@x", "ben@x")).or_default().push(row(json!({"id": "b1", "from": "ben@x", "to": "ann@x", "ts": 2.0})));
        create("Three", soon);
        assert_eq!(payload_of(&sent(&mut rx)[0])["aps"]["interruption-level"], json!("time-sensitive"));
        // at most 3 meeting pushes per organizer and attendee in an hour
        create("Four", soon);
        assert!(sent(&mut rx).is_empty());
        skew(&h, 3601.0);
        // next week is never Time Sensitive; a change of start is `update`; a cancel is `cancel`, active
        let later = pj::now() + 7.0 * 86400.0 + 3601.0;
        let m5 = create("Five", later);
        assert_eq!(payload_of(&sent(&mut rx)[0])["aps"]["interruption-level"], json!("active"));
        h.meeting_update(&sa, &ann, Some(&json!(m5)), &row(json!({"start": later + 60.0, "end": later + 1860.0}))).unwrap();
        let p = payload_of(&sent(&mut rx)[0]);
        assert_eq!(p["aps"]["alert"]["body"], json!("Meeting changed"));
        h.meeting_cancel(&sa, &ann, Some(&json!(m5))).unwrap();
        let jobs = sent(&mut rx);
        assert_eq!(payload_of(&jobs[0])["aps"]["alert"]["body"], json!("Meeting canceled"));
        assert_eq!(inner_of(&h, &jobs[0], &key)["k"], json!("cancel"));
        // a group chat a stranger made with Ben in it does not count until Ben writes in it
        skew(&h, 3601.0);
        h.st.lock().dms.clear();
        h.st.lock().channels.insert("g-01".into(), json!({"id": "g-01", "kind": "group", "name": "", "members": ["ann@x", "ben@x"], "created_by": "ann@x"}));
        let at = h.st.lock().pu.now() + 1800.0;
        create("Six", at);
        assert_eq!(payload_of(&sent(&mut rx)[0])["aps"]["interruption-level"], json!("active"));
        h.st.lock().channel_msgs.insert("g-01".into(), vec![row(json!({"id": "g1", "from": "ben@x", "ts": 1.0}))]);
        let at = h.st.lock().pu.now() + 1800.0;
        create("Seven", at);
        assert_eq!(payload_of(&sent(&mut rx)[0])["aps"]["interruption-level"], json!("time-sensitive"));
    }

    #[test]
    fn a_new_crl_reaches_offline_iphones_as_a_spread_background_push() {
        let (h, mut rx) = hub_on();
        let ben = who("ben@x", IPHONE);
        let (key, answer) = register(&h, &ben, TOKEN, Some(VOIP), true);
        let person = pj::b64_strict(answer["key"].as_str().unwrap()).unwrap();
        h.pc_tell_crl(1_793_996_400);
        skew(&h, CRL_SPREAD + 1.0);
        h.push_tick();
        let jobs = sent(&mut rx);
        assert_eq!(jobs.len(), 1);
        let j = &jobs[0];
        assert!(!j.voip && j.token == TOKEN);
        assert_eq!(header(j, "apns-push-type").as_deref(), Some("background"));
        assert_eq!(header(j, "apns-priority").as_deref(), Some("5"));
        assert_eq!(header(j, "apns-collapse-id"), Some(tag(&person, b"crl")));
        let expires: i64 = header(j, "apns-expiration").unwrap().parse().unwrap();
        assert!((expires - h.st.lock().pu.now() as i64 - 6 * 3600).abs() <= 5);
        let p = payload_of(j);
        assert_eq!(p.as_object().unwrap().keys().collect::<Vec<_>>(), ["aps", "s", "sk", "o"]);
        assert_eq!(p["aps"], json!({"content-available": 1}));
        let inner = inner_of(&h, j, &key);
        assert_eq!((&inner["k"], &inner["from"], &inner["conv"], &inner["id"]), (&json!("crl"), &json!(""), &json!(""), &json!("1793996400")));
        // at most one per device per 15 minutes: the next waits for the window
        h.pc_tell_crl(1_793_997_000);
        skew(&h, CRL_SPREAD + 1.0);
        h.push_tick();
        assert!(sent(&mut rx).is_empty());
        skew(&h, CRL_EVERY);
        h.push_tick();
        assert_eq!(inner_of(&h, &sent(&mut rx)[0], &key)["id"], json!("1793997000"));
        // a sessionless request never makes the device live: nothing changes for push; a polling session does
        let si = session(&h, &ben);
        h.inbox(&si, &ben, 0, 0.0).unwrap();
        h.pc_tell_crl(1_793_998_000);
        skew(&h, CRL_EVERY + CRL_SPREAD + 1.0);
        h.inbox(&si, &ben, 0, 0.0).unwrap();
        h.push_tick();
        assert!(sent(&mut rx).is_empty());
    }

    #[test]
    fn apns_gone_on_voip_clears_only_voip() {
        let (h, _rx) = hub_on();
        let ben = who("ben@x", IPHONE);
        register(&h, &ben, TOKEN, Some(VOIP), true);
        // APNs on an older token changes nothing
        h.push_gone("ben@x", IPHONE, &"ab".repeat(32), "410", false);
        h.push_gone("ben@x", IPHONE, TOKEN, "410", true);
        assert_eq!(h.st.lock().push_tokens["ben@x"][IPHONE]["voip"], json!(VOIP));
        h.push_gone("ben@x", IPHONE, VOIP, "410", true);
        assert_eq!(h.st.lock().push_tokens["ben@x"][IPHONE]["voip"], json!(""));
        h.push_gone("ben@x", IPHONE, TOKEN, "BadDeviceToken", false);
        assert!(!h.st.lock().push_tokens.contains_key("ben@x"));
        register(&h, &ben, TOKEN, None, true);
        assert_eq!(h.drop_serials(&["0x2b".to_string()]), 0);
        assert!(h.st.lock().push_tokens.contains_key("ben@x"));
        assert_eq!(h.drop_serials(&["1A".to_string()]), 0);
        assert!(!h.st.lock().push_tokens.contains_key("ben@x"));
    }

    #[test]
    fn inbox_wait_and_the_read_marks() {
        assert_eq!(inbox_wait("25").unwrap(), m::POLL_WAIT);
        assert_eq!((inbox_wait("1").unwrap(), inbox_wait("10").unwrap(), inbox_wait("25").unwrap()), (1.0, 10.0, 25.0));
        for wrong in ["", "0", "26", "+5", "1.5", " 5", "x", "-1"] {
            assert_eq!(inbox_wait(wrong).unwrap_err().message(), "wait must be 1 to 25 seconds");
        }
        let h = hub();
        let ben = who("ben@x", IPHONE);
        assert_eq!(error(h.notify_reads(&who("ben@x", ""))), "403 finish setting up this device first");
        {
            let mut st = h.st.lock();
            st.read.insert("ben@x".into(), json!({"ann@x": 1.5}));
            st.channel_read.insert("ben@x".into(), json!({"c-01": 2.5}));
        }
        assert_eq!(h.notify_reads(&ben).unwrap(), row(json!({"reads": {"dm:ann@x": 1.5, "channel:c-01": 2.5}})));
    }

    #[test]
    fn apns_answers_are_read() {
        assert_eq!(apns::outcome(200, b""), Outcome::Sent);
        assert_eq!(apns::outcome(410, b"{\"reason\":\"Unregistered\"}"), Outcome::Gone("410".into()));
        assert_eq!(apns::outcome(400, b"{\"reason\":\"BadDeviceToken\"}"), Outcome::Gone("BadDeviceToken".into()));
        assert_eq!(apns::outcome(400, b"{\"reason\":\"BadCollapseId\"}"), Outcome::Failed("400 BadCollapseId".into()));
        assert_eq!(apns::outcome(503, b"nope"), Outcome::Failed("503".into()));
    }

    fn p8() -> (String, Vec<u8>) {
        let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &SystemRandom::new()).unwrap();
        let public = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref()).unwrap().public_key().as_ref().to_vec();
        (pem("PRIVATE KEY", pkcs8.as_ref()), public)
    }

    /// Check an ES256 JWT with the public key; its header and claims.
    fn jwt_parts(token: &str, public: &[u8]) -> (Value, Value) {
        let parts: Vec<&str> = token.split('.').collect();
        assert_eq!(parts.len(), 3);
        let sig = crate::codec::unb64u(parts[2]).unwrap();
        assert_eq!(sig.len(), 64);
        UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, public).verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &sig).expect("an ES256 signature");
        let part = |s: &str| serde_json::from_slice::<Value>(&crate::codec::unb64u(s).unwrap()).unwrap();
        (part(parts[0]), part(parts[1]))
    }

    #[test]
    fn the_provider_token_is_es256_and_kept_50_minutes() {
        let (pem_text, public) = p8();
        let key = Key::from_pem("TEAM123456", "KEY1234567", pem_text.as_bytes()).unwrap();
        let t = key.token().unwrap();
        let (header, claims) = jwt_parts(&t, &public);
        assert_eq!(header, json!({"alg": "ES256", "kid": "KEY1234567"}));
        assert_eq!(claims["iss"], json!("TEAM123456"));
        assert!((claims["iat"].as_i64().unwrap() - pj::now() as i64).abs() <= 2);
        assert_eq!(key.token().unwrap(), t);
        assert_eq!(apns::JWT_EVERY, std::time::Duration::from_secs(3000));
        key.forget();
        let again = key.token().unwrap();
        assert_ne!(again, t);
        jwt_parts(&again, &public);
        // what is not a P-256 PKCS#8 key is refused, with words that never show the file
        let p384 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P384_SHA384_FIXED_SIGNING, &SystemRandom::new()).unwrap();
        for wrong in [b"not a key".to_vec(), pem("PRIVATE KEY", p384.as_ref()).into_bytes(), pem("PRIVATE KEY", b"junk").into_bytes()] {
            assert_eq!(Key::from_pem("T", "K", &wrong).err().unwrap(), "key_file is not a P-256 private key");
        }
        assert_eq!(Key::load("T", "K", "/no/such/key.p8").err().unwrap(), "key_file cannot be read");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = std::env::temp_dir().join(format!("push-{}.p8", pj::token_hex(4)));
            std::fs::write(&path, &pem_text).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
            assert_eq!(Key::load("T", "K", path.to_str().unwrap()).err().unwrap(), "key_file must be readable by the relay only (mode 600)");
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
            assert!(Key::load("T", "K", path.to_str().unwrap()).is_ok());
            let _ = std::fs::remove_file(path);
        }
    }

    fn der(tag: u8, body: &[u8]) -> Vec<u8> {
        let n = body.len();
        let mut out = vec![tag];
        match n {
            0..=0x7f => out.push(n as u8),
            0x80..=0xff => out.extend([0x81, n as u8]),
            _ => out.extend([0x82, (n >> 8) as u8, n as u8]),
        }
        out.extend_from_slice(body);
        out
    }

    fn pem(label: &str, data: &[u8]) -> String {
        let b = pj::b64(data);
        let lines: Vec<&str> = b.as_bytes().chunks(64).map(|c| std::str::from_utf8(c).unwrap()).collect();
        format!("-----BEGIN {label}-----\n{}\n-----END {label}-----\n", lines.join("\n"))
    }

    /// The fake APNs server's certificate: self-signed P-256 for 127.0.0.1 (an IP SAN), and its key, as PEM.
    fn fake_cert() -> (String, String) {
        let rng = SystemRandom::new();
        let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &rng).unwrap();
        let pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, pkcs8.as_ref()).unwrap();
        let spki = crate::der::p256_spki_der(&crate::der::P256Key::from_sec1(pair.public_key().as_ref()).unwrap());
        let alg = der(0x30, &der(0x06, &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]));
        let name = der(0x30, &der(0x31, &der(0x30, &[der(0x06, &[0x55, 0x04, 0x03]), der(0x0c, b"apns.test")].concat())));
        let validity = der(0x30, &[der(0x17, b"250101000000Z"), der(0x17, b"491231235959Z")].concat());
        let san = der(0x30, &[der(0x06, &[0x55, 0x1d, 0x11]), der(0x04, &der(0x30, &der(0x87, &[127, 0, 0, 1])))].concat());
        let extensions = der(0xa3, &der(0x30, &san));
        let tbs = der(0x30, &[der(0xa0, &der(0x02, &[2])), der(0x02, &[1]), alg.clone(), name.clone(), validity, name, spki, extensions].concat());
        let sig = pair.sign(&rng, &tbs).unwrap();
        let cert = der(0x30, &[tbs, alg, der(0x03, &[&[0u8][..], sig.as_ref()].concat())].concat());
        (pem("CERTIFICATE", &cert), pem("PRIVATE KEY", pkcs8.as_ref()))
    }

    type Seen = (String, hyper::HeaderMap, bytes::Bytes);

    /// What a fake server answers a request (path, body): the status and the body.
    type Answer = Arc<dyn Fn(&str, &bytes::Bytes) -> (u16, String) + Send + Sync>;

    /// A fake APNs: a token starting `dead` answers 410, one starting `bad0` 400 BadDeviceToken, anything else 200.
    async fn fake_apns(cert: &str, key: &str) -> (u16, tokio::sync::mpsc::UnboundedReceiver<Seen>) {
        let answer: Answer = Arc::new(|path: &str, _: &bytes::Bytes| {
            let token = path.rsplit('/').next().unwrap_or_default();
            if token.starts_with("dead") {
                (410, "{\"reason\":\"Unregistered\"}".into())
            } else if token.starts_with("bad0") {
                (400, "{\"reason\":\"BadDeviceToken\"}".into())
            } else {
                (200, String::new())
            }
        });
        fake_h2(cert, key, answer).await
    }

    /// A fake HTTP/2 server over TLS (ALPN h2), recording every request and answering it with `answer`.
    async fn fake_h2(cert: &str, key: &str, answer: Answer) -> (u16, tokio::sync::mpsc::UnboundedReceiver<Seen>) {
        use http_body_util::{BodyExt, Full};
        use hyper_util::rt::{TokioExecutor, TokioIo};
        let certs = rustls_pemfile::certs(&mut cert.as_bytes()).collect::<Result<Vec<_>, _>>().unwrap();
        let key = rustls_pemfile::private_key(&mut key.as_bytes()).unwrap().unwrap();
        let mut cfg = rustls::ServerConfig::builder_with_provider(Arc::new(crate::server::provider())).with_safe_default_protocol_versions().unwrap().with_no_client_auth().with_single_cert(certs, key).unwrap();
        cfg.alpn_protocols = vec![b"h2".to_vec()];
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(cfg));
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Seen>();
        tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                let (acceptor, tx, answer) = (acceptor.clone(), tx.clone(), answer.clone());
                tokio::spawn(async move {
                    let Ok(tls) = acceptor.accept(tcp).await else { return };
                    let service = hyper::service::service_fn(move |req: hyper::Request<hyper::body::Incoming>| {
                        let (tx, answer) = (tx.clone(), answer.clone());
                        async move {
                            let path = req.uri().path().to_string();
                            let headers = req.headers().clone();
                            let body = req.into_body().collect().await.map(|b| b.to_bytes()).unwrap_or_default();
                            let (status, text) = answer(&path, &body);
                            let _ = tx.send((path, headers, body));
                            Ok::<_, std::convert::Infallible>(hyper::Response::builder().status(status).body(Full::new(bytes::Bytes::from(text))).unwrap())
                        }
                    });
                    let _ = hyper::server::conn::http2::Builder::new(TokioExecutor::new()).serve_connection(TokioIo::new(tls), service).await;
                });
            }
        });
        (port, rx)
    }

    #[tokio::test]
    async fn the_sender_speaks_http2_to_apns_with_the_hubs_headers_and_drops_gone_tokens() {
        let (cert, cert_key) = fake_cert();
        let (port, mut seen) = fake_apns(&cert, &cert_key).await;
        let ca = std::env::temp_dir().join(format!("apns-ca-{}.pem", pj::token_hex(4)));
        std::fs::write(&ca, &cert).unwrap();
        let ep = Endpoint::new(Some(ca.to_str().unwrap()), ("127.0.0.1".into(), port), ("127.0.0.1".into(), port)).unwrap();
        let (pem_text, public) = p8();
        let key = Key::from_pem("TEAM123456", "KEY1234567", pem_text.as_bytes()).unwrap();
        type Gone = (String, String, String, String, bool);
        let gone: Arc<parking_lot::Mutex<Vec<Gone>>> = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let heard = gone.clone();
        let on_gone: apns::OnGone = Arc::new(move |j: &Job, why: &str| heard.lock().push((j.principal.clone(), j.device.clone(), j.token.clone(), why.to_string(), j.voip)));
        let sender = Sender::start(key, ep, on_gone).unwrap();
        let alert = vec![("apns-push-type", "alert".to_string()), ("apns-topic", TOPIC.to_string()), ("apns-priority", "10".to_string()), ("apns-expiration", "1794003900".to_string()), ("apns-collapse-id", "c0ffee".to_string())];
        let voip = vec![("apns-push-type", "voip".to_string()), ("apns-topic", format!("{TOPIC}.voip")), ("apns-priority", "10".to_string()), ("apns-expiration", "0".to_string())];
        let job = |token: &str, is_voip: bool| Job {
            principal: "ben@x".into(),
            device: IPHONE.into(),
            token: token.into(),
            sandbox: !is_voip,
            voip: is_voip,
            kind: if is_voip { "call".into() } else { "msg".into() },
            headers: if is_voip { voip.clone() } else { alert.clone() },
            payload: b"{\"s\":\"x\"}".to_vec(),
        };
        assert!(sender.send(job(TOKEN, false)));
        let (path, headers, body) = tokio::time::timeout(std::time::Duration::from_secs(10), seen.recv()).await.unwrap().unwrap();
        assert_eq!(path, format!("/3/device/{TOKEN}"));
        let h = |k: &str| headers.get(k).and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
        assert_eq!((h("apns-topic"), h("apns-push-type"), h("apns-priority"), h("apns-expiration"), h("apns-collapse-id")), (TOPIC.into(), "alert".into(), "10".into(), "1794003900".into(), "c0ffee".into()));
        let bearer = h("authorization");
        let (header, claims) = jwt_parts(bearer.strip_prefix("bearer ").unwrap(), &public);
        assert_eq!((header["kid"].clone(), claims["iss"].clone()), (json!("KEY1234567"), json!("TEAM123456")));
        assert_eq!(body.as_ref(), b"{\"s\":\"x\"}");
        // a VoIP push (to the other host's connection): its topic, no collapse id, the same provider token
        assert!(sender.send(job(VOIP, true)));
        let (path, headers, _) = tokio::time::timeout(std::time::Duration::from_secs(10), seen.recv()).await.unwrap().unwrap();
        assert_eq!(path, format!("/3/device/{VOIP}"));
        assert_eq!(headers.get("apns-push-type").unwrap().to_str().unwrap(), "voip");
        assert_eq!(headers.get("apns-topic").unwrap().to_str().unwrap(), format!("{TOPIC}.voip"));
        assert!(headers.get("apns-collapse-id").is_none());
        assert_eq!(headers.get("authorization").unwrap().to_str().unwrap(), bearer);
        // 410 and 400 BadDeviceToken report the token gone (with whether it was a VoIP request); nothing else does
        let dead = format!("dead{}", &TOKEN[4..]);
        let bad = format!("bad0{}", &TOKEN[4..]);
        assert!(sender.send(job(&dead, true)) && sender.send(job(&bad, false)));
        for _ in 0..2 {
            tokio::time::timeout(std::time::Duration::from_secs(10), seen.recv()).await.unwrap().unwrap();
        }
        for _ in 0..100 {
            if gone.lock().len() == 2 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        let mut got = gone.lock().clone();
        got.sort();
        assert_eq!(got, vec![("ben@x".to_string(), IPHONE.to_string(), bad, "BadDeviceToken".to_string(), false), ("ben@x".to_string(), IPHONE.to_string(), dead, "410".to_string(), true)]);
        assert!(seen.try_recv().is_err());
        let _ = std::fs::remove_file(ca);
    }

    // ── Android (FCM) ──

    /// A hub with push on for iPhones (VoIP too) and Android devices, both senders' pushes caught.
    fn hub_android() -> (Hub, Receiver<Job>, Receiver<fcm::Job>) {
        let (h, rx) = hub_on();
        let (sender, frx) = fcm::Sender::capture();
        h.st.lock().pu.fcm = Some(sender);
        (h, rx, frx)
    }

    /// Register an Android device; its seal key and the answer back.
    fn register_android(h: &Hub, w: &Identity, token: &str) -> (agreement::PrivateKey, Obj) {
        let (k, seal, sk) = seal_key_pair();
        let answer = h.push_register(w, &row(json!({"session": "x", "platform": "android", "token": token, "seal": seal, "sk": sk}))).unwrap();
        (k, answer)
    }

    fn fcm_sent(rx: &mut Receiver<fcm::Job>) -> Vec<fcm::Job> {
        let mut out = Vec::new();
        while let Ok(j) = rx.try_recv() {
            out.push(j);
        }
        out
    }

    fn message_of(j: &fcm::Job) -> Value {
        let body: Value = serde_json::from_slice(&j.body).unwrap();
        assert_eq!(body.as_object().unwrap().keys().collect::<Vec<_>>(), ["message"]);
        body["message"].clone()
    }

    fn keys_of(v: &Value) -> Vec<String> {
        v.as_object().unwrap().keys().cloned().collect()
    }

    /// Open a caught FCM push with the device's seal key, as the Android app does (an alert's kind checked against
    /// the data's `cat`).
    fn fcm_inner_of(h: &Hub, j: &fcm::Job, key: &agreement::PrivateKey) -> Value {
        let person = h.st.lock().pu_person_key(&j.principal);
        let data = message_of(j)["data"].clone();
        let channel = channel_of(data["ch"].as_str().unwrap());
        let sk = data["sk"].as_str().unwrap().to_string();
        let now_ms = (h.st.lock().pu.now() * 1000.0) as i64;
        open(&[(sk, key)], &person, channel, data["cat"].as_str().unwrap_or_default(), &data, &mut HashSet::new(), now_ms, &j.device).unwrap()
    }

    #[test]
    fn android_registers_its_fcm_token_with_the_seal_key_and_env_is_ignored() {
        let (h, _rx, _frx) = hub_android();
        let pixel = who("ben@x", PIXEL);
        let (_, seal, sk) = seal_key_pair();
        let good = row(json!({"platform": "android", "token": FCM, "seal": seal, "sk": sk}));
        let with = |k: &str, v: Value| {
            let mut b = good.clone();
            b.insert(k.into(), v);
            b
        };
        let without = |k: &str| {
            let mut b = good.clone();
            b.shift_remove(k);
            b
        };
        for bad_token in [json!("a".repeat(99)), json!("a".repeat(4097)), json!(FCM.replace(':', "/")), json!(format!("{FCM} ")), json!(TOKEN), json!(1), Value::Null] {
            assert_eq!(error(h.push_register(&pixel, &with("token", bad_token))), "400 an android token must be 100 to 4096 letters, digits, colons, underscores or hyphens");
        }
        assert_eq!(error(h.push_register(&pixel, &without("token"))), "400 an android token must be 100 to 4096 letters, digits, colons, underscores or hyphens");
        assert!(h.push_register(&pixel, &with("token", json!("a".repeat(100)))).is_ok());
        assert!(h.push_register(&pixel, &with("token", json!("a".repeat(4096)))).is_ok());
        // the seal key exactly as an iPhone's; no voip_token, callkit false or absent
        assert_eq!(error(h.push_register(&pixel, &without("seal"))), format!("400 {BAD_SEAL}"));
        assert_eq!(error(h.push_register(&pixel, &without("sk"))), format!("400 {BAD_SK}"));
        assert_eq!(error(h.push_register(&pixel, &with("sk", json!("00000000")))), format!("400 {BAD_SK}"));
        for wrong in [("voip_token", json!(VOIP)), ("voip_token", json!("")), ("callkit", json!(true)), ("callkit", json!("no"))] {
            assert_eq!(error(h.push_register(&pixel, &with(wrong.0, wrong.1))), "400 an android registration takes no voip_token, and callkit must be false");
        }
        assert!(h.push_register(&pixel, &with("callkit", json!(false))).is_ok());
        assert!(h.push_register(&pixel, &with("voip_token", Value::Null)).is_ok());
        // env is ignored, whatever it says, sandbox tokens off or not
        h.st.lock().pu.sandbox = false;
        let got = h.push_register(&pixel, &with("env", json!("dev"))).unwrap();
        assert_eq!(got.keys().collect::<Vec<_>>(), ["ok", "key", "voip"]);
        assert_eq!(got["voip"], json!(true));
        let entry = h.st.lock().push_tokens["ben@x"][PIXEL].clone();
        assert_eq!(keys_of(&entry), ["token", "env", "ts", "serial", "seal", "sk", "seal_prev", "sk_prev", "voip", "callkit", "platform"]);
        assert_eq!(
            (&entry["token"], &entry["env"], &entry["seal"], &entry["sk"], &entry["voip"], &entry["callkit"], &entry["platform"]),
            (&json!(FCM), &json!(""), &json!(seal), &json!(sk), &json!(""), &json!(false), &json!("android"))
        );
        // the row loads back; an Android row with iPhone parts or without a seal key does not
        let fresh = hub();
        let mut wrong_rows = Vec::new();
        for (k, v) in [("callkit", json!(true)), ("env", json!("production")), ("voip", json!(VOIP)), ("token", json!(TOKEN)), ("platform", json!("web")), ("seal", json!("")), ("sk", json!(""))] {
            let mut r = entry.clone();
            r[k] = v;
            wrong_rows.push(r);
        }
        let mut both = Obj::new();
        both.insert(PIXEL.into(), entry.clone());
        for (i, r) in wrong_rows.into_iter().enumerate() {
            both.insert(format!("{i:016}"), r);
        }
        fresh.st.lock().pu_load(&row(json!({"push_tokens": {"ben@x": both}})));
        assert_eq!(Value::Object(fresh.st.lock().push_tokens.clone()), json!({"ben@x": {PIXEL: entry}}));
        // FCM off: Android refused, iPhones still register; APNs off: the reverse
        let sender = h.st.lock().pu.fcm.take();
        assert_eq!(error(h.push_register(&pixel, &good)), "501 push notifications for this platform are off on this relay");
        h.st.lock().pu.fcm = sender;
        let sender = h.st.lock().pu.sender.take();
        let iphone = row(json!({"token": TOKEN, "env": "production", "seal": seal, "sk": sk, "callkit": false}));
        assert_eq!(error(h.push_register(&who("ben@x", IPHONE), &iphone)), "501 push notifications for this platform are off on this relay");
        assert!(h.st.lock().pu_on());
        assert!(h.push_register(&pixel, &good).is_ok());
        h.st.lock().pu.sender = sender;
        // unregister: the same for both
        assert_eq!(h.push_unregister(&pixel).unwrap(), row(json!({"ok": true, "removed": true})));
        assert!(!h.st.lock().push_tokens.contains_key("ben@x"));
    }

    #[test]
    fn fcm_messages_per_channel_match_the_golden_json() {
        let person = [7u8; 32];
        let (s, sk) = ("U0VBTEVE", "d197f269");
        let t = |d: &str| tag(&person, d.as_bytes());
        let o = |c: Channel| origin(&person, c, sk, s);
        let golden = |c: Channel, inner: Value| {
            let (message, size) = build_fcm(&person, c, &row(inner), s, sk, 12, FCM);
            (pj::dumps_compact(&message), size)
        };
        // a message: alert, HIGH, an hour, the collapse tag in the data and as the collapse key, category and badge
        let (alert, size) = golden(Channel::Alert, json!({"v": 1, "k": "msg", "conv": "dm:ann@x", "id": "m-1"}));
        assert_eq!(
            alert,
            format!(
                r#"{{"message":{{"token":"{FCM}","data":{{"ch":"alert","c":"{}","s":"{s}","sk":"{sk}","o":"{}","collapse":"{}","cat":"msg","badge":"12"}},"android":{{"priority":"HIGH","ttl":"3600s","collapse_key":"{}"}}}}}}"#,
                t("dm:ann@x"),
                o(Channel::Alert),
                t("msg:m-1"),
                t("msg:m-1")
            )
        );
        assert_eq!(size, 2 + 5 + 1 + 32 + 1 + s.len() + 2 + 8 + 1 + 32 + 8 + 32 + 3 + 3 + 5 + 2);
        // a missed call and a meeting invite: their threads, collapse tags and categories as on the iPhone
        let (missed, _) = golden(Channel::Alert, json!({"v": 1, "k": "missed", "conv": "dm:ann@x", "id": "i-1"}));
        assert!(missed.contains(&format!(r#""collapse":"{}","cat":"missed","badge":"12"}},"android":{{"priority":"HIGH","ttl":"3600s","collapse_key":"{}"}}"#, t("invite:i-1"), t("invite:i-1"))));
        let (meeting, _) = golden(Channel::Alert, json!({"v": 1, "k": "invite", "conv": "meeting:mt-1", "id": "mt-1", "start": 1_794_000_000}));
        assert!(meeting.contains(&format!(r#""c":"{}""#, t("meetings"))) && meeting.contains(&format!(r#""collapse_key":"{}""#, t("meeting:mt-1:1794000000"))));
        assert!(meeting.contains(r#""cat":"mtg""#));
        // a call: voip, HIGH, now or never, no collapse key
        let (voip, _) = golden(Channel::Voip, json!({"v": 1, "k": "call", "conv": "dm:ann@x", "id": "i-1"}));
        assert_eq!(voip, format!(r#"{{"message":{{"token":"{FCM}","data":{{"ch":"voip","c":"{}","s":"{s}","sk":"{sk}","o":"{}"}},"android":{{"priority":"HIGH","ttl":"0s"}}}}}}"#, t("dm:ann@x"), o(Channel::Voip)));
        // a new CRL: background, NORMAL, six hours, the crl collapse key
        let (background, _) = golden(Channel::Background, json!({"v": 1, "k": "crl", "conv": "", "id": "1793996400", "from": ""}));
        assert_eq!(
            background,
            format!(r#"{{"message":{{"token":"{FCM}","data":{{"ch":"background","s":"{s}","sk":"{sk}","o":"{}"}},"android":{{"priority":"NORMAL","ttl":"21600s","collapse_key":"{}"}}}}}}"#, o(Channel::Background), t("crl"))
        );
        // the sealed inner's one size fits FCM's data limit on every channel
        for (c, b64) in [(Channel::Alert, 3540), (Channel::Voip, 1492), (Channel::Background, 1492)] {
            let sealed = "A".repeat(b64);
            let (_, size) = build_fcm(&person, c, &row(json!({"k": "msg", "conv": "x".repeat(300), "id": "y".repeat(64)})), &sealed, sk, 99_999, FCM);
            assert!(size <= fcm::DATA_LIMIT, "{c:?} {size}");
        }
        assert_eq!(fcm::DATA_LIMIT, 4096);
    }

    #[test]
    fn android_devices_get_data_only_fcm_pushes_for_messages_calls_and_crls() {
        let (h, mut rx, mut frx) = hub_android();
        let (ann, pixel) = (who("ann@x", "aaaaaaaaaaaaaaaa"), who("ben@x", PIXEL));
        let sa = session(&h, &ann);
        let sb = session(&h, &pixel);
        h.bye(&sb, &pixel).unwrap();
        let (key, answer) = register_android(&h, &pixel, FCM);
        let person = pj::b64_strict(answer["key"].as_str().unwrap()).unwrap();
        // a direct message: one alert, data only, no notification block, sealed like the iPhone's
        dm(&h, "m-1", json!({}));
        assert!(sent(&mut rx).is_empty());
        let jobs = fcm_sent(&mut frx);
        assert_eq!(jobs.len(), 1);
        let j = &jobs[0];
        assert_eq!((j.principal.as_str(), j.device.as_str(), j.token.as_str(), j.kind.as_str()), ("ben@x", PIXEL, FCM, "msg"));
        let m = message_of(j);
        assert_eq!(keys_of(&m), ["token", "data", "android"]);
        assert_eq!(m["token"], json!(FCM));
        assert_eq!(keys_of(&m["data"]), ["ch", "c", "s", "sk", "o", "collapse", "cat", "badge"]);
        let collapse = tag(&person, b"msg:m-1");
        assert_eq!((&m["data"]["ch"], &m["data"]["c"], &m["data"]["collapse"]), (&json!("alert"), &json!(tag(&person, b"dm:ann@x")), &json!(collapse)));
        assert_eq!((&m["data"]["cat"], &m["data"]["badge"]), (&json!("msg"), &json!("1")));
        assert_eq!(m["data"]["s"].as_str().unwrap().len(), 3540);
        assert_eq!(m["android"], json!({"priority": "HIGH", "ttl": "3600s", "collapse_key": collapse}));
        let inner = fcm_inner_of(&h, j, &key);
        assert_eq!((&inner["k"], &inner["dev"], &inner["from"], &inner["id"]), (&json!("msg"), &json!(PIXEL), &json!("ann@x"), &json!("m-1")));
        // a call rings on the voip channel with the one FCM token, whatever push.voip says
        h.st.lock().pu.voip = false;
        let room = dm_room("ann@x", "ben@x");
        let got = h.invite(&sa, &ann, Some(&json!("ben@x")), Some(&json!(room)), None).unwrap();
        let id = invites(&got)[0]["id"].as_str().unwrap().to_string();
        let jobs = fcm_sent(&mut frx);
        assert_eq!(jobs.len(), 1);
        let m = message_of(&jobs[0]);
        assert_eq!(keys_of(&m["data"]), ["ch", "c", "s", "sk", "o"]);
        assert_eq!((&m["data"]["ch"], m["data"]["s"].as_str().unwrap().len()), (&json!("voip"), 1492));
        assert_eq!(m["android"], json!({"priority": "HIGH", "ttl": "0s"}));
        let inner = fcm_inner_of(&h, &jobs[0], &key);
        assert_eq!((&inner["k"], &inner["id"], &inner["room"]), (&json!("call"), &json!(id), &json!(room)));
        // a new CRL: background, normal priority (the ring has ended meanwhile: its missed call is an alert)
        h.pc_tell_crl(1_793_996_400);
        skew(&h, CRL_SPREAD + 1.0);
        h.push_tick();
        let jobs = fcm_sent(&mut frx);
        let crl = jobs.iter().find(|j| message_of(j)["data"]["ch"] == json!("background")).unwrap();
        let m = message_of(crl);
        assert_eq!(keys_of(&m["data"]), ["ch", "s", "sk", "o"]);
        assert_eq!(m["android"], json!({"priority": "NORMAL", "ttl": "21600s", "collapse_key": tag(&person, b"crl")}));
        assert_eq!(fcm_inner_of(&h, crl, &key)["k"], json!("crl"));
        for missed in jobs.iter().filter(|j| message_of(j)["data"]["ch"] == json!("alert")) {
            assert_eq!(message_of(missed)["android"]["collapse_key"], json!(tag(&person, format!("invite:{id}").as_bytes())));
            assert_eq!(fcm_inner_of(&h, missed, &key)["k"], json!("missed"));
        }
        assert!(sent(&mut rx).is_empty());
    }

    #[test]
    fn fcm_unregistered_and_a_bad_token_clear_the_android_row() {
        let answer = |status: u16, v: Value| fcm::outcome(status, v.to_string().as_bytes());
        let fcm_error = |code: &str| json!({"@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", "errorCode": code});
        assert_eq!(answer(200, json!({"name": "projects/p/messages/1"})), Outcome::Sent);
        assert_eq!(answer(404, json!({"error": {"code": 404, "message": "Requested entity was not found.", "status": "NOT_FOUND", "details": [fcm_error("UNREGISTERED")]}})), Outcome::Gone("UNREGISTERED".into()));
        let not_a_token = json!({"error": {"code": 400, "message": "The registration token is not a valid FCM registration token", "status": "INVALID_ARGUMENT", "details": [fcm_error("INVALID_ARGUMENT")]}});
        assert_eq!(answer(400, not_a_token), Outcome::Gone("INVALID_ARGUMENT".into()));
        let violation = |field: &str| json!({"error": {"code": 400, "message": "Request contains an invalid argument.", "status": "INVALID_ARGUMENT", "details": [{"@type": "type.googleapis.com/google.rpc.BadRequest", "fieldViolations": [{"field": field, "description": "x"}]}]}});
        assert_eq!(answer(400, violation("message.token")), Outcome::Gone("INVALID_ARGUMENT".into()));
        // a bad message is not a bad token; quota, outages and credentials are failures, never retried
        assert_eq!(answer(400, violation("message.android.ttl")), Outcome::Failed("400 INVALID_ARGUMENT".into()));
        assert_eq!(answer(429, json!({"error": {"code": 429, "status": "RESOURCE_EXHAUSTED", "details": [fcm_error("QUOTA_EXCEEDED")]}})), Outcome::Failed("429 QUOTA_EXCEEDED".into()));
        assert_eq!(answer(401, json!({"error": {"code": 401, "status": "UNAUTHENTICATED"}})), Outcome::Failed("401 UNAUTHENTICATED".into()));
        assert_eq!(fcm::outcome(503, b"nope"), Outcome::Failed("503".into()));
        // the hub: FCM on an older token changes nothing; on the row's token the registration goes
        let (h, _rx, _frx) = hub_android();
        let pixel = who("ben@x", PIXEL);
        register_android(&h, &pixel, FCM);
        h.push_gone("ben@x", PIXEL, &format!("{FCM}x"), "UNREGISTERED", false);
        assert_eq!(h.st.lock().push_tokens["ben@x"][PIXEL]["token"], json!(FCM));
        h.push_gone("ben@x", PIXEL, FCM, "UNREGISTERED", false);
        assert!(!h.st.lock().push_tokens.contains_key("ben@x"));
        register_android(&h, &pixel, FCM);
        h.push_gone("ben@x", PIXEL, FCM, "INVALID_ARGUMENT", false);
        assert!(!h.st.lock().push_tokens.contains_key("ben@x"));
    }

    /// A service account key file (JSON) with a fresh RSA key, and the key's public half.
    fn service_account() -> (String, Vec<u8>) {
        let pair = RsaKeyPair::generate(KeySize::Rsa2048).unwrap();
        let pkcs8 = AsDer::<Pkcs8V1Der>::as_der(&pair).unwrap();
        let file = json!({
            "type": "service_account", "project_id": PROJECT, "private_key_id": "0123abcd", "private_key": pem("PRIVATE KEY", pkcs8.as_ref()),
            "client_email": EMAIL, "client_id": "1", "token_uri": "https://oauth2.googleapis.com/token"
        });
        (file.to_string(), pair.public_key().as_ref().to_vec())
    }

    /// Check an RS256 JWT with the public key; its header and claims.
    fn rs256_parts(token: &str, public: &[u8]) -> (Value, Value) {
        let parts: Vec<&str> = token.split('.').collect();
        assert_eq!(parts.len(), 3);
        let sig = crate::codec::unb64u(parts[2]).unwrap();
        UnparsedPublicKey::new(&RSA_PKCS1_2048_8192_SHA256, public).verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &sig).expect("an RS256 signature");
        let part = |s: &str| serde_json::from_slice::<Value>(&crate::codec::unb64u(s).unwrap()).unwrap();
        (part(parts[0]), part(parts[1]))
    }

    #[test]
    fn the_fcm_assertion_is_rs256_and_its_access_token_is_kept_until_5_minutes_before_expiry() {
        let (file, public) = service_account();
        let account = fcm::Account::from_json(file.as_bytes()).unwrap();
        let (header, claims) = rs256_parts(&account.assertion(1_794_000_000).unwrap(), &public);
        assert_eq!(header, json!({"alg": "RS256", "typ": "JWT"}));
        assert_eq!(keys_of(&claims), ["iss", "scope", "aud", "iat", "exp"]);
        assert_eq!(
            claims,
            json!({"iss": EMAIL, "scope": "https://www.googleapis.com/auth/firebase.messaging", "aud": "https://oauth2.googleapis.com/token", "iat": 1_794_000_000, "exp": 1_794_003_600})
        );
        // the access token: kept while good for more than 5 minutes
        assert_eq!(fcm::RENEW_BEFORE, std::time::Duration::from_secs(300));
        assert!(account.cached().is_none());
        account.keep("ya29.a", 3599);
        assert_eq!(account.cached().as_deref(), Some("ya29.a"));
        account.keep("ya29.b", 300);
        assert!(account.cached().is_none());
        account.keep("ya29.c", 0);
        assert!(account.cached().is_none());
        account.keep("ya29.d", 3599);
        account.forget();
        assert!(account.cached().is_none());
        // what is not a service account key is refused, with words that never show the file
        let (p256, _) = p8();
        let key_of = |pem_text: &str| json!({"client_email": EMAIL, "private_key": pem_text}).to_string().into_bytes();
        for wrong in [b"not json".to_vec(), json!({"client_email": EMAIL}).to_string().into_bytes(), json!({"client_email": "", "private_key": "x"}).to_string().into_bytes(), key_of(&p256), key_of(&pem("PRIVATE KEY", b"junk")), key_of("")] {
            assert_eq!(fcm::Account::from_json(&wrong).err().unwrap(), "credentials_file is not a service account key (client_email, private_key)");
        }
        assert_eq!(fcm::Account::load("/no/such/fcm.json").err().unwrap(), "credentials_file cannot be read");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = std::env::temp_dir().join(format!("fcm-{}.json", pj::token_hex(4)));
            std::fs::write(&path, &file).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
            assert_eq!(fcm::Account::load(path.to_str().unwrap()).err().unwrap(), "credentials_file must be readable by the relay only (mode 600)");
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
            assert!(fcm::Account::load(path.to_str().unwrap()).is_ok());
            let _ = std::fs::remove_file(path);
        }
    }

    #[test]
    fn an_endless_expires_in_is_kept_for_an_hour_at_most_and_never_overflows() {
        let (file, _) = service_account();
        let account = fcm::Account::from_json(file.as_bytes()).unwrap();
        for huge in [u64::MAX, u64::MAX / 1000, 10 * 365 * 86_400] {
            account.keep("ya29.long", huge);
            assert_eq!(account.cached().as_deref(), Some("ya29.long"), "{huge}");
        }
    }

    #[tokio::test]
    async fn push_answers_past_64_kib_fail_while_read() {
        let full = |n: usize| http_body_util::Full::new(bytes::Bytes::from(vec![b'x'; n]));
        assert_eq!(apns::answer_body(full(apns::ANSWER_MAX)).await.unwrap().len(), apns::ANSWER_MAX);
        assert!(apns::answer_body(full(apns::ANSWER_MAX + 1)).await.is_err());
        assert!(apns::answer_body(full(16 << 20)).await.is_err());
    }

    /// A fake Google: `/token` answers a new access token each time (`ya29.test-<n>`); FCM's send answers a token
    /// starting `dead` 404 UNREGISTERED, `bad0` 400 INVALID_ARGUMENT, `busy` 429, anything else 200.
    async fn fake_google(cert: &str, key: &str) -> (u16, tokio::sync::mpsc::UnboundedReceiver<Seen>) {
        let issued = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let answer: Answer = Arc::new(move |path: &str, body: &bytes::Bytes| {
            if path == "/token" {
                let n = issued.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                return (200, json!({"access_token": format!("ya29.test-{n}"), "expires_in": 3599, "token_type": "Bearer"}).to_string());
            }
            let sent: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
            let token = sent["message"]["token"].as_str().unwrap_or_default();
            let error = |status: u16, code: &str, message: &str| (status, json!({"error": {"code": status, "message": message, "details": [{"@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", "errorCode": code}]}}).to_string());
            if token.starts_with("dead") {
                error(404, "UNREGISTERED", "Requested entity was not found.")
            } else if token.starts_with("bad0") {
                error(400, "INVALID_ARGUMENT", "The registration token is not a valid FCM registration token")
            } else if token.starts_with("busy") {
                error(429, "QUOTA_EXCEEDED", "Quota exceeded.")
            } else {
                (200, json!({"name": format!("projects/{PROJECT}/messages/1")}).to_string())
            }
        });
        fake_h2(cert, key, answer).await
    }

    #[tokio::test]
    async fn the_fcm_sender_gets_one_access_token_posts_http_v1_and_drops_gone_tokens() {
        let (cert, cert_key) = fake_cert();
        let (port, mut seen) = fake_google(&cert, &cert_key).await;
        let ca = std::env::temp_dir().join(format!("fcm-ca-{}.pem", pj::token_hex(4)));
        std::fs::write(&ca, &cert).unwrap();
        let ep = fcm::Endpoint::new(Some(ca.to_str().unwrap()), ("127.0.0.1".into(), port), ("127.0.0.1".into(), port)).unwrap();
        let (file, public) = service_account();
        let account = fcm::Account::from_json(file.as_bytes()).unwrap();
        type Gone = (String, String, String, String);
        let gone: Arc<parking_lot::Mutex<Vec<Gone>>> = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let heard = gone.clone();
        let on_gone: fcm::OnGone = Arc::new(move |j: &fcm::Job, why: &str| heard.lock().push((j.principal.clone(), j.device.clone(), j.token.clone(), why.to_string())));
        let sender = fcm::Sender::start(account, ep, PROJECT, on_gone).unwrap();
        let body = |token: &str| json!({"message": {"token": token, "data": {"ch": "alert"}, "android": {"priority": "HIGH", "ttl": "3600s"}}}).to_string().into_bytes();
        let job = |token: &str| fcm::Job { principal: "ben@x".into(), device: PIXEL.into(), token: token.into(), kind: "msg".into(), body: body(token) };
        let wait = std::time::Duration::from_secs(10);
        // the first push: the assertion for an access token, then the HTTP v1 send with it
        assert!(sender.send(job(FCM)));
        let (path, headers, form) = tokio::time::timeout(wait, seen.recv()).await.unwrap().unwrap();
        let h = |headers: &hyper::HeaderMap, k: &str| headers.get(k).and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
        assert_eq!((path.as_str(), h(&headers, "content-type").as_str()), ("/token", "application/x-www-form-urlencoded"));
        let form = String::from_utf8(form.to_vec()).unwrap();
        let assertion = form.strip_prefix("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=").unwrap();
        let (_, claims) = rs256_parts(assertion, &public);
        assert_eq!((&claims["iss"], &claims["scope"], &claims["aud"]), (&json!(EMAIL), &json!(fcm::SCOPE), &json!(fcm::AUDIENCE)));
        let (path, headers, sent_body) = tokio::time::timeout(wait, seen.recv()).await.unwrap().unwrap();
        assert_eq!(path, format!("/v1/projects/{PROJECT}/messages:send"));
        assert_eq!((h(&headers, "authorization"), h(&headers, "content-type")), ("Bearer ya29.test-1".to_string(), "application/json".to_string()));
        assert_eq!(sent_body.as_ref(), body(FCM).as_slice());
        // the next push: the same access token, no new token request
        assert!(sender.send(job(FCM)));
        let (path, headers, _) = tokio::time::timeout(wait, seen.recv()).await.unwrap().unwrap();
        assert_eq!((path, h(&headers, "authorization")), (format!("/v1/projects/{PROJECT}/messages:send"), "Bearer ya29.test-1".to_string()));
        // UNREGISTERED and INVALID_ARGUMENT on the token report it gone; 429 does not
        let (dead, bad, busy) = (format!("dead{}", &FCM[4..]), format!("bad0{}", &FCM[4..]), format!("busy{}", &FCM[4..]));
        assert!(sender.send(job(&dead)) && sender.send(job(&bad)) && sender.send(job(&busy)));
        for _ in 0..3 {
            let (path, _, _) = tokio::time::timeout(wait, seen.recv()).await.unwrap().unwrap();
            assert_eq!(path, format!("/v1/projects/{PROJECT}/messages:send"));
        }
        for _ in 0..100 {
            if gone.lock().len() == 2 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let mut got = gone.lock().clone();
        got.sort();
        assert_eq!(got, vec![("ben@x".to_string(), PIXEL.to_string(), bad, "INVALID_ARGUMENT".to_string()), ("ben@x".to_string(), PIXEL.to_string(), dead, "UNREGISTERED".to_string())]);
        assert!(seen.try_recv().is_err());
        let _ = std::fs::remove_file(ca);
    }
}
